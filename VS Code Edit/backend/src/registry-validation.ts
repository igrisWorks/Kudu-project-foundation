import {
  ASSET_TYPES,
  DATA_SOURCE_TYPES,
  type AssetCreateInput,
  type AssetUpdateInput,
  type AssetType,
  type DataSourceConfigurationInput,
  type DataSourceCreateInput,
  type DataSourceType,
  type DataSourceUpdateInput,
  type ExternalIdentifier,
  type RestPaginationConfiguration,
} from "@kudu/shared";
import { ApiFailure } from "./errors.js";

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const credentialReferencePattern = /^env:KUDU_SOURCE_[A-Z0-9_]{1,80}$/;

type Input = Record<string, unknown>;
type Errors = Record<string, string>;

function isInput(value: unknown): value is Input {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireInput(value: unknown): Input {
  if (!isInput(value)) {
    throw new ApiFailure(400, "VALIDATION_ERROR", "Request body must be a JSON object.", {
      body: "A JSON object is required.",
    });
  }
  return value;
}

function unknownFields(input: Input, allowed: string[], errors: Errors): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) errors[key] = "This field is not supported.";
  }
}

function requiredText(
  input: Input,
  field: string,
  maxLength: number,
  errors: Errors,
): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors[field] = "This field is required.";
    return "";
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    errors[field] = `Must be ${maxLength} characters or fewer.`;
  }
  return normalized;
}

function optionalText(
  input: Input,
  field: string,
  maxLength: number,
  errors: Errors,
): string | null | undefined {
  if (!Object.hasOwn(input, field)) return undefined;
  const value = input[field];
  if (value === null) return null;
  if (typeof value !== "string") {
    errors[field] = "Must be text or null.";
    return null;
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    errors[field] = `Must be ${maxLength} characters or fewer.`;
  }
  return normalized || null;
}

function parseKey(
  input: Input,
  field: string,
  required: boolean,
  errors: Errors,
): string | undefined {
  if (!required && !Object.hasOwn(input, field)) return undefined;
  const value = requiredText(input, field, 80, errors);
  if (value && !keyPattern.test(value)) {
    errors[field] = "Use 1–80 letters, numbers, dots, dashes, or underscores; start with a letter or number.";
  }
  return value;
}

function parseAssetType(
  value: unknown,
  field: string,
  required: boolean,
  errors: Errors,
): AssetType | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value === "string" && (ASSET_TYPES as readonly string[]).includes(value)) {
    return value as AssetType;
  }
  errors[field] = "Choose a supported asset type.";
  return undefined;
}

function parseSourceType(
  value: unknown,
  field: string,
  required: boolean,
  errors: Errors,
): DataSourceType | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value === "string" && (DATA_SOURCE_TYPES as readonly string[]).includes(value)) {
    return value as DataSourceType;
  }
  errors[field] = "Choose a supported source type.";
  return undefined;
}

function parseUuid(
  input: Input,
  field: string,
  required: boolean,
  errors: Errors,
): string | null | undefined {
  if (!required && !Object.hasOwn(input, field)) return undefined;
  const value = input[field];
  if (value === null && !required) return null;
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    errors[field] = required ? "A valid identifier is required." : "Choose a valid asset.";
    return null;
  }
  return value;
}

function parseExternalIdentifiers(
  value: unknown,
  required: boolean,
  errors: Errors,
): ExternalIdentifier[] | undefined {
  if (value === undefined && !required) return undefined;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    errors.externalIdentifiers = "Provide at most 20 external identifiers.";
    return [];
  }

  const results: ExternalIdentifier[] = [];
  const seen = new Set<string>();
  value.forEach((candidate, index) => {
    if (!isInput(candidate)) {
      errors[`externalIdentifiers.${index}`] = "Each identifier must be an object.";
      return;
    }
    const nestedErrors: Errors = {};
    unknownFields(candidate, ["sourceKey", "externalId"], nestedErrors);
    const sourceKey = parseKey(candidate, "sourceKey", true, nestedErrors);
    const externalId = requiredText(candidate, "externalId", 256, nestedErrors);
    for (const [field, message] of Object.entries(nestedErrors)) {
      errors[`externalIdentifiers.${index}.${field}`] = message;
    }
    if (sourceKey && externalId) {
      const compound = `${sourceKey.toLowerCase()}\u0000${externalId}`;
      if (seen.has(compound)) {
        errors[`externalIdentifiers.${index}`] = "This source and external ID pair is duplicated.";
      }
      seen.add(compound);
      results.push({ sourceKey, externalId });
    }
  });
  return results;
}

