import {
  ASSET_TYPES,
  type AssetChildSummary,
  type AssetDetail,
  type AssetParentSummary,
  type AssetRecord,
  type AssetStatusFilter,
  type AssetType,
  type DataSourceConfigurationInput,
  type DataSourceConfigurationMetadata,
  type DataSourceEnabledFilter,
  type DataSourceRecord,
  type DataSourceType,
  type ExternalIdentifier,
  type Page,
} from "@kudu/shared";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Database, StoredSourceConfiguration } from "./database.js";
import { ApiFailure } from "./errors.js";
import { isSqliteDatabase, lockSqliteWrite } from "./sqlite-database.js";
import {
  validateAssetCreate,
  validateAssetUpdate,
  validateDataSourceCreate,
  validateDataSourceUpdate,
  validateUuidParameter,
} from "./registry-validation.js";

const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;
const MAX_PAGE = 1_000_000;

interface AssetJoinRow {
  id: string;
  asset_key: string;
  name: string;
  asset_type: AssetType;
  description: string | null;
  parent_asset_id: string | null;
  external_identifiers: ExternalIdentifier[];
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  parent_id: string | null;
  parent_asset_key: string | null;
  parent_name: string | null;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toAssetRecord(row: AssetJoinRow): AssetRecord {
  const parentAsset: AssetParentSummary | null =
    row.parent_id === null
      ? null
      : {
          id: row.parent_id,
          assetKey: row.parent_asset_key ?? "",
          name: row.parent_name ?? "",
        };
  return {
    id: row.id,
    assetKey: row.asset_key,
    name: row.name,
    assetType: row.asset_type,
    description: row.description,
    parentAssetId: row.parent_asset_id,
    parentAsset,
    externalIdentifiers: row.external_identifiers,
    status: row.archived_at === null ? "active" : "archived",
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: iso(row.archived_at),
  };
}

const assetProjection = [
  "a.id as id",
  "a.asset_key as asset_key",
  "a.name as name",
  "a.asset_type as asset_type",
  "a.description as description",
  "a.parent_asset_id as parent_asset_id",
  "a.external_identifiers as external_identifiers",
  "a.created_at as created_at",
  "a.updated_at as updated_at",
  "a.archived_at as archived_at",
  "p.id as parent_id",
  "p.asset_key as parent_asset_key",
  "p.name as parent_name",
] as const;

function searchPattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, "\\$&")}%`;
}

function caseInsensitiveLike(db: Kysely<Database>, column: string, pattern: string) {
  return isSqliteDatabase(db)
    ? sql<boolean>`lower(${sql.ref(column)}) LIKE lower(${pattern}) ESCAPE char(92)`
    : sql<boolean>`lower(${sql.ref(column)}) LIKE lower(${pattern}) ESCAPE chr(92)`;
}

function queryString(query: unknown, field: string): string | undefined {
  if (typeof query !== "object" || query === null || !(field in query)) return undefined;
  const value = (query as Record<string, unknown>)[field];
  if (typeof value !== "string") {
    throw new ApiFailure(400, "INVALID_QUERY", `Query parameter ${field} must be a single string.`);
  }
  return value;
}

function positiveInteger(value: string | undefined, field: string, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ApiFailure(400, "INVALID_QUERY", `Query parameter ${field} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ApiFailure(400, "INVALID_QUERY", `Query parameter ${field} must be between 1 and ${max}.`);
  }
  return parsed;
}

function listParameters(query: unknown) {
  const search = queryString(query, "search")?.trim() ?? "";
  if (search.length > 120) {
    throw new ApiFailure(400, "INVALID_QUERY", "Search must be 120 characters or fewer.");
  }
  return {
    search,
    page: positiveInteger(queryString(query, "page"), "page", 1, MAX_PAGE),
    pageSize: positiveInteger(queryString(query, "pageSize"), "pageSize", PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX),
  };
}

function assetStatusFilter(query: unknown): AssetStatusFilter {
  const status = queryString(query, "status") ?? "active";
  if (status !== "active" && status !== "archived" && status !== "all") {
    throw new ApiFailure(400, "INVALID_QUERY", "Status must be active, archived, or all.");
  }
  return status;
}

