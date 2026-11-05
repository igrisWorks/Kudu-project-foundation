import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import ExcelJS from "exceljs";
import { createApp } from "./app.js";
import { normalizeMappedEvent } from "./event-mappings.js";
import { ingestEvent } from "./events.js";
import { LocalDatabaseManager } from "./local-database.js";
import { storeSourceRecord } from "./source-records.js";

test("the explorer filters persisted events and exports complete attribution and source payloads", async context => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-explorer-"));
  const manager = await LocalDatabaseManager.create(join(directory, "data"));
  const sourceId = randomUUID();
  await manager.db.insertInto("data_sources").values({
    id: sourceId,
    source_key: "explorer-fixture",
    display_name: "Explorer fixture",
    source_type: "json_file",
    description: null,
    configuration: JSON.stringify({
      kind: "json_file",
      relativePath: "events.json",
      sourceTimezone: "Europe/Berlin",
    }),
    enabled: true,
  }).execute();
  const mapping = {
    version: 3,
    definition: { eventType: "eventType", occurredAt: "occurredAt" },
  } as unknown as Parameters<typeof normalizeMappedEvent>[4];
  const normalizedLocalTime = await normalizeMappedEvent(
    manager.db,
    sourceId,
    { eventType: "alarm.raised", occurredAt: "2025-12-18T09:51:23.962" },
    {},
    mapping,
    "local-time-record",
    { mappingVersion: 3 },
    undefined,
    "Europe/Berlin",
  );
  assert.equal(normalizedLocalTime.occurredAt, "2025-12-18T08:51:23.962Z");
  assert.equal(normalizedLocalTime.sourceTimestamp, "2025-12-18T09:51:23.962");

  for (let index = 0; index < 50; index += 1) {
    const originalRecord = {
      recordCode: `cycle-${index}`,
      measurement: { temperature: 20 + index, unit: "degC" },
      ...(index >= 25 ? { newSignal: { value: index, quality: "good" } } : {}),
    };
    await ingestEvent(manager.db, {
      sourceId,
      sourceRecordId: `cycle-${index}`,
      eventType: index % 2 ? "measurement.recorded" : "alarm.cleared",
      occurredAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      sourceTimestamp: `2026-01-01T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00`,
      deduplicationKey: `cycle-${index}`,
      payload: originalRecord,
      provenance: { originalRecord, mappingVersion: 3 },
    });
  }
  const app = await createApp({
    db: manager.db,
    localMode: true,
    localDatabase: manager,
    logLevel: "silent",
  });
  context.after(async () => {
    await app.close();
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  });

  const list = await app.inject({
    method: "GET",
    url: `/api/v1/explorer/events?sourceId=${sourceId}&search=cycle-49&page=1&pageSize=5`,
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(list.statusCode, 200, list.body);
  const page = list.json();
  assert.equal(page.total, 1);
  assert.equal(page.items[0].source.sourceKey, "explorer-fixture");
  assert.deepEqual(page.items[0].payload.measurement, { temperature: 69, unit: "degC" });
  assert.equal(page.items[0].provenance.originalRecord.recordCode, "cycle-49");

  const secondPage = await app.inject({
    method: "GET",
    url: `/api/v1/explorer/events?sourceId=${sourceId}&page=2&pageSize=7&sortBy=occurredAt&sortDirection=asc`,
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(secondPage.statusCode, 200, secondPage.body);
  assert.equal(secondPage.json().total, 50);
  assert.equal(secondPage.json().items.length, 7);
  assert.equal(secondPage.json().items[0].sourceRecordId, "cycle-7");

  const quality = await app.inject({
    method: "GET",
    url: `/api/v1/explorer/quality?sourceId=${sourceId}`,
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(quality.statusCode, 200, quality.body);
  const report = quality.json();
  assert.equal(report.sources.length, 1);
  assert.equal(report.sources[0].sampledEvents, 50);
  assert.equal(report.sources[0].insufficientHistory, false);
  assert.ok(report.sources[0].schemaChanges.some((change: { path: string; change: string }) =>
    change.path === "newSignal" && change.change === "added"));

  const json = await app.inject({
    method: "GET",
    url: `/api/v1/explorer/export?format=json&sourceId=${sourceId}`,
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(json.statusCode, 200, json.body);
  assert.equal(json.json().items.length, 50);
  assert.equal(json.json().items[0].source.id, sourceId);
  assert.ok(json.json().items[0].provenance.originalRecord);

  const csv = await app.inject({
    method: "GET",
    url: `/api/v1/explorer/export?format=csv&sourceId=${sourceId}`,
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(csv.statusCode, 200, csv.body);
  assert.match(csv.headers["content-type"] ?? "", /text\/csv/);
  assert.match(csv.body, /original_record_json/);
  assert.match(csv.body, /cycle-49/);
  assert.match(csv.body, /newSignal/);

  const xlsx = await app.inject({
    method: "GET",
    url: `/api/v1/explorer/export?format=xlsx&sourceId=${sourceId}`,
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(xlsx.statusCode, 200, xlsx.body);
  assert.match(xlsx.headers["content-type"] ?? "", /spreadsheetml/);
  assert.equal(xlsx.rawPayload.subarray(0, 2).toString(), "PK");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(xlsx.rawPayload) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const worksheet = workbook.getWorksheet("Events");
  assert.ok(worksheet);
  assert.ok((worksheet.getRow(1).values as unknown[]).some(value => value === "original_record_json_part_1"));
  assert.ok((worksheet.getRow(2).values as unknown[]).some(value =>
    typeof value === "string" && value.includes("cycle-49")));
});

test("raw source records are explorable, exportable, and preserved with sync checkpoints in SQLite backups", async context => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-raw-explorer-"));
  const manager = await LocalDatabaseManager.create(join(directory, "data"));
  const sourceId = randomUUID();
  const runId = randomUUID();
  const now = new Date().toISOString();
  const rawRecord = {
    id: "fault-raw-1",
    message: "Bearing temperature high",
    number: 812,
    timestamp: "2026-11-05T08:15:00",
    eagleTimestamp: "0001-01-01T00:00:00",
    remark: null,
    cams: [],
    inProgress: false,
    trackingVideoId: null,
    formatName: "alarm",
    machineName: "Mixer 4",
    nested: { samples: [{ value: 34.5, unit: "degC" }] },
  };
  await manager.db.insertInto("data_sources").values({
    id: sourceId,
    source_key: "raw-record-fixture",
    display_name: "Raw record fixture",
    source_type: "rest_api",
    description: null,
    configuration: JSON.stringify({ kind: "rest_api", baseUrl: "http://127.0.0.1:5000" }),
    enabled: true,
  }).execute();
  await manager.db.insertInto("source_sync_runs").values({
    id: runId,
    source_id: sourceId,
    mapping_version: null,
    status: "paused",
    resumable: true,
    request_succeeded: true,
    config_fingerprint: "a".repeat(64),
    checkpoint: JSON.stringify({ cursor: "next-page", cursorHashes: ["page-1"] }),
    pages_completed: 1,
    fetched: 1,
    imported: 1,
    duplicates: 0,
    failed: 0,
    errors: JSON.stringify([]),
    errors_truncated: false,
    last_error_code: null,
    started_at: now,
    updated_at: now,
    completed_at: null,
  }).execute();
  const stored = await storeSourceRecord(manager.db, {
    sourceId,
    sourceRecordId: rawRecord.id,
    deduplicationKey: rawRecord.id,
    rawRecord,
    provenance: { connector: "rest_api", syncRunId: runId, responseFormat: "json" },
    syncRunId: runId,
  });
  assert.equal(stored.duplicate, false);
  const app = await createApp({
    db: manager.db,
    localMode: true,
    localDatabase: manager,
    logLevel: "silent",
  });
  context.after(async () => {
    await app.close();
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  });

  const list = await app.inject({
    method: "GET",
    url: `/api/v1/explorer/records?sourceId=${sourceId}&page=1&pageSize=10`,
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(list.statusCode, 200, list.body);
  const page = list.json();
  assert.equal(page.total, 1);
  assert.equal(page.items[0].processingStatus, "raw_only");
  assert.equal(page.items[0].fieldCount, Object.keys(rawRecord).length);
  assert.equal("rawRecord" in page.items[0], false, "list responses stay summary-only");
  assert.ok(page.recognition.suggestions.some((item: { target: string }) => item.target === "message"));

  const detail = await app.inject({
    method: "GET",
    url: `/api/v1/explorer/records/${stored.id}`,
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().rawRecord, rawRecord);
  assert.equal(detail.json().rawRecord.eagleTimestamp, "0001-01-01T00:00:00");
  assert.equal(detail.json().rawRecord.remark, null);
  assert.deepEqual(detail.json().rawRecord.cams, []);

  const json = await app.inject({
    method: "GET",
    url: `/api/v1/explorer/records/export?format=json&sourceId=${sourceId}`,
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(json.statusCode, 200, json.body);
  assert.deepEqual(json.json().items[0].rawRecord, rawRecord);

  const csv = await app.inject({
    method: "GET",
    url: `/api/v1/explorer/records/export?format=csv&sourceId=${sourceId}`,
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(csv.statusCode, 200, csv.body);
  assert.match(csv.body, /raw_record_json/);
  assert.match(csv.body, /trackingVideoId/);
  assert.match(csv.body, /eagleTimestamp/);

  const xlsx = await app.inject({
    method: "GET",
    url: `/api/v1/explorer/records/export?format=xlsx&sourceId=${sourceId}`,
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(xlsx.statusCode, 200, xlsx.body);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(xlsx.rawPayload) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const worksheet = workbook.getWorksheet("Source records");
  assert.ok(worksheet);
  assert.ok((worksheet.getRow(2).values as unknown[]).some(value =>
    typeof value === "string" && value.includes("trackingVideoId")));

  const backup = await manager.createBackup();
  await manager.restoreBackup(backup.fileName);
  const restored = await manager.db.selectFrom("source_records").select(["raw_record", "sync_run_id"])
    .where("id", "=", stored.id).executeTakeFirstOrThrow();
  assert.equal(restored.sync_run_id, runId);
  assert.deepEqual(restored.raw_record, rawRecord);
  const restoredRun = await manager.db.selectFrom("source_sync_runs").select(["mapping_version", "checkpoint"])
    .where("id", "=", runId).executeTakeFirstOrThrow();
  assert.equal(restoredRun.mapping_version, null);
  assert.deepEqual(restoredRun.checkpoint, { cursor: "next-page", cursorHashes: ["page-1"] });
});
