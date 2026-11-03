import type {
  AuthSessionResponse,
  AssetCreateInput,
  AssetDetail,
  AssetRecord,
  AssetStatusFilter,
  AssetType,
  AssetUpdateInput,
  DataSourceCreateInput,
  DataSourceConfigurationInput,
  DataSourceDiscoveryResult,
  DataSourceEnabledFilter,
  DataSourceRecord,
  DataSourceEventMapping,
  DataSourceEventMappingsResponse,
  DataSourceType,
  DataSourceUpdateInput,
  EventMappingDefinition,
  EventMappingValidationResult,
  FileImportResult,
  EventDetail,
  EventListFilters,
  EventListItem,
  HealthResponse,
  IngestEventInput,
  IngestEventResponse,
  Page,
  RestSyncResult,
  RestSyncRunsResponse,
} from "@kudu/shared";

export interface LocalDatabaseResponse {
  engine: "SQLite";
  connected: boolean;
  filePath: string;
  dataDirectory: string;
  backupsDirectory: string;
  sqliteVersion: string;
  schemaVersion: string;
  migrationState: "current";
  integrity: "ok";
  lastSuccessfulInitialization: string | null;
}

export interface LocalDatabaseBackup {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  createdAt: string;
}

let csrfToken: string | null = null;
export const AUTH_EXPIRED_EVENT = "kudu:auth-expired";

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const prefix = "kudu_csrf=";
  const entry = document.cookie.split(";").map(value => value.trim()).find(value => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}

export interface ListQuery {
  search?: string;
  page?: number;
  pageSize?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (csrfToken) {
    headers.set("X-Kudu-CSRF", csrfToken);
  }
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers,
    });
  } catch {
    throw new ApiError("The Kudu API could not be reached.", 0, "NETWORK_ERROR");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorBody =
      typeof payload === "object" && payload !== null && "error" in payload
        ? (payload as {
            error?: {
              code?: string;
              message?: string;
              fields?: Record<string, string>;
            };
          }).error
        : undefined;
    if (
      response.status === 401 &&
      (errorBody?.code === "AUTH_REQUIRED" || errorBody?.code === "SESSION_EXPIRED")
    ) {
      setCsrfToken(null);
      if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    }
    throw new ApiError(
      errorBody?.message ?? `Request failed (${response.status}).`,
      response.status,
      errorBody?.code ?? "REQUEST_FAILED",
      errorBody?.fields,
    );
  }
  return payload as T;
}

export async function getAuthSession(): Promise<AuthSessionResponse> {
  const session = await request<AuthSessionResponse>("/api/v1/auth/session");
  const token = session.authenticated && !session.localMode ? readCsrfCookie() : null;
  setCsrfToken(token);
  if (session.authenticated && !session.localMode && !token) {
    throw new ApiError(
      "The browser did not accept Kudu's session security cookie. Check the HTTPS and cookie settings.",
      0,
      "CSRF_COOKIE_UNAVAILABLE",
    );
  }
  return session;
}

export function getLocalDatabase(): Promise<LocalDatabaseResponse> {
  return request("/api/v1/local/database");
}

export function listLocalDatabaseBackups(): Promise<{ items: LocalDatabaseBackup[] }> {
  return request("/api/v1/local/database/backups");
}

export function createLocalDatabaseBackup(): Promise<{ backup: LocalDatabaseBackup }> {
  return request("/api/v1/local/database/backups", { method: "POST" });
}

export function restoreLocalDatabaseBackup(backupName: string): Promise<{
  status: LocalDatabaseResponse;
  safetyBackup: LocalDatabaseBackup;
}> {
  return request("/api/v1/local/database/restore", {
    method: "POST", body: JSON.stringify({ backupName, confirm: true }),
  });
}

export async function login(password: string): Promise<AuthSessionResponse> {
  await request<AuthSessionResponse>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  return getAuthSession();
}

export async function logout(): Promise<void> {
  try {
    await request<void>("/api/v1/auth/logout", { method: "POST" });
  } finally {
    setCsrfToken(null);
  }
}

function listPath(resource: string, query: ListQuery, extra: Record<string, string> = {}) {
  const params = new URLSearchParams();
  if (query.search?.trim()) params.set("search", query.search.trim());
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 25));
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return `/api/v1/${resource}?${params.toString()}`;
}

export function getHealth() {
  return request<HealthResponse>("/api/v1/health");
}

export function listAssets(
  query: ListQuery & { status?: AssetStatusFilter; assetType?: AssetType },
): Promise<Page<AssetRecord>> {
  const extra: Record<string, string> = { status: query.status ?? "active" };
  if (query.assetType) extra.assetType = query.assetType;
  return request(listPath("assets", query, extra));
}

