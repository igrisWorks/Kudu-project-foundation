import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "./app.js";
import { LocalDatabaseManager } from "./local-database.js";
import { parseCsv } from "./file-import.js";

const openMeteoDocument = {
  latitude: 52.52,
  longitude: 13.41,
  timezone: "Europe/Berlin",
  hourly_units: { temperature_2m: "°C", relative_humidity_2m: "%", wind_speed_10m: "km/h" },
  hourly: {
    time: ["2026-01-01T00:00", "2026-01-01T01:00", "2026-01-01T02:00"],
    temperature_2m: [2.1, 1.8, 2.4],
    relative_humidity_2m: [81, 83, 80],
    wind_speed_10m: [9.2, 8.8, 10.1],
  },
};

const usgsDocument = {
  type: "FeatureCollection",
  metadata: { generated: 1767225600000, count: 2, title: "All earthquakes, past day" },
  features: [
    {
      type: "Feature",
      id: "us-test-1",
      properties: { mag: 2.4, place: "8 km N of Example", time: 1767222000000 },
      geometry: { type: "Point", coordinates: [-155.1, 19.4, 5.2] },
    },
    {
      type: "Feature",
      id: "us-test-2",
      properties: { mag: 1.2, place: "4 km E of Sample", time: 1767222300000 },
      geometry: { type: "Point", coordinates: [-154.9, 19.5, 3.1] },
    },
  ],
};

