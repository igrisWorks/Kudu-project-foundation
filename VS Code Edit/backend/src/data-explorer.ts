import ExcelJS from "exceljs";
import type {
  EventDetail,
  ExplorerEventQuery,
  ExplorerRecordDetail,
  ExplorerRecordPage,
  ExplorerRecordQuery,
  ExplorerRecordSummary,
  ExplorerQualityReport,
  ExplorerSchemaChange,
  ExplorerSourceQuality,
  JsonObject,
  JsonValue,
  Page,
} from "@kudu/shared";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Database, StoredSourceConfiguration } from "./database.js";
import { ApiFailure } from "./errors.js";
import { recognizeSourceRecords } from "./data-discovery.js";
import { readMappedField } from "./event-mappings.js";
import { validateEventListFilters } from "./event-validation.js";
import { isSqliteDatabase, sqliteTimestamp } from "./sqlite-database.js";

const MAX_EXPORT_EVENTS = 10_000;
const MAX_EXPORT_BYTES = 25 * 1024 * 1024;
const MAX_QUALITY_SOURCES = 50;
const QUALITY_WINDOW = 25;
const MAX_QUALITY_FIELDS = 500;
const EXCEL_CELL_CHUNK = 30_000;
const MAX_EXPORT_RECORDS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ExplorerRow {
  id: string;
  source_id: string;
  source_key: string;
  source_display_name: string;
  asset_id: string | null;
  asset_key: string | null;
  asset_name: string | null;
  source_record_id: string | null;
  event_type: string;
  occurred_at: Date | string;
  ingested_at: Date | string;
  source_timestamp: string;
  deduplication_key: string | null;
  payload: JsonObject | string;
  provenance: JsonObject | string;
}

