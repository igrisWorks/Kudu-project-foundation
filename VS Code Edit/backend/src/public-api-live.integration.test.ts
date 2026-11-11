import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "./app.js";
import { LocalDatabaseManager } from "./local-database.js";

const enabled = process.env.KUDU_LIVE_PUBLIC_API_TESTS === "1";
const responseLimit = 5 * 1024 * 1024;

interface LiveEndpoint {
  sourceKey: string;
  displayName: string;
  baseUrl: string;
  endpointPath: string;
  queryParameters?: Record<string, string>;
  sourceTimezone?: string;
}

class LiveApiFailure extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function dataRowsInCsv(csv: string): number {
  let quoted = false;
  let rows = 0;
  for (let index = 0; index < csv.length; index += 1) {
    if (csv[index] === '"') {
      if (quoted && csv[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && csv[index] === "\n") {
      rows += 1;
    }
  }
  if (csv.length && !csv.endsWith("\n")) rows += 1;
  return Math.max(0, rows - 1);
}

function shouldSkipLiveFailure(error: unknown): string | null {
  if (!(error instanceof LiveApiFailure)) return null;
  if (["REST_DNS_FAILED", "REST_TLS_FAILED", "REST_TIMEOUT", "REST_REQUEST_FAILED"].includes(error.code)) {
    return `${error.code}: public network access was unavailable during this run`;
  }
  if (error.code === "REST_RESPONSE_TOO_LARGE") return "the public response exceeded the configured 5 MiB test limit";
  if (error.code === "REST_HTTP_ERROR" && (error.statusCode === 429 || error.statusCode >= 500)) {
    return `public API returned HTTP ${error.statusCode}`;
  }
  return null;
}

test("opt-in public API integration tests use disposable SQLite and KuduNS raw ingestion", {
  skip: !enabled,
  timeout: 180_000,
}, async context => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-live-public-apis-"));
  const previousPort = process.env.PORT;
  const manager = await LocalDatabaseManager.create(join(directory, "sqlite"));
  await manager.initialize();
  const app = await createApp({
    db: manager.db,
    localMode: true,
    localDatabase: manager,
    importDirectory: directory,
    allowLoopbackRestTests: true,
    logLevel: "silent",
  });
  process.env.PORT = "3000";
  const headers = { host: "localhost:3000", origin: "http://localhost:3000" };

  context.after(async () => {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await app.close();
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  });

  const endpointTest = async (caseContext: typeof context, endpoint: LiveEndpoint) => {
    const configuration = {
      kind: "rest_api",
      baseUrl: endpoint.baseUrl,
      endpointPath: endpoint.endpointPath,
      method: "GET",
      authMode: "none",
      timeoutMs: 10_000,
      maxResponseBytes: responseLimit,
      maxRecords: 500,
      responseFormat: "json",
      ...(endpoint.queryParameters ? { queryParameters: endpoint.queryParameters } : {}),
      ...(endpoint.sourceTimezone ? { sourceTimezone: endpoint.sourceTimezone } : {}),
    };
    const request = async (method: "GET" | "POST", url: string, payload?: object) => {
      const response = await app.inject({
        method,
        url,
        headers,
        ...(payload ? { payload } : {}),
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const body = response.json() as { error?: { code?: string; message?: string } };
        throw new LiveApiFailure(
          response.statusCode,
          body.error?.code ?? "HTTP_ERROR",
          body.error?.message ?? `KuduNS returned HTTP ${response.statusCode}.`,
        );
      }
      return response;
    };

    try {
      const discoveryResponse = await request("POST", "/api/v1/data-sources/discover", {
        sourceType: "rest_api",
        configuration,
        recordPath: "$",
      });
      const discovery = discoveryResponse.json() as { selectedRecordPath?: string; fields?: unknown[] };
      assert.equal(discovery.selectedRecordPath, "$");
      assert.ok((discovery.fields?.length ?? 0) > 0, "discovery should report observed fields");

      const createdResponse = await request("POST", "/api/v1/data-sources", {
        sourceKey: endpoint.sourceKey,
        displayName: endpoint.displayName,
        sourceType: "rest_api",
        configuration,
        enabled: true,
      });
      const sourceId = createdResponse.json().id as string;
      const syncResponse = await request("POST", `/api/v1/data-sources/${sourceId}/sync`);
      const sync = syncResponse.json() as {
        status: string;
        requestSucceeded: boolean;
        fetched: number;
        imported: number;
        failed: number;
        errors?: Array<{ code: string; message: string }>;
      };
      if (sync.status !== "completed" || !sync.requestSucceeded) {
        const firstError = sync.errors?.[0];
        const upstreamStatus = firstError?.code === "REST_HTTP_ERROR"
          ? Number(firstError.message.match(/HTTP (\d+)/)?.[1] ?? 502)
          : 502;
        throw new LiveApiFailure(
          upstreamStatus,
          firstError?.code ?? "REST_SYNC_FAILED",
          firstError?.message ?? `REST sync finished with status ${sync.status}.`,
        );
      }
      assert.equal(sync.failed, 0);

      const recordsResponse = await request("GET", `/api/v1/explorer/records?sourceId=${sourceId}&page=1&pageSize=100`);
      const records = recordsResponse.json() as {
        total: number;
        items: Array<{ id: string; source: { id: string }; processingStatus: string; preview: Record<string, string> }>;
      };
      assert.equal(records.total, sync.imported);
      assert.ok(records.total > 0, "the public endpoint should return at least one raw record");
      assert.ok(records.items.every(item => item.source.id === sourceId && item.processingStatus === "raw_only"));

      const detailResponse = await request("GET", `/api/v1/explorer/records/${records.items[0]!.id}`);
      const detail = detailResponse.json() as { rawRecord: unknown; source: { id: string } };
      assert.equal(detail.source.id, sourceId);
      assert.ok(detail.rawRecord && typeof detail.rawRecord === "object");

      const jsonResponse = await request("GET", `/api/v1/explorer/records/export?format=json&sourceId=${sourceId}`);
      const jsonExport = jsonResponse.json() as { total: number; items: Array<{ source: { id: string }; rawRecord: unknown }> };
      assert.equal(jsonExport.total, records.total);
      assert.ok(jsonExport.items.every(item => item.source.id === sourceId));
      assert.deepEqual(jsonExport.items[0]?.rawRecord, detail.rawRecord);

      const csvResponse = await request("GET", `/api/v1/explorer/records/export?format=csv&sourceId=${sourceId}`);
      assert.equal(dataRowsInCsv(csvResponse.body), records.total);
      const searchTerm = Object.values(records.items[0]!.preview).find(value =>
        value && value !== "null" && value !== "Object" && !value.startsWith("Array"),
      );
      assert.ok(searchTerm, "a representative searchable source value should be available");
      const matchResponse = await request("GET", `/api/v1/explorer/records?sourceId=${sourceId}&search=${encodeURIComponent(searchTerm!)}&page=1&pageSize=10`);
      assert.ok(matchResponse.json().total > 0, "Explorer search finds an observed raw-record value");
      const events = await manager.db.selectFrom("events").select("id").where("source_id", "=", sourceId).execute();
      assert.equal(events.length, 0, "live public raw ingestion does not require mappings or event normalization");
    } catch (error) {
      const skipReason = shouldSkipLiveFailure(error);
      if (skipReason) {
        caseContext.skip(skipReason);
        return;
      }
      throw error;
    }
  };

  const jsonPlaceholderEndpoints = [
    { sourceKey: "live_jsonplaceholder_posts", displayName: "Live JSONPlaceholder posts", baseUrl: "https://jsonplaceholder.typicode.com", endpointPath: "posts" },
    { sourceKey: "live_jsonplaceholder_users", displayName: "Live JSONPlaceholder users", baseUrl: "https://jsonplaceholder.typicode.com", endpointPath: "users" },
    { sourceKey: "live_jsonplaceholder_comments", displayName: "Live JSONPlaceholder comments", baseUrl: "https://jsonplaceholder.typicode.com", endpointPath: "posts/1/comments" },
  ] satisfies LiveEndpoint[];
  for (const endpoint of jsonPlaceholderEndpoints) {
    await context.test(`JSONPlaceholder ${endpoint.endpointPath}`, async child => {
      await endpointTest(child, endpoint);
    });
  }
  await context.test("Open-Meteo column-array response with explicit Europe/Berlin timezone", child =>
    endpointTest(child, {
      sourceKey: "live_openmeteo_hourly",
      displayName: "Live Open-Meteo hourly",
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
    }),
  );
  await context.test("USGS GeoJSON FeatureCollection response", child =>
    endpointTest(child, {
      sourceKey: "live_usgs_all_day",
      displayName: "Live USGS all-day earthquakes",
      baseUrl: "https://earthquake.usgs.gov",
      endpointPath: "earthquakes/feed/v1.0/summary/all_day.geojson",
    }),
  );
});
