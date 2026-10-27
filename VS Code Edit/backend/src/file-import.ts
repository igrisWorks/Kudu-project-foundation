import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { FileImportRecordError, FileImportResult, JsonObject } from "@kudu/shared";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database, StoredSourceConfiguration } from "./database.js";
import { ApiFailure } from "./errors.js";
import { getActiveEventMapping, normalizeMappedEvent, type ActiveEventMapping } from "./event-mappings.js";
import { ingestEvent } from "./events.js";

const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_RECORDS = 1_000;
const MAX_REPORTED_ERRORS = 100;
const sourceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const csvEventFields = new Set(["eventType", "occurredAt", "assetId", "sourceRecordId", "payload"]);
const jsonEventFields = csvEventFields;

type ImportFormat = "csv" | "json";
type JsonRecord = Record<string, unknown>;

interface PreparedImportInput {
  input: JsonRecord;
  rawRecord: JsonObject;
}

interface CsvRow {
  line: number;
  values: string[];
}

function importFileFailure(message: string): ApiFailure {
  return new ApiFailure(400, "INVALID_IMPORT_FILE", message);
}

function recordFailure(message: string, fields?: Record<string, string>): ApiFailure {
  return new ApiFailure(400, "INVALID_IMPORT_RECORD", message, fields);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function parseCsvRows(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let rowTouched = false;
  let line = 1;
  let rowStartLine = 1;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push({ line: rowStartLine, values: row });
    if (rows.length > MAX_IMPORT_RECORDS + 1) {
      throw new ApiFailure(413, "IMPORT_RECORD_LIMIT", `Import files are limited to ${MAX_IMPORT_RECORDS} records.`);
    }
    row = [];
    rowTouched = false;
  };
  const endLine = (currentIndex: number, char: string): number => {
    if (char === "\r" && text[currentIndex + 1] === "\n") return currentIndex + 1;
    return currentIndex;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else if (char === "\r") {
        if (text[index + 1] === "\n") {
          field += "\r\n";
          index += 1;
        } else {
          field += "\r";
        }
        line += 1;
      } else {
        field += char;
        if (char === "\n") line += 1;
      }
      rowTouched = true;
      continue;
    }

    if (afterQuote) {
      if (char === ",") {
        pushField();
        afterQuote = false;
        rowTouched = true;
      } else if (char === "\r" || char === "\n") {
        pushRow();
        index = endLine(index, char);
        line += 1;
        rowStartLine = line;
        afterQuote = false;
      } else {
        throw importFileFailure("The CSV file has unexpected characters after a quoted field.");
      }
      continue;
    }

    if (char === '"') {
      if (field.length !== 0) {
        throw importFileFailure("The CSV file has a quote in an unquoted field.");
      }
      inQuotes = true;
      rowTouched = true;
    } else if (char === ",") {
      pushField();
      rowTouched = true;
    } else if (char === "\r" || char === "\n") {
      pushRow();
      index = endLine(index, char);
      line += 1;
      rowStartLine = line;
    } else {
      field += char;
      rowTouched = true;
    }
  }

  if (inQuotes) throw importFileFailure("The CSV file contains an unclosed quoted field.");
  if (rowTouched || row.length > 0 || field.length > 0 || afterQuote) pushRow();
  return rows;
}

function parseCsv(text: string, requireDefaultHeaders: boolean): { headers: string[]; rows: CsvRow[] } {
  const [headerRow, ...rows] = parseCsvRows(text);
  if (!headerRow || headerRow.values.length === 0 || headerRow.values.some((header) => header.length === 0)) {
    throw importFileFailure("The CSV file must start with a non-empty header row.");
  }
  const headers = headerRow.values;
  if (new Set(headers).size !== headers.length) {
    throw importFileFailure("The CSV header contains duplicate column names.");
  }
  if (requireDefaultHeaders) {
    for (const required of ["eventType", "occurredAt", "payload"]) {
      if (!headers.includes(required)) {
        throw importFileFailure(`The CSV header must include ${required}.`);
      }
    }
  }
  return { headers, rows };
}

function requirePayloadObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw recordFailure("Payload must be a JSON object.", { payload: "Provide a JSON object." });
  }
  return value;
}

