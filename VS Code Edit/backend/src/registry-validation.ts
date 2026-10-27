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

function parseRecordsPath(value: unknown, errors: Errors): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 256) {
    errors["configuration.recordsPath"] = "Use an optional dot-separated path of at most 256 characters.";
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
    errors["configuration.recordsPath"] = "Use a safe dot-separated JSON object path, with at most eight parts.";
    return undefined;
  }
  return normalized;
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
        "timeoutMs", "maxResponseBytes", "maxRecords", "responseFormat", "recordsPath",
      ],
      errors,
    );
    const baseUrl = requiredText(value, "baseUrl", 2000, errors);
    let baseProtocol = "";
    if (baseUrl) {
      try {
        const parsed = new URL(baseUrl);
        baseProtocol = parsed.protocol;
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
    const maxRecords = optionalInteger(value, "maxRecords", 1, 1000, errors);
    const recordsPath = parseRecordsPath(value.recordsPath, errors);

    return {
      kind: "rest_api",
      baseUrl,
      ...(endpointPath !== undefined ? { endpointPath } : {}),
      ...(method !== undefined ? { method } : {}),
      ...(authMode !== undefined ? { authMode } : {}),
      ...(credentialRef !== undefined ? { credentialRef } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
      ...(maxRecords !== undefined ? { maxRecords } : {}),
      ...(responseFormat !== undefined ? { responseFormat } : {}),
      ...(recordsPath !== undefined ? { recordsPath } : {}),
    };
  }

  if (sourceType === "json_file" || sourceType === "csv_file") {
    unknownFields(value, ["kind", "relativePath"], errors);
    return {
      kind: sourceType,
      relativePath: parseRelativePath(value.relativePath, errors),
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
