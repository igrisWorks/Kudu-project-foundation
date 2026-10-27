import type { EventListFilters, IngestEventInput, JsonObject, JsonValue } from "@kudu/shared";
import { ApiFailure } from "./errors.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const eventTypePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const registryKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const dateTimePattern =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/;
const MAX_EVENT_JSON_BYTES = 512 * 1024;

type Input = Record<string, unknown>;
type Errors = Record<string, string>;

export interface ValidatedEventInput extends IngestEventInput {
  assetId: string | null;
  sourceRecordId: string | null;
  sourceTimestamp: string;
  deduplicationKey: string | null;
  provenance: JsonObject;
}

function isObject(value: unknown): value is Input {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown): Input {
  if (!isObject(value)) {
    throw new ApiFailure(400, "VALIDATION_ERROR", "Request body must be a JSON object.", {
      body: "A JSON object is required.",
    });
  }
  return value;
}

function addUnknownFields(input: Input, allowed: string[], errors: Errors): void {
  for (const field of Object.keys(input)) {
    if (!allowed.includes(field)) errors[field] = "This field is not supported.";
  }
}

function stringField(
  value: unknown,
  field: string,
  maxLength: number,
  errors: Errors,
  required = true,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") {
    errors[field] = required ? "This field is required." : "Must be text or null.";
    return undefined;
  }
  if (!value.trim()) {
    errors[field] = required ? "This field is required." : "Must not be blank.";
    return undefined;
  }
  if (value.length > maxLength) {
    errors[field] = `Must be ${maxLength} characters or fewer.`;
  }
  return value;
}

function optionalNullableString(
  input: Input,
  field: string,
  maxLength: number,
  errors: Errors,
): string | null | undefined {
  if (!Object.hasOwn(input, field)) return undefined;
  if (input[field] === null) return null;
  return stringField(input[field], field, maxLength, errors, false);
}

function parseId(
  input: Input,
  field: string,
  required: boolean,
  errors: Errors,
): string | null | undefined {
  if (!Object.hasOwn(input, field)) {
    if (required) errors[field] = "A valid identifier is required.";
    return undefined;
  }
  const value = input[field];
  if (value === null && !required) return null;
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    errors[field] = "Enter a valid UUID.";
    return null;
  }
  return value;
}

export function parseRfc3339(value: unknown, field: string, errors: Errors): string | undefined {
  if (typeof value !== "string" || !dateTimePattern.test(value)) {
    errors[field] = "Use an RFC 3339 timestamp with an explicit timezone, such as 2026-10-27T14:30:00Z.";
    return undefined;
  }
  const match = dateTimePattern.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day ||
    !Number.isFinite(Date.parse(value))
  ) {
    errors[field] = "Enter a real calendar date and time.";
    return undefined;
  }
  return value;
}

function jsonObject(value: unknown, field: string, errors: Errors): JsonObject | undefined {
  if (!isObject(value)) {
    errors[field] = "Must be a JSON object.";
    return undefined;
  }
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > 32) {
      errors[field] = "JSON nesting must not exceed 32 levels.";
      return undefined;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
    } else if (isObject(current.value)) {
      for (const item of Object.values(current.value)) {
        if (item !== null && typeof item === "object") {
          stack.push({ value: item, depth: current.depth + 1 });
        }
      }
    }
  }
  return value as JsonObject;
}

function finish(errors: Errors): void {
  if (Object.keys(errors).length) {
    throw new ApiFailure(400, "VALIDATION_ERROR", "Please correct the highlighted fields.", errors);
  }
}

