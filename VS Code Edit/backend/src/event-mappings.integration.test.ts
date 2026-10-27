import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { createApp } from "./app.js";
import type { Database } from "./database.js";
import { runMigrations } from "./migration-runner.js";

const databaseUrl = process.env.KUDU_TEST_DATABASE_URL;
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../database/migrations");

interface TestLifecycle {
  after(callback: () => void | Promise<void>): void;
}

async function createFixture(context: TestLifecycle) {
  if (!databaseUrl) throw new Error("KUDU_TEST_DATABASE_URL is required for event mapping integration tests.");
  const prefix = `km${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const importDirectory = await mkdtemp(join(tmpdir(), "kudu-event-mapping-"));
  await mkdir(join(importDirectory, "plant"), { recursive: true });
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(pool, migrationsDirectory);
  const app = await createApp({ db, importDirectory, logLevel: "silent" });
  const sourceIds: string[] = [];
  const assetIds: string[] = [];

  context.after(async () => {
    if (sourceIds.length) {
      await db.deleteFrom("events").where("source_id", "in", sourceIds).execute();
      await db.deleteFrom("data_source_event_mappings").where("source_id", "in", sourceIds).execute();
      await db.deleteFrom("data_sources").where("id", "in", sourceIds).execute();
    }
    if (assetIds.length) await db.deleteFrom("assets").where("id", "in", assetIds).execute();
    await app.close();
    await db.destroy();
    await rm(importDirectory, { recursive: true, force: true });
  });

  async function addSource(
    relativePath = "plant/events.json",
    sourceType: "json_file" | "csv_file" = "json_file",
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/data-sources",
      payload: {
        sourceKey: `${prefix}-source-${sourceIds.length + 1}`,
        displayName: "Event mapping integration source",
        sourceType,
        configuration: { kind: sourceType, relativePath },
        enabled: true,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json().id as string;
    sourceIds.push(id);
    return id;
  }

  async function addAsset(): Promise<{ id: string; key: string }> {
    const key = `${prefix}-asset`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      payload: { assetKey: key, name: "Mapped asset", assetType: "machine" },
    });
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json().id as string;
    assetIds.push(id);
    return { id, key };
  }

  return { app, importDirectory, addAsset, addSource };
}

async function createValidateActivate(
  app: Awaited<ReturnType<typeof createApp>>,
  sourceId: string,
  definition: Record<string, unknown>,
  expectedVersion: number,
) {
  const created = await app.inject({
    method: "POST",
    url: `/api/v1/data-sources/${sourceId}/mappings`,
    payload: { definition },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().mapping.version, expectedVersion);

  const validated = await app.inject({
    method: "POST",
    url: `/api/v1/data-sources/${sourceId}/mappings/${expectedVersion}/validate`,
  });
  assert.equal(validated.statusCode, 200, validated.body);
  assert.equal(validated.json().valid, true, validated.body);

  const activated = await app.inject({
    method: "POST",
    url: `/api/v1/data-sources/${sourceId}/mappings/${expectedVersion}/activate`,
  });
  assert.equal(activated.statusCode, 200, activated.body);
  assert.equal(activated.json().mapping.status, "active");
}

test(
  "CSV mapping accepts renamed headers and resolves only the explicit asset key",
  { skip: !databaseUrl },
  async (context) => {
    const { app, importDirectory, addAsset, addSource } = await createFixture(context);
    const sourceId = await addSource("plant/readings.csv", "csv_file");
    const asset = await addAsset();
    const sourceRecord = [
      "counter.reading,2026-10-27T14:30:00+02:00,csv-row-1",
      `${asset.key},23.5,line B`,
    ].join(",");
    await writeFile(
      join(importDirectory, "plant/readings.csv"),
      `kind,time,record_id,asset_ref,temp_c,operator_note\r\n${sourceRecord}`,
      "utf8",
    );
    await createValidateActivate(app, sourceId, {
      eventType: "kind",
      occurredAt: "time",
      sourceRecordId: "record_id",
      assetKey: "asset_ref",
      payload: { temperatureC: "temp_c" },
    }, 1);

    const imported = await app.inject({ method: "POST", url: `/api/v1/data-sources/${sourceId}/import` });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.deepEqual(
      { imported: imported.json().imported, failed: imported.json().failed },
      { imported: 1, failed: 0 },
    );
    const list = await app.inject({ method: "GET", url: `/api/v1/events?sourceId=${sourceId}` });
    const item = list.json().items[0] as { id: string };
    const detail = (await app.inject({ method: "GET", url: `/api/v1/events/${item.id}` })).json();
    assert.equal(detail.eventType, "counter.reading");
    assert.equal(detail.asset.id, asset.id);
    assert.equal(detail.payload.temperatureC, "23.5");
    assert.equal(detail.payload.operator_note, "line B");
    assert.equal(detail.provenance.mappingVersion, 1);
  },
);

test(
  "active mapping normalizes imports, preserves source data, and versions future imports",
  { skip: !databaseUrl },
  async (context) => {
    const { app, importDirectory, addAsset, addSource } = await createFixture(context);
    const sourceId = await addSource();
    const asset = await addAsset();
    const importFile = join(importDirectory, "plant/events.json");
    const firstRecord = {
      kind: "alarm.raised",
      event_time: "2026-10-27T14:30:00+02:00",
      source_record: "mapped-row-1",
      machine_ref: asset.key,
      measurements: { temperature_c: 23.5, temperature_f: 74.3 },
      operator_note: "line A",
      payload: { rawCode: "E-7" },
    };
    const definition = {
      eventType: "kind",
      occurredAt: "event_time",
      sourceRecordId: "source_record",
      assetKey: "machine_ref",
      payload: { temperatureC: "measurements.temperature_c" },
    };
    await writeFile(importFile, JSON.stringify([firstRecord]), "utf8");
    await createValidateActivate(app, sourceId, definition, 1);

    const firstImport = await app.inject({ method: "POST", url: `/api/v1/data-sources/${sourceId}/import` });
    assert.equal(firstImport.statusCode, 200, firstImport.body);
    assert.deepEqual(
      { imported: firstImport.json().imported, failed: firstImport.json().failed },
      { imported: 1, failed: 0 },
    );
    const firstList = await app.inject({ method: "GET", url: `/api/v1/events?sourceId=${sourceId}` });
    const firstItem = firstList.json().items[0] as { id: string; sourceRecordId: string };
    const firstDetailResponse = await app.inject({ method: "GET", url: `/api/v1/events/${firstItem.id}` });
    const firstDetail = firstDetailResponse.json();
    assert.equal(firstItem.sourceRecordId, "mapped-row-1");
    assert.equal(firstDetail.eventType, "alarm.raised");
    assert.equal(new Date(firstDetail.occurredAt).toISOString(), "2026-10-27T12:30:00.000Z");
    assert.equal(firstDetail.sourceTimestamp, firstRecord.event_time);
    assert.equal(firstDetail.asset.id, asset.id);
    assert.equal(firstDetail.payload.temperatureC, 23.5);
    assert.equal(firstDetail.payload.operator_note, "line A");
    assert.equal(firstDetail.payload.rawCode, "E-7");
    assert.equal(firstDetail.provenance.importFormat, "json");
    assert.equal(firstDetail.provenance.mappingVersion, 1);
    assert.deepEqual(firstDetail.provenance.originalRecord, firstRecord);

    const secondDefinition = {
      ...definition,
      payload: { temperatureF: "measurements.temperature_f" },
    };
    await createValidateActivate(app, sourceId, secondDefinition, 2);
    const secondRecord = { ...firstRecord, source_record: "mapped-row-2" };
    await writeFile(importFile, JSON.stringify([secondRecord]), "utf8");
    const secondImport = await app.inject({ method: "POST", url: `/api/v1/data-sources/${sourceId}/import` });
    assert.equal(secondImport.statusCode, 200, secondImport.body);
    assert.deepEqual(
      { imported: secondImport.json().imported, failed: secondImport.json().failed },
      { imported: 1, failed: 0 },
    );
    const secondList = await app.inject({ method: "GET", url: `/api/v1/events?sourceId=${sourceId}` });
    const secondItem = secondList.json().items.find(
      (item: { sourceRecordId: string | null }) => item.sourceRecordId === "mapped-row-2",
    );
    const secondDetail = (await app.inject({ method: "GET", url: `/api/v1/events/${secondItem.id}` })).json();
    assert.equal(secondDetail.payload.temperatureF, 74.3);
    assert.equal(secondDetail.provenance.mappingVersion, 2);
    assert.equal(firstDetail.provenance.mappingVersion, 1);

    const history = await app.inject({ method: "GET", url: `/api/v1/data-sources/${sourceId}/mappings` });
    assert.deepEqual(
      history.json().items.map((mapping: { version: number; status: string }) => [mapping.version, mapping.status]),
      [[2, "active"], [1, "retired"]],
    );
  },
);

test(
  "invalid definitions are blocked and missing required mapped fields fail records",
  { skip: !databaseUrl },
  async (context) => {
    const { app, importDirectory, addSource } = await createFixture(context);
    const sourceId = await addSource();
    await writeFile(join(importDirectory, "plant/events.json"), JSON.stringify([
      { kind: "state.changed", record_id: "missing-time-row" },
    ]), "utf8");

    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/data-sources/${sourceId}/mappings`,
      payload: { definition: { eventType: "../kind", occurredAt: "timestamp" } },
    });
    assert.equal(invalid.statusCode, 201, invalid.body);
    const validation = await app.inject({
      method: "POST",
      url: `/api/v1/data-sources/${sourceId}/mappings/1/validate`,
    });
    assert.equal(validation.statusCode, 200, validation.body);
    assert.equal(validation.json().valid, false);
    assert.equal(validation.json().errors[0].field, "eventType");

    const blocked = await app.inject({
      method: "POST",
      url: `/api/v1/data-sources/${sourceId}/mappings/1/activate`,
    });
    assert.equal(blocked.statusCode, 400);
    assert.equal(blocked.json().error.code, "MAPPING_INVALID");

    const corrected = await app.inject({
      method: "PUT",
      url: `/api/v1/data-sources/${sourceId}/mappings/1`,
      payload: { definition: { eventType: "kind", occurredAt: "timestamp" } },
    });
    assert.equal(corrected.statusCode, 200, corrected.body);
    const correctedValidation = await app.inject({
      method: "POST",
      url: `/api/v1/data-sources/${sourceId}/mappings/1/validate`,
    });
    assert.equal(correctedValidation.json().valid, true, correctedValidation.body);
    const activated = await app.inject({
      method: "POST",
      url: `/api/v1/data-sources/${sourceId}/mappings/1/activate`,
    });
    assert.equal(activated.statusCode, 200, activated.body);

    const imported = await app.inject({ method: "POST", url: `/api/v1/data-sources/${sourceId}/import` });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.deepEqual(
      { records: imported.json().records, imported: imported.json().imported, failed: imported.json().failed },
      { records: 1, imported: 0, failed: 1 },
    );
    assert.equal(
      imported.json().errors[0].fields?.occurredAt,
      "Provide a value in the mapped source field timestamp.",
      JSON.stringify(imported.json().errors[0]),
    );
  },
);

