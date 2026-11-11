import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type {
  JsonObject,
  RestPaginationConfiguration,
  RestSyncRecordError,
  RestSyncResult,
  RestSyncRunStatus,
} from "@kudu/shared";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database, StoredSourceConfiguration } from "./database.js";
import { ApiFailure } from "./errors.js";
import { getActiveEventMapping, loadAssetMatchContext, readMappedField } from "./event-mappings.js";
import { automaticEventDefinition, recognizeSourceRecords } from "./data-discovery.js";
import { normalizeAndLinkSourceRecord, sourceRecordIdentity, storeSourceRecord } from "./source-records.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_BYTES = 1_048_576;
const DEFAULT_RECORDS = 500;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_ERRORS = 100;
const MAX_REDIRECTS = 3;
const MAX_PAGES_PER_ACTION = 3;
const MAX_RETRIES = 3;
const MAX_CURSOR_LENGTH = 4096;
const MAX_CURSOR_HISTORY = 1000;
const SOURCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_REF_PATTERN = /^env:KUDU_SOURCE_[A-Z0-9_]{1,80}$/;

export interface NetworkPolicy {
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
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RestRequestError";
  }
}

function readRetryAfter(headers: http.IncomingHttpHeaders): number | undefined {
  const value = headers["retry-after"];
  if (typeof value !== "string") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.min(date - Date.now(), 10_000));
}

function requestFailureFromError(error: Error): RestRequestError {
  if (error instanceof RestRequestError) return error;
  const code = (error as NodeJS.ErrnoException).code ?? "";
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ENODATA"].includes(code)) {
    return new RestRequestError("REST_DNS_FAILED", "The remote destination could not be resolved.");
  }
  if (/^(ERR_TLS|ERR_SSL|ERR_OSSL|ERR_CERT|CERT_|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT)/i.test(code)) {
    return new RestRequestError("REST_TLS_FAILED", "The remote TLS certificate or handshake could not be verified.");
  }
  return new RestRequestError("REST_REQUEST_FAILED", "The remote request failed.");
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

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function normalizedHost(url: URL): string {
  return normalizeHostname(url.hostname);
}

function getTrustedHosts(policy: NetworkPolicy): Set<string> {
  const configured = policy.trustedHosts ??
    (process.env.KUDU_REST_TRUSTED_HOSTS ?? "").split(",");
  return new Set(configured
    .map((host) => normalizeHostname(host.trim()))
    .filter(Boolean));
}

export function networkPolicyForRestConfiguration(
  policy: NetworkPolicy,
  configuration: Pick<Extract<StoredSourceConfiguration, { kind: "rest_api" }>, "trustedPrivateHost">,
): NetworkPolicy {
  const trustedHosts = getTrustedHosts(policy);
  if (configuration.trustedPrivateHost) {
    trustedHosts.add(normalizeHostname(configuration.trustedPrivateHost));
  }
  return { ...policy, trustedHosts: [...trustedHosts] };
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

function isPrivateNetworkAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? privateIpv4.check(address, "ipv4")
    : family === 6 && privateIpv6.check(address, "ipv6");
}

export function isAllowedRestAddress(
  hostname: string,
  address: string,
  policy: NetworkPolicy = {},
): boolean {
  const host = normalizeHostname(hostname);
  if (isIP(host) && host !== address.toLowerCase()) return false;
  return isAllowedAddress(
    address,
    getTrustedHosts(policy).has(host),
    policy.allowLoopbackForTests === true,
  );
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
  const trusted = getTrustedHosts(policy).has(host);
  const blockedAddresses = addresses.filter((entry) => !isAllowedRestAddress(host, entry.address, policy));
  if (addresses.length === 0 || blockedAddresses.length > 0) {
    const message = blockedAddresses.some((entry) => isPrivateNetworkAddress(entry.address)) && !trusted
      ? "This REST host resolves to a private-network address that is not trusted. Edit the source and enable trust for the exact base-URL hostname or IP. Loopback, link-local, cloud metadata, and reserved addresses remain blocked."
      : "This REST destination resolves to loopback, link-local, cloud metadata, or another prohibited address. Private-host trust does not override those blocks.";
    throw new RestRequestError("REST_DESTINATION_BLOCKED", message, 403);
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
      finish(requestFailureFromError(error));
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
  const trustedHosts = getTrustedHosts(policy);
  const requiresTrustedRedirectTarget = trustedHosts.has(normalizedHost(initialUrl));
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
      if (requiresTrustedRedirectTarget && !trustedHosts.has(normalizedHost(next))) {
        throw new RestRequestError(
          "REST_REDIRECT_REJECTED",
          "A trusted REST host redirected to a different host. Set the source base URL to the final approved host or add that exact redirect host to KUDU_REST_TRUSTED_HOSTS.",
        );
      }
      if (url.protocol === "https:" && next.protocol !== "https:") {
        throw new RestRequestError("REST_REDIRECT_REJECTED", "The remote redirect could not be followed.");
      }
      url = next;
      continue;
    }
    if (status < 200 || status >= 300) {
      throw new RestRequestError(
        "REST_HTTP_ERROR",
        `The remote API returned HTTP ${status}.`,
        status,
        readRetryAfter(response.headers),
      );
    }
    return response.body;
  }
  throw new RestRequestError("REST_REDIRECT_REJECTED", "The remote redirect could not be followed.");
}

