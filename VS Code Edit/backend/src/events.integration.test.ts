import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { createAuthenticatedTestApp } from "./test-support/authenticated-app.js";
import type { Database } from "./database.js";
import { runMigrations } from "./migration-runner.js";

const databaseUrl = process.env.KUDU_TEST_DATABASE_URL;
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../database/migrations",
);

interface TestLifecycle {
  after(callback: () => void | Promise<void>): void;
}

async function createFixture(context: TestLifecycle) {
  if (!databaseUrl) throw new Error("KUDU_TEST_DATABASE_URL is required for event integration tests.");
  const prefix = `ke${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(pool, migrationsDirectory);
  const app = await createAuthenticatedTestApp({ db, logLevel: "silent" });
  let sourceId: string | undefined;
  let assetId: string | undefined;

  context.after(async () => {
    if (sourceId) {
      await db.deleteFrom("events").where("source_id", "=", sourceId).execute();
    }
    if (assetId) {
      await db.deleteFrom("assets").where("id", "=", assetId).execute();
    }
    if (sourceId) {
      await db.deleteFrom("data_sources").where("id", "=", sourceId).execute();
    }
    await app.close();
    await db.destroy();
  });

  const sourceResponse = await app.inject({
    method: "POST",
    url: "/api/v1/data-sources",
    payload: {
      sourceKey: `${prefix}-source`,
      displayName: "Event integration source",
      sourceType: "manual",
      configuration: { kind: "manual" },
    },
  });
  assert.equal(sourceResponse.statusCode, 201);
  const createdSourceId = sourceResponse.json().id as string;
  sourceId = createdSourceId;

  const assetResponse = await app.inject({
    method: "POST",
    url: "/api/v1/assets",
    payload: {
      assetKey: `${prefix}-asset`,
      name: "Event integration asset",
      assetType: "machine",
    },
  });
  assert.equal(assetResponse.statusCode, 201);
  const createdAssetId = assetResponse.json().id as string;
  assetId = createdAssetId;

  return { app, prefix, sourceId: createdSourceId, assetId: createdAssetId };
}

function validEvent(sourceId: string, assetId: string, deduplicationKey: string) {
  return {
    sourceId,
    assetId,
    sourceRecordId: "controller-event-019",
    eventType: "alarm.raised",
    occurredAt: "2026-10-27T16:15:30.123456+02:00",
    sourceTimestamp: "2026-10-27T16:15:30.123456+02:00",
    deduplicationKey,
    payload: {
      alarm: { code: "E-19", severity: 3 },
      unrecognizedField: { vendorValue: "preserved" },
      samples: [1, 2, 3],
    },
    provenance: {
      controller: "press-02",
      signal: "high_pressure",
      timestampFormat: "vendor-local-offset",
    },
  };
}

test(
  "valid event ingestion persists payload, normalized time, and source provenance",
  { skip: !databaseUrl },
  async (context) => {
    const { app, sourceId, assetId, prefix } = await createFixture(context);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      payload: validEvent(sourceId, assetId, `${prefix}-dedupe`),
    });

    assert.equal(response.statusCode, 201);
    const created = response.json();
    assert.equal(created.duplicate, false);
    assert.equal(created.event.source.id, sourceId);
    assert.equal(created.event.asset.id, assetId);
    assert.equal(created.event.sourceRecordId, "controller-event-019");
    assert.equal(created.event.sourceTimestamp, "2026-10-27T16:15:30.123456+02:00");
    assert.equal(created.event.occurredAt, "2026-10-27T14:15:30.123456Z");
    assert.deepEqual(created.event.payload.unrecognizedField, { vendorValue: "preserved" });
    assert.deepEqual(created.event.provenance, {
      controller: "press-02",
      signal: "high_pressure",
      timestampFormat: "vendor-local-offset",
    });
    assert.ok(Number.isFinite(Date.parse(created.event.ingestedAt)));

    const unlinkedResponse = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      payload: {
        ...validEvent(sourceId, assetId, `${prefix}-unlinked`),
        assetId: undefined,
        sourceRecordId: "controller-event-unlinked",
      },
    });
    assert.equal(unlinkedResponse.statusCode, 201);
    assert.equal(unlinkedResponse.json().event.asset, null);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/events/${created.event.id}`,
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().id, created.event.id);
    assert.equal(detail.json().source.id, sourceId);
    assert.equal(detail.json().asset.id, assetId);
    assert.deepEqual(detail.json().payload, created.event.payload);

    const list = await app.inject({
      method: "GET",
      url:
        `/api/v1/events?sourceId=${sourceId}&assetId=${assetId}` +
        "&eventType=alarm.raised&from=2026-10-27T14%3A00%3A00Z&to=2026-10-27T14%3A30%3A00Z",
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().total, 1);
    assert.equal(list.json().items[0].id, created.event.id);
    assert.equal("payload" in list.json().items[0], false);

    const unfilteredList = await app.inject({
      method: "GET",
      url: `/api/v1/events?sourceId=${sourceId}`,
    });
    assert.equal(unfilteredList.statusCode, 200);
    assert.equal(unfilteredList.json().total, 2);
    assert.deepEqual(
      new Set(unfilteredList.json().items.map((item: { id: string }) => item.id)),
      new Set([created.event.id, unlinkedResponse.json().event.id]),
    );

    const missingDetail = await app.inject({
      method: "GET",
      url: "/api/v1/events/00000000-0000-4000-8000-000000000000",
    });
    assert.equal(missingDetail.statusCode, 404);
    assert.equal(missingDetail.json().error.code, "NOT_FOUND");
  },
);

test(
  "malformed timestamps and unregistered source or asset references are rejected",
  { skip: !databaseUrl },
  async (context) => {
    const { app, sourceId, assetId, prefix } = await createFixture(context);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      payload: { ...validEvent(sourceId, assetId, `${prefix}-bad-time`), occurredAt: "2026-02-30T12:00:00Z" },
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error.fields.occurredAt, "Enter a real calendar date and time.");

    const missingSource = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      payload: { ...validEvent(sourceId, assetId, `${prefix}-bad-source`), sourceId: randomUUID() },
    });
    assert.equal(missingSource.statusCode, 400);
    assert.equal(missingSource.json().error.code, "INVALID_REFERENCE");

    const missingAsset = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      payload: { ...validEvent(sourceId, assetId, `${prefix}-bad-asset`), assetId: randomUUID() },
    });
    assert.equal(missingAsset.statusCode, 400);
    assert.equal(missingAsset.json().error.fields.assetId, "Choose a registered asset or omit this field.");
  },
);

test(
  "source-scoped deduplication returns identical retries and rejects key reuse with changed content",
  { skip: !databaseUrl },
  async (context) => {
    const { app, sourceId, assetId, prefix } = await createFixture(context);
    const payload = validEvent(sourceId, assetId, `${prefix}-dedupe`);
    const first = await app.inject({ method: "POST", url: "/api/v1/events", payload });
    const retry = await app.inject({ method: "POST", url: "/api/v1/events", payload });

    assert.equal(first.statusCode, 201);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().duplicate, true);
    assert.equal(retry.json().event.id, first.json().event.id);

    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      payload: {
        ...payload,
        payload: { ...payload.payload, unrecognizedField: { vendorValue: "changed" } },
      },
    });
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.json().error.code, "DEDUPLICATION_CONFLICT");

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/events?sourceId=${sourceId}&eventType=alarm.raised`,
    });
    assert.equal(list.json().total, 1);
  },
);