interface ExplorerFilters {
  sourceId?: string;
  search?: string;
  eventType?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
  sortBy: "occurredAt" | "eventType" | "source";
  sortDirection: "asc" | "desc";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObject(value: JsonObject | string): JsonObject {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function isoTimestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function parseExplorerFilters(query: unknown): ExplorerFilters {
  const input = isObject(query) ? query : {};
  const allowed = new Set([
    "sourceId", "search", "eventType", "from", "to", "page", "pageSize", "sortBy", "sortDirection",
  ]);
  const unknown = Object.keys(input).find(key => !allowed.has(key));
  if (unknown) throw new ApiFailure(400, "INVALID_QUERY", `Unsupported explorer filter: ${unknown}.`);
  const standardFilters = validateEventListFilters({
    ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
    ...(input.eventType !== undefined ? { eventType: input.eventType } : {}),
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
    ...(input.page !== undefined ? { page: input.page } : {}),
    ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
  });
  const search = input.search;
  if (search !== undefined && (typeof search !== "string" || search.trim().length > 200)) {
    throw new ApiFailure(400, "INVALID_QUERY", "Search text must be at most 200 characters.");
  }
  const sortBy = input.sortBy ?? "occurredAt";
  if (sortBy !== "occurredAt" && sortBy !== "eventType" && sortBy !== "source") {
    throw new ApiFailure(400, "INVALID_QUERY", "Sort by occurredAt, eventType, or source.");
  }
  const sortDirection = input.sortDirection ?? "desc";
  if (sortDirection !== "asc" && sortDirection !== "desc") {
    throw new ApiFailure(400, "INVALID_QUERY", "Sort direction must be asc or desc.");
  }
  return {
    sourceId: standardFilters.sourceId,
    search: typeof search === "string" ? search.trim() : undefined,
    eventType: standardFilters.eventType,
    from: standardFilters.from,
    to: standardFilters.to,
    page: standardFilters.page,
    pageSize: standardFilters.pageSize,
    sortBy,
    sortDirection,
  };
}

function buildWhere(db: Kysely<Database>, filters: ExplorerFilters) {
  const clauses = [];
  if (filters.sourceId) clauses.push(sql<boolean>`e.source_id = ${filters.sourceId}`);
  if (filters.eventType) clauses.push(sql<boolean>`e.event_type = ${filters.eventType}`);
  if (filters.from) {
    clauses.push(isSqliteDatabase(db)
      ? sql<boolean>`e.occurred_at >= ${sqliteTimestamp(filters.from)}`
      : sql<boolean>`e.occurred_at >= ${filters.from}::timestamptz`);
  }
  if (filters.to) {
    clauses.push(isSqliteDatabase(db)
      ? sql<boolean>`e.occurred_at <= ${sqliteTimestamp(filters.to)}`
      : sql<boolean>`e.occurred_at <= ${filters.to}::timestamptz`);
  }
  if (filters.search) {
    const term = `%${filters.search}%`;
    clauses.push(sql<boolean>`(
      lower(s.source_key) LIKE lower(${term}) OR
      lower(s.display_name) LIKE lower(${term}) OR
      lower(e.event_type) LIKE lower(${term}) OR
      lower(coalesce(e.source_record_id, '')) LIKE lower(${term}) OR
      lower(e.source_timestamp) LIKE lower(${term}) OR
      lower(coalesce(e.deduplication_key, '')) LIKE lower(${term}) OR
      lower(cast(e.payload as text)) LIKE lower(${term}) OR
      lower(cast(e.provenance as text)) LIKE lower(${term}) OR
      lower(coalesce(a.asset_key, '')) LIKE lower(${term}) OR
      lower(coalesce(a.name, '')) LIKE lower(${term})
    )`);
  }
  return clauses.length ? sql<boolean>`${sql.join(clauses, sql` and `)}` : sql<boolean>`true`;
}

function eventFromRow(row: ExplorerRow): EventDetail {
  return {
    id: row.id,
    source: { id: row.source_id, sourceKey: row.source_key, displayName: row.source_display_name },
    asset: row.asset_id
      ? { id: row.asset_id, assetKey: row.asset_key ?? "", name: row.asset_name ?? "" }
      : null,
    sourceRecordId: row.source_record_id,
    eventType: row.event_type,
    occurredAt: isoTimestamp(row.occurred_at),
    ingestedAt: isoTimestamp(row.ingested_at),
    sourceTimestamp: row.source_timestamp,
    deduplicationKey: row.deduplication_key,
    payload: jsonObject(row.payload),
    provenance: jsonObject(row.provenance),
  };
}

async function readExplorerPage(
  db: Kysely<Database>,
  filters: ExplorerFilters,
): Promise<Page<EventDetail>> {
  const where = buildWhere(db, filters);
  const sourceOrder = filters.sortBy === "source"
    ? sql<string>`s.display_name`
    : filters.sortBy === "eventType"
      ? sql<string>`e.event_type`
      : sql<string>`e.occurred_at`;
  const [rows, count] = await Promise.all([
    db.selectFrom("events as e")
      .innerJoin("data_sources as s", "s.id", "e.source_id")
      .leftJoin("assets as a", "a.id", "e.asset_id")
      .select([
        "e.id as id",
        "e.source_id as source_id",
        "s.source_key as source_key",
        "s.display_name as source_display_name",
        "e.asset_id as asset_id",
        "a.asset_key as asset_key",
        "a.name as asset_name",
        "e.source_record_id as source_record_id",
        "e.event_type as event_type",
        isSqliteDatabase(db)
          ? sql<string>`e.occurred_at`.as("occurred_at")
          : sql<string>`to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("occurred_at"),
        "e.ingested_at as ingested_at",
        "e.source_timestamp as source_timestamp",
        "e.deduplication_key as deduplication_key",
        "e.payload as payload",
        "e.provenance as provenance",
      ])
      .where(where)
      .orderBy(sourceOrder, filters.sortDirection)
      .orderBy("e.id", filters.sortDirection)
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize)
      .execute(),
    db.selectFrom("events as e")
      .innerJoin("data_sources as s", "s.id", "e.source_id")
      .leftJoin("assets as a", "a.id", "e.asset_id")
      .select(eb => eb.fn.countAll<number>().as("total"))
      .where(where)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    items: rows.map(row => eventFromRow(row as unknown as ExplorerRow)),
    total: Number(count.total),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

function sourceRecord(event: EventDetail): JsonObject {
  const original = event.provenance.originalRecord;
  return isObject(original) ? original as JsonObject : event.payload;
}

function valueType(value: JsonValue): ExplorerSourceQuality["fields"][number]["observedTypes"][number] {
  if (value === null) return "unknown";
  if (Array.isArray(value)) return "array";
  if (isObject(value)) return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function collectFieldTypes(record: JsonObject): {
  fields: Map<string, Set<ExplorerSourceQuality["fields"][number]["observedTypes"][number]>>;
  truncated: boolean;
} {
  const fields = new Map<string, Set<ExplorerSourceQuality["fields"][number]["observedTypes"][number]>>();
  let truncated = false;
  const visit = (value: JsonValue, path: string, depth: number) => {
    if (!path) return;
    if (depth > 8) { truncated = true; return; }
    if (!fields.has(path) && fields.size >= MAX_QUALITY_FIELDS) { truncated = true; return; }
    const type = valueType(value);
    const types = fields.get(path) ?? new Set();
    types.add(type);
    fields.set(path, types);
    if (type === "object") {
      for (const [key, child] of Object.entries(value as JsonObject)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        visit(child, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };
  for (const [key, value] of Object.entries(record)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    visit(value, key, 1);
  }
  return { fields, truncated };
}

async function qualityForSource(
  db: Kysely<Database>,
  source: { id: string; source_key: string; display_name: string },
): Promise<ExplorerSourceQuality> {
  const rows = await db.selectFrom("events")
    .select(["payload", "provenance"])
    .where("source_id", "=", source.id)
    .orderBy("occurred_at", "desc")
    .orderBy("id", "desc")
    .limit(QUALITY_WINDOW * 2)
    .execute();
  const events = rows.map(row => {
    const payload = jsonObject(row.payload as JsonObject | string);
    const provenance = jsonObject(row.provenance as JsonObject | string);
    return sourceRecord({
      id: "", source: { id: source.id, sourceKey: source.source_key, displayName: source.display_name },
      asset: null, sourceRecordId: null, eventType: "", occurredAt: "", ingestedAt: "",
      sourceTimestamp: "", deduplicationKey: null, payload, provenance,
    });
  });
  const current = events.slice(0, QUALITY_WINDOW);
  const previous = events.slice(QUALITY_WINDOW, QUALITY_WINDOW * 2);
  const currentCollections = current.map(collectFieldTypes);
  const previousCollections = previous.map(collectFieldTypes);
  const currentByPath = currentCollections.map(collection => collection.fields);
  const previousByPath = previousCollections.map(collection => collection.fields);
  const allPaths = new Set([...currentByPath, ...previousByPath].flatMap(fields => [...fields.keys()]));
  const fields: ExplorerSourceQuality["fields"] = [];
  const schemaChanges: ExplorerSchemaChange[] = [];
  let fieldsTruncated = [...currentCollections, ...previousCollections].some(collection => collection.truncated);
  for (const path of allPaths) {
    if (fields.length >= MAX_QUALITY_FIELDS) { fieldsTruncated = true; break; }
    const currentTypes = new Set(currentByPath.flatMap(map => [...(map.get(path) ?? [])]));
    const previousTypes = new Set(previousByPath.flatMap(map => [...(map.get(path) ?? [])]));
    const recordsPresent = currentByPath.filter(map => map.has(path)).length;
    const observedTypes = [...new Set([...currentTypes, ...previousTypes])].sort();
    fields.push({
      path,
      observedTypes,
      recordsPresent,
      recordsMissing: current.length - recordsPresent,
    });
    if (!previous.length) continue;
    if (!previousTypes.size && currentTypes.size) {
      schemaChanges.push({ path, change: "added", previousTypes: [], currentTypes: [...currentTypes].sort() });
    } else if (previousTypes.size && !currentTypes.size) {
      schemaChanges.push({ path, change: "removed", previousTypes: [...previousTypes].sort(), currentTypes: [] });
    } else if (
      currentTypes.size && previousTypes.size &&
      (currentTypes.size !== previousTypes.size || [...currentTypes].some(type => !previousTypes.has(type)))
    ) {
      schemaChanges.push({ path, change: "type_changed", previousTypes: [...previousTypes].sort(), currentTypes: [...currentTypes].sort() });
    }
  }
  fields.sort((left, right) => left.path.localeCompare(right.path));
  const schemaChangesTruncated = schemaChanges.length > 100;
  return {
    source: { id: source.id, sourceKey: source.source_key, displayName: source.display_name },
    sampledEvents: events.length,
    recentSampledEvents: current.length,
    previousSampledEvents: previous.length,
    fields,
    schemaChanges: schemaChanges.slice(0, 100),
    fieldsTruncated,
    schemaChangesTruncated,
    insufficientHistory: events.length < QUALITY_WINDOW * 2,
  };
}

async function readQualityReport(db: Kysely<Database>, sourceId?: string): Promise<ExplorerQualityReport> {
  const sourcesQuery = db.selectFrom("data_sources").select(["id", "source_key", "display_name"])
    .orderBy("display_name", "asc").limit(MAX_QUALITY_SOURCES + 1);
  const sources = sourceId
    ? await sourcesQuery.where("id", "=", sourceId).execute()
    : await sourcesQuery.execute();
  if (sourceId && !sources.length) throw new ApiFailure(404, "NOT_FOUND", "Data source not found.");
  const reports: ExplorerSourceQuality[] = [];
  for (const source of sources.slice(0, MAX_QUALITY_SOURCES)) reports.push(await qualityForSource(db, source));
  return { sources: reports, sourcesTruncated: !sourceId && sources.length > MAX_QUALITY_SOURCES };
}

function splitExcelCell(value: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (chunk.length + character.length > EXCEL_CELL_CHUNK) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  chunks.push(chunk);
  return chunks;
}

function csvCell(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const safeText = /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

function originalRecordJson(event: EventDetail): string {
  const value = event.provenance.originalRecord;
  return value === undefined ? "" : JSON.stringify(value);
}

async function exportEvents(
  db: Kysely<Database>,
  rawQuery: unknown,
  format: "json" | "csv" | "xlsx",
): Promise<{ contentType: string; fileName: string; content: Buffer | string }> {
  const filtersInput = isObject(rawQuery) ? { ...rawQuery } : {};
  delete filtersInput.format;
  const base = parseExplorerFilters(filtersInput);
  const filters = { ...base, page: 1, pageSize: 100 };
  const items: EventDetail[] = [];
  let serializedBytes = 0;
  let total = 0;
  for (let page = 1; ; page += 1) {
    const result = await readExplorerPage(db, { ...filters, page });
    total = result.total;
    if (total > MAX_EXPORT_EVENTS) {
      throw new ApiFailure(413, "EXPORT_LIMIT_EXCEEDED", `Narrow the filters to export at most ${MAX_EXPORT_EVENTS} events.`);
    }
    for (const event of result.items) {
      const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      serializedBytes += eventBytes;
      if (serializedBytes > MAX_EXPORT_BYTES) {
        throw new ApiFailure(413, "EXPORT_SIZE_LIMIT_EXCEEDED", "The filtered export exceeds the 25 MiB safety limit. Narrow the filters and retry.");
      }
      items.push(event);
    }
    if (result.items.length === 0 || items.length >= total) break;
  }
  const date = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    return {
      contentType: "application/json; charset=utf-8",
      fileName: `kuduns-events-${date}.json`,
      content: JSON.stringify({ exportedAt: new Date().toISOString(), total, items }, null, 2),
    };
  }
  if (format === "csv") {
    const headers = [
      "event_id", "source_id", "source_key", "source_name", "asset_id", "asset_key", "asset_name",
      "source_record_id", "event_type", "occurred_at", "ingested_at", "source_timestamp",
      "deduplication_key", "payload_json", "original_record_json", "provenance_json",
    ];
    const lines = [headers.map(csvCell).join(",")];
    for (const event of items) {
      lines.push([
        event.id, event.source.id, event.source.sourceKey, event.source.displayName,
        event.asset?.id ?? "", event.asset?.assetKey ?? "", event.asset?.name ?? "",
        event.sourceRecordId ?? "", event.eventType, event.occurredAt, event.ingestedAt,
        event.sourceTimestamp, event.deduplicationKey ?? "", JSON.stringify(event.payload),
        originalRecordJson(event), JSON.stringify(event.provenance),
      ].map(csvCell).join(","));
    }
    return {
      contentType: "text/csv; charset=utf-8",
      fileName: `kuduns-events-${date}.csv`,
      content: `\uFEFF${lines.join("\r\n")}`,
    };
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "KuduNS";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("Events");
  const chunkCounts = items.reduce((counts, event) => {
    counts.payload = Math.max(counts.payload, splitExcelCell(JSON.stringify(event.payload)).length);
    counts.original = Math.max(counts.original, splitExcelCell(originalRecordJson(event)).length);
    counts.provenance = Math.max(counts.provenance, splitExcelCell(JSON.stringify(event.provenance)).length);
    return counts;
  }, { payload: 1, original: 1, provenance: 1 });
  const chunkHeaders = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${prefix}_part_${index + 1}`);
  const headers = [
    "event_id", "source_id", "source_key", "source_name", "asset_id", "asset_key", "asset_name",
    "source_record_id", "event_type", "occurred_at", "ingested_at", "source_timestamp",
    "deduplication_key",
    ...chunkHeaders("payload_json", chunkCounts.payload),
    ...chunkHeaders("original_record_json", chunkCounts.original),
    ...chunkHeaders("provenance_json", chunkCounts.provenance),
  ];
  worksheet.addRow(headers);
  for (const event of items) {
    const row: Array<string | null> = [
      event.id, event.source.id, event.source.sourceKey, event.source.displayName,
      event.asset?.id ?? null, event.asset?.assetKey ?? null, event.asset?.name ?? null,
      event.sourceRecordId, event.eventType, event.occurredAt, event.ingestedAt,
      event.sourceTimestamp, event.deduplicationKey,
      ...splitExcelCell(JSON.stringify(event.payload)),
      ...splitExcelCell(originalRecordJson(event)),
      ...splitExcelCell(JSON.stringify(event.provenance)),
    ];
    while (row.length < headers.length) row.push(null);
    worksheet.addRow(row);
  }
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileName: `kuduns-events-${date}.xlsx`,
    content: Buffer.from(buffer),
  };
}

export function registerDataExplorerRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.get<{ Querystring: ExplorerEventQuery }>("/api/v1/explorer/events", async request => {
    return readExplorerPage(db, parseExplorerFilters(request.query));
  });
  app.get<{ Querystring: { sourceId?: string } }>("/api/v1/explorer/quality", async request => {
    return readQualityReport(db, request.query.sourceId);
  });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/explorer/export", async (request, reply) => {
    const format = request.query.format;
    if (format !== "json" && format !== "csv" && format !== "xlsx") {
      throw new ApiFailure(400, "EXPORT_FORMAT_INVALID", "Choose json, csv, or xlsx export format.");
    }
    const { contentType, fileName, content } = await exportEvents(db, request.query, format);
    return reply
      .header("Content-Type", contentType)
      .header("Content-Disposition", `attachment; filename="${fileName}"`)
      .header("Cache-Control", "no-store")
      .send(content);
  });
}