function throwIfInvalid(errors: Errors): void {
  if (Object.keys(errors).length > 0) {
    throw new ApiFailure(400, "VALIDATION_ERROR", "Please correct the highlighted fields.", errors);
  }
}

export function validateAssetCreate(value: unknown): AssetCreateInput {
  const input = requireInput(value);
  const errors: Errors = {};
  unknownFields(
    input,
    ["assetKey", "name", "assetType", "description", "parentAssetId", "externalIdentifiers"],
    errors,
  );
  const assetKey = parseKey(input, "assetKey", true, errors) ?? "";
  const name = requiredText(input, "name", 160, errors);
  const assetType = parseAssetType(input.assetType, "assetType", true, errors) ?? "other";
  const description = optionalText(input, "description", 2000, errors);
  const parentAssetId = parseUuid(input, "parentAssetId", false, errors);
  const externalIdentifiers = parseExternalIdentifiers(input.externalIdentifiers, false, errors);
  throwIfInvalid(errors);
  return {
    assetKey,
    name,
    assetType,
    ...(description !== undefined ? { description } : {}),
    ...(parentAssetId !== undefined ? { parentAssetId } : {}),
    ...(externalIdentifiers !== undefined ? { externalIdentifiers } : {}),
  };
}

export function validateAssetUpdate(value: unknown): AssetUpdateInput {
  const input = requireInput(value);
  const errors: Errors = {};
  unknownFields(
    input,
    ["assetKey", "name", "assetType", "description", "parentAssetId", "externalIdentifiers", "archived"],
    errors,
  );
  const result: AssetUpdateInput = {};
  const assetKey = parseKey(input, "assetKey", false, errors);
  const name = Object.hasOwn(input, "name") ? requiredText(input, "name", 160, errors) : undefined;
  const assetType = parseAssetType(input.assetType, "assetType", false, errors);
  const description = optionalText(input, "description", 2000, errors);
  const parentAssetId = parseUuid(input, "parentAssetId", false, errors);
  const externalIdentifiers = parseExternalIdentifiers(input.externalIdentifiers, false, errors);
  if (Object.hasOwn(input, "archived") && typeof input.archived !== "boolean") {
    errors.archived = "Must be true or false.";
  }
  if (assetKey !== undefined) result.assetKey = assetKey;
  if (name !== undefined) result.name = name;
  if (assetType !== undefined) result.assetType = assetType;
  if (description !== undefined) result.description = description;
  if (parentAssetId !== undefined) result.parentAssetId = parentAssetId;
  if (externalIdentifiers !== undefined) result.externalIdentifiers = externalIdentifiers;
  if (typeof input.archived === "boolean") result.archived = input.archived;
  if (Object.keys(result).length === 0) errors.body = "Provide at least one field to update.";
  throwIfInvalid(errors);
  return result;
}

function parseRelativePath(value: unknown, errors: Errors): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors["configuration.relativePath"] = "A relative path is required.";
    return "";
  }
  const normalized = value.trim();
  if (
    normalized.length > 500 ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    errors["configuration.relativePath"] =
      "Use a path relative to the configured storage root; absolute paths and traversal are not allowed.";
  }
  return normalized;
}

function optionalInteger(
  input: Input,
  field: string,
  minimum: number,
  maximum: number,
  errors: Errors,
): number | undefined {
  if (!Object.hasOwn(input, field)) return undefined;
  const value = input[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    errors[`configuration.${field}`] = `Use a whole number from ${minimum} to ${maximum}.`;
    return undefined;
  }
  return value;
}

function parseEndpointPath(value: unknown, errors: Errors): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    errors["configuration.endpointPath"] = "A relative endpoint path is required.";
    return undefined;
  }
  const normalized = value.trim();
  let decoded: string;
  try {
    decoded = decodeURIComponent(normalized);
  } catch {
    errors["configuration.endpointPath"] = "Use a valid URL path.";
    return undefined;
  }
  if (
    normalized.length > 512 ||
    /[?#\\\0]/.test(normalized) ||
    normalized.includes("://") ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    errors["configuration.endpointPath"] = "Use a relative path without query, fragment, or traversal segments.";
    return undefined;
  }
  return normalized.replace(/^\/+/, "");
}