export function getAsset(id: string): Promise<AssetDetail> {
  return request(`/api/v1/assets/${encodeURIComponent(id)}`);
}

export function createAsset(input: AssetCreateInput): Promise<AssetDetail> {
  return request("/api/v1/assets", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateAsset(id: string, input: AssetUpdateInput): Promise<AssetDetail> {
  return request(`/api/v1/assets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function listDataSources(
  query: ListQuery & { sourceType?: DataSourceType; enabled?: DataSourceEnabledFilter },
): Promise<Page<DataSourceRecord>> {
  const extra: Record<string, string> = {
    enabled: query.enabled ?? "all",
  };
  if (query.sourceType) extra.sourceType = query.sourceType;
  return request(listPath("data-sources", query, extra));
}

export function getDataSource(id: string): Promise<DataSourceRecord> {
  return request(`/api/v1/data-sources/${encodeURIComponent(id)}`);
}

export function createDataSource(input: DataSourceCreateInput): Promise<DataSourceRecord> {
  return request("/api/v1/data-sources", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function discoverDataSource(
  sourceType: Exclude<DataSourceType, "manual">,
  configuration: DataSourceConfigurationInput,
  recordPath?: string,
  sourceKey?: string,
): Promise<DataSourceDiscoveryResult> {
  return request("/api/v1/data-sources/discover", {
    method: "POST",
    body: JSON.stringify({
      sourceType,
      configuration,
      ...(recordPath ? { recordPath } : {}),
      ...(sourceKey ? { sourceKey } : {}),
    }),
  });
}

export function updateDataSource(
  id: string,
  input: DataSourceUpdateInput,
): Promise<DataSourceRecord> {
  return request(`/api/v1/data-sources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function importDataSourceFile(id: string): Promise<FileImportResult> {
  return request(`/api/v1/data-sources/${encodeURIComponent(id)}/import`, {
    method: "POST",
  });
}

export function syncRestDataSource(id: string): Promise<RestSyncResult> {
  return request(`/api/v1/data-sources/${encodeURIComponent(id)}/sync`, {
    method: "POST",
  });
}

export function listRestSyncRuns(id: string): Promise<RestSyncRunsResponse> {
  return request(`/api/v1/data-sources/${encodeURIComponent(id)}/sync-runs`);
}

export function resumeRestSyncRun(id: string, runId: string): Promise<RestSyncResult> {
  return request(
    `/api/v1/data-sources/${encodeURIComponent(id)}/sync-runs/${encodeURIComponent(runId)}/resume`,
    { method: "POST" },
  );
}

export function listDataSourceEventMappings(id: string): Promise<DataSourceEventMappingsResponse> {
  return request(`/api/v1/data-sources/${encodeURIComponent(id)}/mappings`);
}

export function createDataSourceEventMapping(
  id: string,
  definition: EventMappingDefinition,
): Promise<{ mapping: DataSourceEventMapping }> {
  return request(`/api/v1/data-sources/${encodeURIComponent(id)}/mappings`, {
    method: "POST",
    body: JSON.stringify({ definition }),
  });
}

export function updateDataSourceEventMapping(
  id: string,
  version: number,
  definition: EventMappingDefinition,
): Promise<{ mapping: DataSourceEventMapping }> {
  return request(`/api/v1/data-sources/${encodeURIComponent(id)}/mappings/${version}`, {
    method: "PUT",
    body: JSON.stringify({ definition }),
  });
}

export function validateDataSourceEventMapping(
  id: string,
  version: number,
): Promise<{ mapping: DataSourceEventMapping } & EventMappingValidationResult> {
  return request(`/api/v1/data-sources/${encodeURIComponent(id)}/mappings/${version}/validate`, {
    method: "POST",
  });
}

export function activateDataSourceEventMapping(
  id: string,
  version: number,
): Promise<{ mapping: DataSourceEventMapping }> {
  return request(`/api/v1/data-sources/${encodeURIComponent(id)}/mappings/${version}/activate`, {
    method: "POST",
  });
}

export function listEvents(
  query: ListQuery & EventListFilters,
): Promise<Page<EventListItem>> {
  const extra: Record<string, string> = {};
  if (query.sourceId) extra.sourceId = query.sourceId;
  if (query.assetId) extra.assetId = query.assetId;
  if (query.sourceKey) extra.sourceKey = query.sourceKey;
  if (query.assetKey) extra.assetKey = query.assetKey;
  if (query.eventType) extra.eventType = query.eventType;
  if (query.from) extra.from = query.from;
  if (query.to) extra.to = query.to;
  return request(listPath("events", query, extra));
}

export function getEvent(id: string): Promise<EventDetail> {
  return request(`/api/v1/events/${encodeURIComponent(id)}`);
}

export function ingestEvent(input: IngestEventInput): Promise<IngestEventResponse> {
  return request("/api/v1/events", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