function mergePayload(payloadValue: unknown, extraEntries: Array<[string, unknown]>): JsonObject {
  const payload = requirePayloadObject(payloadValue);
  const collisions = extraEntries.some(([key]) => Object.hasOwn(payload, key));
  if (collisions) {
    throw recordFailure(
      "A record field is present both inside payload and as a top-level field.",
      { payload: "Remove duplicate keys or place the value in one location." },
    );
  }
  const extras = Object.fromEntries(extraEntries);
  return { ...payload, ...extras } as JsonObject;
}

function fallbackDeduplicationKey(relativePath: string, recordNumber: number): string {
  const pathHash = createHash("sha256").update(relativePath).digest("hex").slice(0, 32);
  return `file:${pathHash}:${recordNumber}`;
}

function buildEventInput(
  sourceId: string,
  relativePath: string,
  format: ImportFormat,
  recordNumber: number,
  record: JsonRecord,
  payloadValue: unknown,
  extraEntries: Array<[string, unknown]>,
  allowMissingPayload: boolean,
  payloadFieldPresent: boolean,
): PreparedImportInput {
  const effectivePayload = allowMissingPayload && payloadValue === undefined ? {} : payloadValue;
  const payload = mergePayload(effectivePayload, extraEntries);
  const rawRecord = {
    ...record,
    ...(payloadFieldPresent ? { payload: requirePayloadObject(effectivePayload) } : {}),
    ...Object.fromEntries(extraEntries),
  } as JsonObject;
  const sourceRecordId = record.sourceRecordId;
  const hasSourceRecordId = Object.hasOwn(record, "sourceRecordId");
  const deduplicationKey =
    typeof sourceRecordId === "string" && sourceRecordId.trim()
      ? sourceRecordId
      : fallbackDeduplicationKey(relativePath, recordNumber);
  return {
    rawRecord,
    input: {
      sourceId,
      eventType: record.eventType,
      occurredAt: record.occurredAt,
      ...(Object.hasOwn(record, "assetId") ? { assetId: record.assetId } : {}),
      ...(hasSourceRecordId ? { sourceRecordId } : {}),
      deduplicationKey,
      payload,
      provenance: { importFormat: format },
    },
  };
}

async function applyActiveMapping(
  db: Kysely<Database>,
  prepared: PreparedImportInput,
  mapping: ActiveEventMapping,
  format: ImportFormat,
  recordNumber: number,
  relativePath: string,
): Promise<JsonRecord> {
  const sourceId = prepared.input.sourceId;
  if (typeof sourceId !== "string") throw recordFailure("The source identifier is invalid.");
  return normalizeMappedEvent(
    db,
    sourceId,
    prepared.rawRecord,
    prepared.input.payload as JsonObject,
    mapping,
    fallbackDeduplicationKey(relativePath, recordNumber),
    { importFormat: format },
  );
}

function csvRecordToEventInput(
  sourceId: string,
  relativePath: string,
  headers: string[],
  row: CsvRow,
  allowMissingPayload: boolean,
): PreparedImportInput {
  if (row.values.length > headers.length) {
    throw recordFailure(
      "The CSV row contains more values than the header.",
      { record: "Remove extra columns or add their names to the header." },
    );
  }
  const values = [...row.values];
  while (values.length < headers.length) values.push("");
  const record: JsonRecord = {};
  const extraEntries: Array<[string, unknown]> = [];
  let payloadValue: unknown = {};

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]!;
    const value = values[index]!;
    if (header === "payload") {
      if (!value.trim()) {
        payloadValue = {};
      } else {
        try {
          payloadValue = JSON.parse(value) as unknown;
        } catch {
          throw recordFailure("The CSV payload cell is not valid JSON.", {
            payload: "Provide a JSON object in this cell.",
          });
        }
      }
    } else if (csvEventFields.has(header)) {
      if ((header === "assetId" || header === "sourceRecordId") && !value.trim()) continue;
      record[header] = value;
    } else {
      extraEntries.push([header, value]);
    }
  }
  return buildEventInput(
    sourceId,
    relativePath,
    "csv",
    row.line,
    record,
    payloadValue,
    extraEntries,
    allowMissingPayload,
    headers.includes("payload"),
  );
}

