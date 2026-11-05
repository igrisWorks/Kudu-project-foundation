import { createHash, randomUUID } from "node:crypto";
import type { EventMappingDefinition, JsonObject } from "@kudu/shared";
import type { Kysely } from "kysely";
import type { Database } from "./database.js";
import { ApiFailure } from "./errors.js";
import { canonicalJson } from "./event-validation.js";
import { ingestEvent } from "./events.js";
import {
  normalizeMappedEvent,
  readMappedField,
  type ActiveEventMapping,
  type AssetMatchContext,
} from "./event-mappings.js";
import { isSqliteDatabase, lockSqliteWrite } from "./sqlite-database.js";

const MAX_SOURCE_RECORD_BYTES = 5 * 1024 * 1024;
const sensitiveName = /password|secret|token|credential|authorization|cookie|api.?key|private.?key|bearer/i;

export interface SourceRecordInput {
  sourceId: string;
  sourceRecordId?: string | null;
  deduplicationKey: string;
  rawRecord: JsonObject;
  provenance: JsonObject;
  syncRunId?: string | null;
  mappingVersion?: number | null;
}

export interface StoredSourceRecord {
  id: string;
  duplicate: boolean;
  normalizedEventId: string | null;
}

export function sourceRecordIdentity(
  rawRecord: JsonObject,
  definition: EventMappingDefinition | undefined,
  fallbackKey: string,
): { sourceRecordId: string | null; deduplicationKey: string } {
  const path = definition?.sourceRecordId;
  if (path) {
    const value = readMappedField(rawRecord, path);
    if (
      (typeof value === "string" && value.trim().length > 0 && value.length <= 256) ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      const sourceRecordId = String(value);
      return { sourceRecordId, deduplicationKey: sourceRecordId };
    }
  }
  return { sourceRecordId: null, deduplicationKey: fallbackKey };
}

function contentFingerprint(rawRecord: JsonObject): string {
  return createHash("sha256").update(canonicalJson(rawRecord)).digest("hex");
}

function sourceRecordSummary(rawRecord: JsonObject): {
  fieldCount: number;
  fieldNames: string[];
  preview: Record<string, string>;
} {
  const entries = Object.entries(rawRecord);
  const preview: Record<string, string> = {};
  for (const [key, value] of entries.slice(0, 8)) {
    if (sensitiveName.test(key)) {
      preview[key] = "[hidden]";
    } else if (value === null) {
      preview[key] = "null";
    } else if (Array.isArray(value)) {
      preview[key] = `Array · ${value.length}`;
    } else if (typeof value === "object") {
      preview[key] = "Object";
    } else {
      const text = String(value);
      preview[key] = text.length > 96 ? `${text.slice(0, 96)}…` : text;
    }
  }
  return { fieldCount: entries.length, fieldNames: entries.slice(0, 1_000).map(([key]) => key), preview };
}

export async function storeSourceRecord(
  db: Kysely<Database>,
  input: SourceRecordInput,
): Promise<StoredSourceRecord> {
  if (
    !input.deduplicationKey.trim() ||
    input.deduplicationKey.length > 256 ||
    !isJsonObject(input.rawRecord) ||
    !isJsonObject(input.provenance)
  ) {
    throw new ApiFailure(400, "SOURCE_RECORD_INVALID", "The source record is not a valid JSON object.");
  }
  const rawJson = JSON.stringify(input.rawRecord);
  const provenanceJson = JSON.stringify(input.provenance);
  if (Buffer.byteLength(rawJson, "utf8") > MAX_SOURCE_RECORD_BYTES) {
    throw new ApiFailure(413, "SOURCE_RECORD_TOO_LARGE", "A single source record exceeded the supported size limit.");
  }
  const fingerprint = contentFingerprint(input.rawRecord);
  const summary = sourceRecordSummary(input.rawRecord);
  return db.transaction().execute(async (transaction) => {
    if (isSqliteDatabase(transaction)) await lockSqliteWrite(transaction);
    const inserted = await transaction.insertInto("source_records").values({
      id: randomUUID(),
      source_id: input.sourceId,
      source_record_id: input.sourceRecordId ?? null,
      deduplication_key: input.deduplicationKey,
      ingestion_fingerprint: fingerprint,
      raw_record: rawJson,
      raw_bytes: Buffer.byteLength(rawJson, "utf8"),
      field_count: summary.fieldCount,
      field_names: JSON.stringify(summary.fieldNames),
      preview: JSON.stringify(summary.preview),
      provenance: provenanceJson,
      processing_status: "raw_only",
      normalized_event_id: null,
      sync_run_id: input.syncRunId ?? null,
      mapping_version: input.mappingVersion ?? null,
    }).onConflict((conflict) => conflict.columns(["source_id", "deduplication_key"]).doNothing())
      .returning(["id", "normalized_event_id"])
      .executeTakeFirst();
    if (inserted) {
      return { id: inserted.id, duplicate: false, normalizedEventId: inserted.normalized_event_id };
    }

    const existing = await transaction.selectFrom("source_records")
      .select(["id", "ingestion_fingerprint", "normalized_event_id"])
      .where("source_id", "=", input.sourceId)
      .where("deduplication_key", "=", input.deduplicationKey)
      .executeTakeFirst();
    if (!existing) throw new Error("Source-record conflict did not resolve to an existing record.");
    if (existing.ingestion_fingerprint !== fingerprint) {
      throw new ApiFailure(
        409,
        "SOURCE_RECORD_CONFLICT",
        "This source-record key is already used for different original data.",
      );
    }
    return { id: existing.id, duplicate: true, normalizedEventId: existing.normalized_event_id };
  });
}

export async function linkNormalizedEvent(
  db: Kysely<Database>,
  sourceRecordId: string,
  eventId: string,
  mappingVersion: number | null,
): Promise<void> {
  await db.updateTable("source_records")
    .set({
      processing_status: "normalized",
      normalized_event_id: eventId,
      ...(mappingVersion !== null ? { mapping_version: mappingVersion } : {}),
    })
    .where("id", "=", sourceRecordId)
    .execute();
}

export async function normalizeAndLinkSourceRecord(
  db: Kysely<Database>,
  stored: StoredSourceRecord,
  input: {
    sourceId: string;
    rawRecord: JsonObject;
    basePayload: JsonObject;
    fallbackDeduplicationKey: string;
    mapping?: Pick<ActiveEventMapping, "definition"> & { version?: number };
    provenance: JsonObject;
    assetMatchContext?: AssetMatchContext;
    sourceTimezone?: string;
  },
): Promise<string | null> {
  if (!input.mapping?.definition.eventType || !input.mapping.definition.occurredAt) return null;
  if (stored.normalizedEventId) return stored.normalizedEventId;
  try {
    const normalized = await normalizeMappedEvent(
      db,
      input.sourceId,
      input.rawRecord,
      input.basePayload,
      input.mapping,
      input.fallbackDeduplicationKey,
      input.provenance,
      input.assetMatchContext,
      input.sourceTimezone,
    );
    const result = await ingestEvent(db, normalized);
    await linkNormalizedEvent(db, stored.id, result.event.id, input.mapping?.version ?? null);
    return result.event.id;
  } catch (error) {
    throw error;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
