import type {
  DataSourceConfigurationInput,
  DataSourceDiscoveryResult,
  DataSourceType,
  DiscoveredStructure,
  DiscoveredStructureField,
  DiscoveredField,
  DiscoveryRecordPath,
  JsonObject,
  SuggestedFieldMapping,
  SuggestedTargetField,
} from "@kudu/shared";
import { SUGGESTED_PAYLOAD_TARGETS } from "@kudu/shared";
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
const MAX_DISCOVERY_STRUCTURES = 40;
const MAX_STRUCTURE_NODES = 1_000;
const MAX_STRUCTURE_CHILD_FIELDS = 12;
const MAX_PREVIEW_RECORDS = 5;
const MAX_EXAMPLE_LENGTH = 96;
const sensitiveName = /password|secret|token|credential|authorization|cookie|api.?key|private.?key|bearer/i;
const unsafePathParts = new Set(["__proto__", "prototype", "constructor"]);
const placeholderValues = new Set(["", "null", "undefined", "n/a", "na", "none", "not available", "tbd", "-", "--"]);

type RecognitionShape = "scalar" | "object" | "container";
type TargetAliasDefinition = {
  names: Record<string, number>;
  label: string;
  required: boolean;
  shape: RecognitionShape;
};

interface LocatedArray {
  path: string;
  rows: Record<string, unknown>[];
  count: number;
  supported: boolean;
}

interface InspectedField extends DiscoveredField {
  presentCount: number;
  placeholderCount: number;
  validTimestampCount: number;
  numericCount: number;
}