function jsonRecordToEventInput(
  sourceId: string,
  relativePath: string,
  recordValue: unknown,
  recordNumber: number,
  allowMissingPayload: boolean,
): PreparedImportInput {
  if (!isRecord(recordValue)) {
    throw recordFailure("Each JSON array item must be an object.", {
      record: "Provide an event object.",
    });
  }
  const extraEntries = Object.entries(recordValue).filter(([key]) => !jsonEventFields.has(key));
  return buildEventInput(
    sourceId,
    relativePath,
    "json",
    recordNumber,
    recordValue,
    recordValue.payload,
    extraEntries,
    allowMissingPayload,
    Object.hasOwn(recordValue, "payload"),
  );
}

function safeImportError(error: unknown): Omit<FileImportRecordError, "record"> {
  if (error instanceof ApiFailure) {
    return {
      code: error.code,
      message: error.message,
      ...(error.fields ? { fields: error.fields } : {}),
    };
  }
  return {
    code: "IMPORT_RECORD_FAILED",
    message: "The event record could not be persisted.",
  };
}

async function readBoundedFile(filePath: string): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ApiFailure(404, "IMPORT_FILE_NOT_FOUND", "The configured import file was not found.");
    }
    if (code === "ELOOP") {
      throw new ApiFailure(400, "IMPORT_PATH_INVALID", "The configured import file must not resolve through a symbolic link.");
    }
    throw new ApiFailure(500, "IMPORT_FILE_UNAVAILABLE", "The configured import file could not be read.");
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new ApiFailure(400, "IMPORT_FILE_INVALID", "The configured import path must identify a regular file.");
    }
    if (stats.size > MAX_IMPORT_FILE_BYTES) {
      throw new ApiFailure(413, "IMPORT_FILE_TOO_LARGE", `Import files are limited to ${MAX_IMPORT_FILE_BYTES} bytes.`);
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_IMPORT_FILE_BYTES) {
        throw new ApiFailure(413, "IMPORT_FILE_TOO_LARGE", `Import files are limited to ${MAX_IMPORT_FILE_BYTES} bytes.`);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function resolveImportFile(
  importDirectory: string,
  configuredRelativePath: string,
): Promise<string> {
  if (
    !configuredRelativePath ||
    isAbsolute(configuredRelativePath) ||
    configuredRelativePath.startsWith("/") ||
    configuredRelativePath.includes("\\") ||
    configuredRelativePath.includes("\0") ||
    configuredRelativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ApiFailure(400, "IMPORT_PATH_INVALID", "The registered source has an invalid relative file path.");
  }

  try {
    await mkdir(importDirectory, { recursive: true });
    const canonicalRoot = await realpath(importDirectory);
    const requestedFile = resolve(canonicalRoot, configuredRelativePath);
    const requestedRelativePath = relative(canonicalRoot, requestedFile);
    if (
      !requestedRelativePath ||
      requestedRelativePath === ".." ||
      requestedRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(requestedRelativePath)
    ) {
      throw new ApiFailure(400, "IMPORT_PATH_INVALID", "The registered source file must remain inside the import directory.");
    }

    const canonicalFile = await realpath(requestedFile);
    const actualRelativePath = relative(canonicalRoot, canonicalFile);
    if (
      !actualRelativePath ||
      actualRelativePath === ".." ||
      actualRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(actualRelativePath)
    ) {
      throw new ApiFailure(400, "IMPORT_PATH_INVALID", "The registered source file must remain inside the import directory.");
    }
    return canonicalFile;
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ApiFailure(404, "IMPORT_FILE_NOT_FOUND", "The configured import file was not found.");
    }
    throw new ApiFailure(500, "IMPORT_FILE_UNAVAILABLE", "The configured import file could not be accessed.");
  }
}