test(
  "imports without an active mapping retain the existing payload and provenance behavior",
  { skip: !databaseUrl },
  async (context) => {
    const { app, importDirectory, addAsset, addSource } = await createFixture(context);
    const sourceId = await addSource();
    const asset = await addAsset();
    const record = {
      eventType: "state.changed",
      occurredAt: "2026-10-27T12:00:00Z",
      sourceRecordId: "unmapped-row",
      assetId: asset.id,
      payload: { state: "ready" },
      lineName: "press-9",
    };
    await writeFile(join(importDirectory, "plant/events.json"), JSON.stringify([record]), "utf8");

    const imported = await app.inject({ method: "POST", url: `/api/v1/data-sources/${sourceId}/import` });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().imported, 1);
    const list = await app.inject({ method: "GET", url: `/api/v1/events?sourceId=${sourceId}` });
    const event = list.json().items[0] as { id: string };
    const detail = (await app.inject({ method: "GET", url: `/api/v1/events/${event.id}` })).json();
    assert.equal(detail.asset.id, asset.id);
    assert.deepEqual(detail.payload, { state: "ready", lineName: "press-9" });
    assert.deepEqual(detail.provenance, { importFormat: "json" });

    const csvSourceId = await addSource("plant/default.csv", "csv_file");
    const payloadCell = JSON.stringify({ state: "ready" }).replaceAll('"', '""');
    await writeFile(
      join(importDirectory, "plant/default.csv"),
      `eventType,occurredAt,sourceRecordId,payload,lineName\r\nstate.changed,2026-10-27T12:05:00Z,csv-default-row,"${payloadCell}",press-8`,
      "utf8",
    );
    const csvImport = await app.inject({ method: "POST", url: `/api/v1/data-sources/${csvSourceId}/import` });
    assert.equal(csvImport.statusCode, 200, csvImport.body);
    assert.equal(csvImport.json().imported, 1);
    const csvList = await app.inject({ method: "GET", url: `/api/v1/events?sourceId=${csvSourceId}` });
    const csvEvent = csvList.json().items[0] as { id: string };
    const csvDetail = (await app.inject({ method: "GET", url: `/api/v1/events/${csvEvent.id}` })).json();
    assert.deepEqual(csvDetail.payload, { state: "ready", lineName: "press-8" });
    assert.deepEqual(csvDetail.provenance, { importFormat: "csv" });
  },
);