const aliases: Record<SuggestedTargetField, TargetAliasDefinition> = {
  eventType: {
    names: {
      eventtype: 0.98, faulttype: 0.98, alarmtype: 0.98, eventname: 0.94, faultname: 0.94,
      alarmname: 0.94, incidenttype: 0.92, eventkind: 0.91, fault: 0.86, alarm: 0.86,
      category: 0.8, type: 0.74, event: 0.68,
    },
    label: "Event type", required: true, shape: "scalar",
  },
  occurredAt: {
    names: {
      occurredat: 0.98, eventtime: 0.96, faulttime: 0.96, eventdatetime: 0.96, faulttimestamp: 0.96,
      alarmdatetime: 0.96, occurredtime: 0.94, eventtimestamp: 0.94, alarmtime: 0.92,
      timestamp: 0.9, timestamputc: 0.9, datetime: 0.88, starttime: 0.84,
      createdat: 0.82, receivedat: 0.8, time: 0.68, created: 0.64,
    },
    label: "Occurrence time", required: true, shape: "scalar",
  },
  sourceRecordId: {
    names: {
      sourcerecordid: 0.99, eventid: 0.98, faultid: 0.98, alarmid: 0.96, recordid: 0.96,
      occurrenceid: 0.94, eventuuid: 0.92, recordnumber: 0.84, faultnumber: 0.82, id: 0.66,
    },
    label: "Source record ID", required: false, shape: "scalar",
  },
  assetKey: {
    names: {
      assetkey: 0.98, assetid: 0.94, assetidentifier: 0.94, machineid: 0.9, equipmentid: 0.9, deviceid: 0.9,
      machinekey: 0.9, equipmentkey: 0.9, devicekey: 0.9, unitid: 0.8, stationid: 0.8, lineid: 0.76,
    },
    label: "Asset identifier", required: false, shape: "scalar",
  },
  message: {
    names: { faultmessage: 0.98, eventmessage: 0.98, alarmmessage: 0.98, message: 0.95, description: 0.9, details: 0.83, text: 0.7 },
    label: "Message", required: false, shape: "scalar",
  },
  severity: {
    names: { severity: 0.98, severitylevel: 0.96, alarmpriority: 0.94, priority: 0.89, criticality: 0.85, level: 0.74 },
    label: "Severity", required: false, shape: "scalar",
  },
  errorCode: {
    names: { faultcode: 0.98, errorcode: 0.98, alarmcode: 0.95, diagnosticcode: 0.95, eventcode: 0.83, code: 0.7 },
    label: "Error code", required: false, shape: "scalar",
  },
  assetName: {
    names: {
      assetname: 0.97, equipmentname: 0.94, machinename: 0.92, devicename: 0.9,
      unitname: 0.86, stationname: 0.84,
    },
    label: "Asset name", required: false, shape: "scalar",
  },
  status: {
    names: {
      status: 0.97, state: 0.94, operationalstate: 0.96, operatingstate: 0.96,
      condition: 0.9, health: 0.86, mode: 0.82,
    },
    label: "Asset or event state", required: false, shape: "scalar",
  },
  measurementName: {
    names: {
      measurementname: 0.98, metricname: 0.97, parametername: 0.93,
      signalname: 0.9, tagname: 0.86, measurement: 0.82, metric: 0.8,
    },
    label: "Measurement name", required: false, shape: "scalar",
  },
  measurementValue: {
    names: {
      measurementvalue: 0.98, measuredvalue: 0.97, processvalue: 0.92,
      reading: 0.9, numericvalue: 0.88, value: 0.68,
    },
    label: "Measurement value", required: false, shape: "scalar",
  },
  measurementUnit: {
    names: {
      measurementunit: 0.98, unitofmeasure: 0.96, units: 0.9, uom: 0.9, unit: 0.68,
    },
    label: "Measurement unit", required: false, shape: "scalar",
  },
  measurements: {
    names: { measurements: 0.99, measurement: 0.94, readings: 0.94, metrics: 0.94, observations: 0.9 },
    label: "Measurement group", required: false, shape: "container",
  },
  relationships: {
    names: {
      relationships: 0.99, relationship: 0.98, relations: 0.95,
      links: 0.9, references: 0.9, parent: 0.84, children: 0.84,
    },
    label: "Relationships", required: false, shape: "container",
  },
  sourceMetadata: {
    names: {
      sourcemetadata: 0.99, metadata: 0.97, sourceinfo: 0.94,
      attributes: 0.9, context: 0.82, properties: 0.78,
    },
    label: "Source metadata", required: false, shape: "object",
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

function isPlaceholder(value: unknown): boolean {
  return value === null || value === undefined ||
    (typeof value === "string" && placeholderValues.has(value.trim().toLowerCase()));
}

function isNumericValue(value: unknown, csv = false): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string" || (!csv && !value.trim())) return false;
  return /^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()) && Number.isFinite(Number(value));
}

function discoveredValueType(value: unknown, csv = false, sourceTimezone?: string): DiscoveredField["valueType"] {
  if (Array.isArray(value)) return "array";
  if (value === null) return "unknown";
  if (isRecord(value)) return "object";
  if (typeof value === "string" || typeof value === "number") {
    if (normalizeOccurrenceTimestamp(value, sourceTimezone)) return "datetime";
    if (csv && typeof value === "string") {
      if (/^(true|false)$/i.test(value.trim())) return "boolean";
      if (isNumericValue(value, true)) return "number";
    }
    return typeof value as "string" | "number";
  }
  if (typeof value === "boolean") return "boolean";
  return "unknown";
}

