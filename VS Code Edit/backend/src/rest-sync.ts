import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { JsonObject, RestSyncRecordError, RestSyncResult } from "@kudu/shared";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database, StoredSourceConfiguration } from "./database.js";
import { ApiFailure } from "./errors.js";
import { getActiveEventMapping, normalizeMappedEvent, readMappedField } from "./event-mappings.js";
import { ingestEvent } from "./events.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_BYTES = 1_048_576;
const DEFAULT_RECORDS = 500;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_RECORDS = 1_000;
const MAX_ERRORS = 100;
const MAX_REDIRECTS = 3;
const SOURCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_REF_PATTERN = /^env:KUDU_SOURCE_[A-Z0-9_]{1,80}$/;

interface NetworkPolicy {
  trustedHosts?: string[];
  allowLoopbackForTests?: boolean;
}

interface CheckedDestination {
  addresses: LookupAddress[];
}

interface RemoteResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

class RestRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 502,
  ) {
    super(message);
    this.name = "RestRequestError";
  }
}

function makeBlockList(entries: Array<[string, number, "ipv4" | "ipv6"]>): BlockList {
  const list = new BlockList();
  for (const [address, prefix, family] of entries) list.addSubnet(address, prefix, family);
  return list;
}

const blockedIpv4 = makeBlockList([
  ["0.0.0.0", 8, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.88.99.0", 24, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
]);
const privateIpv4 = makeBlockList([
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
]);
const blockedIpv6 = makeBlockList([
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["2001::", 23, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["3fff::", 20, "ipv6"],
]);
const privateIpv6 = makeBlockList([["fc00::", 7, "ipv6"]]);
const globalIpv6 = makeBlockList([["2000::", 3, "ipv6"]]);
const loopbackIpv4 = makeBlockList([["127.0.0.0", 8, "ipv4"]]);
const loopbackIpv6 = makeBlockList([["::1", 128, "ipv6"]]);

function normalizedHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function getTrustedHosts(policy: NetworkPolicy): Set<string> {
  const configured = policy.trustedHosts ??
    (process.env.KUDU_REST_TRUSTED_HOSTS ?? "").split(",");
  return new Set(configured
    .map((host) => host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase())
    .filter(Boolean));
}

function isAllowedAddress(address: string, trusted: boolean, allowLoopbackForTests: boolean): boolean {
  const family = isIP(address);
  if (family === 4) {
    if (loopbackIpv4.check(address, "ipv4")) return allowLoopbackForTests;
    if (blockedIpv4.check(address, "ipv4")) return false;
    if (privateIpv4.check(address, "ipv4")) return trusted;
    return true;
  }
  if (family === 6) {
    if (loopbackIpv6.check(address, "ipv6")) return allowLoopbackForTests;
    if (blockedIpv6.check(address, "ipv6")) return false;
    if (privateIpv6.check(address, "ipv6")) return trusted;
    return globalIpv6.check(address, "ipv6");
  }
  return false;
}

async function validateDestination(
  url: URL,
  policy: NetworkPolicy,
  timeoutMs: number,
): Promise<CheckedDestination> {
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new RestRequestError("REST_DESTINATION_BLOCKED", "The remote destination is not allowed.", 403);
  }
  const host = normalizedHost(url);
  const trusted = getTrustedHosts(policy).has(host);
  let addresses: LookupAddress[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    let timer: NodeJS.Timeout | undefined;
    try {
      addresses = await Promise.race([
        lookup(host, { all: true, verbatim: true }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new RestRequestError("REST_TIMEOUT", "The remote request timed out.", 504)),
            timeoutMs,
          );
        }),
      ]);
    } catch (cause) {
      if (timer) clearTimeout(timer);
      if (cause instanceof RestRequestError) throw cause;
      throw new RestRequestError("REST_DNS_FAILED", "The remote destination could not be resolved.");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !isAllowedAddress(entry.address, trusted, policy.allowLoopbackForTests === true))
  ) {
    throw new RestRequestError("REST_DESTINATION_BLOCKED", "The remote destination is not allowed.", 403);
  }
  return { addresses };
}