test("public API fixtures use the real REST discovery, raw ingestion, exploration, and export pipeline", async context => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-public-api-pipeline-"));
  const previousPort = process.env.PORT;
  const requests = new Map<string, number>();
  const remote = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    requests.set(url.pathname, (requests.get(url.pathname) ?? 0) + 1);
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (url.pathname === "/api/posts") {
      response.end(JSON.stringify([
        { userId: 1, id: 1, title: "First post", body: "A public fixture post." },
        { userId: 2, id: 2, title: "Second post", body: "Another public fixture post." },
      ]));
      return;
    }
    if (url.pathname === "/v1/forecast") {
      assert.equal(url.searchParams.get("latitude"), "52.52");
      assert.equal(url.searchParams.get("longitude"), "13.41");
      assert.equal(url.searchParams.get("hourly"), "temperature_2m,relative_humidity_2m,wind_speed_10m");
      assert.equal(url.searchParams.get("timezone"), "Europe/Berlin");
      assert.equal(url.searchParams.get("forecast_days"), "2");
      response.end(JSON.stringify(openMeteoDocument));
      return;
    }
    if (url.pathname === "/earthquakes/feed/v1.0/summary/all_day.geojson") {
      response.end(JSON.stringify(usgsDocument));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "unexpected fixture endpoint" }));
  });
  await new Promise<void>((resolve, reject) => {
    remote.once("error", reject);
    remote.listen(0, "127.0.0.1", resolve);
  });
  const port = (remote.address() as { port: number }).port;
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
  const request = async (method: "GET" | "POST", url: string, payload?: object) => {
    const response = await app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
    return response;
  };
  const baseConfig = (endpointPath: string, extra: Record<string, unknown> = {}) => ({
    kind: "rest_api",
    baseUrl: `http://127.0.0.1:${port}/api`,
    endpointPath,
    method: "GET",
    authMode: "none",
    timeoutMs: 2_000,
    maxResponseBytes: 100_000,
    maxRecords: 500,
    responseFormat: "json",
    ...extra,
  });
  const sourceIds: string[] = [];
  const ingest = async (key: string, config: Record<string, unknown>, recordPath: string) => {
    const discovery = await request("POST", "/api/v1/data-sources/discover", {
      sourceType: "rest_api",
      configuration: config,
      recordPath,
    });
    assert.equal(discovery.statusCode, 200, discovery.body);
    assert.equal(discovery.json().selectedRecordPath, recordPath);
    const created = await request("POST", "/api/v1/data-sources", {
      sourceKey: key,
      displayName: `Public API fixture ${key}`,
      sourceType: "rest_api",
      configuration: {
        ...config,
        ...(recordPath !== "$" ? { recordsPath: recordPath } : {}),
      },
      enabled: true,
    });
    assert.equal(created.statusCode, 201, created.body);
    const createdSource = created.json();
    assert.deepEqual(createdSource.configuration.queryParameters ?? {}, config.queryParameters ?? {});
    const sourceId = createdSource.id as string;
    sourceIds.push(sourceId);
    const synced = await request("POST", `/api/v1/data-sources/${sourceId}/sync`);
    assert.equal(synced.statusCode, 200, synced.body);
    assert.equal(synced.json().failed, 0);
    assert.equal(synced.json().status, "completed");
    const page = await request("GET", `/api/v1/explorer/records?sourceId=${sourceId}&page=1&pageSize=100`);
    assert.equal(page.statusCode, 200, page.body);
    const recordPage = page.json();
    assert.equal(recordPage.items.length, synced.json().imported);
    assert.ok(recordPage.items.every((item: { processingStatus: string }) => item.processingStatus === "raw_only"));
    return { sourceId, recordPage, discovery: discovery.json(), sync: synced.json() };
  };

  context.after(async () => {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await app.close();
    await manager.close();
    await new Promise<void>(resolve => remote.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const posts = await ingest("public_test_jsonplaceholder_fixture", baseConfig("posts"), "$");
  assert.equal(posts.sync.fetched, 2);
  assert.deepEqual(posts.discovery.fields.map((field: { path: string }) => field.path), ["body", "id", "title", "userId"]);

  const openMeteoConfig = baseConfig("v1/forecast", {
    baseUrl: `http://127.0.0.1:${port}`,
    queryParameters: {
      latitude: "52.52",
      longitude: "13.41",
      hourly: "temperature_2m,relative_humidity_2m,wind_speed_10m",
      timezone: "Europe/Berlin",
      forecast_days: "2",
    },
    sourceTimezone: "Europe/Berlin",
  });
  const openMeteo = await ingest("public_test_openmeteo_fixture", openMeteoConfig, "$");
  assert.equal(openMeteo.sync.fetched, 1);
  const openMeteoSource = await manager.db.selectFrom("data_sources").select("configuration")
    .where("id", "=", openMeteo.sourceId).executeTakeFirstOrThrow();
  assert.equal(openMeteoSource.configuration.kind, "rest_api");
  if (openMeteoSource.configuration.kind === "rest_api") {
    assert.equal(openMeteoSource.configuration.sourceTimezone, "Europe/Berlin");
  }
  assert.ok(openMeteo.discovery.fields.some((field: { path: string; valueType: string }) =>
    field.path === "hourly.time" && field.valueType === "array"));
  const openMeteoRecord = await request("GET", `/api/v1/explorer/records/${openMeteo.recordPage.items[0].id}`);
  assert.equal(openMeteoRecord.statusCode, 200, openMeteoRecord.body);
  assert.deepEqual(openMeteoRecord.json().rawRecord, openMeteoDocument);
  assert.equal(openMeteoRecord.json().source.sourceKey, "public_test_openmeteo_fixture");

  const usgs = await ingest(
    "public_test_usgs_fixture",
    { ...baseConfig("earthquakes/feed/v1.0/summary/all_day.geojson"), baseUrl: `http://127.0.0.1:${port}` },
    "$",
  );
  assert.equal(usgs.sync.fetched, 1);
  assert.ok(usgs.discovery.fields.some((field: { path: string; valueType: string }) =>
    field.path === "features" && field.valueType === "array"));
  const usgsRecord = await request("GET", `/api/v1/explorer/records/${usgs.recordPage.items[0].id}`);
  assert.equal(usgsRecord.statusCode, 200, usgsRecord.body);
  assert.deepEqual(usgsRecord.json().rawRecord, usgsDocument);
  assert.equal(usgsRecord.json().rawRecord.features.length, 2);

  const sourceIdsSet = new Set([posts.sourceId, openMeteo.sourceId, usgs.sourceId]);
  assert.equal(sourceIdsSet.size, 3, "each public API keeps its own source identity");
  for (const sourceId of sourceIds) {
    const sourceExport = await request("GET", `/api/v1/explorer/records/export?format=json&sourceId=${sourceId}`);
    assert.equal(sourceExport.statusCode, 200, sourceExport.body);
    const exported = sourceExport.json();
    assert.equal(exported.items.length, exported.total);
    assert.ok(exported.items.every((item: { source: { id: string } }) => item.source.id === sourceId));
    const csvExport = await request("GET", `/api/v1/explorer/records/export?format=csv&sourceId=${sourceId}`);
    assert.equal(csvExport.statusCode, 200, csvExport.body);
    const parsedCsv = parseCsv(csvExport.body.replace(/^\uFEFF/, ""), false);
    assert.equal(parsedCsv.rows.length, exported.total);
    const rawJsonIndex = parsedCsv.headers.indexOf("raw_record_json");
    assert.notEqual(rawJsonIndex, -1);
    const firstRaw = JSON.parse(parsedCsv.rows[0]!.values[rawJsonIndex]!) as unknown;
    assert.deepEqual(firstRaw, exported.items[0]!.rawRecord);
  }

  const search = await request("GET", `/api/v1/explorer/records?sourceId=${usgs.sourceId}&search=FeatureCollection&page=1&pageSize=25`);
  assert.equal(search.statusCode, 200, search.body);
  assert.equal(search.json().total, 1);
  const events = await manager.db.selectFrom("events").select("id").where("source_id", "in", sourceIds).execute();
  assert.equal(events.length, 0, "the raw public API test does not require mapping or normalization");
  assert.ok((requests.get("/api/posts") ?? 0) >= 2);
  assert.ok((requests.get("/v1/forecast") ?? 0) >= 2);
  assert.ok((requests.get("/earthquakes/feed/v1.0/summary/all_day.geojson") ?? 0) >= 2);
});