function collectLeafFields(records: Record<string, unknown>[], csv = false, sourceTimezone?: string): InspectedField[] {
  const entries = new Map<string, {
    types: Set<DiscoveredField["valueType"]>;
    examples: string[];
    presentCount: number;
    placeholderCount: number;
    validTimestampCount: number;
    numericCount: number;
  }>();
  const visit = (value: unknown, path: string, depth: number) => {
    const leafName = path.split(".").at(-1) ?? "";
    if (!path || !supportedPath(path) || depth > MAX_DISCOVERY_DEPTH || sensitiveName.test(leafName)) return;
    const valueType = discoveredValueType(value, csv, sourceTimezone);
    const entry = entries.get(path) ?? {
      types: new Set<DiscoveredField["valueType"]>(),
      examples: [],
      presentCount: 0,
      placeholderCount: 0,
      validTimestampCount: 0,
      numericCount: 0,
    };
    entry.types.add(valueType);
    entry.presentCount += 1;
    if (isPlaceholder(value)) entry.placeholderCount += 1;
    if (normalizeOccurrenceTimestamp(value, sourceTimezone)) entry.validTimestampCount += 1;
    if (!isPlaceholder(value) && isNumericValue(value, csv)) entry.numericCount += 1;
    if (entry.examples.length < 3 && value !== undefined) {
      const example = displayExample(value, leafName);
      if (!entry.examples.includes(example)) entry.examples.push(example);
    }
    entries.set(path, entry);

    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (entries.size >= MAX_DISCOVERY_FIELDS) break;
        if (safePathSegment(key)) visit(child, `${path}.${key}`, depth + 1);
      }
    }
  };

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (entries.size >= MAX_DISCOVERY_FIELDS) break;
      if (safePathSegment(key)) visit(value, key, 1);
    }
  }
  return [...entries.entries()].map(([path, entry]) => ({
    path,
    valueType: entry.types.size > 1 ? "mixed" : [...entry.types][0] ?? "unknown",
    examples: entry.examples,
    presentCount: entry.presentCount,
    placeholderCount: entry.placeholderCount,
    validTimestampCount: entry.validTimestampCount,
    numericCount: entry.numericCount,
  })).sort((left, right) => left.path.localeCompare(right.path));
}

function lastPathPart(path: string): string {
  return normalizedName(path.split(".").at(-1) ?? "");
}

function shapeMatches(field: InspectedField, shape: RecognitionShape): boolean {
  if (shape === "scalar") return field.valueType !== "object" && field.valueType !== "array";
  if (shape === "object") return field.valueType === "object";
  return field.valueType === "object" || field.valueType === "array";
}