function requestOnce(
  url: URL,
  destination: CheckedDestination,
  authorization: string | undefined,
  maxResponseBytes: number,
  timeoutMs: number,
): Promise<RemoteResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const requestHostname = normalizedHost(url);
    const addresses = destination.addresses;
    const pinnedLookup: LookupFunction = (hostname, options, callback) => {
      if (hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase() !== requestHostname) {
        callback(Object.assign(new Error("DNS target changed."), { code: "EACCES" }), "", 0);
        return;
      }
      const filtered = options.family
        ? addresses.filter((entry) => entry.family === options.family)
        : addresses;
      if (filtered.length === 0) {
        callback(Object.assign(new Error("No validated address."), { code: "EAI_ADDRFAMILY" }), "", 0);
        return;
      }
      if (options.all) callback(null, filtered);
      else callback(null, filtered[0]!.address, filtered[0]!.family);
    };
    const agent = url.protocol === "https:"
      ? new https.Agent({ keepAlive: false, lookup: pinnedLookup })
      : new http.Agent({ keepAlive: false, lookup: pinnedLookup });
    const headers: http.OutgoingHttpHeaders = {
      accept: "application/json",
      "user-agent": "Kudu-ReadOnly-REST-Connector/1.0",
    };
    if (authorization) headers.authorization = authorization;

    let settled = false;
    const finish = (error?: Error, response?: RemoteResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      agent.destroy();
      if (error) reject(error);
      else if (response) resolve(response);
      else reject(new RestRequestError("REST_REQUEST_FAILED", "The remote request failed."));
    };
    const request = transport.request(
      url,
      {
        method: "GET",
        headers,
        agent,
        ...(url.protocol === "https:" && !isIP(requestHostname) ? { servername: requestHostname } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.byteLength;
          if (receivedBytes > maxResponseBytes) {
            finish(new RestRequestError("REST_RESPONSE_TOO_LARGE", "The remote response exceeded the configured size limit.", 413));
            request.destroy();
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          finish(undefined, {
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", () => {
          finish(new RestRequestError("REST_REQUEST_FAILED", "The remote response could not be read."));
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new RestRequestError("REST_TIMEOUT", "The remote request timed out.", 504));
    }, timeoutMs);
    request.on("error", (error: Error) => {
      finish(
        error instanceof RestRequestError
          ? error
          : new RestRequestError("REST_REQUEST_FAILED", "The remote request failed."),
      );
    });
    request.end();
  });
}

async function requestJson(
  initialUrl: URL,
  authorization: string | undefined,
  timeoutMs: number,
  maxResponseBytes: number,
  policy: NetworkPolicy,
): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  const credentialOrigin = initialUrl.origin;
  let url = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new RestRequestError("REST_TIMEOUT", "The remote request timed out.", 504);
    const destination = await validateDestination(url, policy, remainingMs);
    const requestTimeoutMs = deadline - Date.now();
    if (requestTimeoutMs <= 0) throw new RestRequestError("REST_TIMEOUT", "The remote request timed out.", 504);
    const response = await requestOnce(
      url,
      destination,
      url.origin === credentialOrigin ? authorization : undefined,
      maxResponseBytes,
      requestTimeoutMs,
    );
    const status = response.statusCode;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new RestRequestError("REST_REDIRECT_REJECTED", "The remote redirect could not be followed.");
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new RestRequestError("REST_REDIRECT_REJECTED", "The remote redirect could not be followed.");
      }
      if (url.protocol === "https:" && next.protocol !== "https:") {
        throw new RestRequestError("REST_REDIRECT_REJECTED", "The remote redirect could not be followed.");
      }
      url = next;
      continue;
    }
    if (status < 200 || status >= 300) {
      throw new RestRequestError("REST_HTTP_ERROR", `The remote API returned HTTP ${status}.`);
    }
    return response.body;
  }
  throw new RestRequestError("REST_REDIRECT_REJECTED", "The remote redirect could not be followed.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fallbackKey(sourceId: string, record: JsonObject): string {
  const fingerprint = createHash("sha256").update(canonicalJson(record)).digest("hex");
  return `rest:${sourceId}:${fingerprint}`;
}