function assetTypeFilter(query: unknown): AssetType | undefined {
  const assetType = queryString(query, "assetType");
  if (assetType === undefined || assetType === "") return undefined;
  if (!ASSET_TYPES.includes(assetType as AssetType)) {
    throw new ApiFailure(400, "INVALID_QUERY", "Asset type is not supported.");
  }
  return assetType as AssetType;
}

function dataSourceTypeFilter(query: unknown): DataSourceType | undefined {
  const type = queryString(query, "sourceType");
  if (type === undefined || type === "") return undefined;
  if (type !== "rest_api" && type !== "json_file" && type !== "csv_file" && type !== "manual") {
    throw new ApiFailure(400, "INVALID_QUERY", "Source type is not supported.");
  }
  return type;
}

function enabledFilter(query: unknown): DataSourceEnabledFilter {
  const enabled = queryString(query, "enabled") ?? "all";
  if (enabled !== "all" && enabled !== "enabled" && enabled !== "disabled") {
    throw new ApiFailure(400, "INVALID_QUERY", "Enabled filter must be all, enabled, or disabled.");
  }
  return enabled;
}

function toPage<T>(items: T[], totalValue: number | string, page: number, pageSize: number): Page<T> {
  return { items, total: Number(totalValue), page, pageSize };
}

function sourceConfigurationMetadata(
  sourceType: DataSourceType,
  configuration: StoredSourceConfiguration,
): DataSourceConfigurationMetadata {
  if (configuration.kind !== sourceType) {
    throw new Error("Stored source type does not match its configuration.");
  }
  switch (configuration.kind) {
    case "rest_api":
      return {
        kind: "rest_api",
        baseUrl: configuration.baseUrl,
        credentialConfigured: Boolean(configuration.credentialRef),
        ...(configuration.endpointPath !== undefined ? { endpointPath: configuration.endpointPath } : {}),
        ...(configuration.method !== undefined ? { method: configuration.method } : {}),
        ...(configuration.authMode !== undefined ? { authMode: configuration.authMode } : {}),
        ...(configuration.timeoutMs !== undefined ? { timeoutMs: configuration.timeoutMs } : {}),
        ...(configuration.maxResponseBytes !== undefined ? { maxResponseBytes: configuration.maxResponseBytes } : {}),
        ...(configuration.maxRecords !== undefined ? { maxRecords: configuration.maxRecords } : {}),
        ...(configuration.responseFormat !== undefined ? { responseFormat: configuration.responseFormat } : {}),
        ...(configuration.recordsPath !== undefined ? { recordsPath: configuration.recordsPath } : {}),
        ...(configuration.pagination !== undefined ? { pagination: configuration.pagination } : {}),
      };
    case "json_file":
      return {
        kind: "json_file",
        relativePath: configuration.relativePath,
        ...(configuration.recordsPath ? { recordsPath: configuration.recordsPath } : {}),
      };
    case "csv_file":
      return { kind: configuration.kind, relativePath: configuration.relativePath };
    case "manual":
      return { kind: "manual", referenceOnly: true };
  }
}