async function requestJsonWithRetry(
  initialUrl: URL,
  authorization: string | undefined,
  timeoutMs: number,
  maxResponseBytes: number,
  policy: NetworkPolicy,
): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RestRequestError("REST_TIMEOUT", "The remote request timed out.", 504);
    try {
      return await requestJson(initialUrl, authorization, remaining, maxResponseBytes, policy);
    } catch (cause) {
      if (!(cause instanceof RestRequestError)) throw cause;
      const retryable =
        cause.code === "REST_TIMEOUT" ||
        cause.code === "REST_REQUEST_FAILED" ||
        (cause.code === "REST_HTTP_ERROR" && (cause.statusCode === 429 || cause.statusCode >= 500));
      if (!retryable || attempt === MAX_RETRIES) throw cause;
      const delay = Math.min(cause.retryAfterMs ?? 250 * (2 ** attempt), 5_000);
      if (Date.now() + delay >= deadline) throw cause;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new RestRequestError("REST_REQUEST_FAILED", "The remote request failed.");
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

interface SyncCheckpoint {
  offset?: number;
  page?: number;
  cursor?: string;
  cursorHashes?: string[];
}

interface SyncRunRow {
  id: string;
  source_id: string;
  mapping_version: number | null;
  status: RestSyncRunStatus;
  resumable: boolean;
  request_succeeded: boolean;
  config_fingerprint: string;
  checkpoint: JsonObject;
  pages_completed: number;
  fetched: number;
  imported: number;
  duplicates: number;
  failed: number;
  errors: RestSyncRecordError[];
  errors_truncated: boolean;
  last_error_code: string | null;
  started_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

function runResult(row: SyncRunRow): RestSyncResult {
  const timestamp = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return {
    runId: row.id,
    sourceId: row.source_id,
    mappingVersion: row.mapping_version,
    status: row.status,
    requestSucceeded: row.request_succeeded,
    pagesCompleted: row.pages_completed,
    fetched: row.fetched,
    imported: row.imported,
    duplicates: row.duplicates,
    failed: row.failed,
    errors: row.errors,
    errorsTruncated: row.errors_truncated,
    startedAt: timestamp(row.started_at),
    updatedAt: timestamp(row.updated_at),
    completedAt: row.completed_at ? timestamp(row.completed_at) : null,
    resumable: row.resumable,
  };
}

function syncConfigFingerprint(configuration: Extract<StoredSourceConfiguration, { kind: "rest_api" }>): string {
  return createHash("sha256").update(canonicalJson({
    baseUrl: configuration.baseUrl,
    trustedPrivateHost: configuration.trustedPrivateHost ?? "",
    queryParameters: configuration.queryParameters ?? {},
    endpointPath: configuration.endpointPath ?? "",
    method: configuration.method ?? "GET",
    authMode: configuration.authMode ?? "none",
    credentialRef: configuration.credentialRef ?? "",
    recordsPath: configuration.recordsPath ?? "",
    sourceTimezone: configuration.sourceTimezone ?? "",
    pagination: configuration.pagination ?? null,
  })).digest("hex");
}

function initialCheckpoint(pagination: RestPaginationConfiguration | undefined): SyncCheckpoint {
  if (pagination?.strategy === "offset") return { offset: pagination.startOffset ?? 0 };
  if (pagination?.strategy === "page") return { page: pagination.startPage ?? 1 };
  return {};
}

function checkpointFrom(value: unknown): SyncCheckpoint {
  if (typeof value === "string") {
    try { return checkpointFrom(JSON.parse(value) as unknown); } catch { return {}; }
  }
  return isRecord(value) ? value as SyncCheckpoint : {};
}

function pageUrl(
  endpoint: URL,
  pagination: RestPaginationConfiguration | undefined,
  checkpoint: SyncCheckpoint,
  remaining: number,
): { url: URL; requestedLimit: number } {
  const url = new URL(endpoint);
  if (!pagination) return { url, requestedLimit: remaining };
  const requestedLimit = Math.min(pagination.pageSize, remaining);
  url.searchParams.set(pagination.limitParameter, String(requestedLimit));
  if (pagination.strategy === "offset") {
    url.searchParams.set(pagination.offsetParameter!, String(checkpoint.offset ?? pagination.startOffset ?? 0));
  } else if (pagination.strategy === "page") {
    url.searchParams.set(pagination.pageParameter!, String(checkpoint.page ?? pagination.startPage ?? 1));
  } else if (checkpoint.cursor) {
    url.searchParams.set(pagination.cursorParameter!, checkpoint.cursor);
  }
  if (pagination.dateFromParameter && pagination.dateFrom) {
    url.searchParams.set(pagination.dateFromParameter, pagination.dateFrom);
  }
  if (pagination.dateToParameter && pagination.dateTo) {
    url.searchParams.set(pagination.dateToParameter, pagination.dateTo);
  }
  return { url, requestedLimit };
}

function recordsFromResponse(
  value: unknown,
  configuration: Extract<StoredSourceConfiguration, { kind: "rest_api" }>,
): unknown[] {
  const records = configuration.recordsPath
    ? isRecord(value) ? readMappedField(value as JsonObject, configuration.recordsPath) : undefined
    : value;
  if (Array.isArray(records)) return records;
  if (!configuration.recordsPath && isRecord(records)) return [records];
  throw new RestRequestError("REST_RECORDS_PATH_INVALID", "The configured JSON path did not contain an array of records.", 400);
}

function nextCursorFromResponse(
  value: unknown,
  pagination: RestPaginationConfiguration,
): string | undefined {
  if (!isRecord(value)) return undefined;
  const cursor = readMappedField(value as JsonObject, pagination.nextCursorPath!);
  if (cursor === undefined || cursor === null || cursor === "") return undefined;
  if (typeof cursor === "string" || (typeof cursor === "number" && Number.isFinite(cursor))) {
    const token = String(cursor);
    if (token.length > MAX_CURSOR_LENGTH) {
      throw new RestRequestError("REST_CURSOR_TOO_LARGE", "The remote cursor exceeded the supported size.", 400);
    }
    return token;
  }
  throw new RestRequestError("REST_CURSOR_INVALID", "The configured next-cursor path did not contain a string or number.", 400);
}

async function getSyncRun(db: Kysely<Database>, runId: string): Promise<SyncRunRow | undefined> {
  return await db.selectFrom("source_sync_runs").selectAll().where("id", "=", runId).executeTakeFirst() as SyncRunRow | undefined;
}

async function persistRun(
  db: Kysely<Database>,
  runId: string,
  values: {
    status: RestSyncRunStatus;
    resumable: boolean;
    requestSucceeded: boolean;
    checkpoint: SyncCheckpoint;
    pagesCompleted: number;
    fetched: number;
    imported: number;
    duplicates: number;
    failed: number;
    errors: RestSyncRecordError[];
    errorsTruncated: boolean;
    lastErrorCode: string | null;
    completed: boolean;
  },
): Promise<SyncRunRow> {
  const now = new Date().toISOString();
  await db.updateTable("source_sync_runs").set({
    status: values.status,
    resumable: values.resumable,
    request_succeeded: values.requestSucceeded,
    checkpoint: JSON.stringify(values.checkpoint),
    pages_completed: values.pagesCompleted,
    fetched: values.fetched,
    imported: values.imported,
    duplicates: values.duplicates,
    failed: values.failed,
    errors: JSON.stringify(values.errors),
    errors_truncated: values.errorsTruncated,
    last_error_code: values.lastErrorCode,
    updated_at: now,
    completed_at: values.completed ? now : null,
  }).where("id", "=", runId).execute();
  const row = await getSyncRun(db, runId);
  if (!row) throw new Error("The sync run disappeared while it was being updated.");
  return row;
}

function appendRunError(
  errors: RestSyncRecordError[],
  errorsTruncated: boolean,
  error: RestSyncRecordError,
): { errors: RestSyncRecordError[]; errorsTruncated: boolean } {
  if (errors.length >= MAX_ERRORS) return { errors, errorsTruncated: true };
  return { errors: [...errors, error], errorsTruncated };
}

async function executeSyncRun(
  db: Kysely<Database>,
  source: { id: string; sourceKey: string; configuration: Extract<StoredSourceConfiguration, { kind: "rest_api" }> },
  mapping: Awaited<ReturnType<typeof getActiveEventMapping>>,
  initialRun: SyncRunRow,
  endpoint: URL,
  authorization: string | undefined,
  timeoutMs: number,
  maxResponseBytes: number,
  maxRecords: number,
  policy: NetworkPolicy,
): Promise<RestSyncResult> {
  let run = initialRun;
  let checkpoint = checkpointFrom(run.checkpoint);
  let requestSucceeded = run.request_succeeded;
  let pagesCompleted = run.pages_completed;
  let fetched = run.fetched;
  let imported = run.imported;
  let duplicates = run.duplicates;
  let failed = run.failed;
  let errors = run.errors;
  let errorsTruncated = run.errors_truncated;
  let lastErrorCode = run.last_error_code;
  let actionPages = 0;
  const pagination = source.configuration.pagination;
  let assetMatchContext: Awaited<ReturnType<typeof loadAssetMatchContext>> | undefined;
  let done = false;
  let lastRequestAt = 0;

  try {
    assetMatchContext = mapping?.definition.assetKey
      ? await loadAssetMatchContext(db, source.sourceKey)
      : undefined;
    while (!done && actionPages < MAX_PAGES_PER_ACTION && pagesCompleted < MAX_RECORDS + 1) {
      const remaining = maxRecords - fetched;
      if (remaining <= 0) break;
      const request = pageUrl(endpoint, pagination, checkpoint, remaining);
      if (actionPages > 0 && pagination?.requestIntervalMs) {
        const waitMs = pagination.requestIntervalMs - (Date.now() - lastRequestAt);
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      let bytes: Buffer;
      try {
        bytes = await requestJsonWithRetry(request.url, authorization, timeoutMs, maxResponseBytes, policy);
        requestSucceeded = true;
      } finally {
        lastRequestAt = Date.now();
      }
      let responseJson: unknown;
      try { responseJson = JSON.parse(bytes.toString("utf8")) as unknown; }
      catch { throw new RestRequestError("REST_INVALID_JSON", "The remote response was not valid JSON."); }
      const records = recordsFromResponse(responseJson, source.configuration);
      if (pagination && records.length > request.requestedLimit) {
        throw new RestRequestError("REST_PAGE_LIMIT_IGNORED", "The remote API returned more records than the configured page size.", 400);
      }
      if (!pagination && records.length > maxRecords) {
        throw new RestRequestError("REST_RECORD_LIMIT_EXCEEDED", `The response exceeded the configured maximum of ${maxRecords} records.`, 400);
      }

      const pageFetched = records.length;
      let pageImported = 0;
      let pageDuplicates = 0;
      let pageFailed = 0;
      const objectRecords = records.filter(isRecord) as JsonObject[];
      const recognition = recognizeSourceRecords("rest_api", objectRecords, source.configuration.sourceTimezone);
      const automaticDefinition = automaticEventDefinition(recognition);
      const normalizationMapping = mapping ?? (automaticDefinition ? { definition: automaticDefinition } : undefined);
      const suggestedSourceRecordId = recognition.suggestions.find(item => item.target === "sourceRecordId")?.sourcePath ?? undefined;
      const identityDefinition = mapping?.definition
        ? { ...mapping.definition, sourceRecordId: mapping.definition.sourceRecordId ?? suggestedSourceRecordId }
        : { sourceRecordId: suggestedSourceRecordId };
      for (let index = 0; index < records.length; index += 1) {
        const value = records[index];
        const recordNumber = fetched + index + 1;
        try {
          if (!isRecord(value)) throw new ApiFailure(400, "INVALID_REMOTE_RECORD", "The remote item must be a JSON object.");
          const rawRecord = value as JsonObject;
          const fallbackDeduplicationKey = fallbackKey(source.id, rawRecord);
          const identity = sourceRecordIdentity(rawRecord, identityDefinition, fallbackDeduplicationKey);
          const stored = await storeSourceRecord(db, {
            sourceId: source.id,
            sourceRecordId: identity.sourceRecordId,
            deduplicationKey: identity.deduplicationKey,
            rawRecord,
            provenance: {
              connector: "rest_api",
              responseFormat: "json",
              syncRunId: run.id,
              ...(mapping ? { mappingVersion: mapping.version } : {}),
            },
            syncRunId: run.id,
            mappingVersion: mapping?.version,
          });
          if (stored.duplicate) pageDuplicates += 1;
          else pageImported += 1;
          let payload: JsonObject = {};
          try { payload = basePayload(rawRecord); } catch { /* Preserve raw-only when the event payload shape is unsupported. */ }
          await normalizeAndLinkSourceRecord(db, stored, {
            sourceId: source.id,
            rawRecord,
            basePayload: payload,
            fallbackDeduplicationKey,
            mapping: normalizationMapping,
            provenance: {
              connector: "rest_api",
              responseFormat: "json",
              syncRunId: run.id,
              ...(mapping ? { mappingVersion: mapping.version } : {}),
            },
            assetMatchContext,
            sourceTimezone: source.configuration.sourceTimezone,
          });
        } catch (cause) {
          if (!(cause instanceof ApiFailure) || cause.statusCode >= 500) throw cause;
          pageFailed += 1;
          const appended = appendRunError(errors, errorsTruncated, recordError(recordNumber, cause));
          errors = appended.errors;
          errorsTruncated = appended.errorsTruncated || pageFailed + failed > errors.length;
        }
      }
      fetched += pageFetched;
      imported += pageImported;
      duplicates += pageDuplicates;
      failed += pageFailed;
      pagesCompleted += 1;
      actionPages += 1;

      let nextCheckpoint = checkpoint;
      if (!pagination) done = true;
      else if (pagination.strategy === "cursor") {
        const nextCursor = nextCursorFromResponse(responseJson, pagination);
        if (!nextCursor) done = true;
        else {
          const hashes = checkpoint.cursorHashes ?? [];
          const hash = createHash("sha256").update(nextCursor).digest("hex");
          if (hashes.includes(hash)) throw new RestRequestError("REST_CURSOR_REPEATED", "The remote API repeated a cursor; sync stopped to prevent an infinite loop.", 400);
          nextCheckpoint = { ...checkpoint, cursor: nextCursor, cursorHashes: [...hashes, hash].slice(-MAX_CURSOR_HISTORY) };
        }
      } else {
        done = records.length < request.requestedLimit;
        nextCheckpoint = pagination.strategy === "offset"
          ? { ...checkpoint, offset: (checkpoint.offset ?? pagination.startOffset ?? 0) + records.length }
          : { ...checkpoint, page: (checkpoint.page ?? pagination.startPage ?? 1) + 1 };
      }
      checkpoint = nextCheckpoint;
      lastErrorCode = pageFailed ? "RECORDS_REJECTED" : null;
      run = await persistRun(db, run.id, {
        status: "running",
        resumable: false,
        requestSucceeded,
        checkpoint,
        pagesCompleted,
        fetched,
        imported,
        duplicates,
        failed,
        errors,
        errorsTruncated,
        lastErrorCode,
        completed: false,
      });
      if (done) break;
    }

    const status: RestSyncRunStatus = done ? "completed" : "paused";
    run = await persistRun(db, run.id, {
      status,
      resumable: status === "paused",
      requestSucceeded,
      checkpoint,
      pagesCompleted,
      fetched,
      imported,
      duplicates,
      failed,
      errors,
      errorsTruncated,
      lastErrorCode,
      completed: done,
    });
    if (requestSucceeded && done) {
      await db.updateTable("data_sources").set({
        last_successful_sync_at: new Date(),
        last_error_summary: failed ? `${failed} record${failed === 1 ? "" : "s"} failed during the latest sync.` : null,
      }).where("id", "=", source.id).execute();
    }
    return runResult(run);
  } catch (cause) {
    const safeError = cause instanceof RestRequestError
      ? { record: 0, code: cause.code, message: cause.message }
      : cause instanceof ApiFailure && cause.statusCode < 500
        ? recordError(0, cause)
        : { record: 0, code: "REST_SYNC_FAILED", message: "The sync stopped because the application could not safely process a response." };
    const appended = appendRunError(errors, errorsTruncated, safeError);
    errors = appended.errors;
    errorsTruncated = appended.errorsTruncated;
    lastErrorCode = safeError.code;
    run = await persistRun(db, run.id, {
      status: "failed",
      resumable: cause instanceof RestRequestError && (
        cause.code === "REST_TIMEOUT" || cause.code === "REST_REQUEST_FAILED" ||
        (cause.code === "REST_HTTP_ERROR" && (cause.statusCode === 429 || cause.statusCode >= 500))
      ),
      requestSucceeded,
      checkpoint,
      pagesCompleted,
      fetched,
      imported,
      duplicates,
      failed,
      errors,
      errorsTruncated,
      lastErrorCode,
      completed: true,
    });
    await db.updateTable("data_sources").set({
      last_error_summary: safeError.message.slice(0, 1000),
    }).where("id", "=", source.id).execute();
    return runResult(run);
  }
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
    const endpoint = new URL(`${prefix}/${suffix}`, base.origin);
    for (const [name, value] of Object.entries(configuration.queryParameters ?? {})) {
      endpoint.searchParams.set(name, value);
    }
    return endpoint;
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
  const requestPolicy = networkPolicyForRestConfiguration(policy, configuration);
  if (configuration.authMode === "bearer" && url.protocol !== "https:") {
    throw new ApiFailure(400, "BEARER_REQUIRES_HTTPS", "Bearer authentication requires HTTPS.");
  }
  const token = parseBearerToken(configuration);
  if (configuration.authMode === "bearer" && !token) {
    throw new ApiFailure(400, "BEARER_TOKEN_UNAVAILABLE", "The configured bearer-token environment variable is not available.");
  }
  let bytes: Buffer;
  try {
    const discoveryRequest = pageUrl(
      url,
      configuration.pagination,
      initialCheckpoint(configuration.pagination),
      limits.maxRecords,
    );
    bytes = await requestJsonWithRetry(
      discoveryRequest.url,
      token ? `Bearer ${token}` : undefined,
      limits.timeoutMs,
      limits.maxResponseBytes,
      requestPolicy,
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

function replaceDiscoveryRecords(document: unknown, recordPath: string, records: unknown[]): unknown {
  if (recordPath === "$") return records;
  const parts = recordPath.split(".");
  const replace = (current: unknown, index: number): Record<string, unknown> => {
    if (!isRecord(current)) {
      throw new RestRequestError("REST_RECORDS_PATH_INVALID", "The selected record collection changed shape during discovery.", 400);
    }
    const key = parts[index];
    if (!key || !Object.hasOwn(current, key)) {
      throw new RestRequestError("REST_RECORDS_PATH_INVALID", "The selected record collection changed shape during discovery.", 400);
    }
    return {
      ...current,
      [key]: index === parts.length - 1 ? records : replace(current[key], index + 1),
    };
  };
  return replace(document, 0);
}

export async function extendRestDiscoverySample(
  configuration: Extract<StoredSourceConfiguration, { kind: "rest_api" }>,
  firstDocument: unknown,
  recordPath: string,
  policy: NetworkPolicy = {},
): Promise<{ document: unknown; sampledPageCount: number }> {
  const pagination = configuration.pagination;
  if (!pagination) return { document: firstDocument, sampledPageCount: 1 };
  const url = endpointUrl(configuration);
  const limits = validateLimits(configuration);
  if (!url || !limits) throw new ApiFailure(400, "SOURCE_CONFIGURATION_INVALID", "Configure a valid endpoint path and bounded request limits.");
  const requestPolicy = networkPolicyForRestConfiguration(policy, configuration);
  if (configuration.authMode === "bearer" && url.protocol !== "https:") {
    throw new ApiFailure(400, "BEARER_REQUIRES_HTTPS", "Bearer authentication requires HTTPS.");
  }
  const token = parseBearerToken(configuration);
  if (configuration.authMode === "bearer" && !token) {
    throw new ApiFailure(400, "BEARER_TOKEN_UNAVAILABLE", "The configured bearer-token environment variable is not available.");
  }

  const recordsConfiguration = { ...configuration, recordsPath: recordPath === "$" ? "" : recordPath };
  let checkpoint = initialCheckpoint(pagination);
  let requestedLimit = pageUrl(url, pagination, checkpoint, limits.maxRecords).requestedLimit;
  let currentDocument = firstDocument;
  let currentRecords = recordsFromResponse(currentDocument, recordsConfiguration);
  const combinedRecords = currentRecords.slice(0, limits.maxRecords);
  let remaining = limits.maxRecords - combinedRecords.length;
  let sampledPageCount = 1;
  const cursorHashes: string[] = [];

  for (let page = 1; page < MAX_PAGES_PER_ACTION && remaining > 0; page += 1) {
    if (pagination.strategy === "cursor") {
      const nextCursor = nextCursorFromResponse(currentDocument, pagination);
      if (!nextCursor) break;
      const hash = createHash("sha256").update(nextCursor).digest("hex");
      if (cursorHashes.includes(hash)) {
        throw new ApiFailure(400, "REST_CURSOR_REPEATED", "The remote API repeated a cursor; discovery stopped to prevent an infinite loop.");
      }
      cursorHashes.push(hash);
      checkpoint = { ...checkpoint, cursor: nextCursor, cursorHashes: cursorHashes.slice(-MAX_CURSOR_HISTORY) };
    } else {
      if (currentRecords.length < requestedLimit) break;
      checkpoint = pagination.strategy === "offset"
        ? { ...checkpoint, offset: (checkpoint.offset ?? pagination.startOffset ?? 0) + currentRecords.length }
        : { ...checkpoint, page: (checkpoint.page ?? pagination.startPage ?? 1) + 1 };
    }

    const requestIntervalMs = pagination.requestIntervalMs ?? 0;
    if (requestIntervalMs > 0) {
      await new Promise(resolve => setTimeout(resolve, requestIntervalMs));
    }
    let bytes: Buffer;
    let request: ReturnType<typeof pageUrl>;
    try {
      request = pageUrl(url, pagination, checkpoint, remaining);
      bytes = await requestJsonWithRetry(
        request.url,
        token ? `Bearer ${token}` : undefined,
        limits.timeoutMs,
        limits.maxResponseBytes,
        requestPolicy,
      );
    } catch (cause) {
      if (cause instanceof RestRequestError) throw new ApiFailure(cause.statusCode, cause.code, cause.message);
      throw new ApiFailure(502, "REST_REQUEST_FAILED", "The remote request failed during bounded discovery.");
    }

    let nextDocument: unknown;
    try {
      nextDocument = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new ApiFailure(502, "REST_INVALID_JSON", "A paginated discovery response was not valid JSON.");
    }
    try {
      currentRecords = recordsFromResponse(nextDocument, recordsConfiguration);
    } catch (cause) {
      if (cause instanceof RestRequestError) {
        throw new ApiFailure(502, cause.code, "A paginated discovery response did not contain the selected record collection.");
      }
      throw cause;
    }
    const acceptedRecords = currentRecords.slice(0, remaining);
    combinedRecords.push(...acceptedRecords);
    remaining -= acceptedRecords.length;
    currentDocument = nextDocument;
    requestedLimit = request.requestedLimit;
    sampledPageCount += 1;
    if (currentRecords.length < requestedLimit) break;
  }

  return {
    document: replaceDiscoveryRecords(firstDocument, recordPath, combinedRecords),
    sampledPageCount,
  };
}

export function registerRestSyncRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  policy: NetworkPolicy = {},
): void {
  async function loadEnabledRestSource(id: string) {
    if (!SOURCE_ID_PATTERN.test(id)) throw new ApiFailure(400, "INVALID_ID", "A valid data-source identifier is required.");
    const source = await db.selectFrom("data_sources")
      .select(["id", "source_key", "source_type", "enabled", "configuration"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!source) throw new ApiFailure(404, "NOT_FOUND", "Data source not found.");
    if (source.source_type !== "rest_api") throw new ApiFailure(409, "UNSUPPORTED_SOURCE_TYPE", "Only REST API sources can be synced.");
    if (!source.enabled) throw new ApiFailure(409, "SOURCE_DISABLED", "Enable this source before syncing.");
    if (source.configuration.kind !== "rest_api") throw new ApiFailure(409, "SOURCE_CONFIGURATION_INVALID", "The REST source configuration is invalid.");
    const configuration = source.configuration;
    if (
      (configuration.method !== undefined && configuration.method !== "GET") ||
      (configuration.responseFormat !== undefined && configuration.responseFormat !== "json") ||
      (configuration.authMode !== undefined && configuration.authMode !== "none" && configuration.authMode !== "bearer")
    ) throw new ApiFailure(409, "SOURCE_CONFIGURATION_INVALID", "The REST source configuration is not supported.");
    const endpoint = endpointUrl(configuration);
    const limits = validateLimits(configuration);
    if (!endpoint || !limits) throw new ApiFailure(409, "SOURCE_CONFIGURATION_INVALID", "Configure a valid endpoint path and bounded request limits.");
    const mapping = await getActiveEventMapping(db, source.id);
    if (configuration.authMode === "bearer" && endpoint.protocol !== "https:") {
      throw new ApiFailure(409, "BEARER_REQUIRES_HTTPS", "Bearer authentication requires HTTPS.");
    }
    const token = parseBearerToken(configuration);
    if (configuration.authMode === "bearer" && !token) {
      throw new ApiFailure(409, "BEARER_TOKEN_UNAVAILABLE", "The configured bearer-token environment variable is not available.");
    }
    return {
      id: source.id,
      sourceKey: source.source_key,
      configuration,
      endpoint,
      mapping,
      token,
      timeoutMs: limits.timeoutMs,
      maxResponseBytes: limits.maxResponseBytes,
      maxRecords: limits.maxRecords,
    };
  }

  async function createRun(sourceId: string, mappingVersion: number | null, configuration: Extract<StoredSourceConfiguration, { kind: "rest_api" }>): Promise<SyncRunRow> {
    const existing = await db.selectFrom("source_sync_runs").select(["id"])
      .where("source_id", "=", sourceId).where("status", "=", "running").executeTakeFirst();
    if (existing) throw new ApiFailure(409, "SYNC_ALREADY_RUNNING", "This source already has an active sync run.");
    const now = new Date().toISOString();
    const runId = randomUUID();
    try {
      await db.insertInto("source_sync_runs").values({
        id: runId,
        source_id: sourceId,
        mapping_version: mappingVersion,
        status: "running",
        resumable: false,
        request_succeeded: false,
        config_fingerprint: syncConfigFingerprint(configuration),
        checkpoint: JSON.stringify(initialCheckpoint(configuration.pagination)),
        pages_completed: 0,
        fetched: 0,
        imported: 0,
        duplicates: 0,
        failed: 0,
        errors: "[]",
        errors_truncated: false,
        last_error_code: null,
        started_at: now,
        updated_at: now,
        completed_at: null,
      }).execute();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      if ((isRecord(cause) && cause.code === "23505") || /UNIQUE constraint failed|unique constraint/i.test(message)) {
        throw new ApiFailure(409, "SYNC_ALREADY_RUNNING", "This source already has an active sync run.");
      }
      throw cause;
    }
    const run = await getSyncRun(db, runId);
    if (!run) throw new ApiFailure(500, "SYNC_RUN_CREATE_FAILED", "The sync run could not be created.");
    return run;
  }

  function execute(source: Awaited<ReturnType<typeof loadEnabledRestSource>>, run: SyncRunRow) {
    return executeSyncRun(
      db,
      { id: source.id, sourceKey: source.sourceKey, configuration: source.configuration },
      source.mapping,
      run,
      source.endpoint,
      source.token ? `Bearer ${source.token}` : undefined,
      source.timeoutMs,
      source.maxResponseBytes,
      source.maxRecords,
      networkPolicyForRestConfiguration(policy, source.configuration),
    );
  }

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/v1/data-sources/:id/sync",
    async (request): Promise<RestSyncResult> => {
      if (request.body !== undefined) throw new ApiFailure(400, "REQUEST_BODY_NOT_ALLOWED", "This sync action does not accept a request body.");
      const source = await loadEnabledRestSource(request.params.id);
      const run = await createRun(source.id, source.mapping?.version ?? null, source.configuration);
      return execute(source, run);
    },
  );

  app.get<{ Params: { id: string } }>("/api/v1/data-sources/:id/sync-runs", async (request) => {
    if (!SOURCE_ID_PATTERN.test(request.params.id)) throw new ApiFailure(400, "INVALID_ID", "A valid data-source identifier is required.");
    const source = await db.selectFrom("data_sources").select(["id", "source_type"]).where("id", "=", request.params.id).executeTakeFirst();
    if (!source) throw new ApiFailure(404, "NOT_FOUND", "Data source not found.");
    if (source.source_type !== "rest_api") throw new ApiFailure(409, "UNSUPPORTED_SOURCE_TYPE", "Sync history is available for REST API sources.");
    const rows = await db.selectFrom("source_sync_runs").selectAll()
      .where("source_id", "=", source.id).orderBy("started_at", "desc").orderBy("id", "desc").limit(25).execute() as SyncRunRow[];
    return { items: rows.map(runResult) };
  });

  app.post<{ Params: { id: string; runId: string }; Body: unknown }>(
    "/api/v1/data-sources/:id/sync-runs/:runId/resume",
    async (request): Promise<RestSyncResult> => {
      if (request.body !== undefined) throw new ApiFailure(400, "REQUEST_BODY_NOT_ALLOWED", "This resume action does not accept a request body.");
      const source = await loadEnabledRestSource(request.params.id);
      if (!SOURCE_ID_PATTERN.test(request.params.runId)) throw new ApiFailure(400, "INVALID_ID", "A valid sync-run identifier is required.");
      let run = await getSyncRun(db, request.params.runId);
      if (!run || run.source_id !== source.id) throw new ApiFailure(404, "NOT_FOUND", "Sync run not found.");
      const staleRunning = run.status === "running" && Date.now() - new Date(run.updated_at).getTime() > 60_000;
      if (staleRunning) {
        await db.updateTable("source_sync_runs").set({
          status: "paused",
          resumable: true,
          updated_at: new Date().toISOString(),
        }).where("id", "=", run.id).where("status", "=", "running").execute();
        run = await getSyncRun(db, run.id);
        if (!run) throw new ApiFailure(404, "NOT_FOUND", "Sync run not found.");
      }
      if (!run.resumable || (run.status !== "paused" && run.status !== "failed")) {
        throw new ApiFailure(409, "SYNC_RUN_NOT_RESUMABLE", "This sync run cannot be resumed.");
      }
      if (run.config_fingerprint !== syncConfigFingerprint(source.configuration)) {
        throw new ApiFailure(409, "SYNC_CONFIGURATION_CHANGED", "The source pagination or record-selection configuration changed; start a new sync run.");
      }
      if ((source.mapping?.version ?? null) !== run.mapping_version) {
        throw new ApiFailure(409, "SYNC_MAPPING_CHANGED", "The active event mapping changed; start a new sync run.");
      }
      await db.updateTable("source_sync_runs").set({
        status: "running",
        resumable: false,
        updated_at: new Date().toISOString(),
        completed_at: null,
      }).where("id", "=", run.id).where("status", "in", ["paused", "failed"]).execute();
      const resumed = await getSyncRun(db, run.id);
      if (!resumed) throw new ApiFailure(404, "NOT_FOUND", "Sync run not found.");
      return execute(source, resumed);
    },
  );
}
