import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { EventMappingDefinition, FileImportRecordError, FileImportResult, JsonObject } from "@kudu/shared";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database, StoredSourceConfiguration } from "./database.js";
import { ApiFailure } from "./errors.js";
import {
  getActiveEventMapping,
  loadAssetMatchContext,
  readMappedField,
  type ActiveEventMapping,
} from "./event-mappings.js";
import { automaticEventDefinition, recognizeSourceRecords } from "./data-discovery.js";
import { normalizeAndLinkSourceRecord, sourceRecordIdentity, storeSourceRecord } from "./source-records.js";

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
  rawRecord: JsonObject;
  basePayload: JsonObject;
}

export interface CsvRow {
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

export function parseCsv(text: string, requireDefaultHeaders: boolean): { headers: string[]; rows: CsvRow[] } {
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

function fallbackDeduplicationKey(relativePath: string, recordNumber: number): string {
  const pathHash = createHash("sha256").update(relativePath).digest("hex").slice(0, 32);
  return `file:${pathHash}:${recordNumber}`;
}

function buildEventInput(
  record: JsonRecord,
  payloadValue: unknown,
  rawPayloadValue: unknown,
  extraEntries: Array<[string, unknown]>,
  payloadFieldPresent: boolean,
): PreparedImportInput {
  const payload = isJsonObject(payloadValue) ? payloadValue : {};
  const collisions = extraEntries.some(([key]) => Object.hasOwn(payload, key));
  const basePayload = collisions ? {} : { ...payload, ...Object.fromEntries(extraEntries) } as JsonObject;
  const rawRecord = {
    ...record,
    ...(payloadFieldPresent ? { payload: rawPayloadValue } : {}),
    ...Object.fromEntries(extraEntries),
  } as JsonObject;
  return {
    rawRecord,
    basePayload,
  };
}

function csvRecordToEventInput(
  headers: string[],
  row: CsvRow,
): PreparedImportInput {
  if (row.values.length > headers.length) {
    throw recordFailure(
      "The CSV row contains more values than the header.",
      { record: "Remove extra columns or add their names to the header." },
    );
  }
  const record: JsonRecord = {};
  const extraEntries: Array<[string, unknown]> = [];
  let payloadValue: unknown = {};
  let rawPayloadValue: unknown;

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]!;
    if (index >= row.values.length) continue;
    const value = row.values[index]!;
    if (header === "payload") {
      rawPayloadValue = value;
      if (!value.trim()) {
        payloadValue = {};
      } else {
        try {
          payloadValue = JSON.parse(value) as unknown;
        } catch {
          payloadValue = undefined;
        }
      }
    } else if (csvEventFields.has(header)) {
      record[header] = value;
    } else {
      extraEntries.push([header, value]);
    }
  }
  return buildEventInput(
    record,
    payloadValue,
    rawPayloadValue,
    extraEntries,
    headers.includes("payload") && rawPayloadValue !== undefined,
  );
}

