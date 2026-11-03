import type {
  DataSourceConfigurationInput,
  DataSourceDiscoveryResult,
  DataSourceType,
  DiscoveredField,
  DiscoveryRecordPath,
  JsonObject,
  SuggestedFieldMapping,
  SuggestedTargetField,
} from "@kudu/shared";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { ApiFailure } from "./errors.js";
import { parseCsv, readBoundedFile, resolveImportFile } from "./file-import.js";
import { normalizeOccurrenceTimestamp, readMappedField, validateEventMappingDefinition } from "./event-mappings.js";
import type { Database, StoredSourceConfiguration } from "./database.js";
import { fetchRestDiscoveryDocument } from "./rest-sync.js";
import { validateDataSourceCreate } from "./registry-validation.js";

const MAX_DISCOVERY_DEPTH = 8;
const MAX_DISCOVERY_NODES = 5_000;
const MAX_RECORD_PATHS = 20;
const MAX_DISCOVERY_FIELDS = 80;
const MAX_PREVIEW_RECORDS = 5;
const MAX_EXAMPLE_LENGTH = 96;
const sensitiveName = /password|secret|token|credential|authorization|cookie|api.?key|private.?key|bearer/i;
const unsafePathParts = new Set(["__proto__", "prototype", "constructor"]);

interface LocatedArray {
  path: string;
  rows: Record<string, unknown>[];
  count: number;
  supported: boolean;
}