function basePayload(record: JsonObject): JsonObject {
  const payloadValue = record.payload;
  if (payloadValue !== undefined && !isRecord(payloadValue)) {
    throw new ApiFailure(400, "INVALID_IMPORT_RECORD", "The remote record payload must be a JSON object.");
  }
  const payload = { ...(payloadValue as JsonObject | undefined) };
  const eventFields = new Set(["eventType", "occurredAt", "assetId", "sourceRecordId", "payload"]);
  for (const [key, value] of Object.entries(record)) {
    if (eventFields.has(key)) continue;
    if (Object.hasOwn(payload, key)) {
      throw new ApiFailure(400, "INVALID_IMPORT_RECORD", "A remote record field conflicts with its payload object.");
    }
    Object.defineProperty(payload, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return payload;
}

function failureResult(sourceId: string, error: RestRequestError): RestSyncResult {
  return {
    sourceId,
    requestSucceeded: false,
    fetched: 0,
    imported: 0,
    duplicates: 0,
    failed: 0,
    errors: [{ record: 0, code: error.code, message: error.message }],
    errorsTruncated: false,
  };
}

function configurationFailure(sourceId: string, code: string, message: string): RestSyncResult {
  return failureResult(sourceId, new RestRequestError(code, message, 400));
}

function recordError(record: number, cause: unknown): RestSyncRecordError {
  if (cause instanceof ApiFailure && cause.statusCode < 500) {
    return {
      record,
      code: cause.code,
      message: cause.message,
      ...(cause.fields ? { fields: cause.fields } : {}),
    };
  }
  return { record, code: "INGESTION_FAILED", message: "The record could not be ingested." };
}

function parseBearerToken(configuration: Extract<StoredSourceConfiguration, { kind: "rest_api" }>): string | undefined {
  if ((configuration.authMode ?? "none") !== "bearer") return undefined;
  const reference = configuration.credentialRef;
  if (!reference || !CREDENTIAL_REF_PATTERN.test(reference)) return undefined;
  const value = process.env[reference.slice("env:".length)];
  if (!value || value.length > 8192 || /[\r\n]/.test(value)) return undefined;
  return value;
}

function endpointUrl(configuration: Extract<StoredSourceConfiguration, { kind: "rest_api" }>): URL | undefined {
  const endpointPath = configuration.endpointPath;
  if (!endpointPath || endpointPath.length > 512 || /[?#\\\0]/.test(endpointPath) || endpointPath.includes("://")) {
    return undefined;
  }
  const parts = endpointPath.split("/");
  if (parts.some((part) => part === "." || part === "..")) return undefined;
  let base: URL;
  try {
    base = new URL(configuration.baseUrl);
  } catch {
    return undefined;
  }
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    return undefined;
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  const suffix = endpointPath.replace(/^\/+/, "");
  try {
    return new URL(`${prefix}/${suffix}`, base.origin);
  } catch {
    return undefined;
  }
}

function validateLimits(configuration: Extract<StoredSourceConfiguration, { kind: "rest_api" }>): {
  timeoutMs: number;
  maxResponseBytes: number;
  maxRecords: number;
} | undefined {
  const timeoutMs = configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = configuration.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES;
  const maxRecords = configuration.maxRecords ?? DEFAULT_RECORDS;
  if (
    !Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > MAX_TIMEOUT_MS ||
    !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_RESPONSE_BYTES ||
    !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS
  ) {
    return undefined;
  }
  return { timeoutMs, maxResponseBytes, maxRecords };
}

export async function fetchRestDiscoveryDocument(
  configuration: Extract<StoredSourceConfiguration, { kind: "rest_api" }>,
  policy: NetworkPolicy = {},
): Promise<unknown> {
  const url = endpointUrl(configuration);
  const limits = validateLimits(configuration);
  if (!url || !limits) throw new ApiFailure(400, "SOURCE_CONFIGURATION_INVALID", "Configure a valid endpoint path and bounded request limits.");
  if (configuration.authMode === "bearer" && url.protocol !== "https:") {
    throw new ApiFailure(400, "BEARER_REQUIRES_HTTPS", "Bearer authentication requires HTTPS.");
  }
  const token = parseBearerToken(configuration);
  if (configuration.authMode === "bearer" && !token) {
    throw new ApiFailure(400, "BEARER_TOKEN_UNAVAILABLE", "The configured bearer-token environment variable is not available.");
  }
  let bytes: Buffer;
  try {
    bytes = await requestJson(
      url,
      token ? `Bearer ${token}` : undefined,
      limits.timeoutMs,
      limits.maxResponseBytes,
      policy,
    );
  } catch (cause) {
    if (cause instanceof RestRequestError) throw new ApiFailure(cause.statusCode, cause.code, cause.message);
    throw new ApiFailure(502, "REST_REQUEST_FAILED", "The remote request failed.");
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new ApiFailure(502, "REST_INVALID_JSON", "The remote response was not valid JSON.");
  }
}

export function registerRestSyncRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  policy: NetworkPolicy = {},
): void {
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/v1/data-sources/:id/sync",
    async (request): Promise<RestSyncResult> => {
      if (!SOURCE_ID_PATTERN.test(request.params.id)) {
        throw new ApiFailure(400, "INVALID_ID", "A valid data-source identifier is required.");
      }
      if (request.body !== undefined) {
        throw new ApiFailure(400, "REQUEST_BODY_NOT_ALLOWED", "This sync action does not accept a request body.");
      }
      const source = await db
        .selectFrom("data_sources")
        .select(["id", "source_type", "enabled", "configuration"])
        .where("id", "=", request.params.id)
        .executeTakeFirst();
      if (!source) throw new ApiFailure(404, "NOT_FOUND", "Data source not found.");
      if (source.source_type !== "rest_api") {
        throw new ApiFailure(409, "UNSUPPORTED_SOURCE_TYPE", "Only REST API sources can be synced.");
      }
      if (!source.enabled) throw new ApiFailure(409, "SOURCE_DISABLED", "Enable this source before syncing.");
      if (source.configuration.kind !== "rest_api") {
        throw new ApiFailure(409, "SOURCE_CONFIGURATION_INVALID", "The REST source configuration is invalid.");
      }
      const configuration = source.configuration;
      if (
        (configuration.method !== undefined && configuration.method !== "GET") ||
        (configuration.responseFormat !== undefined && configuration.responseFormat !== "json") ||
        (configuration.authMode !== undefined && configuration.authMode !== "none" && configuration.authMode !== "bearer")
      ) {
        return configurationFailure(source.id, "SOURCE_CONFIGURATION_INVALID", "The REST source configuration is not supported.");
      }
      const url = endpointUrl(configuration);
      const limits = validateLimits(configuration);
      if (!url || !limits) {
        return configurationFailure(source.id, "SOURCE_CONFIGURATION_INVALID", "Configure a valid endpoint path and bounded request limits.");
      }
      const mapping = await getActiveEventMapping(db, source.id);
      if (!mapping) {
        throw new ApiFailure(409, "ACTIVE_MAPPING_REQUIRED", "Activate an event mapping before syncing this REST source.");
      }
      if (configuration.authMode === "bearer" && url.protocol !== "https:") {
        return configurationFailure(source.id, "BEARER_REQUIRES_HTTPS", "Bearer authentication requires HTTPS.");
      }
      const token = parseBearerToken(configuration);
      if (configuration.authMode === "bearer" && !token) {
        return configurationFailure(source.id, "BEARER_TOKEN_UNAVAILABLE", "The configured bearer-token environment variable is not available.");
      }

      let responseBytes: Buffer;
      try {
        responseBytes = await requestJson(
          url,
          token ? `Bearer ${token}` : undefined,
          limits.timeoutMs,
          limits.maxResponseBytes,
          policy,
        );
      } catch (cause) {
        const safeError = cause instanceof RestRequestError
          ? cause
          : new RestRequestError("REST_REQUEST_FAILED", "The remote request failed.");
        return failureResult(source.id, safeError);
      }

      let responseJson: unknown;
      try {
        responseJson = JSON.parse(responseBytes.toString("utf8"));
      } catch {
        return failureResult(
          source.id,
          new RestRequestError("REST_INVALID_JSON", "The remote response was not valid JSON."),
        );
      }
      const recordsValue = configuration.recordsPath
        ? (isRecord(responseJson) ? readMappedField(responseJson as JsonObject, configuration.recordsPath) : undefined)
        : responseJson;
      if (!Array.isArray(recordsValue)) {
        return failureResult(
          source.id,
          new RestRequestError("REST_RECORDS_PATH_INVALID", "The configured JSON path did not contain an array of records."),
        );
      }
      if (recordsValue.length > limits.maxRecords) {
        return {
          sourceId: source.id,
          requestSucceeded: true,
          fetched: recordsValue.length,
          imported: 0,
          duplicates: 0,
          failed: recordsValue.length,
          errors: [{
            record: 0,
            code: "REST_RECORD_LIMIT_EXCEEDED",
            message: `The response contained ${recordsValue.length} records; the configured limit is ${limits.maxRecords}.`,
          }],
          errorsTruncated: false,
        };
      }

      let imported = 0;
      let duplicates = 0;
      let failed = 0;
      const errors: RestSyncRecordError[] = [];
      for (let index = 0; index < recordsValue.length; index += 1) {
        const record = recordsValue[index];
        const recordNumber = index + 1;
        try {
          if (!isRecord(record)) {
            throw new ApiFailure(400, "INVALID_REMOTE_RECORD", "The remote item must be a JSON object.");
          }
          const rawRecord = record as JsonObject;
          const normalized = await normalizeMappedEvent(
            db,
            source.id,
            rawRecord,
            basePayload(rawRecord),
            mapping,
            fallbackKey(source.id, rawRecord),
            { connector: "rest_api", responseFormat: "json" },
          );
          const ingestion = await ingestEvent(db, normalized);
          if (ingestion.duplicate) duplicates += 1;
          else imported += 1;
        } catch (cause) {
          failed += 1;
          if (errors.length < MAX_ERRORS) errors.push(recordError(recordNumber, cause));
        }
      }
      return {
        sourceId: source.id,
        requestSucceeded: true,
        fetched: recordsValue.length,
        imported,
        duplicates,
        failed,
        errors,
        errorsTruncated: failed > errors.length,
      };
    },
  );
}
