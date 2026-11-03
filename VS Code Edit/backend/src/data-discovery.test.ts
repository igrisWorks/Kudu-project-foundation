import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDiscoveryResult } from "./data-discovery.js";
import { createApp } from "./app.js";
import { LocalDatabaseManager } from "./local-database.js";
import { normalizeOccurrenceTimestamp } from "./event-mappings.js";

test("discovery finds record collections and does not choose between ambiguous arrays", () => {
  const { result } = buildDiscoveryResult("rest_api", {
    data: { records: [{ eventType: "temperature", occurredAt: "2026-11-01T12:00:00Z" }] },
    faults: [{ faultType: "overheat", eventTime: 1793534400 }],
  });
  assert.deepEqual(result.recordPaths.map(item => item.path), ["data.records", "faults"]);
  assert.equal(result.selectedRecordPath, null);
  assert.equal(result.preview.length, 0);
  assert.ok(result.warnings.some(warning => warning.includes("Choose a record collection")));
});

test("discovery suggests common aliases, accepts Unix timestamps, and hides sensitive examples", () => {
  const { result } = buildDiscoveryResult("rest_api", {
    faults: [{
      faultId: "F-1",
      faultType: "overheat",
      eventTime: 1793534400,
      assetId: "machine-7",
      severity: "high",
      apiToken: "sensitive-fixture-value",
    }],
  });
  assert.equal(result.selectedRecordPath, "faults");
  assert.equal(result.suggestions.find(item => item.target === "eventType")?.sourcePath, "faultType");
  assert.equal(result.suggestions.find(item => item.target === "occurredAt")?.sourcePath, "eventTime");
  assert.equal(result.preview[0]?.state, "valid");
  assert.equal(JSON.stringify(result).includes("sensitive-fixture-value"), false);
  assert.equal(result.fields.some(field => field.path === "apiToken"), false);
  assert.equal(normalizeOccurrenceTimestamp(1793534400), "2026-11-01T12:00:00.000Z");
  assert.equal(normalizeOccurrenceTimestamp("1793534400000"), "2026-11-01T12:00:00.000Z");
  assert.equal(normalizeOccurrenceTimestamp("2026-11-01T12:00:00"), undefined, "timestamps without a timezone must not be guessed");
});

test("discovery marks competing field suggestions as ambiguous and inspects CSV headers", () => {
  const ambiguous = buildDiscoveryResult("rest_api", {
    faults: [{
      eventType: "fault",
      faultType: "overheat",
      occurredAt: "2026-11-01T12:00:00Z",
      timestamp: "2026-11-01T12:00:00Z",
    }],
  }).result;
  assert.equal(ambiguous.suggestions.find(item => item.target === "eventType")?.ambiguous, true);
  assert.equal(ambiguous.suggestions.find(item => item.target === "eventType")?.sourcePath, null);
  assert.equal(ambiguous.suggestions.find(item => item.target === "occurredAt")?.ambiguous, true);

  const csv = buildDiscoveryResult(
    "csv_file",
    "fault_id,fault_type,event_time,message\nF-2,low_pressure,2026-11-01T12:00:00Z,Pressure low\n",
  ).result;
  assert.equal(csv.selectedRecordPath, "$");
  assert.deepEqual(csv.fields.map(field => field.path), ["event_time", "fault_id", "fault_type", "message"]);
  assert.equal(csv.suggestions.find(item => item.target === "eventType")?.sourcePath, "fault_type");
});