async function processImport(
  db: Kysely<Database>,
  sourceId: string,
  relativePath: string,
  format: ImportFormat,
  bytes: Buffer,
  activeMapping?: ActiveEventMapping,
): Promise<FileImportResult> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw importFileFailure("Import files must be valid UTF-8.");
  }

  let inputs: Array<{ record: number; buildInput: () => PreparedImportInput }>;
  if (format === "csv") {
    const parsed = parseCsv(text, !activeMapping);
    inputs = parsed.rows.map((row) => ({
      record: row.line,
      buildInput: () => csvRecordToEventInput(sourceId, relativePath, parsed.headers, row, Boolean(activeMapping)),
    }));
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw importFileFailure("The JSON file is malformed.");
    }
    if (!Array.isArray(parsed)) {
      throw importFileFailure("The JSON file must contain an array of event objects.");
    }
    if (parsed.length > MAX_IMPORT_RECORDS) {
      throw new ApiFailure(413, "IMPORT_RECORD_LIMIT", `Import files are limited to ${MAX_IMPORT_RECORDS} records.`);
    }
    inputs = parsed.map((record, index) => ({
      record: index + 1,
      buildInput: () => jsonRecordToEventInput(sourceId, relativePath, record, index + 1, Boolean(activeMapping)),
    }));
  }

  const result: FileImportResult = {
    sourceId,
    format,
    records: inputs.length,
    imported: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    errorsTruncated: false,
  };
  for (const item of inputs) {
    try {
      const prepared = item.buildInput();
      const input = activeMapping
        ? await applyActiveMapping(db, prepared, activeMapping, format, item.record, relativePath)
        : prepared.input;
      const response = await ingestEvent(db, input);
      if (response.duplicate) result.skipped += 1;
      else result.imported += 1;
    } catch (error) {
      result.failed += 1;
      if (result.errors.length < MAX_REPORTED_ERRORS) {
        result.errors.push({ record: item.record, ...safeImportError(error) });
      } else {
        result.errorsTruncated = true;
      }
    }
  }
  return result;
}

export function registerFileImportRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  importDirectory: string,
): void {
  app.post<{ Params: { id: string } }>(
    "/api/v1/data-sources/:id/import",
    async (request) => {
      if (!sourceIdPattern.test(request.params.id)) {
        throw new ApiFailure(400, "INVALID_ID", "A valid data-source identifier is required.");
      }
      if (request.body !== undefined) {
        throw new ApiFailure(
          400,
          "IMPORT_BODY_NOT_ALLOWED",
          "Import reads only the file configured on this registered data source.",
        );
      }

      const source = await db
        .selectFrom("data_sources")
        .select(["id", "source_type", "configuration", "enabled"])
        .where("id", "=", request.params.id)
        .executeTakeFirst();
      if (!source) throw new ApiFailure(404, "NOT_FOUND", "Data source not found.");
      if (!source.enabled) {
        throw new ApiFailure(409, "SOURCE_DISABLED", "Enable this data source before importing its file.");
      }
      if (source.source_type !== "csv_file" && source.source_type !== "json_file") {
        throw new ApiFailure(
          400,
          "UNSUPPORTED_SOURCE_TYPE",
          "Only registered CSV and JSON file data sources can be imported.",
        );
      }

      const configuration = source.configuration as StoredSourceConfiguration;
      if (
        configuration.kind !== source.source_type ||
        !("relativePath" in configuration) ||
        typeof configuration.relativePath !== "string"
      ) {
        throw new ApiFailure(
          409,
          "SOURCE_CONFIGURATION_INVALID",
          "This data source does not have a valid configured import file.",
        );
      }
      const format: ImportFormat = source.source_type === "csv_file" ? "csv" : "json";
      const expectedExtension = format === "csv" ? ".csv" : ".json";
      if (extname(configuration.relativePath).toLowerCase() !== expectedExtension) {
        throw new ApiFailure(
          400,
          "IMPORT_FORMAT_MISMATCH",
          `The registered ${format.toUpperCase()} source must reference a ${expectedExtension} file.`,
        );
      }
      const activeMapping = await getActiveEventMapping(db, source.id);
      const filePath = await resolveImportFile(importDirectory, configuration.relativePath);
      const bytes = await readBoundedFile(filePath);
      return processImport(db, source.id, configuration.relativePath, format, bytes, activeMapping);
    },
  );
}
