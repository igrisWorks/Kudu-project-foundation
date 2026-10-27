import type {
  AssetCreateInput,
  AssetDetail,
  AssetRecord,
  AssetStatusFilter,
  AssetUpdateInput,
  DataSourceCreateInput,
  DataSourceEnabledFilter,
  DataSourceRecord,
  DataSourceType,
  DataSourceUpdateInput,
  EventDetail,
  EventListFilters,
  EventListItem,
  HealthResponse,
  IngestEventInput,
  IngestEventResponse,
  Page,
} from "@kudu/shared";

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
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
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
    throw new ApiError(
      errorBody?.message ?? `Request failed (${response.status}).`,
      response.status,
      errorBody?.code ?? "REQUEST_FAILED",
      errorBody?.fields,
    );
  }
  return payload as T;
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
  query: ListQuery & { status?: AssetStatusFilter },
): Promise<Page<AssetRecord>> {
  return request(
    listPath("assets", query, { status: query.status ?? "active" }),
  );
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

export function updateDataSource(
  id: string,
  input: DataSourceUpdateInput,
): Promise<DataSourceRecord> {
  return request(`/api/v1/data-sources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
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