test("source registration does not connect; explicit REST and nested JSON discovery use bounded fixtures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-discovery-"));
  const imports = join(directory, "imports");
  await mkdir(imports);
  let requests = 0;
  const remote = createServer((request, response) => {
    requests += 1;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/faults");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      faults: [
        {
          faultId: "F-remote-1", faultType: "overheat", eventTime: 1793534400, severity: "high",
          assetId: "registered-machine", apiToken: "sensitive-fixture-value",
        },
        {
          faultId: "F-remote-2", faultType: "low_pressure", eventTime: 1793534401, severity: "medium",
          assetId: "unregistered-machine", apiToken: "sensitive-fixture-value",
        },
      ],
    }));
  });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  const address = remote.address() as { port: number };
  let manager = await LocalDatabaseManager.create(join(directory, "data"));
  const app = await createApp({
    db: manager.db,
    localMode: true,
    localDatabase: manager,
    importDirectory: imports,
    allowLoopbackRestTests: true,
    logLevel: "silent",
  });
  const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: object, expected = method === "POST" ? 201 : 200) => {
    const response = await app.inject({
      method,
      url,
      headers: { host: "localhost:3000", origin: "http://localhost:3000" },
      ...(payload ? { payload } : {}),
    });
    assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
    return response.json();
  };
  try {
    await call("POST", "/api/v1/assets", { assetKey: "registered-machine", name: "Registered machine", assetType: "other" });
    const configuration = {
      kind: "rest_api" as const,
      baseUrl: `http://127.0.0.1:${address.port}/api`,
      endpointPath: "faults",
      method: "GET" as const,
      authMode: "none" as const,
      timeoutMs: 2_000,
      maxResponseBytes: 128_000,
      maxRecords: 100,
    };
    const source = await call("POST", "/api/v1/data-sources", {
      sourceKey: "faults-rest",
      displayName: "Fault records",
      sourceType: "rest_api",
      configuration,
      enabled: true,
    });
    assert.equal(source.enabled, true);
    assert.equal(requests, 0, "saving an enabled source must not issue an HTTP request");
    const discovery = await call("POST", "/api/v1/data-sources/discover", { sourceType: "rest_api", configuration }, 200);
    assert.equal(requests, 1, "only explicit discovery reads the REST fixture");
    assert.equal(discovery.selectedRecordPath, "faults");
    assert.equal(discovery.preview[0]?.state, "valid", "exact registered asset keys may be suggested as matches");
    assert.equal(discovery.preview[1]?.state, "rejected", "unregistered asset IDs must not be previewed as valid associations");
    assert.equal(discovery.suggestions.find((item: { target: string }) => item.target === "eventType")?.sourcePath, "faultType");
    assert.equal(JSON.stringify(discovery).includes("sensitive-fixture-value"), false);
    assert.ok(discovery.warnings.some((warning: string) => warning.includes("do not exactly match")));
    assert.equal((await call("GET", `/api/v1/data-sources/${source.id}/mappings`)).items.length, 0);
    await call("PATCH", `/api/v1/data-sources/${source.id}`, {
      configuration: { ...configuration, recordsPath: "faults" },
    }, 200);
    assert.equal(requests, 1, "saving the selected collection path must not make another request");
    await call("POST", `/api/v1/data-sources/${source.id}/mappings`, {
      definition: {
        eventType: "faultType",
        occurredAt: "eventTime",
        sourceRecordId: "faultId",
        payload: { severity: "severity" },
      },
    });
    const validation = await call("POST", `/api/v1/data-sources/${source.id}/mappings/1/validate`, undefined, 200);
    assert.equal(validation.valid, true);
    await call("POST", `/api/v1/data-sources/${source.id}/mappings/1/activate`, undefined, 200);
    const synced = await call("POST", `/api/v1/data-sources/${source.id}/sync`, undefined, 200);
    assert.equal(synced.imported, 2, JSON.stringify(synced));
    assert.equal(requests, 2, "sync contacts the endpoint only after the operator requests it");

    await writeFile(join(imports, "nested.json"), JSON.stringify({
      envelope: { version: 1 },
      faults: [{ eventType: "bearing_fault", occurredAt: "2026-11-01T12:00:00Z", payload: { code: "B-4" } }],
    }));
    const fileConfiguration = { kind: "json_file" as const, relativePath: "nested.json", recordsPath: "faults" };
    const fileSource = await call("POST", "/api/v1/data-sources", {
      sourceKey: "faults-json",
      displayName: "Historical faults",
      sourceType: "json_file",
      configuration: fileConfiguration,
      enabled: true,
    });
    const fileDiscovery = await call("POST", "/api/v1/data-sources/discover", {
      sourceType: "json_file",
      configuration: fileConfiguration,
    }, 200);
    assert.equal(fileDiscovery.selectedRecordPath, "faults");
    await call("POST", `/api/v1/data-sources/${fileSource.id}/import`, undefined, 409);
    await call("POST", `/api/v1/data-sources/${fileSource.id}/mappings`, {
      definition: { eventType: "eventType", occurredAt: "occurredAt", payload: {} },
    });
    const fileMapping = await call("POST", `/api/v1/data-sources/${fileSource.id}/mappings/1/validate`, undefined, 200);
    assert.equal(fileMapping.valid, true);
    await call("POST", `/api/v1/data-sources/${fileSource.id}/mappings/1/activate`, undefined, 200);
    const imported = await call("POST", `/api/v1/data-sources/${fileSource.id}/import`, undefined, 200);
    assert.equal(imported.records, 1);
    assert.equal(imported.imported, 1);
    assert.equal(requests, 2, "file discovery and import do not contact the REST fixture");
    const events = await call("GET", "/api/v1/events");
    assert.equal(events.total, 3);
  } finally {
    await app.close();
    await manager.close();
    await new Promise<void>(resolve => remote.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