export function validateEventIngest(value: unknown): ValidatedEventInput {
  const input = assertObject(value);
  const errors: Errors = {};
  addUnknownFields(
    input,
    [
      "sourceId",
      "assetId",
      "sourceRecordId",
      "eventType",
      "occurredAt",
      "sourceTimestamp",
      "deduplicationKey",
      "payload",
      "provenance",
    ],
    errors,
  );

  const sourceId = parseId(input, "sourceId", true, errors) ?? "";
  const assetId = parseId(input, "assetId", false, errors);
  const sourceRecordId = optionalNullableString(input, "sourceRecordId", 256, errors);
  const eventType = stringField(input.eventType, "eventType", 120, errors) ?? "";
  if (eventType && !eventTypePattern.test(eventType)) {
    errors.eventType = "Use letters, numbers, dots, underscores, colons, or dashes.";
  }
  const occurredAt = parseRfc3339(input.occurredAt, "occurredAt", errors) ?? "";
  const sourceTimestamp = optionalNullableString(input, "sourceTimestamp", 256, errors);
  const deduplicationKey = optionalNullableString(input, "deduplicationKey", 256, errors);
  const payload = jsonObject(input.payload, "payload", errors);
  const provenance = Object.hasOwn(input, "provenance")
    ? jsonObject(input.provenance, "provenance", errors)
    : {};

  if (payload && provenance) {
    try {
      if (Buffer.byteLength(JSON.stringify({ payload, provenance }), "utf8") > MAX_EVENT_JSON_BYTES) {
        errors.payload = "Payload and provenance together must not exceed 512 KiB.";
      }
    } catch {
      errors.payload = "Payload and provenance must be valid JSON objects.";
    }
  }

  finish(errors);
  return {
    sourceId,
    assetId: assetId ?? null,
    sourceRecordId: sourceRecordId ?? null,
    eventType,
    occurredAt,
    sourceTimestamp: sourceTimestamp ?? occurredAt,
    deduplicationKey: deduplicationKey ?? null,
    payload: payload!,
    provenance: provenance!,
  };
}

export function validateEventListFilters(query: unknown): EventListFilters & {
  page: number;
  pageSize: number;
} {
  const input = isObject(query) ? query : {};
  const errors: Errors = {};
  const allowed = new Set(["sourceId", "assetId", "sourceKey", "assetKey", "eventType", "from", "to", "page", "pageSize"]);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) errors[field] = "This query parameter is not supported.";
  }

  function readQueryString(field: string, maxLength: number): string | undefined {
    if (!Object.hasOwn(input, field)) return undefined;
    return stringField(input[field], field, maxLength, errors, false);
  }

  function readQueryId(field: string): string | undefined {
    const value = readQueryString(field, 36);
    if (value && !uuidPattern.test(value)) errors[field] = "Enter a valid UUID.";
    return value;
  }

  function readPage(field: "page" | "pageSize", fallback: number, max: number): number {
    if (!Object.hasOwn(input, field)) return fallback;
    const value = input[field];
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      errors[field] = "Must be a positive integer.";
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
      errors[field] = `Must be between 1 and ${max}.`;
      return fallback;
    }
    return parsed;
  }

  const sourceId = readQueryId("sourceId");
  const assetId = readQueryId("assetId");
  const sourceKey = readQueryString("sourceKey", 80);
  const assetKey = readQueryString("assetKey", 80);
  if (sourceKey && !registryKeyPattern.test(sourceKey)) {
    errors.sourceKey = "Enter an exact registered source key.";
  }
  if (assetKey && !registryKeyPattern.test(assetKey)) {
    errors.assetKey = "Enter an exact registered asset key.";
  }
  const eventType = readQueryString("eventType", 120);
  if (eventType && !eventTypePattern.test(eventType)) {
    errors.eventType = "Event type has an invalid format.";
  }
  const from = Object.hasOwn(input, "from")
    ? parseRfc3339(input.from, "from", errors)
    : undefined;
  const to = Object.hasOwn(input, "to")
    ? parseRfc3339(input.to, "to", errors)
    : undefined;
  if (from && to && Date.parse(from) > Date.parse(to)) {
    errors.to = "The end time must be on or after the start time.";
  }
  const page = readPage("page", 1, 1_000_000);
  const pageSize = readPage("pageSize", 25, 100);
  finish(errors);

  return {
    ...(sourceId ? { sourceId } : {}),
    ...(assetId ? { assetId } : {}),
    ...(sourceKey ? { sourceKey } : {}),
    ...(assetKey ? { assetKey } : {}),
    ...(eventType ? { eventType } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    page,
    pageSize,
  };
}

export function canonicalJson(value: JsonValue | JsonObject): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
