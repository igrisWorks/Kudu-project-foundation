import ExcelJS from "exceljs";
import type {
  DataSourceType,
  ExplorerRecordDetail,
  ExplorerRecordEventSummary,
  ExplorerRecordPage,
  ExplorerRecordQuery,
  ExplorerRecordSummary,
  JsonObject,
  Page,
} from "@kudu/shared";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Database, StoredSourceConfiguration } from "./database.js";
import { ApiFailure } from "./errors.js";
import { recognizeSourceRecords } from "./data-discovery.js";
import { readMappedField } from "./event-mappings.js";
import { validateEventListFilters } from "./event-validation.js";

const MAX_EXPORT_RECORDS = 10_000;
const MAX_EXPORT_BYTES = 25 * 1024 * 1024;
const MAX_SAMPLE_RECORDS = 5;
const EXCEL_CELL_CHUNK = 30_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SourceRecordRow {
  id: string;
  source_id: string;
  source_key: string;
  source_display_name: string;
  source_type: DataSourceType;
  configuration?: StoredSourceConfiguration | string;
  source_record_id: string | null;
  deduplication_key: string;
  ingested_at: Date | string;
  processing_status: "raw_only" | "normalized";
  normalized_event_id: string | null;
  event_type: string | null;
  event_occurred_at: Date | string | null;
  field_count: number;
  field_names: string[] | string;
  preview: Record<string, string> | string;
  raw_record?: JsonObject | string;
  provenance?: JsonObject | string;
}