function parseDotPath(value: unknown, field: string, errors: Errors): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 256) {
    errors[field] = "Use an optional dot-separated path of at most 256 characters.";
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) return "";
  const parts = normalized.split(".");
  if (
    parts.length > 8 ||
    parts.some((part) => !part || part.length > 128 || part.trim() !== part ||
      ["__proto__", "constructor", "prototype"].includes(part))
  ) {
    errors[field] = "Use a safe dot-separated JSON object path, with at most eight parts.";
    return undefined;
  }
  return normalized;
}

function parseRecordsPath(value: unknown, errors: Errors): string | undefined {
  return parseDotPath(value, "configuration.recordsPath", errors);
}

function parseSourceTimezone(value: unknown, errors: Errors): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) {
    errors["configuration.sourceTimezone"] = "Use a valid IANA time zone, such as Europe/Berlin.";
    return undefined;
  }
  const timezone = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    errors["configuration.sourceTimezone"] = "Use a valid IANA time zone, such as Europe/Berlin.";
    return undefined;
  }
}

function parseQueryParameter(value: unknown, field: string, errors: Errors): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value.trim())) {
    errors[field] = "Use a parameter name of up to 64 letters, numbers, dots, dashes, or underscores.";
    return undefined;
  }
  return value.trim();
}

const sensitiveQueryParameterName = /password|secret|token|credential|authorization|cookie|api.?key|private.?key|bearer|(^|[_-])(auth|key|signature|sig)([_-]|$)/i;

function parseQueryParameters(value: unknown, errors: Errors): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isInput(value)) {
    errors["configuration.queryParameters"] = "Query parameters must be an object of text values.";
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > 32) {
    errors["configuration.queryParameters"] = "Configure no more than 32 query parameters.";
    return undefined;
  }
  const parsed: Record<string, string> = {};
  let totalCharacters = 0;
  for (const [name, item] of entries) {
    const field = `configuration.queryParameters.${name}`;
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) || sensitiveQueryParameterName.test(name)) {
      errors[field] = "Use a safe parameter name; credentials must use a bearer-token environment reference.";
      continue;
    }
    if (typeof item !== "string" || item.length > 512 || /[\r\n\0]/.test(item)) {
      errors[field] = "Use a text value up to 512 characters without line breaks.";
      continue;
    }
    totalCharacters += name.length + item.length;
    parsed[name] = item;
  }
  if (totalCharacters > 4096) {
    errors["configuration.queryParameters"] = "The combined query parameters must be at most 4096 characters.";
  }
  return parsed;
}