const aliases: Record<SuggestedTargetField, { names: string[]; label: string; required: boolean }> = {
  eventType: {
    names: ["eventtype", "faulttype", "alarmtype", "type", "event", "category"],
    label: "Event type", required: true,
  },
  occurredAt: {
    names: ["occurredat", "timestamp", "eventtime", "faulttime", "datetime", "time", "createdat"],
    label: "Occurrence time", required: true,
  },
  sourceRecordId: {
    names: ["sourcerecordid", "eventid", "faultid", "recordid", "id"],
    label: "Source record ID", required: false,
  },
  assetKey: {
    names: ["assetkey", "assetid", "machineid", "equipmentid", "deviceid", "machinename", "equipmentname"],
    label: "Asset identifier", required: false,
  },
  message: {
    names: ["message", "description", "faultmessage", "eventmessage"],
    label: "Message", required: false,
  },
  severity: {
    names: ["severity", "priority", "level"],
    label: "Severity", required: false,
  },
  errorCode: {
    names: ["faultcode", "errorcode", "code"],
    label: "Error code", required: false,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function supportedPath(path: string): boolean {
  if (path === "$") return true;
  if (!path || path.length > 256) return false;
  const parts = path.split(".");
  return parts.length <= MAX_DISCOVERY_DEPTH && parts.every(part =>
    part.length > 0 && part.length <= 128 && !part.includes(".") && !unsafePathParts.has(part),
  );
}

function safePathSegment(segment: string): boolean {
  return segment.length > 0 && segment.length <= 128 && !segment.includes(".") && !unsafePathParts.has(segment);
}

function displayExample(value: unknown, name = ""): string {
  if (sensitiveName.test(name)) return "[hidden]";
  if (value === null) return "null";
  if (typeof value === "object") return Array.isArray(value) ? `[array: ${value.length}]` : "[object]";
  const text = String(value);
  return text.length > MAX_EXAMPLE_LENGTH ? `${text.slice(0, MAX_EXAMPLE_LENGTH)}…` : text;
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function locateRecordArrays(value: unknown): { arrays: LocatedArray[]; truncated: boolean; nestedArrays: boolean } {
  const arrays: LocatedArray[] = [];
  let visited = 0;
  let truncated = false;
  let nestedArrays = false;
  const containsNestedArray = (current: unknown, depth: number) => {
    if (depth > MAX_DISCOVERY_DEPTH || !isRecord(current)) return;
    for (const [key, child] of Object.entries(current)) {
      if (!safePathSegment(key)) continue;
      if (Array.isArray(child)) nestedArrays = true;
      else if (isRecord(child)) containsNestedArray(child, depth + 1);
    }
  };
  const visit = (current: unknown, path: string, depth: number) => {
    visited += 1;
    if (visited > MAX_DISCOVERY_NODES || arrays.length >= MAX_RECORD_PATHS) {
      truncated = true;
      return;
    }
    if (depth > MAX_DISCOVERY_DEPTH || !isRecord(current)) return;
    for (const [key, child] of Object.entries(current)) {
      if (visited > MAX_DISCOVERY_NODES || arrays.length >= MAX_RECORD_PATHS) {
        truncated = true;
        return;
      }
      const childPath = path ? `${path}.${key}` : key;
      if (Array.isArray(child)) {
        const rows = child.filter(isRecord).slice(0, 100);
        if (rows.length) arrays.push({ path: childPath, rows, count: child.length, supported: safePathSegment(key) && supportedPath(childPath) });
        for (const row of rows.slice(0, MAX_PREVIEW_RECORDS)) containsNestedArray(row, 0);
        if (child.some(isRecord) && child.some(value => !isRecord(value))) truncated = true;
      } else if (isRecord(child) && safePathSegment(key)) {
        visit(child, childPath, depth + 1);
      } else if (isRecord(child)) {
        truncated = true;
      }
    }
  };
  if (Array.isArray(value)) {
    const rows = value.filter(isRecord).slice(0, 100);
    if (rows.length) arrays.push({ path: "$", rows, count: value.length, supported: true });
    for (const row of rows.slice(0, MAX_PREVIEW_RECORDS)) containsNestedArray(row, 0);
    if (value.some(isRecord) && value.some(item => !isRecord(item))) truncated = true;
  } else if (isRecord(value)) {
    visit(value, "", 0);
  }
  return { arrays, truncated, nestedArrays };
}

function collectLeafFields(records: Record<string, unknown>[], csv = false): DiscoveredField[] {
  const types = new Map<string, Set<DiscoveredField["valueType"]>>();
  const examples = new Map<string, string[]>();
  const visit = (value: unknown, path: string, depth: number) => {
    if (!path || !supportedPath(path) || depth > MAX_DISCOVERY_DEPTH || sensitiveName.test(path.split(".").at(-1) ?? "")) return;
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (types.size >= MAX_DISCOVERY_FIELDS) return;
        if (safePathSegment(key)) visit(child, `${path}.${key}`, depth + 1);
      }
      return;
    }
    let valueType: DiscoveredField["valueType"] = Array.isArray(value)
      ? "array"
      : value === null ? "unknown"
        : typeof value === "object" ? "object"
          : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
            ? typeof value as "string" | "number" | "boolean"
            : "unknown";
    if (csv && typeof value === "string") {
      if (/^(true|false)$/i.test(value.trim())) valueType = "boolean";
      else if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()) && Number.isFinite(Number(value))) valueType = "number";
      else if (value.length >= 8 && !Number.isNaN(Date.parse(value))) valueType = "datetime";
    }
    const foundTypes = types.get(path) ?? new Set<DiscoveredField["valueType"]>();
    foundTypes.add(valueType);
    types.set(path, foundTypes);
    const foundExamples = examples.get(path) ?? [];
    if (foundExamples.length < 3 && value !== undefined && !foundExamples.includes(displayExample(value))) {
      foundExamples.push(displayExample(value));
      examples.set(path, foundExamples);
    }
  };
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (types.size >= MAX_DISCOVERY_FIELDS) break;
      if (safePathSegment(key)) visit(value, key, 1);
    }
  }
  return [...types.entries()].map(([path, foundTypes]) => ({
    path,
    valueType: foundTypes.size > 1 ? "mixed" : [...foundTypes][0] ?? "unknown",
    examples: examples.get(path) ?? [],
  })).sort((left, right) => left.path.localeCompare(right.path));
}

function lastPathPart(path: string): string {
  return normalizedName(path.split(".").at(-1) ?? "");
}

function isTimestampExample(value: string): boolean {
  if (/^-?\d{9,16}$/.test(value)) return Boolean(normalizeOccurrenceTimestamp(Number(value)));
  return !Number.isNaN(Date.parse(value)) && value.length >= 8;
}

