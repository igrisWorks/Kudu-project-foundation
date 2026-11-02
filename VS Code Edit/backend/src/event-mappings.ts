import type {
  DataSourceEventMapping,
  EventMappingDefinition,
  EventMappingStatus,
  EventMappingValidationError,
  EventMappingValidationResult,
  JsonObject,
} from "@kudu/shared";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "./database.js";
import { ApiFailure } from "./errors.js";
import { isSqliteDatabase, lockSqliteWrite } from "./sqlite-database.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const definitionKeys = new Set(["eventType", "occurredAt", "sourceRecordId", "assetKey", "payload"]);
const unsafePathParts = new Set(["__proto__", "prototype", "constructor"]);
const MAX_DEFINITION_BYTES = 16 * 1024;
const MAX_PAYLOAD_MAPPINGS = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validFieldPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) return false;
  const parts = value.split(".");
  return parts.length <= 8 && parts.every(
    (part) => part.length > 0 && part.length <= 128 && part.trim() === part && !unsafePathParts.has(part),
  );
}

function validPayloadKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 120 &&
    value.trim() === value &&
    !value.includes("\0") &&
    !unsafePathParts.has(value)
  );
}

export function validateEventMappingDefinition(value: unknown): EventMappingValidationResult {
  const errors: EventMappingValidationError[] = [];
  if (!isPlainObject(value)) {
    return { valid: false, errors: [{ field: "definition", message: "Provide a mapping object." }] };
  }

  for (const key of Object.keys(value).sort()) {
    if (!definitionKeys.has(key)) {
      errors.push({ field: key, message: "This mapping property is not supported." });
    }
  }

  for (const required of ["eventType", "occurredAt"] as const) {
    if (!(required in value)) {
      errors.push({ field: required, message: "Select a source field for this required event property." });
    } else if (!validFieldPath(value[required])) {
      errors.push({ field: required, message: "Use a valid source field path with at most eight dot-separated parts." });
    }
  }

  for (const optional of ["sourceRecordId", "assetKey"] as const) {
    if (optional in value && !validFieldPath(value[optional])) {
      errors.push({ field: optional, message: "Use a valid source field path with at most eight dot-separated parts." });
    }
  }

  if ("payload" in value) {
    if (!isPlainObject(value.payload)) {
      errors.push({ field: "payload", message: "Payload mappings must be an object of output names and source paths." });
    } else {
      const payloadEntries = Object.entries(value.payload).sort(([left], [right]) => left.localeCompare(right));
      if (payloadEntries.length > MAX_PAYLOAD_MAPPINGS) {
        errors.push({ field: "payload", message: `Use no more than ${MAX_PAYLOAD_MAPPINGS} payload mappings.` });
      }
      for (const [target, sourcePath] of payloadEntries) {
        if (!validPayloadKey(target)) {
          errors.push({ field: `payload.${target}`, message: "Use a safe output name of at most 120 characters." });
        }
        if (!validFieldPath(sourcePath)) {
          errors.push({ field: `payload.${target}`, message: "Use a valid source field path with at most eight dot-separated parts." });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function readMappedField(record: JsonObject, fieldPath: string): unknown {
  let current: unknown = record;
  for (const part of fieldPath.split(".")) {
    if (!isPlainObject(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

export interface ActiveEventMapping {
  version: number;
  definition: EventMappingDefinition;
}

function mappingRecordFailure(message: string, fields?: Record<string, string>): ApiFailure {
  return new ApiFailure(400, "INVALID_IMPORT_RECORD", message, fields);
}

export async function normalizeMappedEvent(
  db: Kysely<Database>,
  sourceId: string,
  rawRecord: JsonObject,
  basePayload: JsonObject,
  mapping: ActiveEventMapping,
  fallbackDeduplicationKey: string,
  provenance: JsonObject,
): Promise<JsonObject> {
  const { definition, version } = mapping;
  const eventType = readMappedField(rawRecord, definition.eventType!);
  const occurredAt = readMappedField(rawRecord, definition.occurredAt!);
  if (typeof eventType !== "string" || !eventType.trim()) {
    throw mappingRecordFailure("The mapped event type is missing or is not a non-empty string.", {
      eventType: `Provide a value in the mapped source field ${definition.eventType}.`,
    });
  }
  if (typeof occurredAt !== "string" || !occurredAt.trim()) {
    throw mappingRecordFailure("The mapped occurrence timestamp is missing or is not a non-empty string.", {
      occurredAt: `Provide a value in the mapped source field ${definition.occurredAt}.`,
    });
  }

  let sourceRecordId: string | undefined;
  if (definition.sourceRecordId) {
    const value = readMappedField(rawRecord, definition.sourceRecordId);
    if (value !== undefined && value !== null && value !== "") {
      if (typeof value !== "string") {
        throw mappingRecordFailure("The mapped source-record ID must be a string.", {
          sourceRecordId: "Provide a string value or leave the field blank.",
        });
      }
      sourceRecordId = value;
    }
  }

  let assetId: string | undefined;
  if (definition.assetKey) {
    const value = readMappedField(rawRecord, definition.assetKey);
    if (value !== undefined && value !== null && value !== "") {
      if (typeof value !== "string") {
        throw mappingRecordFailure("The mapped asset key must be a string.", {
          assetKey: "Provide an exact registered asset key or leave the field blank.",
        });
      }
      const asset = await db
        .selectFrom("assets")
        .select(["id", "archived_at"])
        .where("asset_key", "=", value)
        .executeTakeFirst();
      if (!asset || asset.archived_at !== null) {
        throw mappingRecordFailure("The mapped asset key does not identify an active registered asset.", {
          assetKey: "Use an exact active asset key from the registry.",
        });
      }
      assetId = asset.id;
    }
  }

  const payload = { ...basePayload };
  for (const [target, sourcePath] of Object.entries(definition.payload ?? {})) {
    const value = readMappedField(rawRecord, sourcePath);
    if (value === undefined) {
      throw mappingRecordFailure("A configured payload source field is missing.", {
        [`payload.${target}`]: `Provide a value in the mapped source field ${sourcePath}.`,
      });
    }
    if (Object.hasOwn(payload, target) && !isDeepStrictEqual(payload[target], value)) {
      throw mappingRecordFailure("A mapped payload field conflicts with an existing payload value.", {
        [`payload.${target}`]: "Rename the output field or remove the conflicting source payload key.",
      });
    }
    Object.defineProperty(payload, target, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return {
    sourceId,
    eventType,
    occurredAt,
    sourceTimestamp: occurredAt,
    ...(assetId ? { assetId } : {}),
    ...(sourceRecordId !== undefined ? { sourceRecordId } : {}),
    deduplicationKey: sourceRecordId?.trim() ? sourceRecordId : fallbackDeduplicationKey,
    payload,
    provenance: { ...provenance, mappingVersion: version, originalRecord: rawRecord },
  };
}

export async function getActiveEventMapping(
  db: Kysely<Database>,
  sourceId: string,
): Promise<ActiveEventMapping | undefined> {
  const row = await db
    .selectFrom("data_source_event_mappings")
    .select(["version", "definition"])
    .where("source_id", "=", sourceId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!row) return undefined;
  const validation = validateEventMappingDefinition(row.definition);
  if (!validation.valid) {
    throw new ApiFailure(409, "ACTIVE_MAPPING_INVALID", "The active event mapping failed validation.");
  }
  return {
    version: row.version,
    definition: row.definition as unknown as EventMappingDefinition,
  };
}

function toMappingRecord(row: {
  id: string;
  source_id: string;
  version: number;
  status: EventMappingStatus;
  definition: JsonObject;
  validation_errors: EventMappingValidationError[];
  validated_at: Date | null;
  activated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): DataSourceEventMapping {
  return {
    id: row.id,
    sourceId: row.source_id,
    version: row.version,
    status: row.status,
    definition: row.definition,
    validationErrors: row.validation_errors,
    validatedAt: row.validated_at?.toISOString() ?? null,
    activatedAt: row.activated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function requireMappingSource(
  db: Kysely<Database> | Transaction<Database>,
  sourceId: string,
): Promise<void> {
  const source = await db
    .selectFrom("data_sources")
    .select(["id", "source_type"])
    .where("id", "=", sourceId)
    .executeTakeFirst();
  if (!source) throw new ApiFailure(404, "NOT_FOUND", "Data source not found.");
  if (source.source_type !== "csv_file" && source.source_type !== "json_file" && source.source_type !== "rest_api") {
    throw new ApiFailure(400, "UNSUPPORTED_SOURCE_TYPE", "Event mappings support CSV, JSON, and REST API sources.");
  }
}

function requireUuid(value: string): void {
  if (!uuidPattern.test(value)) {
    throw new ApiFailure(400, "INVALID_ID", "A valid data-source identifier is required.");
  }
}

function parseVersion(value: string): number {
  if (!/^[1-9]\d{0,8}$/.test(value)) {
    throw new ApiFailure(400, "INVALID_VERSION", "A positive mapping version is required.");
  }
  return Number(value);
}

function parseDefinitionBody(body: unknown): JsonObject {
  if (!isPlainObject(body) || !isPlainObject(body.definition)) {
    throw new ApiFailure(400, "INVALID_MAPPING", "Provide a JSON object in the definition field.");
  }
  const serialized = JSON.stringify(body.definition);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DEFINITION_BYTES) {
    throw new ApiFailure(413, "MAPPING_TOO_LARGE", `Mapping definitions are limited to ${MAX_DEFINITION_BYTES} bytes.`);
  }
  return body.definition as JsonObject;
}

function assertNoBody(body: unknown): void {
  if (body !== undefined) {
    throw new ApiFailure(400, "REQUEST_BODY_NOT_ALLOWED", "This mapping action does not accept a request body.");
  }
}

function notDraft(): ApiFailure {
  return new ApiFailure(409, "MAPPING_NOT_DRAFT", "Only a draft mapping can be changed or validated.");
}

export function registerEventMappingRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.get<{ Params: { id: string } }>("/api/v1/data-sources/:id/mappings", async (request) => {
    requireUuid(request.params.id);
    await requireMappingSource(db, request.params.id);
    const rows = await db
      .selectFrom("data_source_event_mappings")
      .selectAll()
      .where("source_id", "=", request.params.id)
      .orderBy("version", "desc")
      .execute();
    return { items: rows.map(toMappingRecord) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/data-sources/:id/mappings", async (request, reply) => {
    requireUuid(request.params.id);
    const definition = parseDefinitionBody(request.body);
    const row = await db.transaction().execute(async (transaction) => {
      await lockSqliteWrite(transaction);
      const sourceQuery = transaction
        .selectFrom("data_sources")
        .select(["id", "source_type"])
        .where("id", "=", request.params.id);
      const source = isSqliteDatabase(transaction)
        ? await sourceQuery.executeTakeFirst()
        : await sourceQuery.forUpdate().executeTakeFirst();
      if (!source) throw new ApiFailure(404, "NOT_FOUND", "Data source not found.");
      if (source.source_type !== "csv_file" && source.source_type !== "json_file" && source.source_type !== "rest_api") {
        throw new ApiFailure(400, "UNSUPPORTED_SOURCE_TYPE", "Event mappings support CSV, JSON, and REST API sources.");
      }
      const existingDraft = await transaction
        .selectFrom("data_source_event_mappings")
        .select("id")
        .where("source_id", "=", source.id)
        .where("status", "=", "draft")
        .executeTakeFirst();
      if (existingDraft) {
        throw new ApiFailure(409, "MAPPING_DRAFT_EXISTS", "Update or activate the existing draft before creating another mapping version.");
      }
      const latest = await transaction
        .selectFrom("data_source_event_mappings")
        .select("version")
        .where("source_id", "=", source.id)
        .orderBy("version", "desc")
        .limit(1)
        .executeTakeFirst();
      return transaction
        .insertInto("data_source_event_mappings")
        .values({
          id: randomUUID(),
          source_id: source.id,
          version: (latest?.version ?? 0) + 1,
          status: "draft",
          definition: JSON.stringify(definition),
          validation_errors: "[]",
          validated_at: null,
          activated_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return reply.code(201).send({ mapping: toMappingRecord(row) });
  });

  app.put<{ Params: { id: string; version: string }; Body: unknown }>(
    "/api/v1/data-sources/:id/mappings/:version",
    async (request) => {
      requireUuid(request.params.id);
      const version = parseVersion(request.params.version);
      const definition = parseDefinitionBody(request.body);
    await requireMappingSource(db, request.params.id);
      const row = await db
        .updateTable("data_source_event_mappings")
        .set({
          definition: JSON.stringify(definition),
          validation_errors: "[]",
          validated_at: null,
          updated_at: new Date(),
        })
        .where("source_id", "=", request.params.id)
        .where("version", "=", version)
        .where("status", "=", "draft")
        .returningAll()
        .executeTakeFirst();
      if (!row) {
        const exists = await db
          .selectFrom("data_source_event_mappings")
          .select("id")
          .where("source_id", "=", request.params.id)
          .where("version", "=", version)
          .executeTakeFirst();
        if (!exists) throw new ApiFailure(404, "NOT_FOUND", "Mapping version not found.");
        throw notDraft();
      }
      return { mapping: toMappingRecord(row) };
    },
  );

  app.post<{ Params: { id: string; version: string }; Body: unknown }>(
    "/api/v1/data-sources/:id/mappings/:version/validate",
    async (request) => {
      requireUuid(request.params.id);
      const version = parseVersion(request.params.version);
      assertNoBody(request.body);
    await requireMappingSource(db, request.params.id);
      const outcome = await db.transaction().execute(async (transaction) => {
        await lockSqliteWrite(transaction);
        const rowQuery = transaction
          .selectFrom("data_source_event_mappings")
          .selectAll()
          .where("source_id", "=", request.params.id)
          .where("version", "=", version);
        const row = isSqliteDatabase(transaction)
          ? await rowQuery.executeTakeFirst()
          : await rowQuery.forUpdate().executeTakeFirst();
        if (!row) throw new ApiFailure(404, "NOT_FOUND", "Mapping version not found.");
        if (row.status !== "draft") throw notDraft();
        const validation = validateEventMappingDefinition(row.definition);
        const updated = await transaction
          .updateTable("data_source_event_mappings")
          .set({
            validation_errors: JSON.stringify(validation.errors),
            validated_at: validation.valid ? new Date() : null,
            updated_at: new Date(),
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { mapping: toMappingRecord(updated), validation };
      });
      return {
        mapping: outcome.mapping,
        valid: outcome.validation.valid,
        errors: outcome.validation.errors,
      };
    },
  );

  app.post<{ Params: { id: string; version: string }; Body: unknown }>(
    "/api/v1/data-sources/:id/mappings/:version/activate",
    async (request) => {
      requireUuid(request.params.id);
      const version = parseVersion(request.params.version);
      assertNoBody(request.body);
      await requireMappingSource(db, request.params.id);
      const outcome = await db.transaction().execute(async (transaction) => {
        await lockSqliteWrite(transaction);
        const rowQuery = transaction
          .selectFrom("data_source_event_mappings")
          .selectAll()
          .where("source_id", "=", request.params.id)
          .where("version", "=", version);
        const row = isSqliteDatabase(transaction)
          ? await rowQuery.executeTakeFirst()
          : await rowQuery.forUpdate().executeTakeFirst();
        if (!row) throw new ApiFailure(404, "NOT_FOUND", "Mapping version not found.");
        if (row.status !== "draft") throw notDraft();

        const validation = validateEventMappingDefinition(row.definition);
        if (!validation.valid) {
          const updated = await transaction
            .updateTable("data_source_event_mappings")
            .set({
              validation_errors: JSON.stringify(validation.errors),
              validated_at: null,
              updated_at: new Date(),
            })
            .where("id", "=", row.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          return { mapping: toMappingRecord(updated), errors: validation.errors };
        }
        if (!row.validated_at || row.validation_errors.length > 0) {
          throw new ApiFailure(409, "MAPPING_NOT_VALIDATED", "Validate this mapping before activating it.");
        }

        const activatedAt = new Date();
        await transaction
          .updateTable("data_source_event_mappings")
          .set({ status: "retired", updated_at: activatedAt })
          .where("source_id", "=", row.source_id)
          .where("status", "=", "active")
          .execute();
        const activated = await transaction
          .updateTable("data_source_event_mappings")
          .set({ status: "active", activated_at: activatedAt, updated_at: activatedAt })
          .where("id", "=", row.id)
          .where("status", "=", "draft")
          .returningAll()
          .executeTakeFirstOrThrow();
        return { mapping: toMappingRecord(activated), errors: null };
      });
      if (outcome.errors) {
        throw new ApiFailure(400, "MAPPING_INVALID", "Correct the mapping validation errors before activating it.", {
          validation: outcome.errors.map((error) => `${error.field}: ${error.message}`).join(" "),
        });
      }
      return { mapping: outcome.mapping };
    },
  );
}