function parsePagination(value: unknown, errors: Errors): RestPaginationConfiguration | undefined {
  if (value === undefined) return undefined;
  if (!isInput(value)) {
    errors["configuration.pagination"] = "Pagination must be a configuration object.";
    return undefined;
  }
  const prefix = "configuration.pagination";
  unknownFields(value, [
    "strategy", "pageSize", "limitParameter", "startOffset", "startPage", "offsetParameter",
    "pageParameter", "cursorParameter", "nextCursorPath", "requestIntervalMs", "dateFromParameter", "dateFrom",
    "dateToParameter", "dateTo",
  ], errors);
  if (value.strategy !== "offset" && value.strategy !== "page" && value.strategy !== "cursor") {
    errors[`${prefix}.strategy`] = "Choose offset, page-number, or cursor pagination.";
    return undefined;
  }
  const strategy = value.strategy;
  const pageSize = optionalInteger(value, "pageSize", 1, 1000, errors);
  if (pageSize === undefined) errors[`${prefix}.pageSize`] = "Set a page size from 1 to 1000.";
  const limitParameter = parseQueryParameter(value.limitParameter, `${prefix}.limitParameter`, errors);
  const requestIntervalMs = optionalInteger(value, "requestIntervalMs", 0, 10_000, errors);
  const startOffset = optionalInteger(value, "startOffset", 0, 1_000_000_000, errors);
  const startPage = optionalInteger(value, "startPage", 0, 1_000_000_000, errors);
  const offsetParameter = strategy === "offset"
    ? parseQueryParameter(value.offsetParameter, `${prefix}.offsetParameter`, errors)
    : undefined;
  const pageParameter = strategy === "page"
    ? parseQueryParameter(value.pageParameter, `${prefix}.pageParameter`, errors)
    : undefined;
  const cursorParameter = strategy === "cursor"
    ? parseQueryParameter(value.cursorParameter, `${prefix}.cursorParameter`, errors)
    : undefined;
  const nextCursorPath = strategy === "cursor"
    ? parseDotPath(value.nextCursorPath, `${prefix}.nextCursorPath`, errors)
    : undefined;
  if (strategy === "cursor" && !nextCursorPath) {
    errors[`${prefix}.nextCursorPath`] ??= "Configure the response path that contains the next cursor.";
  }
  const dateFromParameter = value.dateFromParameter === undefined
    ? undefined
    : parseQueryParameter(value.dateFromParameter, `${prefix}.dateFromParameter`, errors);
  const dateFrom = value.dateFrom === undefined ? undefined : requiredText(value, "dateFrom", 128, errors);
  const dateToParameter = value.dateToParameter === undefined
    ? undefined
    : parseQueryParameter(value.dateToParameter, `${prefix}.dateToParameter`, errors);
  const dateTo = value.dateTo === undefined ? undefined : requiredText(value, "dateTo", 128, errors);
  if ((dateFromParameter && !dateFrom) || (dateFrom && !dateFromParameter)) {
    errors[`${prefix}.dateFrom`] = "Set both the start-date query parameter and its value.";
  }
  if ((dateToParameter && !dateTo) || (dateTo && !dateToParameter)) {
    errors[`${prefix}.dateTo`] = "Set both the end-date query parameter and its value.";
  }
  const params = [limitParameter, offsetParameter, pageParameter, cursorParameter, dateFromParameter, dateToParameter]
    .filter((item): item is string => Boolean(item));
  if (new Set(params).size !== params.length) errors[`${prefix}.limitParameter`] = "Pagination and date parameters must be distinct.";
  if (startOffset !== undefined && strategy !== "offset") errors[`${prefix}.startOffset`] = "Start offset applies only to offset pagination.";
  if (startPage !== undefined && strategy !== "page") errors[`${prefix}.startPage`] = "Start page applies only to page-number pagination.";
  if (
    pageSize === undefined || limitParameter === undefined ||
    (strategy === "offset" && offsetParameter === undefined) ||
    (strategy === "page" && pageParameter === undefined) ||
    (strategy === "cursor" && (cursorParameter === undefined || nextCursorPath === undefined || nextCursorPath === "")) ||
    Object.keys(errors).some((key) => key.startsWith(`${prefix}.`))
  ) return undefined;
  return {
    strategy,
    pageSize,
    limitParameter,
    ...(requestIntervalMs !== undefined ? { requestIntervalMs } : {}),
    ...(startOffset !== undefined ? { startOffset } : {}),
    ...(startPage !== undefined ? { startPage } : {}),
    ...(offsetParameter ? { offsetParameter } : {}),
    ...(pageParameter ? { pageParameter } : {}),
    ...(cursorParameter ? { cursorParameter } : {}),
    ...(nextCursorPath ? { nextCursorPath } : {}),
    ...(dateFromParameter && dateFrom ? { dateFromParameter, dateFrom } : {}),
    ...(dateToParameter && dateTo ? { dateToParameter, dateTo } : {}),
  };
}

