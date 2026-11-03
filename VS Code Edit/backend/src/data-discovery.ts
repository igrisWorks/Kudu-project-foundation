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
import {
  loadAssetMatchContext,
  normalizeOccurrenceTimestamp,
  readMappedField,
  resolveAssetIdentifier,
  validateEventMappingDefinition,
} from "./event-mappings.js";
import type { Database, StoredSourceConfiguration } from "./database.js";
import { extendRestDiscoverySample, fetchRestDiscoveryDocument } from "./rest-sync.js";
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

const aliases: Record<SuggestedTargetField, { names: Record<string, number>; label: string; required: boolean }> = {
  eventType: {
    names: {
      eventtype: 0.98, faulttype: 0.98, alarmtype: 0.98, eventname: 0.94, faultname: 0.94,
      alarmname: 0.94, category: 0.8, type: 0.74, event: 0.68,
    },
    label: "Event type", required: true,
  },
  occurredAt: {
    names: {
      occurredat: 0.98, eventtime: 0.96, faulttime: 0.96, eventdatetime: 0.96, faulttimestamp: 0.96,
      alarmdatetime: 0.96, occurredtime: 0.94, alarmtime: 0.92, timestamp: 0.9, timestamputc: 0.9,
      datetime: 0.88, createdat: 0.82, receivedat: 0.8, time: 0.68, created: 0.64,
    },
    label: "Occurrence time", required: true,
  },
  sourceRecordId: {
    names: {
      sourcerecordid: 0.99, eventid: 0.98, faultid: 0.98, alarmid: 0.96, recordid: 0.96,
      occurrenceid: 0.94, eventuuid: 0.92, faultnumber: 0.82, id: 0.66,
    },
    label: "Source record ID", required: false,
  },
  assetKey: {
    names: {
      assetkey: 0.98, assetid: 0.94, machineid: 0.9, equipmentid: 0.9, deviceid: 0.9,
      machinekey: 0.9, equipmentkey: 0.9, devicekey: 0.9, machinename: 0.84,
      equipmentname: 0.84, unitid: 0.8, stationid: 0.8, lineid: 0.76,
    },
    label: "Asset identifier", required: false,
  },
  message: {
    names: { faultmessage: 0.98, eventmessage: 0.98, alarmmessage: 0.98, message: 0.95, description: 0.9, details: 0.83, text: 0.7 },
    label: "Message", required: false,
  },
  severity: {
    names: { severity: 0.98, severitylevel: 0.96, alarmpriority: 0.94, priority: 0.89, criticality: 0.85, level: 0.74 },
    label: "Severity", required: false,
  },
  errorCode: {
    names: { faultcode: 0.98, errorcode: 0.98, alarmcode: 0.95, diagnosticcode: 0.95, eventcode: 0.83, code: 0.7 },
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
    if (typeof value === "string" && normalizeOccurrenceTimestamp(value)) {
      valueType = "datetime";
    } else if (typeof value === "number" && normalizeOccurrenceTimestamp(value)) {
      valueType = "datetime";
    } else if (csv && typeof value === "string") {
      if (/^(true|false)$/i.test(value.trim())) valueType = "boolean";
      else if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()) && Number.isFinite(Number(value))) valueType = "number";
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
  return Boolean(normalizeOccurrenceTimestamp(value));
}