function makeSuggestions(fields: InspectedField[], sampleCount: number): SuggestedFieldMapping[] {
  return (Object.entries(aliases) as Array<[SuggestedTargetField, typeof aliases[SuggestedTargetField]]>).map(([target, spec]) => {
    const candidates = fields.flatMap(field => {
      const name = lastPathPart(field.path);
      const aliasScore = spec.names[name];
      if (aliasScore === undefined || !shapeMatches(field, spec.shape)) return [];
      let score = aliasScore;
      const presentRatio = sampleCount ? field.presentCount / sampleCount : 0;
      const usableCount = Math.max(0, field.presentCount - field.placeholderCount);
      const usableRatio = field.presentCount ? usableCount / field.presentCount : 0;
      if (presentRatio >= 0.8) score += 0.04;
      else if (presentRatio < 0.5) score -= 0.14;
      if (usableRatio < 0.5) score -= 0.2;
      else if (usableRatio < 0.8) score -= 0.08;
      if (field.valueType === "mixed") score -= 0.12;

      if (target === "occurredAt") {
        const timestampRatio = field.presentCount ? field.validTimestampCount / field.presentCount : 0;
        if (timestampRatio >= 0.8) score += 0.14;
        else if (timestampRatio > 0) score += 0.04;
        else score -= 0.4;
        if (field.valueType === "datetime") score += 0.04;
      }
      if (target === "measurementValue") {
        const numericRatio = usableCount ? field.numericCount / usableCount : 0;
        if (numericRatio >= 0.8) score += 0.1;
        else if (numericRatio > 0) score += 0.04;
        else score -= 0.12;
      }
      if (target === "eventType" || target === "message" || target === "severity" ||
        target === "errorCode" || target === "assetName" || target === "status" ||
        target === "measurementName" || target === "measurementUnit" || target === "sourceRecordId" ||
        target === "assetKey") {
        if (field.valueType === "string" || field.valueType === "datetime") score += 0.03;
        else if (field.valueType === "number") score += 0.01;
        else if (field.valueType === "boolean") score -= 0.08;
      }
      const evidence = {
        presentRatio,
        usableRatio,
        timestampRatio: field.presentCount ? field.validTimestampCount / field.presentCount : 0,
      };
      return [{ field, score: Math.max(0, Math.min(0.99, score)), evidence }];
    }).sort((left, right) => right.score - left.score || left.field.path.localeCompare(right.field.path));
    const top = candidates[0];
    const ambiguous = Boolean(top && candidates.length > 1 && top.score - candidates[1]!.score < 0.12);
    const confidenceScore = Math.max(0, Math.min(0.99, top?.score ?? 0));
    const confidence = confidenceScore >= 0.85 ? "high" : confidenceScore >= 0.65 ? "medium" : "low";
    const safeEvidence = Boolean(top &&
      top.evidence.presentRatio >= 0.8 &&
      top.evidence.usableRatio >= 0.8 &&
      (target !== "occurredAt" || top.evidence.timestampRatio >= 0.8));
    const sourcePath = top && !ambiguous && confidence === "high" && safeEvidence ? top.field.path : null;
    const evidenceText = top
      ? `${top.field.presentCount} of ${sampleCount} sampled records contain this field; ${Math.max(0, top.field.presentCount - top.field.placeholderCount)} contain non-placeholder values.` +
        (target === "occurredAt"
          ? ` ${top.field.validTimestampCount} contain a valid explicitly zoned or supported Unix timestamp.`
          : "")
      : "";
    let note = !top ? "No matching field was found. Choose a source field during review." :
      ambiguous ? "Several source fields are plausible. Choose one; none has been selected." :
        confidence !== "high" || !safeEvidence
          ? `Evidence is insufficient for preselection. Review the field and examples. ${evidenceText}`
          : `Strong name and sample evidence; review before validation and activation. ${evidenceText}`;
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

function possibleTargetForStructureField(path: string, valueType: DiscoveredField["valueType"]): SuggestedTargetField | undefined {
  const name = normalizedName(path.replace(/\[\]/g, "").split(".").at(-1) ?? "");
  const candidates = (Object.entries(aliases) as Array<[SuggestedTargetField, TargetAliasDefinition]>)
    .flatMap(([target, spec]) => {
      const score = spec.names[name];
      if (score === undefined) return [];
      const field = {
        path,
        valueType,
        examples: [],
        presentCount: 1,
        placeholderCount: 0,
        validTimestampCount: 0,
        numericCount: 0,
      };
      return shapeMatches(field, spec.shape) ? [{ target, score }] : [];
    })
    .sort((left, right) => right.score - left.score || left.target.localeCompare(right.target));
  const top = candidates[0];
  if (!top || top.score < 0.78 || (candidates[1] && top.score - candidates[1]!.score < 0.12)) return undefined;
  return top.target;
}

function structureMeaning(
  path: string,
  kind: "object" | "array",
  childFields: DiscoveredStructureField[],
): { meaning: DiscoveredStructure["possibleMeaning"]; confidenceScore: number; note: string } {
  const segments = path.replace(/\[\]/g, "").split(".").map(normalizedName);
  if (segments.some(segment => ["measurement", "measurements", "metric", "metrics", "reading", "readings", "observation", "observations"].includes(segment))) {
    return {
      meaning: "measurements",
      confidenceScore: 0.92,
      note: "The structure name suggests measurement data; its contents are retained as-is and are not flattened.",
    };
  }
  if (segments.some(segment => ["relationship", "relationships", "relation", "relations", "link", "links", "reference", "references", "parent", "parents", "child", "children"].includes(segment))) {
    return {
      meaning: "relationships",
      confidenceScore: 0.9,
      note: "The structure name suggests relationships; inspect its child fields before deciding how to use it.",
    };
  }
  if (segments.some(segment => ["metadata", "attributes", "context", "properties", "sourceinfo"].includes(segment))) {
    return {
      meaning: "source-metadata",
      confidenceScore: 0.9,
      note: "The structure name suggests source metadata; it remains a structured value in the original record.",
    };
  }
  if (
    kind === "array" &&
    childFields.some(field => field.possibleTarget === "eventType") &&
    childFields.some(field => field.possibleTarget === "occurredAt")
  ) {
    return {
      meaning: "event-records",
      confidenceScore: 0.76,
      note: "Child field names resemble event records, but array entries are not mapped as scalar fields.",
    };
  }
  return {
    meaning: "unknown",
    confidenceScore: 0,
    note: "The structure is shown without assigning a meaning because the available evidence is insufficient.",
  };
}

function collectStructures(records: Record<string, unknown>[], csv = false): DiscoveredStructure[] {
  interface MutableStructure {
    path: string;
    kind: "object" | "array";
    sampleCount: number;
    itemCount: number;
    childFields: Map<string, DiscoveredStructureField>;
  }
  const structures = new Map<string, MutableStructure>();
  let visited = 0;
  const safeStructuralPath = (path: string) => path.split(".").every(part => {
    const name = part.replace(/\[\]/g, "");
    return safePathSegment(name) && !sensitiveName.test(name);
  });
  const addStructure = (path: string, kind: "object" | "array", itemCount = 0): MutableStructure | undefined => {
    if ((!supportedPath(path) && !path.includes("[]")) || !safeStructuralPath(path)) return undefined;
    let structure = structures.get(path);
    if (!structure && structures.size < MAX_DISCOVERY_STRUCTURES) {
      structure = { path, kind, sampleCount: 0, itemCount: 0, childFields: new Map() };
      structures.set(path, structure);
    }
    if (structure && structure.kind === kind) {
      structure.sampleCount += 1;
      structure.itemCount += itemCount;
      return structure;
    }
    return undefined;
  };
  const addChildField = (structure: MutableStructure, path: string, value: unknown) => {
    if (structure.childFields.size >= MAX_STRUCTURE_CHILD_FIELDS || !safeStructuralPath(path)) return;
    const valueType = discoveredValueType(value, csv);
    const possibleTarget = possibleTargetForStructureField(path, valueType);
    const existing = structure.childFields.get(path);
    if (!existing || existing.valueType !== valueType) {
      structure.childFields.set(path, {
        path,
        valueType: existing ? "mixed" : valueType,
        ...(possibleTarget ? { possibleTarget } : {}),
      });
    }
  };
  const visit = (value: unknown, path: string, depth: number) => {
    visited += 1;
    if (visited > MAX_STRUCTURE_NODES || depth > MAX_DISCOVERY_DEPTH || structures.size >= MAX_DISCOVERY_STRUCTURES) return;
    if (isRecord(value)) {
      const structure = addStructure(path, "object");
      if (!structure) return;
      for (const [key, child] of Object.entries(value)) {
        if (!safePathSegment(key) || sensitiveName.test(key)) continue;
        if (structure.childFields.size >= MAX_STRUCTURE_CHILD_FIELDS) break;
        const childPath = `${path}.${key}`;
        addChildField(structure, childPath, child);
        if (isRecord(child) || Array.isArray(child)) visit(child, childPath, depth + 1);
      }
      return;
    }
    if (Array.isArray(value)) {
      const structure = addStructure(path, "array", value.length);
      if (!structure) return;
      for (const item of value.slice(0, MAX_PREVIEW_RECORDS)) {
        if (isRecord(item)) {
          for (const [key, child] of Object.entries(item)) {
            if (!safePathSegment(key) || sensitiveName.test(key)) continue;
            if (structure.childFields.size >= MAX_STRUCTURE_CHILD_FIELDS) break;
            const childPath = `${path}[].${key}`;
            addChildField(structure, childPath, child);
            if (isRecord(child) || Array.isArray(child)) visit(child, childPath, depth + 1);
          }
        } else {
          addChildField(structure, `${path}[]`, item);
        }
      }
    }
  };

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (safePathSegment(key) && !sensitiveName.test(key) && (isRecord(value) || Array.isArray(value))) {
        visit(value, key, 1);
      }
    }
  }

  return [...structures.values()].map(structure => {
    const childFields = [...structure.childFields.values()].sort((left, right) => left.path.localeCompare(right.path));
    const meaning = structureMeaning(structure.path, structure.kind, childFields);
    return {
      path: structure.path,
      kind: structure.kind,
      sampleCount: structure.sampleCount,
      itemCount: structure.itemCount,
      childFields,
      possibleMeaning: meaning.meaning,
      confidenceScore: meaning.confidenceScore,
      note: meaning.note,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function definitionFor(suggestions: SuggestedFieldMapping[]) {
  const path = (field: SuggestedTargetField) => suggestions.find(item => item.target === field)?.sourcePath ?? undefined;
  const payload: Record<string, string> = {};
  for (const field of SUGGESTED_PAYLOAD_TARGETS) {
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
  sourceTimezone?: string,
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
    else if (!normalizeOccurrenceTimestamp(timestamp, sourceTimezone)) issues.push("Occurrence time is not supported, ambiguous, or missing a configured source time zone.");
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
    const normalizedTime = normalizeOccurrenceTimestamp(timestamp, sourceTimezone);
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
  sourceTimezone?: string,
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
  const inspectedFields = collectLeafFields(records, sourceType === "csv_file", sourceTimezone);
  const fields: DiscoveredField[] = inspectedFields.map(({ path, valueType, examples }) => ({ path, valueType, examples }));
  const suggestions = makeSuggestions(inspectedFields, records.length);
  const structures = collectStructures(records, sourceType === "csv_file");
  const warnings: string[] = [];
  if (truncated) warnings.push("Discovery reached a safety limit or found mixed record arrays. Some content is not shown.");
  if (nestedArrays) warnings.push("Nested arrays inside sample records are not flattened automatically. Review their structure before mapping.");
  if (recordPaths.some(path => !path.supported)) warnings.push("Some record collections use paths that cannot be represented safely by the current mapping format.");
  if (candidates.length > 1 && !selectedRecordPath) warnings.push("Choose a record collection before reviewing its fields.");
  if (!candidates.length) warnings.push("No array of records was found. Check the response structure or select a supported JSON/CSV file.");
  if (fields.length >= MAX_DISCOVERY_FIELDS) warnings.push("The field preview was capped; remaining fields are preserved in the original record payload.");
  if (structures.some(structure => structure.kind === "array")) {
    warnings.push("Nested arrays are summarized for review, not flattened into event fields. Imports retain their original structure.");
  }
  if (fields.length) warnings.push("Sensitive-looking field values are hidden in examples. Unmapped source fields remain in each imported event payload.");
  const preview = toPreview(records, fields, suggestions, sourceTimezone);
  return {
    result: {
      sourceType: sourceType as DataSourceDiscoveryResult["sourceType"],
      sampledPageCount: 1,
      recordPaths,
      selectedRecordPath,
      fields,
      suggestions,
      structures,
      preview,
      warnings,
    },
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
    const sourceTimezone = "sourceTimezone" in validated.configuration
      ? validated.configuration.sourceTimezone
      : undefined;
    let discovery = buildDiscoveryResult(sourceType, document, requestedPath, sourceTimezone);
    if (sourceType === "rest_api" && restConfiguration?.pagination && discovery.result.selectedRecordPath) {
      const sample = await extendRestDiscoverySample(
        restConfiguration,
        document,
        discovery.result.selectedRecordPath,
        policy,
      );
      if (sample.sampledPageCount > 1) {
        document = sample.document;
        discovery = buildDiscoveryResult(sourceType, document, requestedPath ?? discovery.result.selectedRecordPath, sourceTimezone);
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
