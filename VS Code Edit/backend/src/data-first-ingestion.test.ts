import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "./app.js";
import { LocalDatabaseManager } from "./local-database.js";
import { normalizeOccurrenceTimestamp } from "./event-mappings.js";

const loopbackHost = "127.0.0.1";

test("REST, JSON, and CSV ingestion accept unmapped industrial records without losing source values", async context => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-data-first-"));
  const importDirectory = join(directory, "imports");
  await mkdir(importDirectory);
  const manager = await LocalDatabaseManager.create(join(directory, "data"));
  const restRecords = [
    {
      id: "rest-001",
      message: "Bearing temperature high",
      number: 812,
      timestamp: "2026-11-05T08:15:00",
      eagleTimestamp: "0001-01-01T00:00:00",
      remark: null,
      cams: [],
      faultShowingCamId: null,
      inProgress: false,
      trackingVideoId: null,
      formatName: "alarm",
      machineName: "Mixer 4",
      samples: [{ value: 34.5, unit: "degC" }],
    },
    {
      id: "rest-002",
      message: "Drive state changed",
      number: null,
      timestamp: "2026-11-05T08:16:00",
      eagleTimestamp: "0001-01-01T00:00:00",
      remark: null,
      cams: [],
      faultShowingCamId: null,
      inProgress: false,
      trackingVideoId: null,
      formatName: "state",
      machineName: "Mixer 4",
    },
  ];
  const remote = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ records: restRecords }));
  });
  await new Promise<void>((resolve, reject) => {
    remote.once("error", reject);
    remote.listen(0, loopbackHost, resolve);
  });
  const address = remote.address();
  assert.ok(address && typeof address !== "string");
  const app = await createApp({
    db: manager.db,
    localMode: true,
    localDatabase: manager,
    importDirectory,
    allowLoopbackRestTests: true,
    logLevel: "silent",
  });
  context.after(async () => {
    await app.close();
    await manager.close();
    await new Promise<void>(resolve => remote.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const call = async (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) => {
    const response = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
    });
    return response;
  };

  const restSourceResponse = await call("POST", "/api/v1/data-sources", {
    sourceKey: "data-first-rest",
    displayName: "Data-first REST",
    sourceType: "rest_api",
    configuration: {
      kind: "rest_api",
      baseUrl: `http://${loopbackHost}:${address.port}`,
      endpointPath: "/records",
      recordsPath: "records",
      maxRecords: 100,
    },
    enabled: true,
  });
  assert.equal(restSourceResponse.statusCode, 201, restSourceResponse.body);
  const restSourceId = restSourceResponse.json().id as string;
  const firstSync = await call("POST", `/api/v1/data-sources/${restSourceId}/sync`);
  assert.equal(firstSync.statusCode, 200, firstSync.body);
  assert.equal(firstSync.json().mappingVersion, null);
  assert.equal(firstSync.json().imported, 2);
  assert.equal(firstSync.json().failed, 0);
  const repeatSync = await call("POST", `/api/v1/data-sources/${restSourceId}/sync`);
  assert.equal(repeatSync.statusCode, 200, repeatSync.body);
  assert.equal(repeatSync.json().imported, 0);
  assert.equal(repeatSync.json().duplicates, 2);
  const restRows = await manager.db.selectFrom("source_records").selectAll()
    .where("source_id", "=", restSourceId).orderBy("deduplication_key").execute();
  assert.equal(restRows.length, 2);
  const storedRest = restRows.find(row => row.raw_record.id === "rest-001");
  assert.ok(storedRest);
  assert.deepEqual(storedRest.raw_record, restRecords[0]);
  assert.equal(storedRest.raw_record.timestamp, "2026-11-05T08:15:00");
  assert.equal(storedRest.raw_record.eagleTimestamp, "0001-01-01T00:00:00");
  assert.deepEqual(storedRest.raw_record.cams, []);
  assert.equal(storedRest.raw_record.remark, null);
  assert.equal(storedRest.processing_status, "raw_only", "records without a defensible event type/time remain raw-only");
  assert.equal(await manager.db.selectFrom("events").selectAll().where("source_id", "=", restSourceId).executeTakeFirst(), undefined);
  assert.equal(normalizeOccurrenceTimestamp("0001-01-01T00:00:00Z"), undefined);

  const restExplorer = await call("GET", `/api/v1/explorer/records?sourceId=${restSourceId}&page=1&pageSize=10`);
  assert.equal(restExplorer.statusCode, 200, restExplorer.body);
  assert.equal(restExplorer.json().total, 2);
  assert.ok(restExplorer.json().recognition.suggestions.some(
    (suggestion: { target: string; sourcePath: string | null }) =>
      suggestion.target === "message" && suggestion.sourcePath === "message",
  ));
  assert.ok(restExplorer.json().recognition.suggestions.some(
    (suggestion: { target: string; sourcePath: string | null; confidence: string; alternatives: string[] }) =>
      suggestion.target === "errorCode" && suggestion.alternatives.includes("number") &&
      suggestion.confidence === "low" && suggestion.sourcePath === null,
  ), "generic numeric fields remain review suggestions rather than guessed mappings");

  const jsonRecords = [
    {
      id: "json-001",
      message: "Valve fault",
      timestamp: "0001-01-01T00:00:00",
      detail: null,
      cams: [],
      nested: { samples: [{ value: 5, unit: "bar" }] },
      trackingVideoId: null,
    },
    {
      id: "json-002",
      message: "Pressure recovered",
      timestamp: "2026-11-05T08:30:00Z",
      cams: [],
      nested: { samples: [] },
    },
  ];
  await writeFile(join(importDirectory, "records.json"), JSON.stringify(jsonRecords));
  const jsonSourceResponse = await call("POST", "/api/v1/data-sources", {
    sourceKey: "data-first-json",
    displayName: "Data-first JSON",
    sourceType: "json_file",
    configuration: { kind: "json_file", relativePath: "records.json" },
    enabled: true,
  });
  assert.equal(jsonSourceResponse.statusCode, 201, jsonSourceResponse.body);
  const jsonSourceId = jsonSourceResponse.json().id as string;
  const jsonImport = await call("POST", `/api/v1/data-sources/${jsonSourceId}/import`);
  assert.equal(jsonImport.statusCode, 200, jsonImport.body);
  assert.equal(jsonImport.json().imported, 2);
  assert.equal(jsonImport.json().failed, 0);
  const jsonRows = await manager.db.selectFrom("source_records").selectAll()
    .where("source_id", "=", jsonSourceId).execute();
  assert.equal(jsonRows.length, 2);
  assert.deepEqual(jsonRows.find(row => row.raw_record.id === "json-001")?.raw_record, jsonRecords[0]);
  assert.equal(jsonRows.find(row => row.raw_record.id === "json-002")?.raw_record.detail, undefined);
  assert.equal(jsonRows.find(row => row.raw_record.id === "json-001")?.raw_record.detail, null);

  const csvText = [
    "id,message,number,timestamp,cams,remark,missing,flag",
    'csv-001,"Fault, high",812,"0001-01-01T00:00:00","[]","",,true',
    'csv-002,"Fault cleared",,"2026-11-05T08:40:00Z"',
  ].join("\r\n");
  await writeFile(join(importDirectory, "records.csv"), csvText);
  const csvSourceResponse = await call("POST", "/api/v1/data-sources", {
    sourceKey: "data-first-csv",
    displayName: "Data-first CSV",
    sourceType: "csv_file",
    configuration: { kind: "csv_file", relativePath: "records.csv" },
    enabled: true,
  });
  assert.equal(csvSourceResponse.statusCode, 201, csvSourceResponse.body);
  const csvSourceId = csvSourceResponse.json().id as string;
  const csvImport = await call("POST", `/api/v1/data-sources/${csvSourceId}/import`);
  assert.equal(csvImport.statusCode, 200, csvImport.body);
  assert.equal(csvImport.json().imported, 2);
  assert.equal(csvImport.json().failed, 0);
  const csvRows = await manager.db.selectFrom("source_records").selectAll()
    .where("source_id", "=", csvSourceId).execute();
  const explicitEmpty = csvRows.find(row => row.raw_record.id === "csv-001");
  const missingCell = csvRows.find(row => row.raw_record.id === "csv-002");
  assert.equal(explicitEmpty?.raw_record.remark, "");
  assert.equal(explicitEmpty?.raw_record.missing, "");
  assert.equal(explicitEmpty?.raw_record.cams, "[]", "CSV retains the exact JSON-encoded cell text");
  assert.equal(Object.hasOwn(missingCell?.raw_record ?? {}, "cams"), false, "a missing trailing cell remains absent");
  assert.equal(Object.hasOwn(missingCell?.raw_record ?? {}, "remark"), false);

  const csvExport = await call("GET", `/api/v1/explorer/records/export?format=json&sourceId=${csvSourceId}`);
  assert.equal(csvExport.statusCode, 200, csvExport.body);
  assert.equal(csvExport.json().items.find((item: { rawRecord: { id: string } }) => item.rawRecord.id === "csv-001").rawRecord.cams, "[]");
});