function jsonRecordToEventInput(
  recordValue: unknown,
): PreparedImportInput {
  if (!isRecord(recordValue)) {
    throw recordFailure("Each JSON array item must be an object.", {
      record: "Provide an event object.",
    });
  }
  const extraEntries = Object.entries(recordValue).filter(([key]) => !jsonEventFields.has(key));
  return buildEventInput(
    recordValue,
    recordValue.payload,
    recordValue.payload,
    extraEntries,
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

export async function readBoundedFile(filePath: string): Promise<Buffer> {
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

export async function resolveImportFile(
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
  recordsPath?: string,
  sourceTimezone?: string,
): Promise<FileImportResult> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw importFileFailure("Import files must be valid UTF-8.");
  }

  let inputs: Array<{ record: number; buildInput: () => PreparedImportInput }>;
  if (format === "csv") {
    const parsed = parseCsv(text, false);
    inputs = parsed.rows.map((row) => ({
      record: row.line,
      buildInput: () => csvRecordToEventInput(parsed.headers, row),
    }));
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw importFileFailure("The JSON file is malformed.");
    }
    const candidateRecords = recordsPath
      ? isRecord(parsed) ? readMappedField(parsed as JsonObject, recordsPath) : undefined
      : Array.isArray(parsed) ? parsed : isRecord(parsed) ? [parsed] : parsed;
    if (!Array.isArray(candidateRecords)) {
      throw importFileFailure("The JSON file must contain a record object or an array of record objects.");
    }
    if (candidateRecords.length > MAX_IMPORT_RECORDS) {
      throw new ApiFailure(413, "IMPORT_RECORD_LIMIT", `Import files are limited to ${MAX_IMPORT_RECORDS} records.`);
    }
    inputs = candidateRecords.map((record, index) => ({
      record: index + 1,
      buildInput: () => jsonRecordToEventInput(record),
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
  type BuiltImportInput =
    | { item: (typeof inputs)[number]; prepared: PreparedImportInput }
    | { item: (typeof inputs)[number]; error: unknown };
  const preparedInputs: BuiltImportInput[] = inputs.map(item => {
    try {
      return { item, prepared: item.buildInput() };
    } catch (error) {
      return { item, error };
    }
  });
  const rawRecords = preparedInputs.flatMap(entry =>
    "prepared" in entry ? [entry.prepared.rawRecord as Record<string, unknown>] : [],
  );
  const source = await db.selectFrom("data_sources")
    .select(["source_key"])
    .where("id", "=", sourceId)
    .executeTakeFirst();
  const recognition = recognizeSourceRecords(
    format === "csv" ? "csv_file" : "json_file",
    rawRecords,
    sourceTimezone,
  );
  const automaticDefinition = automaticEventDefinition(recognition);
  const normalizationMapping = activeMapping ?? (automaticDefinition ? { definition: automaticDefinition } : undefined);
  const suggestedSourceRecordId = recognition.suggestions.find(item => item.target === "sourceRecordId")?.sourcePath ?? undefined;
  const identityDefinition: EventMappingDefinition | undefined = normalizationMapping?.definition
    ? {
        ...normalizationMapping.definition,
        sourceRecordId: normalizationMapping.definition.sourceRecordId ?? suggestedSourceRecordId,
      }
    : suggestedSourceRecordId ? { sourceRecordId: suggestedSourceRecordId } : undefined;
  const assetMatchContext = activeMapping?.definition.assetKey && source
    ? await loadAssetMatchContext(db, source.source_key)
    : undefined;
  for (const entry of preparedInputs) {
    const { item } = entry;
    try {
      if (!("prepared" in entry)) throw entry.error;
      const prepared = entry.prepared;
      const fallbackKey = fallbackDeduplicationKey(relativePath, item.record);
      const identity = sourceRecordIdentity(prepared.rawRecord, identityDefinition, fallbackKey);
      const stored = await storeSourceRecord(db, {
        sourceId,
        sourceRecordId: identity.sourceRecordId,
        deduplicationKey: identity.deduplicationKey,
        rawRecord: prepared.rawRecord,
        provenance: {
          connector: format === "csv" ? "csv_file" : "json_file",
          relativePath,
          ...(activeMapping ? { mappingVersion: activeMapping.version } : {}),
        },
        mappingVersion: activeMapping?.version,
      });
      if (stored.duplicate) result.skipped += 1;
      else result.imported += 1;
      await normalizeAndLinkSourceRecord(db, stored, {
        sourceId,
        rawRecord: prepared.rawRecord,
        basePayload: prepared.basePayload,
        fallbackDeduplicationKey: fallbackKey,
        mapping: normalizationMapping,
        provenance: {
          importFormat: format,
          relativePath,
          ...(activeMapping ? { mappingVersion: activeMapping.version } : {}),
        },
        assetMatchContext,
        sourceTimezone,
      });
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
      return processImport(
        db, source.id, configuration.relativePath, format, bytes, activeMapping,
        configuration.kind === "json_file" ? configuration.recordsPath : undefined,
        configuration.sourceTimezone,
      );
    },
  );
}
