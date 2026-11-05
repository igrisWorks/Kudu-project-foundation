import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "./app.js";
import { LocalDatabaseManager } from "./local-database.js";

test("SQLite Local persists assets, sources, microsecond events, mappings, file imports and REST sync", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-workflows-"));
  const imports = join(directory, "imports");
  await mkdir(imports);
  const historicalRecords = [
    { record: "paged-1", type: "alarm", time: "2026-11-01T12:00:00Z", machine: "press-2", reading: 1 },
    { record: "paged-2", type: "alarm", time: "2026-11-01T12:01:00Z", machine: "Unknown machine", reading: 2 },
    { record: "paged-3", type: "alarm", time: "2026-11-01T12:02:00Z", machine: "Ambiguous", reading: 3 },
    { record: "paged-4", type: "alarm", time: "2026-11-01T12:03:00Z", machine: "Ambiguous", reading: 4 },
    { record: "paged-5", type: "alarm", time: "2026-11-01T12:04:00Z", machine: "press-2", reading: 5 },
  ];
  const pageApiRecords = [
    { record: "page-0", type: "page", time: "2026-11-01T13:00:00Z", reading: 10 },
    { record: "page-1", type: "page", time: "2026-11-01T13:01:00Z", reading: 11 },
  ];
  const cursorApiRecords = [
    { record: "cursor-1", type: "cursor", time: "2026-11-01T14:00:00Z", reading: 20 },
    { record: "cursor-2", type: "cursor", time: "2026-11-01T14:01:00Z", reading: 21 },
  ];
  const pageRequests: string[] = [];
  let recoverRemoteAvailable = false;
  const remote = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/paged")) {
      const url = new URL(request.url, "http://localhost");
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      response.end(JSON.stringify({ items: historicalRecords.slice(offset, offset + limit) }));
      return;
    }
    if (request.url?.startsWith("/page-api")) {
      const url = new URL(request.url, "http://localhost");
      pageRequests.push(url.search);
      const page = Number(url.searchParams.get("page") ?? 0);
      response.end(JSON.stringify({ items: pageApiRecords.slice(page, page + 1) }));
      return;
    }
    if (request.url?.startsWith("/cursor-api")) {
      const url = new URL(request.url, "http://localhost");
      const cursor = url.searchParams.get("cursor");
      const index = cursor ? 1 : 0;
      response.end(JSON.stringify({
        items: [cursorApiRecords[index]],
        paging: { next: cursor ? null : "cursor-page-2" },
      }));
      return;
    }
    if (request.url?.startsWith("/recoverable")) {
      if (!recoverRemoteAvailable) {
        response.statusCode = 503;
        response.end();
        return;
      }
      response.end(JSON.stringify({ items: [{ record: "recovered-1", type: "recovered", time: "2026-11-01T15:00:00Z", reading: 30 }] }));
      return;
    }
    response.end(JSON.stringify({ items: [{
      record: "rest-1",
      type: "temperature",
      time: "2026-11-01T12:00:00Z",
      reading: 42,
      state: "running",
      payload: { measurements: [{ metricName: "temperature", measurementValue: 42, measurementUnit: "degC" }] },
    }] }));
  });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  const address = remote.address() as { port: number };
  let manager = await LocalDatabaseManager.create(join(directory, "data"));
  let app = await createApp({
    db: manager.db, localMode: true, localDatabase: manager,
    importDirectory: imports, allowLoopbackRestTests: true, logLevel: "silent",
  });
  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object, expected = method === "POST" ? 201 : 200) => {
    const response = await app.inject({
      method, url, headers: { host: "localhost:3000", origin: "http://localhost:3000" },
      ...(payload ? { payload } : {}),
    });
    assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
    return response.json();
  };
  try {
    const session = await call("GET", "/api/v1/auth/session");
    assert.equal(session.localMode, true);
    const parent = await call("POST", "/api/v1/assets", { assetKey: "line-1", name: "Line", assetType: "production_line" });
    const child = await call("POST", "/api/v1/assets", {
      assetKey: "sensor-1", name: "Sensor", assetType: "sensor", parentAssetId: parent.id,
      externalIdentifiers: [{ sourceKey: "paged", externalId: "press-2" }],
    });
    await call("POST", "/api/v1/assets", { assetKey: "machine-a", name: "Ambiguous", assetType: "machine" });
    await call("POST", "/api/v1/assets", { assetKey: "machine-b", name: "Ambiguous", assetType: "machine" });
    await call("POST", "/api/v1/assets", { assetKey: "LINE-1", name: "Duplicate", assetType: "other" }, 409);
    await call("PATCH", `/api/v1/assets/${parent.id}`, { parentAssetId: child.id }, 400);
    const search = await call("GET", "/api/v1/assets?search=LINE");
    assert.equal(search.total, 1);
    const manual = await call("POST", "/api/v1/data-sources", {
      sourceKey: "manual", displayName: "Manual", sourceType: "manual", configuration: { kind: "manual" },
    });
    const eventInput = {
      sourceId: manual.id, assetId: child.id, eventType: "measurement",
      occurredAt: "2026-11-01T13:00:00.123456+01:00", payload: { temperature: 24 }, deduplicationKey: "one",
    };
    const event = await call("POST", "/api/v1/events", eventInput);
    assert.equal(event.event.occurredAt, "2026-11-01T12:00:00.123456Z");
    assert.equal((await call("POST", "/api/v1/events", eventInput, 200)).duplicate, true);
    await call("POST", "/api/v1/events", { ...eventInput, payload: { temperature: 25 } }, 409);
    const filtered = await call("GET", "/api/v1/events?from=2026-11-01T12%3A00%3A00.123456Z&to=2026-11-01T12%3A00%3A00.123456Z");
    assert.equal(filtered.total, 1);

    const mapping = async (
      sourceId: string,
      assetKey?: string,
      payloadMappings: Record<string, string> = { reading: "reading" },
    ) => {
      await call("POST", `/api/v1/data-sources/${sourceId}/mappings`, { definition: {
        eventType: "type", occurredAt: "time", sourceRecordId: "record",
        ...(assetKey ? { assetKey } : {}),
        payload: payloadMappings,
      } });
      await call("POST", `/api/v1/data-sources/${sourceId}/mappings/1/validate`, undefined, 200);
      await call("POST", `/api/v1/data-sources/${sourceId}/mappings/1/activate`, undefined, 200);
      assert.equal((await call("GET", `/api/v1/data-sources/${sourceId}/mappings`)).items[0].status, "active");
    };
    const mappedIndustrialPayload = {
      measurementValue: "reading",
      status: "state",
      measurements: "payload.measurements",
    };
    const nestedMeasurements = [{ metricName: "temperature", measurementValue: 31, measurementUnit: "degC" }];
    for (const format of ["json", "csv"] as const) {
      const fileName = `readings.${format}`;
      const fileContents = format === "json"
        ? JSON.stringify([{
          record: "json-1",
          type: "temperature",
          time: "2026-11-01T12:00:00Z",
          reading: 31,
          state: "running",
          payload: { measurements: nestedMeasurements },
        }])
        : [
          "record,type,time,reading,state,payload",
          `csv-1,temperature,2026-11-01T12:00:00Z,32,running,"${JSON.stringify({ measurements: nestedMeasurements }).replaceAll('"', '""')}"`,
        ].join("\n");
      await writeFile(join(imports, fileName), fileContents);
      const source = await call("POST", "/api/v1/data-sources", {
        sourceKey: format, displayName: format, sourceType: `${format}_file`,
        configuration: { kind: `${format}_file`, relativePath: fileName },
      });
      await mapping(source.id, undefined, mappedIndustrialPayload);
      const imported = await call("POST", `/api/v1/data-sources/${source.id}/import`, undefined, 200);
      assert.equal(imported.imported, 1, JSON.stringify(imported));
      assert.equal(imported.failed, 0, JSON.stringify(imported));
      const fileEvents = await call("GET", `/api/v1/events?sourceKey=${format}`);
      const fileEvent = await call("GET", `/api/v1/events/${fileEvents.items[0].id}`);
      assert.equal(fileEvent.payload.status, "running");
      assert.equal(fileEvent.payload.measurementValue, format === "json" ? 31 : "32");
      assert.deepEqual(fileEvent.payload.measurements, nestedMeasurements);
      if (format === "json") {
        assert.deepEqual(fileEvent.provenance.originalRecord.payload.measurements, nestedMeasurements);
      } else {
        assert.equal(typeof fileEvent.provenance.originalRecord.payload, "string");
        assert.deepEqual(JSON.parse(fileEvent.provenance.originalRecord.payload).measurements, nestedMeasurements);
      }
    }
    const restConfig = {
      kind: "rest_api",
      baseUrl: `http://127.0.0.1:${address.port}`,
      endpointPath: "/events",
      method: "GET",
      authMode: "none",
      trustedPrivateHost: "127.0.0.1",
      recordsPath: "items",
    };
    const discoveredRest = await call("POST", "/api/v1/data-sources/discover", {
      sourceType: "rest_api",
      configuration: restConfig,
    }, 200);
    assert.equal(discoveredRest.selectedRecordPath, "items");
    const rest = await call("POST", "/api/v1/data-sources", {
      sourceKey: "rest", displayName: "REST", sourceType: "rest_api", configuration: restConfig,
    });
    await mapping(rest.id, undefined, mappedIndustrialPayload);
    const synced = await call("POST", `/api/v1/data-sources/${rest.id}/sync`, undefined, 200);
    assert.equal(synced.imported, 1, JSON.stringify(synced));
    assert.equal((await call("GET", `/api/v1/data-sources/${rest.id}`)).sourceKey, "rest");
    const restEvents = await call("GET", "/api/v1/events?sourceKey=rest");
    const restEvent = await call("GET", `/api/v1/events/${restEvents.items[0].id}`);
    assert.equal(restEvent.payload.status, "running");
    assert.equal(restEvent.payload.measurementValue, 42);
    assert.deepEqual(restEvent.payload.measurements, [
      { metricName: "temperature", measurementValue: 42, measurementUnit: "degC" },
    ]);
    assert.deepEqual(restEvent.provenance.originalRecord.payload.measurements, restEvent.payload.measurements);
    const paged = await call("POST", "/api/v1/data-sources", {
      sourceKey: "paged", displayName: "Paged REST", sourceType: "rest_api", enabled: true,
      configuration: {
        kind: "rest_api", baseUrl: `http://127.0.0.1:${address.port}`, endpointPath: "/paged",
        method: "GET", authMode: "none", recordsPath: "items", maxRecords: 4,
        pagination: {
          strategy: "offset", pageSize: 2, limitParameter: "limit", offsetParameter: "offset",
          requestIntervalMs: 0,
        },
      },
    });
    await mapping(paged.id, "machine");
    const firstBatch = await call("POST", `/api/v1/data-sources/${paged.id}/sync`, undefined, 200);
    assert.equal(firstBatch.status, "paused", JSON.stringify(firstBatch));
    assert.equal(firstBatch.pagesCompleted, 2);
    assert.equal(firstBatch.fetched, 4);
    assert.equal(firstBatch.imported, 4);
    assert.equal(firstBatch.resumable, true);
    const storedRuns = await call("GET", `/api/v1/data-sources/${paged.id}/sync-runs`);
    assert.equal(storedRuns.items[0].runId, firstBatch.runId);
    assert.equal(storedRuns.items[0].status, "paused");
    const backup = await call("POST", "/api/v1/local/database/backups");
    await call("PATCH", `/api/v1/assets/${child.id}`, { name: "Changed" });
    await call("POST", "/api/v1/local/database/restore", { backupName: backup.backup.fileName, confirm: true }, 200);
    assert.equal((await call("GET", `/api/v1/assets/${child.id}`)).name, "Sensor");
    const before = await call("GET", "/api/v1/events");
    assert.equal(before.total, 8);
    await app.close();
    await manager.close();
    manager = await LocalDatabaseManager.create(join(directory, "data"));
    app = await createApp({
      db: manager.db, localMode: true, localDatabase: manager,
      allowLoopbackRestTests: true, logLevel: "silent",
    });
    const persistedRest = await call("GET", `/api/v1/data-sources/${rest.id}`);
    assert.equal(persistedRest.configuration.trustedPrivateHost, "127.0.0.1");
    assert.equal((await call("GET", "/api/v1/events")).total, before.total);
    assert.equal((await call("GET", "/api/v1/assets")).total, 4);
    assert.equal((await call("GET", "/api/v1/data-sources")).total, 5);
    const pagedRunsAfterRestart = await call("GET", `/api/v1/data-sources/${paged.id}/sync-runs`);
    assert.equal(pagedRunsAfterRestart.items[0].runId, firstBatch.runId);
    const editedPaged = await call("PATCH", `/api/v1/data-sources/${paged.id}`, {
      configuration: {
        kind: "rest_api", baseUrl: `http://127.0.0.1:${address.port}`, endpointPath: "/paged",
        method: "GET", authMode: "none", recordsPath: "items", maxRecords: 6,
        pagination: {
          strategy: "offset", pageSize: 2, limitParameter: "limit", offsetParameter: "offset",
          requestIntervalMs: 0,
        },
      },
    });
    assert.equal(editedPaged.configuration.maxRecords, 6);
    const resumed = await call("POST", `/api/v1/data-sources/${paged.id}/sync-runs/${firstBatch.runId}/resume`, undefined, 200);
    assert.equal(resumed.status, "completed", JSON.stringify(resumed));
    assert.equal(resumed.pagesCompleted, 3);
    assert.equal(resumed.fetched, 5);
    assert.equal(resumed.imported, 5);
    const pagedEvents = await call("GET", "/api/v1/events?sourceKey=paged&pageSize=20");
    assert.equal(pagedEvents.total, 5, JSON.stringify(pagedEvents));
    const eventDetails = await Promise.all(pagedEvents.items.map((item: { id: string }) => call("GET", `/api/v1/events/${item.id}`)));
    assert.equal(eventDetails.find((item: { sourceRecordId: string }) => item.sourceRecordId === "paged-1").provenance.assetMatch.status, "matched");
    assert.equal(eventDetails.find((item: { sourceRecordId: string }) => item.sourceRecordId === "paged-2").provenance.assetMatch.status, "unmatched");
    assert.equal(eventDetails.find((item: { sourceRecordId: string }) => item.sourceRecordId === "paged-3").provenance.assetMatch.status, "ambiguous");
    const pagedFirstEvent = eventDetails.find((item: { sourceRecordId: string }) => item.sourceRecordId === "paged-1");
    assert.equal(pagedFirstEvent.asset.id, child.id);
    assert.equal(pagedFirstEvent.provenance.syncRunId, firstBatch.runId);
    assert.equal(pagedFirstEvent.provenance.mappingVersion, 1);
    const repeated = await call("POST", `/api/v1/data-sources/${paged.id}/sync`, undefined, 200);
    assert.equal(repeated.imported, 0);
    assert.equal(repeated.duplicates, 5);
    historicalRecords[0]!.reading = 999;
    const changedDuplicate = await call("POST", `/api/v1/data-sources/${paged.id}/sync`, undefined, 200);
    assert.equal(changedDuplicate.imported, 0);
    assert.equal(changedDuplicate.duplicates, 4);
    assert.equal(changedDuplicate.failed, 1);
    assert.equal((await call("GET", `/api/v1/events/${pagedFirstEvent.id}`)).payload.reading, 1);
    const pageApiConfiguration = {
      kind: "rest_api" as const, baseUrl: `http://127.0.0.1:${address.port}`, endpointPath: "/page-api",
      recordsPath: "items", maxRecords: 10,
      pagination: {
        strategy: "page" as const, pageSize: 1, limitParameter: "limit", pageParameter: "page",
        startPage: 0, requestIntervalMs: 0, dateFromParameter: "from", dateFrom: "2026-11-01",
      },
    };
    const pageApi = await call("POST", "/api/v1/data-sources", {
      sourceKey: "page-api", displayName: "Page-number API", sourceType: "rest_api", enabled: true,
      configuration: pageApiConfiguration,
    });
    const pageDiscovery = await call("POST", "/api/v1/data-sources/discover", {
      sourceType: "rest_api",
      sourceKey: "page-api",
      configuration: pageApiConfiguration,
    }, 200);
    assert.equal(pageDiscovery.sampledPageCount, 3);
    assert.equal(pageDiscovery.recordPaths[0]?.recordCount, 2);
    await mapping(pageApi.id);
    const pagedByNumber = await call("POST", `/api/v1/data-sources/${pageApi.id}/sync`, undefined, 200);
    assert.equal(pagedByNumber.status, "completed");
    assert.equal(pagedByNumber.fetched, 2);
    assert.equal(pagedByNumber.pagesCompleted, 3);
    assert.ok(pageRequests.some(value => new URLSearchParams(value).get("from") === "2026-11-01"));

    const cursorApiConfiguration = {
      kind: "rest_api" as const, baseUrl: `http://127.0.0.1:${address.port}`, endpointPath: "/cursor-api",
      recordsPath: "items", maxRecords: 10,
      pagination: {
        strategy: "cursor" as const, pageSize: 1, limitParameter: "limit", cursorParameter: "cursor",
        nextCursorPath: "paging.next", requestIntervalMs: 0,
      },
    };
    const cursorApi = await call("POST", "/api/v1/data-sources", {
      sourceKey: "cursor-api", displayName: "Cursor API", sourceType: "rest_api", enabled: true,
      configuration: cursorApiConfiguration,
    });
    const cursorDiscovery = await call("POST", "/api/v1/data-sources/discover", {
      sourceType: "rest_api",
      sourceKey: "cursor-api",
      configuration: cursorApiConfiguration,
    }, 200);
    assert.equal(cursorDiscovery.sampledPageCount, 2);
    assert.equal(cursorDiscovery.recordPaths[0]?.recordCount, 2);
    await mapping(cursorApi.id);
    const cursorSync = await call("POST", `/api/v1/data-sources/${cursorApi.id}/sync`, undefined, 200);
    assert.equal(cursorSync.status, "completed");
    assert.equal(cursorSync.fetched, 2);
    assert.equal(cursorSync.pagesCompleted, 2);

    const recoverable = await call("POST", "/api/v1/data-sources", {
      sourceKey: "recoverable", displayName: "Recoverable API", sourceType: "rest_api", enabled: true,
      configuration: {
        kind: "rest_api", baseUrl: `http://127.0.0.1:${address.port}`, endpointPath: "/recoverable",
        recordsPath: "items", maxRecords: 10,
      },
    });
    await mapping(recoverable.id);
    const failedRun = await call("POST", `/api/v1/data-sources/${recoverable.id}/sync`, undefined, 200);
    assert.equal(failedRun.status, "failed");
    assert.equal(failedRun.resumable, true);
    assert.equal(failedRun.requestSucceeded, false);
    recoverRemoteAvailable = true;
    const recovered = await call("POST", `/api/v1/data-sources/${recoverable.id}/sync-runs/${failedRun.runId}/resume`, undefined, 200);
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.imported, 1);
    assert.equal((await call("GET", "/api/v1/events")).total, before.total + 6);
    assert.equal((await call("GET", "/api/v1/data-sources")).total, 8);
    assert.equal((await call("GET", "/api/v1/local/database")).engine, "SQLite");

    const parentDeleteBlocked = await call("DELETE", `/api/v1/assets/${parent.id}`, undefined, 409);
    assert.equal(parentDeleteBlocked.error.code, "ASSET_HAS_CHILDREN");
    const linkedEvents = await manager.db.selectFrom("events").select("id").where("asset_id", "=", child.id).execute();
    assert.ok(linkedEvents.length >= 1);
    const childRemoval = await call("DELETE", `/api/v1/assets/${child.id}`);
    assert.equal(childRemoval.outcome, "deleted");
    assert.equal(childRemoval.eventsUnassigned, linkedEvents.length);
    const preservedEvent = await call("GET", `/api/v1/events/${event.event.id}`);
    assert.equal(preservedEvent.asset, null);
    assert.deepEqual(preservedEvent.payload, { temperature: 24 });
    assert.equal((await call("DELETE", `/api/v1/assets/${parent.id}`)).outcome, "deleted");

    const sourceRemoval = await call("DELETE", `/api/v1/data-sources/${manual.id}`);
    assert.equal(sourceRemoval.outcome, "archived");
    assert.equal(sourceRemoval.preserved.events, 1);
    assert.equal((await call("GET", `/api/v1/data-sources/${manual.id}`)).enabled, false);
    assert.deepEqual((await call("GET", `/api/v1/events/${event.event.id}`)).payload, { temperature: 24 });
    const emptySource = await call("POST", "/api/v1/data-sources", {
      sourceKey: "unused", displayName: "Unused source", sourceType: "manual", configuration: { kind: "manual" },
    });
    assert.equal((await call("DELETE", `/api/v1/data-sources/${emptySource.id}`)).outcome, "deleted");
    await call("GET", `/api/v1/data-sources/${emptySource.id}`, undefined, 404);
  } finally {
    await app.close();
    await manager.close();
    await new Promise<void>(resolve => remote.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a damaged SQLite database is rejected without deleting or replacing its bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-damaged-"));
  const file = join(directory, "kuduns.db");
  const damaged = Buffer.from("not a sqlite database");
  await writeFile(file, damaged);
  try {
    await assert.rejects(() => LocalDatabaseManager.create(directory));
    assert.deepEqual(await readFile(file), damaged);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
