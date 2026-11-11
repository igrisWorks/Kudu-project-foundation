import type { DataSourceConfigurationInput, DataSourceDiscoveryResult, DataSourceRecord, ExplorerRecordSummary, JsonObject } from "@kudu/shared";
import { ApiError } from "../api";

export type ApiTestId = "jsonplaceholder" | "openmeteo" | "usgs";
export type TestStatus = "idle" | "connecting" | "running" | "passed" | "failed";

export interface PublicApiTest {
  id: ApiTestId;
  name: string;
  purpose: string;
  baseUrl: string;
  endpointPath: string;
  queryParameters?: Record<string, string>;
  sourceTimezone?: string;
  recordPath: "$";
  documentationUrl: string;
}

export interface ApiTestState {
  status: TestStatus;
  message?: string;
  category?: string;
  errorCode?: string;
  discovery?: DataSourceDiscoveryResult;
  source?: DataSourceRecord;
  records?: ExplorerRecordSummary[];
  rawRecord?: JsonObject;
  fetched?: number;
  imported?: number;
  rawOnly?: number;
  duplicates?: number;
  failed?: number;
  features?: number;
  measurements?: number;
  fieldsDetected?: number;
  searchTerm?: string;
  searchMatches?: number;
  jsonExportCount?: number;
  csvExportCount?: number;
  sourceRecordCount?: number;
  testedEndpoint?: string;
}

export const jsonPlaceholderEndpoints = [
  { path: "posts", label: "Posts · 100 typical records" },
  { path: "users", label: "Users · nested addresses" },
  { path: "posts/1/comments", label: "Post comments · nested resource" },
] as const;

export const publicApiTests: PublicApiTest[] = [
  {
    id: "jsonplaceholder",
    name: "JSONPlaceholder",
    purpose: "Basic REST/JSON, records, nested resources, search, and export.",
    baseUrl: "https://jsonplaceholder.typicode.com",
    endpointPath: "posts",
    recordPath: "$",
    documentationUrl: "https://jsonplaceholder.typicode.com/",
  },
  {
    id: "openmeteo",
    name: "Open-Meteo",
    purpose: "Column-oriented measurements, timestamp alignment, and explicit timezone handling.",
    baseUrl: "https://api.open-meteo.com",
    endpointPath: "v1/forecast",
    queryParameters: {
      latitude: "52.52",
      longitude: "13.41",
      hourly: "temperature_2m,relative_humidity_2m,wind_speed_10m",
      timezone: "Europe/Berlin",
      forecast_days: "2",
    },
    sourceTimezone: "Europe/Berlin",
    recordPath: "$",
    documentationUrl: "https://open-meteo.com/en/docs",
  },
  {
    id: "usgs",
    name: "USGS Earthquake GeoJSON",
    purpose: "FeatureCollection metadata, nested feature properties, and coordinate preservation.",
    baseUrl: "https://earthquake.usgs.gov",
    endpointPath: "earthquakes/feed/v1.0/summary/all_day.geojson",
    recordPath: "$",
    documentationUrl: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/index.php",
  },
];

export const initialEndpoint: Record<ApiTestId, string> = {
  jsonplaceholder: "posts",
  openmeteo: "v1/forecast",
  usgs: "earthquakes/feed/v1.0/summary/all_day.geojson",
};

export function requestConfiguration(test: PublicApiTest, endpointPath = test.endpointPath): DataSourceConfigurationInput {
  return {
    kind: "rest_api",
    baseUrl: test.baseUrl,
    endpointPath,
    method: "GET",
    authMode: "none",
    timeoutMs: 10_000,
    maxResponseBytes: 5 * 1024 * 1024,
    maxRecords: 500,
    responseFormat: "json",
    ...(test.queryParameters ? { queryParameters: test.queryParameters } : {}),
    ...(test.sourceTimezone ? { sourceTimezone: test.sourceTimezone } : {}),
  };
}

export function safeEndpoint(test: PublicApiTest, endpointPath: string): string {
  const url = new URL(`${test.baseUrl.replace(/\/+$/, "")}/${endpointPath.replace(/^\/+/, "")}`);
  for (const [name, value] of Object.entries(test.queryParameters ?? {})) url.searchParams.set(name, value);
  return url.toString();
}

export function errorCategory(error: unknown): { category: string; code: string; message: string } {
  const errorCode = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const code = error instanceof ApiError
    ? error.code
    : typeof errorCode === "string"
      ? errorCode
      : "CLIENT_ERROR";
  const message = error instanceof Error ? error.message : "The compatibility test failed.";
  if (code === "REST_DNS_FAILED") return { category: "DNS", code, message };
  if (code === "REST_TLS_FAILED") return { category: "TLS certificate or handshake", code, message };
  if (code === "REST_HTTP_ERROR") return { category: "HTTP", code, message };
  if (code === "REST_INVALID_JSON") return { category: "JSON parsing", code, message };
  if (code === "REST_RESPONSE_TOO_LARGE") return { category: "Response size limit", code, message };
  if (code === "REST_TIMEOUT") return { category: "Timeout", code, message };
  if (code === "REST_REQUEST_FAILED" || code === "NETWORK_ERROR") return { category: "Network or transport", code, message };
  return { category: "KuduNS validation or ingestion", code, message };
}

export function csvDataRowCount(text: string): number {
  let quoted = false;
  let rows = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && character === "\n") {
      rows += 1;
    }
  }
  if (text.length > 0 && !text.endsWith("\n")) rows += 1;
  return Math.max(0, rows - 1);
}
