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
import {
  extendRestDiscoverySample,
  fetchRestDiscoveryDocument,
  isAllowedRestAddress,
  networkPolicyForRestConfiguration,
} from "./rest-sync.js";

test("private REST trust is exact-host scoped and never permits loopback or metadata addresses", () => {
  const policy = networkPolicyForRestConfiguration(
    { trustedHosts: [] },
    { trustedPrivateHost: "10.11.36.65" },
  );
  assert.equal(isAllowedRestAddress("10.11.36.65", "10.11.36.65", policy), true);
  assert.equal(isAllowedRestAddress("factory-api.internal", "10.11.36.65", policy), false);
  assert.equal(isAllowedRestAddress("10.11.36.65", "127.0.0.1", policy), false);
  assert.equal(isAllowedRestAddress("10.11.36.65", "169.254.169.254", policy), false);
  assert.equal(isAllowedRestAddress("10.11.36.65", "192.168.1.2", policy), false);
  const trustedHostnamePolicy = networkPolicyForRestConfiguration(
    { trustedHosts: [] },
    { trustedPrivateHost: "factory-api.internal" },
  );
  assert.equal(isAllowedRestAddress("factory-api.internal", "192.168.1.2", trustedHostnamePolicy), true);
});

test("a trusted REST host cannot redirect to a host that is not explicitly trusted", async () => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(302, { location: `http://localhost:${(server.address() as { port: number }).port}/redirected` });
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    await assert.rejects(
      fetchRestDiscoveryDocument({
        kind: "rest_api",
        baseUrl: `http://127.0.0.1:${address.port}`,
        endpointPath: "events",
      }, { trustedHosts: ["127.0.0.1"], allowLoopbackForTests: true }),
      (error: unknown) => {
        const apiError = error as { code?: string; message?: string };
        assert.equal(apiError.code, "REST_REDIRECT_REJECTED");
        assert.match(apiError.message ?? "", /KUDU_REST_TRUSTED_HOSTS/);
        return true;
      },
    );
    assert.equal(requestCount, 1, "the redirected host must not receive a request");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

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

test("shared recognition uses industrial aliases and timezone-aware value evidence across JSON and CSV", () => {
  const json = buildDiscoveryResult("json_file", {
    alarms: [{
      alarmName: "bearing_temperature",
      alarmDateTime: "2026-11-01T12:00:00Z",
      occurrenceId: "A-17",
      equipmentKey: "mill-2",
      diagnosticCode: "D-5",
    }],
  }).result;
  assert.equal(json.suggestions.find(item => item.target === "eventType")?.sourcePath, "alarmName");
  assert.equal(json.suggestions.find(item => item.target === "occurredAt")?.sourcePath, "alarmDateTime");
  assert.equal(json.fields.find(field => field.path === "alarmDateTime")?.valueType, "datetime");
  assert.equal(json.suggestions.find(item => item.target === "assetKey")?.sourcePath, "equipmentKey");
  assert.equal(json.suggestions.find(item => item.target === "errorCode")?.sourcePath, "diagnosticCode");

  const csv = buildDiscoveryResult(
    "csv_file",
    "alarm_name,alarm_datetime,occurrence_id,equipment_key\nbearing_temperature,2026-11-01T12:00:00Z,A-17,mill-2\n",
  ).result;
  assert.equal(csv.suggestions.find(item => item.target === "eventType")?.sourcePath, "alarm_name");
  assert.equal(csv.suggestions.find(item => item.target === "occurredAt")?.sourcePath, "alarm_datetime");
  assert.equal(csv.fields.find(field => field.path === "alarm_datetime")?.valueType, "datetime");
});

test("shared industrial recognition preselects only safe matches across REST, JSON, and CSV", () => {
  const json = buildDiscoveryResult("json_file", {
    envelope: {
      records: [{
        incidentType: "bearing_overheat",
        timestampUtc: "2026-11-01T12:00:00Z",
        recordId: "event-17",
        equipmentName: "Press 7",
        operatingState: "running",
        measurementName: "bearing_temperature",
        measurementValue: 82.4,
        measurementUnit: "degC",
        measurements: [{ metricName: "vibration", measuredValue: 4.2, unitOfMeasure: "mm/s" }],
        relationships: [{ relationType: "part_of", targetId: "line-2" }],
        sourceMetadata: { gateway: { channel: "A" } },
      }],
    },
  }, "envelope.records").result;
  const rest = buildDiscoveryResult("rest_api", {
    eventData: [{
      incidentType: "bearing_overheat",
      timestampUtc: "2026-11-01T12:00:00Z",
      recordId: "event-17",
      equipmentName: "Press 7",
      operatingState: "running",
      measurementName: "bearing_temperature",
      measurementValue: 82.4,
      measurementUnit: "degC",
    }],
  }).result;
  const csv = buildDiscoveryResult(
    "csv_file",
    "incident_type,timestamp_utc,record_id,equipment_name,operating_state,measurement_name,measurement_value,measurement_unit\n" +
      "bearing_overheat,2026-11-01T12:00:00Z,event-17,Press 7,running,bearing_temperature,82.4,degC\n",
  ).result;

  for (const result of [json, rest, csv]) {
    const occurrence = result.suggestions.find(item => item.target === "occurredAt");
    assert.equal(occurrence?.sourcePath, result.sourceType === "csv_file" ? "timestamp_utc" : "timestampUtc");
    assert.equal(occurrence?.confidence, "high");
    assert.equal(occurrence?.ambiguous, false);
  }
  assert.equal(json.suggestions.find(item => item.target === "eventType")?.sourcePath, "incidentType");
  assert.equal(rest.suggestions.find(item => item.target === "eventType")?.sourcePath, "incidentType");
  assert.equal(csv.suggestions.find(item => item.target === "eventType")?.sourcePath, "incident_type");
  assert.equal(json.suggestions.find(item => item.target === "measurementValue")?.sourcePath, "measurementValue");
  assert.equal(json.suggestions.find(item => item.target === "status")?.sourcePath, "operatingState");
  assert.equal(json.suggestions.find(item => item.target === "sourceMetadata")?.sourcePath, "sourceMetadata");
  assert.equal(json.suggestions.find(item => item.target === "relationships")?.sourcePath, "relationships");
  assert.equal(json.suggestions.find(item => item.target === "measurements")?.sourcePath, "measurements");

  const measurementStructure = json.structures.find(structure => structure.path === "measurements");
  assert.equal(measurementStructure?.possibleMeaning, "measurements");
  assert.ok(measurementStructure?.childFields.some(field =>
    field.path === "measurements[].metricName" && field.possibleTarget === "measurementName"));
  assert.equal(json.fields.some(field => field.path === "measurements[].metricName"), false,
    "array members must not be flattened into mappable scalar fields");
  assert.ok(json.warnings.some(warning => warning.includes("not flattened")));
});

test("low-confidence, placeholder, and ambiguous candidates remain unselected", () => {
  const result = buildDiscoveryResult("json_file", {
    records: [{
      type: "N/A",
      timestamp: "2026-11-01T12:00:00",
      value: "unknown",
    }],
  }).result;
  assert.equal(result.suggestions.find(item => item.target === "eventType")?.sourcePath, null);
  assert.notEqual(result.suggestions.find(item => item.target === "eventType")?.confidence, "high");
  assert.equal(result.suggestions.find(item => item.target === "occurredAt")?.sourcePath, null,
    "a timestamp without timezone evidence must not be preselected");
  const ambiguous = buildDiscoveryResult("json_file", {
    records: [{
      eventType: "state_changed",
      faultType: "low_pressure",
      occurredAt: "2026-11-01T12:00:00Z",
    }],
  }).result;
  assert.equal(ambiguous.suggestions.find(item => item.target === "eventType")?.ambiguous, true);
  assert.equal(ambiguous.suggestions.find(item => item.target === "eventType")?.sourcePath, null);
});

test("explicit REST discovery samples at most three configured pages and merges their fields", async () => {
  const offsets: number[] = [];
  const remote = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    offsets.push(Number(url.searchParams.get("offset")));
    const offset = Number(url.searchParams.get("offset"));
    const records = Array.from({ length: 2 }, (_, index) => ({
      faultType: "bearing_fault",
      eventTime: `2026-11-01T12:00:${String(offset + index).padStart(2, "0")}Z`,
      faultId: `F-${offset + index}`,
      ...(offset === 2 && index === 0 ? { diagnosticCode: "D-12" } : {}),
    }));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ faults: records }));
  });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  try {
    const address = remote.address() as { port: number };
    const configuration = {
      kind: "rest_api" as const,
      baseUrl: `http://127.0.0.1:${address.port}/api`,
      endpointPath: "faults",
      method: "GET" as const,
      authMode: "none" as const,
      timeoutMs: 2_000,
      maxResponseBytes: 128_000,
      maxRecords: 10,
      pagination: {
        strategy: "offset" as const,
        pageSize: 2,
        limitParameter: "limit",
        offsetParameter: "offset",
        startOffset: 0,
        requestIntervalMs: 0,
      },
    };
    const policy = { allowLoopbackForTests: true };
    const firstPage = await fetchRestDiscoveryDocument(configuration, policy);
    const sample = await extendRestDiscoverySample(configuration, firstPage, "faults", policy);
    const result = buildDiscoveryResult("rest_api", sample.document, "faults").result;
    assert.deepEqual(offsets, [0, 2, 4], "discovery must stop at the three-page cap");
    assert.equal(sample.sampledPageCount, 3);
    assert.equal(result.recordPaths[0]?.recordCount, 6);
    const errorCodeSuggestion = result.suggestions.find(item => item.target === "errorCode");
    assert.equal(errorCodeSuggestion?.sourcePath, null, "a field present in only one sampled record must not be preselected");
    assert.ok(errorCodeSuggestion?.alternatives.includes("diagnosticCode"));
    assert.match(errorCodeSuggestion?.note ?? "", /1 of 5 sampled records/);
  } finally {
    await new Promise<void>(resolve => remote.close(() => resolve()));
  }
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
  let changeFirstRemotePayload = false;
  const remote = createServer((request, response) => {
    requests += 1;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/faults");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      faults: [
        {
          faultId: "F-remote-1", faultType: "overheat", eventTime: 1793534400, severity: "high",
          message: changeFirstRemotePayload ? "Temperature high changed" : "Temperature high",
          assetId: "registered-machine", apiToken: "sensitive-fixture-value",
        },
        {
          faultId: "F-remote-2", faultType: "low_pressure", eventTime: 1793534401, severity: "medium", message: "Pressure low",
          assetId: "Registered machine", apiToken: "sensitive-fixture-value",
        },
        {
          faultId: "F-remote-3", faultType: "bearing_fault", eventTime: 1793534402, severity: "low", message: "Bearing vibration",
          assetId: "unregistered-machine", apiToken: "sensitive-fixture-value",
        },
        {
          faultId: "F-remote-4", faultType: "motor_fault", eventTime: 1793534403, severity: "high", message: "Motor temperature",
          assetId: "remote-motor-7", apiToken: "sensitive-fixture-value",
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
    await call("POST", "/api/v1/assets", {
      assetKey: "motor-7",
      name: "Motor 7",
      assetType: "other",
      externalIdentifiers: [{ sourceKey: "faults-rest", externalId: "remote-motor-7" }],
    });
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
    const discovery = await call("POST", "/api/v1/data-sources/discover", {
      sourceType: "rest_api",
      configuration,
      sourceKey: "faults-rest",
    }, 200);
    assert.equal(requests, 1, "only explicit discovery reads the REST fixture");
    assert.equal(discovery.selectedRecordPath, "faults");
    assert.equal(discovery.preview[0]?.assetMatch?.matchType, "asset_key");
    assert.equal(discovery.preview[1]?.assetMatch?.matchType, "name_suggestion");
    assert.equal(discovery.preview[1]?.state, "valid", "name-only candidates must not block an event preview");
    assert.equal(discovery.preview[2]?.assetMatch?.status, "unmatched");
    assert.equal(discovery.preview[2]?.state, "valid", "unmatched asset IDs remain unattached rather than rejecting events");
    assert.equal(discovery.preview[3]?.assetMatch?.matchType, "registered_external_identifier");
    assert.equal(discovery.suggestions.find((item: { target: string }) => item.target === "eventType")?.sourcePath, "faultType");
    assert.equal(JSON.stringify(discovery).includes("sensitive-fixture-value"), false);
    assert.ok(discovery.warnings.some((warning: string) => warning.includes("unmatched or ambiguous")));
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
        assetKey: "assetId",
        payload: { message: "message", severity: "severity" },
      },
    });
    const validation = await call("POST", `/api/v1/data-sources/${source.id}/mappings/1/validate`, undefined, 200);
    assert.equal(validation.valid, true);
    await call("POST", `/api/v1/data-sources/${source.id}/mappings/1/activate`, undefined, 200);
    const synced = await call("POST", `/api/v1/data-sources/${source.id}/sync`, undefined, 200);
    assert.equal(synced.imported, 4, JSON.stringify(synced));
    assert.equal(requests, 2, "sync contacts the endpoint only after the operator requests it");
    const syncedAgain = await call("POST", `/api/v1/data-sources/${source.id}/sync`, undefined, 200);
    assert.equal(syncedAgain.imported, 0);
    assert.equal(syncedAgain.duplicates, 4, "the active mapping is reused without duplicating stable source records");
    assert.equal(requests, 3);
    changeFirstRemotePayload = true;
    const conflictedSync = await call("POST", `/api/v1/data-sources/${source.id}/sync`, undefined, 200);
    assert.equal(conflictedSync.imported, 0);
    assert.equal(conflictedSync.failed, 1, "changed content under a stable source ID is rejected as a conflict");
    assert.equal(requests, 4);

    await writeFile(join(imports, "nested.json"), JSON.stringify({
      envelope: { version: 1 },
      faults: [{
        faultType: "bearing_fault",
        eventTime: "2026-11-01T12:00:00Z",
        faultId: "F-json-1",
        assetId: "unregistered-json-unit",
        message: "Bearing temperature high",
        severity: "high",
      }],
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
      sourceKey: "faults-json",
    }, 200);
    assert.equal(fileDiscovery.selectedRecordPath, "faults");
    await call("POST", `/api/v1/data-sources/${fileSource.id}/import`, undefined, 409);
    await call("POST", `/api/v1/data-sources/${fileSource.id}/mappings`, {
      definition: {
        eventType: "faultType",
        occurredAt: "eventTime",
        sourceRecordId: "faultId",
        assetKey: "assetId",
        payload: { message: "message", severity: "severity" },
      },
    });
    const fileMapping = await call("POST", `/api/v1/data-sources/${fileSource.id}/mappings/1/validate`, undefined, 200);
    assert.equal(fileMapping.valid, true);
    await call("POST", `/api/v1/data-sources/${fileSource.id}/mappings/1/activate`, undefined, 200);
    const imported = await call("POST", `/api/v1/data-sources/${fileSource.id}/import`, undefined, 200);
    assert.equal(imported.records, 1);
    assert.equal(imported.imported, 1);
    const importedAgain = await call("POST", `/api/v1/data-sources/${fileSource.id}/import`, undefined, 200);
    assert.equal(importedAgain.imported, 0, "the saved active mapping is reused on repeated import");

    await writeFile(join(imports, "events.csv"), [
      "faultType,eventTime,faultId,assetId,message,severity",
      "pump_fault,2026-11-01T13:00:00Z,F-csv-1,unregistered-csv-pump,Pump vibration,medium",
      "",
    ].join("\n"));
    const csvConfiguration = { kind: "csv_file" as const, relativePath: "events.csv" };
    const csvSource = await call("POST", "/api/v1/data-sources", {
      sourceKey: "faults-csv",
      displayName: "CSV faults",
      sourceType: "csv_file",
      configuration: csvConfiguration,
      enabled: true,
    });
    const csvDiscovery = await call("POST", "/api/v1/data-sources/discover", {
      sourceType: "csv_file",
      configuration: csvConfiguration,
      sourceKey: "faults-csv",
    }, 200);
    assert.equal(csvDiscovery.selectedRecordPath, "$");
    await call("POST", `/api/v1/data-sources/${csvSource.id}/mappings`, {
      definition: {
        eventType: "faultType",
        occurredAt: "eventTime",
        sourceRecordId: "faultId",
        assetKey: "assetId",
        payload: { message: "message", severity: "severity" },
      },
    });
    const csvMapping = await call("POST", `/api/v1/data-sources/${csvSource.id}/mappings/1/validate`, undefined, 200);
    assert.equal(csvMapping.valid, true);
    await call("POST", `/api/v1/data-sources/${csvSource.id}/mappings/1/activate`, undefined, 200);
    const csvImported = await call("POST", `/api/v1/data-sources/${csvSource.id}/import`, undefined, 200);
    assert.equal(csvImported.imported, 1);
    const csvImportedAgain = await call("POST", `/api/v1/data-sources/${csvSource.id}/import`, undefined, 200);
    assert.equal(csvImportedAgain.imported, 0, "the same mapping contract is reused for CSV without remapping");
    assert.equal(requests, 4, "file discovery and import do not contact the REST fixture");
    const events = await call("GET", "/api/v1/events");
    assert.equal(events.total, 6);

    const restEvents = await manager.db.selectFrom("events")
      .select(["id", "source_record_id", "asset_id"])
      .where("source_id", "=", source.id)
      .execute();
    const registeredAsset = await manager.db.selectFrom("assets").select("id")
      .where("asset_key", "=", "registered-machine").executeTakeFirst();
    const externalAsset = await manager.db.selectFrom("assets").select("id")
      .where("asset_key", "=", "motor-7").executeTakeFirst();
    assert.equal(restEvents.find(event => event.source_record_id === "F-remote-1")?.asset_id, registeredAsset?.id);
    assert.equal(restEvents.find(event => event.source_record_id === "F-remote-2")?.asset_id, null, "name suggestions are never automatically associated");
    assert.equal(restEvents.find(event => event.source_record_id === "F-remote-3")?.asset_id, null, "unknown asset IDs remain unassociated");
    assert.equal(restEvents.find(event => event.source_record_id === "F-remote-4")?.asset_id, externalAsset?.id);
    const preservedEvent = restEvents.find(event => event.source_record_id === "F-remote-1");
    assert.ok(preservedEvent);
    const eventDetail = await call("GET", `/api/v1/events/${preservedEvent.id}`);
    assert.equal(eventDetail.payload.message, "Temperature high");
    assert.equal(eventDetail.provenance.originalRecord.faultType, "overheat");
  } finally {
    await app.close();
    await manager.close();
    await new Promise<void>(resolve => remote.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Local SQLite REST discovery accepts the Vite origin while preserving origin and private-network blocks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-discovery-local-origin-"));
  let fixtureRequests = 0;
  const remote = createServer((_request, response) => {
    fixtureRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ faults: [{ eventType: "overheat", occurredAt: "2026-11-04T12:00:00Z" }] }));
  });
  let manager: LocalDatabaseManager | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const previousPort = process.env.PORT;
  try {
    await new Promise<void>((resolve, reject) => {
      remote.once("error", reject);
      remote.listen(0, "127.0.0.1", resolve);
    });
    const fixturePort = (remote.address() as { port: number }).port;
    manager = await LocalDatabaseManager.create(join(directory, "sqlite"));
    app = await createApp({
      db: manager.db,
      localMode: true,
      localDatabase: manager,
      allowLoopbackRestTests: true,
      restTrustedHosts: [],
      logLevel: "silent",
    });
    // pnpm dev sets PORT=3000; Vite changeOrigin rewrites Host to its target
    // but keeps the browser Origin and same-origin Fetch Metadata.
    process.env.PORT = "3000";
    const browserHeaders = {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:5173",
      "sec-fetch-site": "same-origin",
    };
    const configuration = {
      kind: "rest_api",
      baseUrl: `http://127.0.0.1:${fixturePort}/api`,
      endpointPath: "faults",
      method: "GET",
      authMode: "none",
      timeoutMs: 2_000,
      maxResponseBytes: 16_000,
      maxRecords: 100,
    };

    const allowed = await app.inject({
      method: "POST",
      url: "/api/v1/data-sources/discover",
      headers: browserHeaders,
      payload: { sourceType: "rest_api", configuration, sourceKey: "vite-origin-source" },
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(fixtureRequests, 1, "the request passed Local-mode origin validation and reached discovery");

    const crossOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/data-sources/discover",
      headers: { ...browserHeaders, origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      payload: { sourceType: "rest_api", configuration, sourceKey: "vite-origin-source" },
    });
    assert.equal(crossOrigin.statusCode, 403);
    assert.equal(crossOrigin.json().error.code, "LOCAL_ORIGIN_REQUIRED");
    assert.equal(fixtureRequests, 1, "a blocked origin must not reach the remote REST source");

    const privateDestination = await app.inject({
      method: "POST",
      url: "/api/v1/data-sources/discover",
      headers: browserHeaders,
      payload: {
        sourceType: "rest_api",
        configuration: { ...configuration, baseUrl: "http://10.0.0.12/api" },
        sourceKey: "vite-origin-source",
      },
    });
    assert.equal(privateDestination.statusCode, 403);
    assert.equal(privateDestination.json().error.code, "REST_DESTINATION_BLOCKED");
    assert.match(privateDestination.json().error.message, /enable trust for the exact base-URL hostname or IP/i);
    assert.equal(fixtureRequests, 1, "an untrusted private destination must remain blocked");
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await app?.close();
    await manager?.close();
    await new Promise<void>(resolve => remote.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