function makeSuggestions(fields: DiscoveredField[]): SuggestedFieldMapping[] {
  return (Object.entries(aliases) as Array<[SuggestedTargetField, typeof aliases[SuggestedTargetField]]>).map(([target, spec]) => {
    const candidates = fields.flatMap(field => {
      const name = lastPathPart(field.path);
      const index = spec.names.indexOf(name);
      if (index < 0) return [];
      let score = 0.98 - index * 0.035;
      const examples = field.examples;
      if (target === "occurredAt") {
        if (examples.some(isTimestampExample)) score = Math.min(0.99, score + 0.06);
        else score -= 0.35;
      }
      if (target === "eventType" && !examples.some(example => example !== "null" && example !== "[object]" && example !== "[array: 0]")) score -= 0.3;
      if (target === "sourceRecordId" && name === "id") score = 0.66;
      if (target === "assetKey" && name !== "assetkey") score = Math.min(score, 0.76);
      if (target === "errorCode" && name === "code") score = Math.min(score, 0.72);
      return [{ field, score }];
    }).sort((left, right) => right.score - left.score || left.field.path.localeCompare(right.field.path));
    const top = candidates[0];
    const ambiguous = Boolean(top && candidates.length > 1 && top.score - candidates[1]!.score < 0.12);
    const confidenceScore = Math.max(0, Math.min(0.99, top?.score ?? 0));
    const confidence = confidenceScore >= 0.85 ? "high" : confidenceScore >= 0.65 ? "medium" : "low";
    const sourcePath = top && !ambiguous && confidenceScore >= 0.65 ? top.field.path : null;
    let note = !top ? "No matching field was found. Choose a source field during review." :
      ambiguous ? "Several source fields are plausible. Choose one; none has been selected." :
        confidence === "low" ? "Low-confidence match. Confirm the source field manually." : "Review this suggestion and its example before activation.";
    if (target === "assetKey" && sourcePath && sourcePath !== "assetKey") {
      note = "This may be an external asset ID or name, not a registered KuduNS asset key. Confirm the match; unmatched assets are not auto-associated.";
    }
    return {
      target,
      sourcePath,
      confidence,
      confidenceScore: Number(confidenceScore.toFixed(2)),
      required: spec.required,
      ambiguous,
      alternatives: candidates.slice(0, 5).map(candidate => candidate.field.path),
      examples: top?.field.examples ?? [],
      note,
    };
  });
}

function definitionFor(suggestions: SuggestedFieldMapping[]) {
  const path = (field: SuggestedTargetField) => suggestions.find(item => item.target === field)?.sourcePath ?? undefined;
  const payload: Record<string, string> = {};
  for (const field of ["message", "severity", "errorCode"] as const) {
    const sourcePath = path(field);
    if (sourcePath) payload[field] = sourcePath;
  }
  return {
    ...(path("eventType") ? { eventType: path("eventType") } : {}),
    ...(path("occurredAt") ? { occurredAt: path("occurredAt") } : {}),
    ...(path("sourceRecordId") ? { sourceRecordId: path("sourceRecordId") } : {}),
    ...(path("assetKey") ? { assetKey: path("assetKey") } : {}),
    payload,
  };
}

function toPreview(
  records: Record<string, unknown>[],
  fields: DiscoveredField[],
  suggestions: SuggestedFieldMapping[],
): DataSourceDiscoveryResult["preview"] {
  const definition = definitionFor(suggestions);
  const pathFor = (target: SuggestedTargetField) => suggestions.find(item => item.target === target)?.sourcePath;
  const eventPath = pathFor("eventType");
  const timePath = pathFor("occurredAt");
  const idPath = pathFor("sourceRecordId");
  const seenIds = new Set<string>();
  return records.slice(0, MAX_PREVIEW_RECORDS).map((record, index) => {
    const issues: string[] = [];
    const eventType = eventPath ? readMappedField(record as JsonObject, eventPath) : undefined;
    const timestamp = timePath ? readMappedField(record as JsonObject, timePath) : undefined;
    if (!eventPath) issues.push("Choose a source for required Event type.");
    else if (typeof eventType !== "string" || !eventType.trim()) issues.push("Event type must be a non-empty string.");
    if (!timePath) issues.push("Choose a source for required Occurrence time.");
    else if (!normalizeOccurrenceTimestamp(timestamp)) issues.push("Occurrence time is not a supported date/time or Unix timestamp.");
    const sourceRecordId = idPath ? readMappedField(record as JsonObject, idPath) : undefined;
    if (sourceRecordId !== undefined && sourceRecordId !== null && sourceRecordId !== "") {
      const id = String(sourceRecordId);
      if (seenIds.has(id)) issues.push("This source record ID repeats in the preview; imports will be deduplicated.");
      seenIds.add(id);
    }
    const values: Record<string, string> = {};
    for (const field of fields) {
      values[field.path] = displayExample(readMappedField(record as JsonObject, field.path), field.path.split(".").at(-1));
    }
    const normalized: Record<string, string> = {};
    if (typeof eventType === "string" && eventType.trim()) normalized.eventType = eventType.trim();
    const normalizedTime = normalizeOccurrenceTimestamp(timestamp);
    if (normalizedTime) normalized.occurredAt = normalizedTime;
    if (idPath && sourceRecordId !== undefined && sourceRecordId !== null) normalized.sourceRecordId = displayExample(sourceRecordId);
    const assetPath = pathFor("assetKey");
    const assetKey = assetPath ? readMappedField(record as JsonObject, assetPath) : undefined;
    if (assetPath && assetKey !== undefined && assetKey !== null) normalized.assetKey = displayExample(assetKey);
    for (const [target, sourcePath] of Object.entries(definition.payload ?? {})) {
      const value = readMappedField(record as JsonObject, sourcePath);
      if (value !== undefined) normalized[target] = displayExample(value, target);
    }
    const rejected = issues.some(issue => /must be|not a supported|repeats/i.test(issue));
    return { recordNumber: index + 1, state: rejected ? "rejected" : issues.length ? "warning" : "valid", issues, values, normalized };
  });
}