function toDataSourceRecord(row: {
  id: string;
  source_key: string;
  display_name: string;
  source_type: DataSourceType;
  description: string | null;
  configuration: StoredSourceConfiguration;
  enabled: boolean;
  connection_status: DataSourceRecord["connectionStatus"];
  ingestion_status: DataSourceRecord["ingestionStatus"];
  last_successful_sync_at: Date | null;
  last_error_summary: string | null;
  created_at: Date;
  updated_at: Date;
}): DataSourceRecord {
  return {
    id: row.id,
    sourceKey: row.source_key,
    displayName: row.display_name,
    sourceType: row.source_type,
    description: row.description,
    configuration: sourceConfigurationMetadata(row.source_type, row.configuration),
    enabled: row.enabled,
    connectionStatus: row.connection_status,
    ingestionStatus: row.ingestion_status,
    lastSuccessfulSyncAt: iso(row.last_successful_sync_at),
    lastErrorSummary: row.last_error_summary,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mergeRestCredential(
  incoming: DataSourceConfigurationInput,
  current: StoredSourceConfiguration | undefined,
): StoredSourceConfiguration {
  if (incoming.kind !== "rest_api") return incoming;
  const currentReference =
    current?.kind === "rest_api" ? current.credentialRef : undefined;
  const { credentialRef, ...configuration } = incoming;
  let merged: StoredSourceConfiguration;
  if (!Object.hasOwn(incoming, "credentialRef")) {
    merged = {
      ...configuration,
      ...(currentReference ? { credentialRef: currentReference } : {}),
    };
  } else {
    merged = {
      ...configuration,
      ...(credentialRef ? { credentialRef } : {}),
    };
  }
  if (merged.kind === "rest_api" && merged.authMode === "bearer" && !merged.credentialRef) {
    throw new ApiFailure(400, "VALIDATION_ERROR", "A bearer token environment reference is required.", {
      "configuration.credentialRef": "Set a credential reference or select no authentication.",
    });
  }
  return merged;
}

async function ensureParent(
  db: Kysely<Database>,
  parentAssetId: string | null,
  assetId?: string,
): Promise<void> {
  if (!parentAssetId) return;
  if (assetId && parentAssetId === assetId) {
    throw new ApiFailure(400, "PARENT_CYCLE", "An asset cannot be its own parent.");
  }
  const parent = await db
    .selectFrom("assets")
    .select(["id", "archived_at"])
    .where("id", "=", parentAssetId)
    .executeTakeFirst();
  if (!parent) {
    throw new ApiFailure(400, "INVALID_PARENT", "The selected parent asset does not exist.");
  }
  if (parent.archived_at) {
    throw new ApiFailure(400, "INVALID_PARENT", "An archived asset cannot be selected as a new parent.");
  }
  if (assetId) {
    const cycle = await sql<{ id: string }>`
      WITH RECURSIVE descendants(id) AS (
      SELECT id FROM assets WHERE parent_asset_id = ${assetId}
        UNION
        SELECT child.id
        FROM assets AS child
        INNER JOIN descendants AS parent ON child.parent_asset_id = parent.id
      )
      SELECT id FROM descendants WHERE id = ${parentAssetId} LIMIT 1
    `.execute(db);
    if (cycle.rows.length > 0) {
      throw new ApiFailure(400, "PARENT_CYCLE", "The selected parent would create an asset hierarchy cycle.");
    }
  }
}

async function getAssetDetail(db: Kysely<Database>, id: string): Promise<AssetDetail> {
  const row = await db
    .selectFrom("assets as a")
    .leftJoin("assets as p", "p.id", "a.parent_asset_id")
    .select(assetProjection)
    .where("a.id", "=", id)
    .executeTakeFirst();
  if (!row) throw new ApiFailure(404, "NOT_FOUND", "Asset not found.");
  const children = await db
    .selectFrom("assets")
    .select(["id", "asset_key", "name", "asset_type"])
    .where("parent_asset_id", "=", id)
    .orderBy("asset_key", "asc")
    .orderBy("id", "asc")
    .execute();
  const result = toAssetRecord(row as AssetJoinRow);
  const childSummaries: AssetChildSummary[] = children.map((child) => ({
    id: child.id,
    assetKey: child.asset_key,
    name: child.name,
    assetType: child.asset_type,
  }));
  return { ...result, children: childSummaries };
}

async function getDataSourceDetail(db: Kysely<Database>, id: string): Promise<DataSourceRecord> {
  const row = await db
    .selectFrom("data_sources")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new ApiFailure(404, "NOT_FOUND", "Data source not found.");
  return toDataSourceRecord(row);
}

async function listAssets(
  db: Kysely<Database>,
  query: unknown,
): Promise<Page<AssetRecord>> {
  const { search, page, pageSize } = listParameters(query);
  const status = assetStatusFilter(query);
  const assetType = assetTypeFilter(query);
  let rowsQuery = db
    .selectFrom("assets as a")
    .leftJoin("assets as p", "p.id", "a.parent_asset_id")
    .select(assetProjection);
  let countQuery = db.selectFrom("assets").select((eb) => eb.fn.countAll<number>().as("total"));

  if (status === "active") {
    rowsQuery = rowsQuery.where("a.archived_at", "is", null);
    countQuery = countQuery.where("archived_at", "is", null);
  } else if (status === "archived") {
    rowsQuery = rowsQuery.where("a.archived_at", "is not", null);
    countQuery = countQuery.where("archived_at", "is not", null);
  }
  if (assetType) {
    rowsQuery = rowsQuery.where("a.asset_type", "=", assetType);
    countQuery = countQuery.where("asset_type", "=", assetType);
  }
  if (search) {
    const pattern = searchPattern(search);
    rowsQuery = rowsQuery.where((eb) =>
      eb.or([
        caseInsensitiveLike(db, "a.asset_key", pattern),
        caseInsensitiveLike(db, "a.name", pattern),
      ]),
    );
    countQuery = countQuery.where((eb) =>
      eb.or([
        caseInsensitiveLike(db, "asset_key", pattern),
        caseInsensitiveLike(db, "name", pattern),
      ]),
    );
  }

  const [rows, total] = await Promise.all([
    rowsQuery
      .orderBy("a.asset_key", "asc")
      .orderBy("a.id", "asc")
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute(),
    countQuery.executeTakeFirstOrThrow(),
  ]);
  return toPage(rows.map((row) => toAssetRecord(row as AssetJoinRow)), total.total, page, pageSize);
}

async function listDataSources(
  db: Kysely<Database>,
  query: unknown,
): Promise<Page<DataSourceRecord>> {
  const { search, page, pageSize } = listParameters(query);
  const sourceType = dataSourceTypeFilter(query);
  const enabled = enabledFilter(query);
  let rowsQuery = db.selectFrom("data_sources").selectAll();
  let countQuery = db.selectFrom("data_sources").select((eb) => eb.fn.countAll<number>().as("total"));
  if (sourceType) {
    rowsQuery = rowsQuery.where("source_type", "=", sourceType);
    countQuery = countQuery.where("source_type", "=", sourceType);
  }
  if (enabled !== "all") {
    const enabledValue = enabled === "enabled";
    rowsQuery = rowsQuery.where("enabled", "=", enabledValue);
    countQuery = countQuery.where("enabled", "=", enabledValue);
  }
  if (search) {
    const pattern = searchPattern(search);
    rowsQuery = rowsQuery.where((eb) =>
      eb.or([
        caseInsensitiveLike(db, "source_key", pattern),
        caseInsensitiveLike(db, "display_name", pattern),
      ]),
    );
    countQuery = countQuery.where((eb) =>
      eb.or([
        caseInsensitiveLike(db, "source_key", pattern),
        caseInsensitiveLike(db, "display_name", pattern),
      ]),
    );
  }
  const [rows, total] = await Promise.all([
    rowsQuery
      .orderBy("display_name", "asc")
      .orderBy("id", "asc")
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute(),
    countQuery.executeTakeFirstOrThrow(),
  ]);
  return toPage(rows.map(toDataSourceRecord), total.total, page, pageSize);
}

export function registerRegistryRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.get("/api/v1/assets", async (request) => listAssets(db, request.query));

  app.post("/api/v1/assets", async (request, reply) => {
    const input = validateAssetCreate(request.body);
    const id = await db.transaction().execute(async (transaction) => {
      if (isSqliteDatabase(transaction)) await lockSqliteWrite(transaction);
      else await sql`SELECT pg_advisory_xact_lock(7224, 2)`.execute(transaction);
      await ensureParent(transaction, input.parentAssetId ?? null);
      const row = await transaction
        .insertInto("assets")
        .values({
          id: randomUUID(),
          asset_key: input.assetKey,
          name: input.name,
          asset_type: input.assetType,
          description: input.description ?? null,
          parent_asset_id: input.parentAssetId ?? null,
          external_identifiers: JSON.stringify(input.externalIdentifiers ?? []),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return row.id;
    });
    return reply.code(201).send(await getAssetDetail(db, id));
  });

  app.get<{ Params: { id: string } }>("/api/v1/assets/:id", async (request) => {
    const id = validateUuidParameter(request.params.id, "asset");
    return getAssetDetail(db, id);
  });

  app.patch<{ Params: { id: string } }>("/api/v1/assets/:id", async (request) => {
    const id = validateUuidParameter(request.params.id, "asset");
    const input = validateAssetUpdate(request.body);
    await db.transaction().execute(async (transaction) => {
      if (isSqliteDatabase(transaction)) await lockSqliteWrite(transaction);
      else await sql`SELECT pg_advisory_xact_lock(7224, 2)`.execute(transaction);
      const currentQuery = () => transaction
        .selectFrom("assets")
        .select(["id", "parent_asset_id"])
        .where("id", "=", id);
      const current = isSqliteDatabase(transaction)
        ? await currentQuery().executeTakeFirst()
        : await currentQuery().forUpdate().executeTakeFirst();
      if (!current) throw new ApiFailure(404, "NOT_FOUND", "Asset not found.");
      if (
        input.parentAssetId !== undefined &&
        input.parentAssetId !== current.parent_asset_id
      ) {
        await ensureParent(transaction, input.parentAssetId, id);
      }

      const update: Record<string, unknown> = { updated_at: new Date() };
      if (input.assetKey !== undefined) update.asset_key = input.assetKey;
      if (input.name !== undefined) update.name = input.name;
      if (input.assetType !== undefined) update.asset_type = input.assetType;
      if (input.description !== undefined) update.description = input.description;
      if (input.parentAssetId !== undefined) update.parent_asset_id = input.parentAssetId;
      if (input.externalIdentifiers !== undefined) {
        update.external_identifiers = JSON.stringify(input.externalIdentifiers);
      }
      if (input.archived !== undefined) {
        update.archived_at = input.archived ? new Date() : null;
      }
      await transaction.updateTable("assets").set(update).where("id", "=", id).execute();
    });
    return getAssetDetail(db, id);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/assets/:id", async (request) => {
    const id = validateUuidParameter(request.params.id, "asset");
    return db.transaction().execute(async (transaction) => {
      if (isSqliteDatabase(transaction)) await lockSqliteWrite(transaction);
      else await sql`SELECT pg_advisory_xact_lock(7224, 2)`.execute(transaction);

      const assetQuery = () => transaction
        .selectFrom("assets")
        .select("id")
        .where("id", "=", id);
      const asset = isSqliteDatabase(transaction)
        ? await assetQuery().executeTakeFirst()
        : await assetQuery().forUpdate().executeTakeFirst();
      if (!asset) throw new ApiFailure(404, "NOT_FOUND", "Asset not found.");

      const childCount = await transaction
        .selectFrom("assets")
        .select((eb) => eb.fn.countAll<number>().as("total"))
        .where("parent_asset_id", "=", id)
        .executeTakeFirstOrThrow();
      if (Number(childCount.total) > 0) {
        throw new ApiFailure(
          409,
          "ASSET_HAS_CHILDREN",
          "This asset has child assets. Reassign or remove those child references before deleting it.",
        );
      }

      const eventCount = await transaction
        .selectFrom("events")
        .select((eb) => eb.fn.countAll<number>().as("total"))
        .where("asset_id", "=", id)
        .executeTakeFirstOrThrow();
      await transaction.deleteFrom("assets").where("id", "=", id).execute();
      return { outcome: "deleted" as const, eventsUnassigned: Number(eventCount.total) };
    });
  });

  app.get("/api/v1/data-sources", async (request) => listDataSources(db, request.query));

  app.post("/api/v1/data-sources", async (request, reply) => {
    const input = validateDataSourceCreate(request.body);
    const storedConfiguration = mergeRestCredential(input.configuration, undefined);
    const row = await db
      .insertInto("data_sources")
      .values({
        id: randomUUID(),
        source_key: input.sourceKey,
        display_name: input.displayName,
        source_type: input.sourceType,
        description: input.description ?? null,
        configuration: JSON.stringify(storedConfiguration),
        enabled: input.enabled ?? true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return reply.code(201).send(await getDataSourceDetail(db, row.id));
  });

  app.get<{ Params: { id: string } }>("/api/v1/data-sources/:id", async (request) => {
    const id = validateUuidParameter(request.params.id, "data source");
    return getDataSourceDetail(db, id);
  });

  app.patch<{ Params: { id: string } }>("/api/v1/data-sources/:id", async (request) => {
    const id = validateUuidParameter(request.params.id, "data source");
    const input = validateDataSourceUpdate(request.body);
    const current = await db
      .selectFrom("data_sources")
      .select(["id", "source_type", "configuration"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!current) throw new ApiFailure(404, "NOT_FOUND", "Data source not found.");

    const nextType = input.sourceType ?? input.configuration?.kind ?? current.source_type;
    if (input.configuration && input.configuration.kind !== nextType) {
      throw new ApiFailure(
        400,
        "VALIDATION_ERROR",
        "Configuration type must match the selected source type.",
        { configuration: "Choose configuration fields for the selected source type." },
      );
    }
    if (nextType !== current.source_type && !input.configuration) {
      throw new ApiFailure(
        400,
        "VALIDATION_ERROR",
        "A configuration is required when changing the source type.",
        { configuration: "Provide configuration for the new source type." },
      );
    }
    const storedConfiguration = input.configuration
      ? mergeRestCredential(input.configuration, current.configuration)
      : undefined;
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (input.sourceKey !== undefined) update.source_key = input.sourceKey;
    if (input.displayName !== undefined) update.display_name = input.displayName;
    if (input.sourceType !== undefined || input.configuration !== undefined) {
      update.source_type = nextType;
    }
    if (input.description !== undefined) update.description = input.description;
    if (storedConfiguration) update.configuration = JSON.stringify(storedConfiguration);
    if (input.enabled !== undefined) update.enabled = input.enabled;

    await db.updateTable("data_sources").set(update).where("id", "=", id).execute();
    return getDataSourceDetail(db, id);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/data-sources/:id", async (request) => {
    const id = validateUuidParameter(request.params.id, "data source");
    return db.transaction().execute(async (transaction) => {
      if (isSqliteDatabase(transaction)) await lockSqliteWrite(transaction);
      else await sql`SELECT pg_advisory_xact_lock(7224, 1)`.execute(transaction);

      const sourceQuery = () => transaction
        .selectFrom("data_sources")
        .select("id")
        .where("id", "=", id);
      const source = isSqliteDatabase(transaction)
        ? await sourceQuery().executeTakeFirst()
        : await sourceQuery().forUpdate().executeTakeFirst();
      if (!source) throw new ApiFailure(404, "NOT_FOUND", "Data source not found.");

      const [events, mappings, syncRuns] = await Promise.all([
        transaction.selectFrom("events").select((eb) => eb.fn.countAll<number>().as("total"))
          .where("source_id", "=", id).executeTakeFirstOrThrow(),
        transaction.selectFrom("data_source_event_mappings").select((eb) => eb.fn.countAll<number>().as("total"))
          .where("source_id", "=", id).executeTakeFirstOrThrow(),
        transaction.selectFrom("data_source_sync_runs").select((eb) => eb.fn.countAll<number>().as("total"))
          .where("source_id", "=", id).executeTakeFirstOrThrow(),
      ]);
      const preserved = {
        events: Number(events.total),
        mappings: Number(mappings.total),
        syncRuns: Number(syncRuns.total),
      };
      const hasHistory = Object.values(preserved).some((count) => count > 0);
      if (hasHistory) {
        await transaction.updateTable("data_sources")
          .set({ enabled: false, updated_at: new Date() })
          .where("id", "=", id)
          .execute();
        return { outcome: "archived" as const, preserved };
      }

      await transaction.deleteFrom("data_sources").where("id", "=", id).execute();
      return { outcome: "deleted" as const, preserved };
    });
  });
}

