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
import { getActiveEventMapping, normalizeMappedEvent, readMappedField } from "./event-mappings.js";
import { ingestEvent } from "./events.js";

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

interface SyncCheckpoint extends JsonObject {
  offset?: number;
  page?: number;
  cursor?: string;
  cursorHashes?: string[];
}

interface SyncRunRow {
  id: string;
  source_id: string;
  mapping_version: number;
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
    endpointPath: configuration.endpointPath ?? "",
    method: configuration.method ?? "GET",
    authMode: configuration.authMode ?? "none",
    credentialRef: configuration.credentialRef ?? "",
    recordsPath: configuration.recordsPath ?? "",
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
  if (!Array.isArray(records)) {
    throw new RestRequestError("REST_RECORDS_PATH_INVALID", "The configured JSON path did not contain an array of records.", 400);
  }
  return records;
}

function nextCursorFromResponse(
  value: unknown,
  pagination: RestPaginationConfiguration,
): string | undefined {
  if (!isRecord(value)) return undefined;
  const cursor = readMappedField(value as JsonObject, pagination.nextCursorPath!);
  if (cursor === undefined || cursor === null || cursor === "") return undefined;
  if (typeof cursor === "string" || (typeof cursor === "number" && Number.isFinite(cursor))) return String(cursor);
  throw new RestRequestError("REST_CURSOR_INVALID", "The configured next-cursor path did not contain a string or number.", 400);
}

async function getSyncRun(db: Kysely<Database>, runId: string): Promise<SyncRunRow | undefined> {
  return await db.selectFrom("data_source_sync_runs").selectAll().where("id", "=", runId).executeTakeFirst() as SyncRunRow | undefined;
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
  await db.updateTable("data_source_sync_runs").set({
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
  mapping: Awaited<ReturnType<typeof getActiveEventMapping>> & {},
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
  let done = false;
  let lastRequestAt = 0;

  try {
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
      for (let index = 0; index < records.length; index += 1) {
        const value = records[index];
        const recordNumber = fetched + index + 1;
        try {
          if (!isRecord(value)) throw new ApiFailure(400, "INVALID_REMOTE_RECORD", "The remote item must be a JSON object.");
          const rawRecord = value as JsonObject;
          const normalized = await normalizeMappedEvent(
            db,
            source.id,
            rawRecord,
            basePayload(rawRecord),
            mapping,
            fallbackKey(source.id, rawRecord),
            { connector: "rest_api", responseFormat: "json", syncRunId: run.id, mappingVersion: mapping.version },
          );
          const ingestion = await ingestEvent(db, normalized);
          if (ingestion.duplicate) pageDuplicates += 1;
          else pageImported += 1;
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
          nextCheckpoint = { ...checkpoint, cursor: nextCursor, cursorHashes: [...hashes, hash].slice(-10_000) };
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
        last_successful_sync_at: new Date().toISOString(),
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
    const discoveryRequest = pageUrl(
      url,
      configuration.pagination,
      initialCheckpoint(configuration.pagination),
      configuration.pagination?.pageSize ?? limits.maxRecords,
    );
    bytes = await requestJsonWithRetry(
      discoveryRequest.url,
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
      responseBytes = await requestJsonWithRetry(
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