export function buildDiscoveryResult(
  sourceType: DataSourceType,
  document: unknown,
  requestedPath?: string,
): { result: DataSourceDiscoveryResult; selectedRows: Record<string, unknown>[] } {
  let candidates: LocatedArray[];
  let truncated = false;
  let nestedArrays = false;
  if (sourceType === "csv_file") {
    if (typeof document !== "string") throw new ApiFailure(400, "DISCOVERY_INVALID_FILE", "The CSV file could not be decoded as UTF-8.");
    const parsed = parseCsv(document, false);
    const rows = parsed.rows.map(row => Object.fromEntries(parsed.headers.map((header, index) => [header, row.values[index] ?? ""])));
    candidates = rows.length ? [{ path: "$", rows, count: rows.length, supported: true }] : [];
  } else {
    const found = locateRecordArrays(document);
    candidates = found.arrays;
    truncated = found.truncated;
    nestedArrays = found.nestedArrays;
  }
  const recordPaths: DiscoveryRecordPath[] = candidates.map(candidate => ({
    path: candidate.path,
    recordCount: candidate.count,
    supported: candidate.supported,
  }));
  const selectedRecordPath = requestedPath
    ? candidates.find(candidate => candidate.path === requestedPath && candidate.supported)?.path ?? null
    : candidates.length === 1 && candidates[0]!.supported ? candidates[0]!.path : null;
  if (requestedPath && !selectedRecordPath) {
    throw new ApiFailure(400, "DISCOVERY_PATH_INVALID", "Choose one of the supported record collections shown in the discovery results.");
  }
  const selected = selectedRecordPath ? candidates.find(candidate => candidate.path === selectedRecordPath) : undefined;
  const records = selected?.rows.slice(0, MAX_PREVIEW_RECORDS) ?? [];
    const fields = collectLeafFields(records, sourceType === "csv_file");
  const suggestions = makeSuggestions(fields);
  const warnings: string[] = [];
  if (truncated) warnings.push("Discovery reached a safety limit or found mixed record arrays. Some content is not shown.");
  if (nestedArrays) warnings.push("Nested arrays inside sample records are not flattened automatically. Review their structure before mapping.");
  if (recordPaths.some(path => !path.supported)) warnings.push("Some record collections use paths that cannot be represented safely by the current mapping format.");
  if (candidates.length > 1 && !selectedRecordPath) warnings.push("Choose a record collection before reviewing its fields.");
  if (!candidates.length) warnings.push("No array of records was found. Check the response structure or select a supported JSON/CSV file.");
  if (fields.length >= MAX_DISCOVERY_FIELDS) warnings.push("The field preview was capped; remaining fields are preserved in the original record payload.");
  if (fields.length) warnings.push("Sensitive-looking field values are hidden in examples. Unmapped source fields remain in each imported event payload.");
  const preview = toPreview(records, fields, suggestions);
  return {
    result: { sourceType: sourceType as DataSourceDiscoveryResult["sourceType"], recordPaths, selectedRecordPath, fields, suggestions, preview, warnings },
    selectedRows: records,
  };
}

function isJsonConfiguration(configuration: DataSourceConfigurationInput): configuration is Extract<DataSourceConfigurationInput, { kind: "json_file" }> {
  return configuration.kind === "json_file";
}