function parseConfiguration(
  value: unknown,
  sourceType: DataSourceType,
  errors: Errors,
): DataSourceConfigurationInput {
  if (!isInput(value)) {
    errors.configuration = "A configuration object is required.";
    return { kind: "manual" };
  }

  const kind = value.kind;
  if (kind !== sourceType) {
    errors.configuration = "Configuration type must match the selected source type.";
  }

  if (sourceType === "rest_api") {
    unknownFields(
      value,
      [
        "kind", "baseUrl", "endpointPath", "method", "authMode", "credentialRef",
        "trustedPrivateHost", "queryParameters", "sourceTimezone", "timeoutMs", "maxResponseBytes", "maxRecords", "responseFormat", "recordsPath", "pagination",
      ],
      errors,
    );
    const baseUrl = requiredText(value, "baseUrl", 2000, errors);
    let baseProtocol = "";
    let baseHost = "";
    if (baseUrl) {
      try {
        const parsed = new URL(baseUrl);
        baseProtocol = parsed.protocol;
        baseHost = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
        if (
          (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
          !parsed.hostname ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash
        ) {
          errors["configuration.baseUrl"] =
            "Use an HTTP or HTTPS URL without embedded credentials, query parameters, or fragments.";
        }
      } catch {
        errors["configuration.baseUrl"] = "Enter a valid HTTP or HTTPS URL.";
      }
    }
    let trustedPrivateHost: string | undefined;
    if (Object.hasOwn(value, "trustedPrivateHost")) {
      if (
        typeof value.trustedPrivateHost !== "string" ||
        !value.trustedPrivateHost.trim() ||
        value.trustedPrivateHost.trim().length > 253
      ) {
        errors["configuration.trustedPrivateHost"] = "Trust must name the exact hostname or IP from the base URL.";
      } else {
        const candidate = value.trustedPrivateHost.trim()
          .replace(/^\[|\]$/g, "")
          .replace(/\.$/, "")
          .toLowerCase();
        if (!baseHost || candidate !== baseHost) {
          errors["configuration.trustedPrivateHost"] = "Only the exact host in the REST base URL can be trusted.";
        } else {
          trustedPrivateHost = baseHost;
        }
      }
    }

    const endpointPath = parseEndpointPath(value.endpointPath, errors);
    let method: "GET" | undefined;
    if (Object.hasOwn(value, "method")) {
      if (value.method !== "GET") errors["configuration.method"] = "Only GET is supported.";
      else method = "GET";
    }
    let authMode: "none" | "bearer" | undefined;
    if (Object.hasOwn(value, "authMode")) {
      if (value.authMode !== "none" && value.authMode !== "bearer") {
        errors["configuration.authMode"] = "Choose no authentication or a bearer token.";
      } else {
        authMode = value.authMode;
      }
    }
    if (authMode === "bearer" && baseProtocol !== "https:") {
      errors["configuration.authMode"] = "Bearer authentication requires an HTTPS base URL.";
    }

    let credentialRef: string | null | undefined;
    if (Object.hasOwn(value, "credentialRef")) {
      const candidate = value.credentialRef;
      if (candidate === null) {
        credentialRef = null;
      } else if (
        typeof candidate === "string" &&
        credentialReferencePattern.test(candidate.trim())
      ) {
        credentialRef = candidate.trim();
      } else {
        errors["configuration.credentialRef"] =
          "Use a reference such as env:KUDU_SOURCE_PLANT_API_TOKEN; do not enter a credential value.";
      }
    }
    if (authMode === "bearer" && credentialRef === null) {
      errors["configuration.credentialRef"] = "A bearer token reference is required; clear authentication mode to remove it.";
    }

    let responseFormat: "json" | undefined;
    if (Object.hasOwn(value, "responseFormat")) {
      if (value.responseFormat !== "json") errors["configuration.responseFormat"] = "Only JSON responses are supported.";
      else responseFormat = "json";
    }
    const timeoutMs = optionalInteger(value, "timeoutMs", 500, 30_000, errors);
    const maxResponseBytes = optionalInteger(value, "maxResponseBytes", 1024, 5 * 1024 * 1024, errors);
    const maxRecords = optionalInteger(value, "maxRecords", 1, 100_000, errors);
    const queryParameters = parseQueryParameters(value.queryParameters, errors);
    const sourceTimezone = parseSourceTimezone(value.sourceTimezone, errors);
    const recordsPath = parseRecordsPath(value.recordsPath, errors);
    const pagination = parsePagination(value.pagination, errors);

    return {
      kind: "rest_api",
      baseUrl,
      ...(endpointPath !== undefined ? { endpointPath } : {}),
      ...(method !== undefined ? { method } : {}),
      ...(authMode !== undefined ? { authMode } : {}),
      ...(credentialRef !== undefined ? { credentialRef } : {}),
      ...(trustedPrivateHost !== undefined ? { trustedPrivateHost } : {}),
      ...(queryParameters !== undefined ? { queryParameters } : {}),
      ...(sourceTimezone !== undefined ? { sourceTimezone } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
      ...(maxRecords !== undefined ? { maxRecords } : {}),
      ...(responseFormat !== undefined ? { responseFormat } : {}),
      ...(recordsPath !== undefined ? { recordsPath } : {}),
      ...(pagination !== undefined ? { pagination } : {}),
    };
  }

  if (sourceType === "json_file" || sourceType === "csv_file") {
    unknownFields(value, sourceType === "json_file" ? ["kind", "relativePath", "recordsPath", "sourceTimezone"] : ["kind", "relativePath", "sourceTimezone"], errors);
    const recordsPath = sourceType === "json_file" ? parseRecordsPath(value.recordsPath, errors) : undefined;
    const sourceTimezone = parseSourceTimezone(value.sourceTimezone, errors);
    return {
      kind: sourceType,
      relativePath: parseRelativePath(value.relativePath, errors),
      ...(recordsPath !== undefined && sourceType === "json_file" ? { recordsPath } : {}),
      ...(sourceTimezone !== undefined ? { sourceTimezone } : {}),
    };
  }

  unknownFields(value, ["kind"], errors);
  return { kind: "manual" };
}

export function validateDataSourceCreate(value: unknown): DataSourceCreateInput {
  const input = requireInput(value);
  const errors: Errors = {};
  unknownFields(
    input,
    ["sourceKey", "displayName", "sourceType", "description", "configuration", "enabled"],
    errors,
  );
  const sourceKey = parseKey(input, "sourceKey", true, errors) ?? "";
  const displayName = requiredText(input, "displayName", 160, errors);
  const sourceType = parseSourceType(input.sourceType, "sourceType", true, errors) ?? "manual";
  const description = optionalText(input, "description", 2000, errors);
  const configuration = parseConfiguration(input.configuration, sourceType, errors);
  if (Object.hasOwn(input, "enabled") && typeof input.enabled !== "boolean") {
    errors.enabled = "Must be true or false.";
  }
  throwIfInvalid(errors);
  return {
    sourceKey,
    displayName,
    sourceType,
    ...(description !== undefined ? { description } : {}),
    configuration,
    ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
  };
}

export function validateDataSourceUpdate(value: unknown): DataSourceUpdateInput {
  const input = requireInput(value);
  const errors: Errors = {};
  unknownFields(
    input,
    ["sourceKey", "displayName", "sourceType", "description", "configuration", "enabled"],
    errors,
  );
  const result: DataSourceUpdateInput = {};
  const sourceKey = parseKey(input, "sourceKey", false, errors);
  const displayName = Object.hasOwn(input, "displayName")
    ? requiredText(input, "displayName", 160, errors)
    : undefined;
  const sourceType = parseSourceType(input.sourceType, "sourceType", false, errors);
  const description = optionalText(input, "description", 2000, errors);
  if (Object.hasOwn(input, "configuration")) {
    const configurationValue = input.configuration;
    const configKind =
      isInput(configurationValue) && typeof configurationValue.kind === "string"
        ? configurationValue.kind
        : undefined;
    const resolvedType =
      sourceType ??
      ((DATA_SOURCE_TYPES as readonly string[]).includes(configKind ?? "")
        ? (configKind as DataSourceType)
        : undefined);
    if (resolvedType) {
      result.configuration = parseConfiguration(configurationValue, resolvedType, errors);
    } else {
      errors.configuration = "A supported source configuration is required.";
    }
  }
  if (Object.hasOwn(input, "enabled") && typeof input.enabled !== "boolean") {
    errors.enabled = "Must be true or false.";
  }
  if (sourceKey !== undefined) result.sourceKey = sourceKey;
  if (displayName !== undefined) result.displayName = displayName;
  if (sourceType !== undefined) result.sourceType = sourceType;
  if (description !== undefined) result.description = description;
  if (typeof input.enabled === "boolean") result.enabled = input.enabled;
  if (Object.keys(result).length === 0) errors.body = "Provide at least one field to update.";
  throwIfInvalid(errors);
  return result;
}

export function validateUuidParameter(value: string | undefined, name: string): string {
  if (!value || !uuidPattern.test(value)) {
    throw new ApiFailure(400, "INVALID_ID", `A valid ${name} identifier is required.`);
  }
  return value;
}