function makeSuggestions(fields: DiscoveredField[]): SuggestedFieldMapping[] {
  return (Object.entries(aliases) as Array<[SuggestedTargetField, typeof aliases[SuggestedTargetField]]>).map(([target, spec]) => {
    const candidates = fields.flatMap(field => {
      const name = lastPathPart(field.path);
      const aliasScore = spec.names[name];
      if (aliasScore === undefined) return [];
      let score = aliasScore;
      const examples = field.examples;
      if (target === "occurredAt") {
        if (examples.some(isTimestampExample)) score = Math.min(0.99, score + 0.08);
        else score -= 0.38;
        if (field.valueType === "datetime") score = Math.min(0.99, score + 0.04);
      }
      const stringOrNumber = field.valueType === "string" || field.valueType === "number";
      if (target === "eventType") {
        if (field.valueType === "string") score += 0.03;
        else score -= 0.28;
      }
      if (target === "sourceRecordId" || target === "assetKey" || target === "severity" || target === "errorCode") {
        if (!stringOrNumber) score -= 0.18;
      }
      if (target === "message") {
        if (field.valueType === "string") score += 0.02;
        else score -= 0.2;
      }
      if (field.valueType === "mixed") score -= 0.1;
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
    result: { sourceType: sourceType as DataSourceDiscoveryResult["sourceType"], sampledPageCount: 1, recordPaths, selectedRecordPath, fields, suggestions, preview, warnings },
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
    let discoverySourceKey = "";
    if (Object.hasOwn(request.body, "sourceKey")) {
      if (typeof request.body.sourceKey !== "string" || request.body.sourceKey.trim().length > 80) {
        throw new ApiFailure(400, "DISCOVERY_SOURCE_KEY_INVALID", "The optional source key must be valid text up to 80 characters.");
      }
      discoverySourceKey = request.body.sourceKey.trim();
      if (discoverySourceKey && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(discoverySourceKey)) {
        throw new ApiFailure(400, "DISCOVERY_SOURCE_KEY_INVALID", "Use a source key containing letters, numbers, dots, dashes, or underscores.");
      }
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
    let restConfiguration: Extract<StoredSourceConfiguration, { kind: "rest_api" }> | undefined;
    if (sourceType === "rest_api") {
      const config = validated.configuration;
      if (config.kind !== "rest_api") throw new ApiFailure(400, "DISCOVERY_REQUEST_INVALID", "The REST configuration is invalid.");
      const restConfig = config as StoredSourceConfiguration & Extract<StoredSourceConfiguration, { kind: "rest_api" }>;
      restConfiguration = restConfig;
      document = await fetchRestDiscoveryDocument(restConfig, policy);
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
    let discovery = buildDiscoveryResult(sourceType, document, requestedPath);
    if (sourceType === "rest_api" && restConfiguration?.pagination && discovery.result.selectedRecordPath) {
      const sample = await extendRestDiscoverySample(
        restConfiguration,
        document,
        discovery.result.selectedRecordPath,
        policy,
      );
      if (sample.sampledPageCount > 1) {
        document = sample.document;
        discovery = buildDiscoveryResult(sourceType, document, requestedPath ?? discovery.result.selectedRecordPath);
        discovery.result.sampledPageCount = sample.sampledPageCount;
        discovery.result.warnings.push(
          `Discovery sampled ${sample.sampledPageCount} pages; this is a bounded sample, not a total source count.`,
        );
      }
    }
    const { result, selectedRows } = discovery;
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
    // Reuse the ingestion resolver for preview only; suggestions never associate or create assets.
    const assetSuggestion = result.suggestions.find(item => item.target === "assetKey");
    if (assetSuggestion?.sourcePath) {
      const assetContext = await loadAssetMatchContext(db, discoverySourceKey);
      let nonMatchedAsset = false;
      for (const [index, record] of selectedRows.slice(0, MAX_PREVIEW_RECORDS).entries()) {
        const value = readMappedField(record as JsonObject, assetSuggestion.sourcePath);
        if (value === undefined || value === null || value === "") continue;
        const resolution = resolveAssetIdentifier(String(value), assetContext);
        const preview = result.preview[index];
        if (!preview) continue;
        const status = resolution.provenance.status;
        const confidence = resolution.provenance.confidence;
        const matchType = resolution.provenance.matchType;
        if (status === "matched" || status === "ambiguous" || status === "unmatched") {
          preview.assetMatch = {
            status,
            confidence: typeof confidence === "number" ? confidence : 0,
            ...(matchType === "asset_key" || matchType === "registered_external_identifier" || matchType === "name_suggestion"
              ? { matchType }
              : {}),
          };
        }
        if (status !== "matched") nonMatchedAsset = true;
      }
      if (nonMatchedAsset) result.warnings.push(
        "Some suggested asset identifiers are unmatched or ambiguous. They remain unassociated; name matches are suggestions only.",
      );
    }
    return result;
  });
}