export function registerDataDiscoveryRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  importDirectory: string,
  policy: { trustedHosts?: string[]; allowLoopbackForTests?: boolean } = {},
): void {
  app.post<{ Body: unknown }>("/api/v1/data-sources/discover", async request => {
    if (!isRecord(request.body)) throw new ApiFailure(400, "DISCOVERY_REQUEST_INVALID", "Provide a data source type and configuration.");
    const sourceType = request.body.sourceType;
    if (sourceType !== "rest_api" && sourceType !== "json_file" && sourceType !== "csv_file") {
      throw new ApiFailure(400, "DISCOVERY_SOURCE_UNSUPPORTED", "Discovery supports REST API, JSON and CSV sources.");
    }
    let validated;
    try {
      validated = validateDataSourceCreate({
        sourceKey: "discovery-preview",
        displayName: "Discovery preview",
        sourceType,
        configuration: request.body.configuration,
        enabled: false,
      });
    } catch (cause) {
      if (cause instanceof ApiFailure) throw cause;
      throw new ApiFailure(400, "DISCOVERY_REQUEST_INVALID", "Correct the source configuration before discovering data.");
    }
    const selectedPath = typeof request.body.recordPath === "string" && request.body.recordPath.trim()
      ? request.body.recordPath.trim()
      : undefined;
    let document: unknown;
    let requestedPath = selectedPath;
    if (sourceType === "rest_api") {
      const config = validated.configuration;
      if (config.kind !== "rest_api") throw new ApiFailure(400, "DISCOVERY_REQUEST_INVALID", "The REST configuration is invalid.");
      document = await fetchRestDiscoveryDocument(config as StoredSourceConfiguration & Extract<StoredSourceConfiguration, { kind: "rest_api" }>, policy);
      if (!requestedPath && config.recordsPath) requestedPath = config.recordsPath;
    } else {
      const config = validated.configuration;
      if (config.kind !== "json_file" && config.kind !== "csv_file") {
        throw new ApiFailure(400, "DISCOVERY_REQUEST_INVALID", "The file configuration is invalid.");
      }
      if (sourceType === "csv_file" && !config.relativePath.toLowerCase().endsWith(".csv")) {
        throw new ApiFailure(400, "DISCOVERY_FILE_FORMAT_MISMATCH", "Choose a .csv file for this source.");
      }
      if (sourceType === "json_file" && !config.relativePath.toLowerCase().endsWith(".json")) {
        throw new ApiFailure(400, "DISCOVERY_FILE_FORMAT_MISMATCH", "Choose a .json file for this source.");
      }
      const filePath = await resolveImportFile(importDirectory, config.relativePath);
      const bytes = await readBoundedFile(filePath);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
      if (sourceType === "csv_file") document = text;
      else {
        try { document = JSON.parse(text) as unknown; }
        catch { throw new ApiFailure(400, "DISCOVERY_INVALID_JSON", "The JSON file is malformed."); }
      }
      if (!requestedPath && isJsonConfiguration(config) && config.recordsPath) requestedPath = config.recordsPath;
    }
    const { result, selectedRows } = buildDiscoveryResult(sourceType, document, requestedPath);
    if (result.selectedRecordPath === "$" && sourceType !== "csv_file") {
      result.selectedRecordPath = "$";
    }
    const definition = definitionFor(result.suggestions);
    const validation = validateEventMappingDefinition(definition);
    if (!validation.valid) {
      result.warnings.push("Required event fields need review before an event mapping can be created.");
    }
    if (result.selectedRecordPath && result.selectedRecordPath !== "$") {
      result.warnings.push("This record path is a preview selection. Save it in source settings before Sync now or file import.");
    }
    // Confirm exact registered asset keys for the preview without auto-creating or associating assets.
    const assetSuggestion = result.suggestions.find(item => item.target === "assetKey");
    if (assetSuggestion?.sourcePath) {
      let unmatchedAsset = false;
      for (const [index, record] of selectedRows.slice(0, MAX_PREVIEW_RECORDS).entries()) {
        const value = readMappedField(record as JsonObject, assetSuggestion.sourcePath);
        if (value === undefined || value === null || value === "") continue;
        const exists = await db.selectFrom("assets").select("id")
          .where("asset_key", "=", String(value)).where("archived_at", "is", null).executeTakeFirst();
        if (!exists) {
          unmatchedAsset = true;
          const preview = result.preview[index];
          if (preview) {
            preview.state = "rejected";
            preview.issues.push("Suggested asset identifier does not match an active registered KuduNS asset key.");
          }
        }
      }
      if (unmatchedAsset) result.warnings.push("One or more suggested asset identifiers do not exactly match an active KuduNS asset key. No asset was automatically associated.");
    }
    return result;
  });
}