interface RecordFilters extends ExplorerRecordQuery {
  page: number;
  pageSize: number;
  sortBy: "ingestedAt" | "source" | "status";
  sortDirection: "asc" | "desc";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObject(value: unknown): JsonObject {
  if (typeof value !== "string") return isObject(value) ? value as JsonObject : {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function jsonStringArray(value: string[] | string): string[] {
  if (Array.isArray(value)) return value.filter(item => typeof item === "string");
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function isoTimestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function parseFilters(query: unknown): RecordFilters {
  const input = isObject(query) ? query : {};
  const allowed = new Set(["sourceId", "search", "page", "pageSize", "sortBy", "sortDirection", "format"]);
  const unknown = Object.keys(input).find(key => !allowed.has(key));
  if (unknown) throw new ApiFailure(400, "INVALID_QUERY", `Unsupported source-record filter: ${unknown}.`);
  const standard = validateEventListFilters({
    ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
    ...(input.page !== undefined ? { page: input.page } : {}),
    ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
  });
  if (input.search !== undefined && (typeof input.search !== "string" || input.search.trim().length > 200)) {
    throw new ApiFailure(400, "INVALID_QUERY", "Search text must be at most 200 characters.");
  }
  const sortBy = input.sortBy ?? "ingestedAt";
  if (sortBy !== "ingestedAt" && sortBy !== "source" && sortBy !== "status") {
    throw new ApiFailure(400, "INVALID_QUERY", "Sort by ingestion time, source, or processing status.");
  }
  const sortDirection = input.sortDirection ?? "desc";
  if (sortDirection !== "asc" && sortDirection !== "desc") {
    throw new ApiFailure(400, "INVALID_QUERY", "Sort direction must be asc or desc.");
  }
  return {
    ...(standard.sourceId ? { sourceId: standard.sourceId } : {}),
    ...(typeof input.search === "string" && input.search.trim() ? { search: input.search.trim() } : {}),
    page: standard.page,
    pageSize: standard.pageSize,
    sortBy,
    sortDirection,
  };
}

function buildWhere(filters: RecordFilters) {
  const clauses = [];
  if (filters.sourceId) clauses.push(sql<boolean>`sr.source_id = ${filters.sourceId}`);
  if (filters.search) {
    const term = `%${filters.search}%`;
    clauses.push(sql<boolean>`(
      lower(s.source_key) LIKE lower(${term}) OR
      lower(s.display_name) LIKE lower(${term}) OR
      lower(coalesce(sr.source_record_id, '')) LIKE lower(${term}) OR
      lower(cast(sr.raw_record as text)) LIKE lower(${term})
    )`);
  }
  return clauses.length ? sql<boolean>`${sql.join(clauses, sql` and `)}` : sql<boolean>`true`;
}

function eventSummary(row: SourceRecordRow): ExplorerRecordEventSummary | null {
  if (!row.normalized_event_id || !row.event_type || !row.event_occurred_at) return null;
  return {
    id: row.normalized_event_id,
    eventType: row.event_type,
    occurredAt: isoTimestamp(row.event_occurred_at),
  };
}

function summaryFromRow(row: SourceRecordRow): ExplorerRecordSummary {
  return {
    id: row.id,
    source: { id: row.source_id, sourceKey: row.source_key, displayName: row.source_display_name },
    sourceRecordId: row.source_record_id,
    deduplicationKey: row.deduplication_key,
    ingestedAt: isoTimestamp(row.ingested_at),
    processingStatus: row.processing_status,
    normalizedEvent: eventSummary(row),
    fieldCount: Number(row.field_count),
    fieldNames: jsonStringArray(row.field_names),
    preview: jsonObject(row.preview) as Record<string, string>,
  };
}

async function recognitionForSource(
  db: Kysely<Database>,
  sourceId: string,
): Promise<ReturnType<typeof recognizeSourceRecords> | null> {
  const source = await db.selectFrom("data_sources")
    .select(["source_type", "configuration"])
    .where("id", "=", sourceId)
    .executeTakeFirst();
  if (!source || source.source_type === "manual") return null;
  const samples = await db.selectFrom("source_records")
    .select("raw_record")
    .where("source_id", "=", sourceId)
    .orderBy("ingested_at", "desc")
    .orderBy("id", "desc")
    .limit(MAX_SAMPLE_RECORDS)
    .execute();
  const configuration = source.configuration as StoredSourceConfiguration;
  const sourceTimezone = "sourceTimezone" in configuration ? configuration.sourceTimezone : undefined;
  return recognizeSourceRecords(
    source.source_type,
    samples.map(row => jsonObject(row.raw_record)),
    sourceTimezone,
  );
}

async function readRecordPage(
  db: Kysely<Database>,
  filters: RecordFilters,
): Promise<ExplorerRecordPage> {
  const where = buildWhere(filters);
  let rowsQuery = db.selectFrom("source_records as sr")
    .innerJoin("data_sources as s", "s.id", "sr.source_id")
    .leftJoin("events as e", "e.id", "sr.normalized_event_id")
    .select([
      "sr.id as id",
      "sr.source_id as source_id",
      "s.source_key as source_key",
      "s.display_name as source_display_name",
      "s.source_type as source_type",
      "sr.source_record_id as source_record_id",
      "sr.deduplication_key as deduplication_key",
      "sr.ingested_at as ingested_at",
      "sr.processing_status as processing_status",
      "sr.normalized_event_id as normalized_event_id",
      "e.event_type as event_type",
      "e.occurred_at as event_occurred_at",
      "sr.field_count as field_count",
      "sr.field_names as field_names",
      "sr.preview as preview",
    ])
    .where(where);
  if (filters.sortBy === "source") rowsQuery = rowsQuery.orderBy("s.display_name", filters.sortDirection);
  else if (filters.sortBy === "status") rowsQuery = rowsQuery.orderBy("sr.processing_status", filters.sortDirection);
  else rowsQuery = rowsQuery.orderBy("sr.ingested_at", filters.sortDirection);
  const [rows, count] = await Promise.all([
    rowsQuery.orderBy("sr.id", filters.sortDirection)
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize)
      .execute(),
    db.selectFrom("source_records as sr")
      .innerJoin("data_sources as s", "s.id", "sr.source_id")
      .select(eb => eb.fn.countAll<number>().as("total"))
      .where(where)
      .executeTakeFirstOrThrow(),
  ]);
  const recognition = filters.sourceId ? await recognitionForSource(db, filters.sourceId) : null;
  return {
    items: rows.map(row => summaryFromRow(row as unknown as SourceRecordRow)),
    total: Number(count.total),
    page: filters.page,
    pageSize: filters.pageSize,
    recognition,
  };
}

async function readRecordDetail(db: Kysely<Database>, id: string): Promise<ExplorerRecordDetail> {
  const row = await db.selectFrom("source_records as sr")
    .innerJoin("data_sources as s", "s.id", "sr.source_id")
    .leftJoin("events as e", "e.id", "sr.normalized_event_id")
    .select([
      "sr.id as id",
      "sr.source_id as source_id",
      "s.source_key as source_key",
      "s.display_name as source_display_name",
      "s.source_type as source_type",
      "s.configuration as configuration",
      "sr.source_record_id as source_record_id",
      "sr.deduplication_key as deduplication_key",
      "sr.ingested_at as ingested_at",
      "sr.processing_status as processing_status",
      "sr.normalized_event_id as normalized_event_id",
      "e.event_type as event_type",
      "e.occurred_at as event_occurred_at",
      "sr.field_count as field_count",
      "sr.field_names as field_names",
      "sr.preview as preview",
      "sr.raw_record as raw_record",
      "sr.provenance as provenance",
    ])
    .where("sr.id", "=", id)
    .executeTakeFirst() as (SourceRecordRow & { configuration: StoredSourceConfiguration | string }) | undefined;
  if (!row) throw new ApiFailure(404, "NOT_FOUND", "Source record not found.");
  const rawRecord = jsonObject(row.raw_record);
  const recognition = await recognitionForSource(db, row.source_id);
  const missingFields = recognition?.fields
    .filter(field => readMappedField(rawRecord, field.path) === undefined)
    .map(field => field.path) ?? [];
  return {
    ...summaryFromRow(row),
    rawRecord,
    missingFields,
    provenance: jsonObject(row.provenance),
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  const safe = /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function splitExcelCell(value: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += EXCEL_CELL_CHUNK) {
    chunks.push(value.slice(index, index + EXCEL_CELL_CHUNK));
  }
  return chunks.length ? chunks : [""];
}

async function exportSourceRecords(
  db: Kysely<Database>,
  rawQuery: Record<string, unknown>,
  format: "json" | "csv" | "xlsx",
): Promise<{ contentType: string; fileName: string; content: Buffer | string }> {
  const filters = parseFilters({ ...rawQuery, page: "1", pageSize: "100" });
  const where = buildWhere(filters);
  const totals = await db.selectFrom("source_records as sr")
    .innerJoin("data_sources as s", "s.id", "sr.source_id")
    .select(eb => [
      eb.fn.countAll<number>().as("total"),
      eb.fn.sum<number>("sr.raw_bytes").as("raw_bytes"),
    ])
    .where(where)
    .executeTakeFirstOrThrow();
  const total = Number(totals.total);
  const rawBytes = Number(totals.raw_bytes ?? 0);
  if (total > MAX_EXPORT_RECORDS) {
    throw new ApiFailure(413, "EXPORT_LIMIT_EXCEEDED", `Narrow the filters to export at most ${MAX_EXPORT_RECORDS} source records.`);
  }
  if (rawBytes > MAX_EXPORT_BYTES) {
    throw new ApiFailure(413, "EXPORT_SIZE_LIMIT_EXCEEDED", "The filtered source-record export exceeds 25 MiB. Narrow the filters and retry.");
  }
  const rows = await db.selectFrom("source_records as sr")
    .innerJoin("data_sources as s", "s.id", "sr.source_id")
    .leftJoin("events as e", "e.id", "sr.normalized_event_id")
    .select([
      "sr.id as id",
      "sr.source_id as source_id",
      "s.source_key as source_key",
      "s.display_name as source_display_name",
      "sr.source_record_id as source_record_id",
      "sr.deduplication_key as deduplication_key",
      "sr.ingested_at as ingested_at",
      "sr.processing_status as processing_status",
      "sr.normalized_event_id as normalized_event_id",
      "e.event_type as event_type",
      "e.occurred_at as event_occurred_at",
      "sr.raw_record as raw_record",
      "sr.provenance as provenance",
    ])
    .where(where)
    .orderBy("sr.ingested_at", filters.sortDirection)
    .orderBy("sr.id", filters.sortDirection)
    .execute() as unknown as SourceRecordRow[];
  const items = rows.map(row => ({
    id: row.id,
    source: { id: row.source_id, sourceKey: row.source_key, displayName: row.source_display_name },
    sourceRecordId: row.source_record_id,
    deduplicationKey: row.deduplication_key,
    ingestedAt: isoTimestamp(row.ingested_at),
    processingStatus: row.processing_status,
    normalizedEvent: eventSummary(row),
    rawRecord: jsonObject(row.raw_record),
    provenance: jsonObject(row.provenance),
  }));
  const date = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    const content = JSON.stringify({ exportedAt: new Date().toISOString(), total, items }, null, 2);
    if (Buffer.byteLength(content, "utf8") > MAX_EXPORT_BYTES) {
      throw new ApiFailure(413, "EXPORT_SIZE_LIMIT_EXCEEDED", "The export exceeds 25 MiB after metadata is included. Narrow the filters and retry.");
    }
    return { contentType: "application/json; charset=utf-8", fileName: `kuduns-source-records-${date}.json`, content };
  }
  if (format === "csv") {
    const headers = [
      "record_id", "source_id", "source_key", "source_name", "source_record_id",
      "deduplication_key", "ingested_at", "processing_status", "raw_record_json", "provenance_json",
      "normalized_event_json",
    ];
    const lines = [headers.map(csvCell).join(",")];
    for (const item of items) {
      lines.push([
        item.id, item.source.id, item.source.sourceKey, item.source.displayName, item.sourceRecordId,
        item.deduplicationKey, item.ingestedAt, item.processingStatus, item.rawRecord,
        item.provenance, item.normalizedEvent,
      ].map(csvCell).join(","));
    }
    const content = `\uFEFF${lines.join("\r\n")}`;
    if (Buffer.byteLength(content, "utf8") > MAX_EXPORT_BYTES) {
      throw new ApiFailure(413, "EXPORT_SIZE_LIMIT_EXCEEDED", "The export exceeds 25 MiB after metadata is included. Narrow the filters and retry.");
    }
    return { contentType: "text/csv; charset=utf-8", fileName: `kuduns-source-records-${date}.csv`, content };
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "KuduNS";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("Source records");
  const chunkCounts = items.reduce((counts, item) => {
    counts.raw = Math.max(counts.raw, splitExcelCell(JSON.stringify(item.rawRecord)).length);
    counts.provenance = Math.max(counts.provenance, splitExcelCell(JSON.stringify(item.provenance)).length);
    counts.normalized = Math.max(counts.normalized, splitExcelCell(JSON.stringify(item.normalizedEvent)).length);
    return counts;
  }, { raw: 1, provenance: 1, normalized: 1 });
  const chunkHeaders = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${prefix}_part_${index + 1}`);
  worksheet.addRow([
    "record_id", "source_id", "source_key", "source_name", "source_record_id",
    "deduplication_key", "ingested_at", "processing_status",
    ...chunkHeaders("raw_record_json", chunkCounts.raw),
    ...chunkHeaders("provenance_json", chunkCounts.provenance),
    ...chunkHeaders("normalized_event_json", chunkCounts.normalized),
  ]);
  for (const item of items) {
    const row: Array<string | null> = [
      item.id, item.source.id, item.source.sourceKey, item.source.displayName,
      item.sourceRecordId, item.deduplicationKey, item.ingestedAt, item.processingStatus,
      ...splitExcelCell(JSON.stringify(item.rawRecord)),
      ...splitExcelCell(JSON.stringify(item.provenance)),
      ...splitExcelCell(JSON.stringify(item.normalizedEvent)),
    ];
    worksheet.addRow(row);
  }
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.getRow(1).font = { bold: true };
  const content = Buffer.from(await workbook.xlsx.writeBuffer());
  if (content.byteLength > MAX_EXPORT_BYTES) {
    throw new ApiFailure(413, "EXPORT_SIZE_LIMIT_EXCEEDED", "The export exceeds 25 MiB after workbook metadata is included. Narrow the filters and retry.");
  }
  return {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileName: `kuduns-source-records-${date}.xlsx`,
    content,
  };
}

export function registerSourceRecordExplorerRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/explorer/records", async request => {
    return readRecordPage(db, parseFilters(request.query));
  });
  app.get<{ Params: { id: string } }>("/api/v1/explorer/records/:id", async request => {
    if (!UUID_PATTERN.test(request.params.id)) throw new ApiFailure(400, "INVALID_ID", "A valid source-record identifier is required.");
    return readRecordDetail(db, request.params.id);
  });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/explorer/records/export", async (request, reply) => {
    const format = request.query.format;
    if (format !== "json" && format !== "csv" && format !== "xlsx") {
      throw new ApiFailure(400, "EXPORT_FORMAT_INVALID", "Choose json, csv, or xlsx export format.");
    }
    const { contentType, fileName, content } = await exportSourceRecords(db, request.query, format);
    return reply
      .header("Content-Type", contentType)
      .header("Content-Disposition", `attachment; filename="${fileName}"`)
      .header("Cache-Control", "no-store")
      .send(content);
  });
}
