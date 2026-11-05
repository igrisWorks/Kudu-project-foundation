import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  if (!databaseUrl) throw new Error("KUDU_TEST_DATABASE_URL is required for file import integration tests.");
  const prefix = `ki${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const importDirectory = await mkdtemp(join(tmpdir(), "kudu-file-import-"));
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(pool, migrationsDirectory);
  const app = await createAuthenticatedTestApp({ db, importDirectory, logLevel: "silent" });
  const sourceIds: string[] = [];
  const assetIds: string[] = [];

  context.after(async () => {
    if (sourceIds.length) {
      await db.deleteFrom("source_records").where("source_id", "in", sourceIds).execute();
      await db.deleteFrom("events").where("source_id", "in", sourceIds).execute();
      await db.deleteFrom("data_sources").where("id", "in", sourceIds).execute();
    }
    if (assetIds.length) {
      await db.deleteFrom("assets").where("id", "in", assetIds).execute();
    }
    await app.close();
    await db.destroy();
    await rm(importDirectory, { recursive: true, force: true });
  });

  async function addSource(
    sourceType: "csv_file" | "json_file" | "manual",
    relativePath: string,
    enabled = true,
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/data-sources",
      payload: {
        sourceKey: `${prefix}-${sourceIds.length + 1}`,
        displayName: "File import integration source",
        sourceType,
        configuration:
          sourceType === "manual"
            ? { kind: "manual" }
            : { kind: sourceType, relativePath },
        enabled,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json().id as string;
    sourceIds.push(id);
    return id;
  }

  async function addAsset(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      payload: {
        assetKey: `${prefix}-asset`,
        name: "File import test asset",
        assetType: "machine",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json().id as string;
    assetIds.push(id);
    return id;
  }

  return { app, importDirectory, addAsset, addSource };
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function csvRow(values: string[]): string {
  return values.map(csvCell).join(",");
}

test(
  "CSV import preserves raw fields, avoids guessed asset links, and skips identical re-imports",
  { skip: !databaseUrl },
  async (context) => {
    const { app, importDirectory, addAsset, addSource } = await createFixture(context);
    const relativePath = "plant/events.csv";
    const sourceId = await addSource("csv_file", relativePath);
    const assetId = await addAsset();
    await mkdir(join(importDirectory, "plant"), { recursive: true });
    const contents = [
      ["eventType", "occurredAt", "assetId", "sourceRecordId", "payload", "machineLabel"],
      ["alarm.raised", "2026-10-27T12:00:00.123456Z", assetId, "csv-row-01", JSON.stringify({ code: "E-01" }), "press-7"],
      ["counter.reading", "2026-10-27T12:01:00Z", "", "", JSON.stringify({ count: 12 }), "press-8"],
    ].map(csvRow).join("\r\n");
    await writeFile(join(importDirectory, relativePath), contents, "utf8");

    const first = await app.inject({ method: "POST", url: `/api/v1/data-sources/${sourceId}/import` });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(
      {
        records: first.json().records,
        imported: first.json().imported,
        skipped: first.json().skipped,
        failed: first.json().failed,
      },
      { records: 2, imported: 2, skipped: 0, failed: 0 },
    );
    assert.equal(JSON.stringify(first.json()).includes(importDirectory), false);

    const retry = await app.inject({ method: "POST", url: `/api/v1/data-sources/${sourceId}/import` });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(
      {
        records: retry.json().records,
        imported: retry.json().imported,
        skipped: retry.json().skipped,
        failed: retry.json().failed,
      },
      { records: 2, imported: 0, skipped: 2, failed: 0 },
    );

    const list = await app.inject({ method: "GET", url: `/api/v1/events?sourceId=${sourceId}` });
    assert.equal(list.json().total, 2);
    const event = list.json().items.find((item: { eventType: string }) => item.eventType === "alarm.raised");
    assert.ok(event, JSON.stringify(list.json().items));
    assert.equal(event.asset?.id, undefined, "a source asset identifier is not linked without an approved mapping");
    const rawList = await app.inject({ method: "GET", url: `/api/v1/explorer/records?sourceId=${sourceId}` });
    const rawDetails = await Promise.all(rawList.json().items.map((item: { id: string }) =>
      app.inject({ method: "GET", url: `/api/v1/explorer/records/${item.id}` })));
    const rawDetail = rawDetails.find(item => item.json().rawRecord.sourceRecordId === "csv-row-01");
    assert.ok(rawDetail, "the source-specific identifier remains in the original CSV record");
    assert.equal(rawDetail.json().rawRecord.assetId, assetId);
    const detail = await app.inject({ method: "GET", url: `/api/v1/events/${event.id}` });
    assert.deepEqual(detail.json().payload, { code: "E-01", machineLabel: "press-7" });
  },
);

test(
  "JSON import preserves malformed and unmapped records without inventing event timestamps",
  { skip: !databaseUrl },
  async (context) => {
    const { app, importDirectory, addSource } = await createFixture(context);
    const relativePath = "records.json";
    const sourceId = await addSource("json_file", relativePath);
    await writeFile(
      join(importDirectory, relativePath),
      JSON.stringify([
        {
          eventType: "state.changed",
          occurredAt: "2026-10-27T12:00:00Z",
          sourceRecordId: "json-row-01",
          payload: { state: "ready" },
          vendorCode: "V-42",
        },
        {
          eventType: "state.changed",
          occurredAt: "not-a-timestamp",
          sourceRecordId: "json-row-02",
          payload: { state: "unknown" },
        },
        {
          eventType: "state.changed",
          occurredAt: "2026-10-27T12:02:00Z",
          sourceRecordId: "json-row-03",
          payload: ["not", "an", "object"],
        },
      ]),
      "utf8",
    );

    const response = await app.inject({ method: "POST", url: `/api/v1/data-sources/${sourceId}/import` });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      {
        records: response.json().records,
        imported: response.json().imported,
        skipped: response.json().skipped,
        failed: response.json().failed,
      },
      { records: 3, imported: 3, skipped: 0, failed: 0 },
    );
    assert.deepEqual(response.json().errors, []);

    const list = await app.inject({ method: "GET", url: `/api/v1/events?sourceId=${sourceId}` });
    assert.equal(list.json().total, 0, "a mixed timestamp sample is not automatically normalized");
    const rawList = await app.inject({ method: "GET", url: `/api/v1/explorer/records?sourceId=${sourceId}` });
    assert.equal(rawList.json().total, 3);
    const detailForRecord = async (sourceRecordId: string) => {
      const item = rawList.json().items.find((candidate: { sourceRecordId: string }) => candidate.sourceRecordId === sourceRecordId);
      assert.ok(item, `raw record ${sourceRecordId} should remain explorable`);
      return app.inject({ method: "GET", url: `/api/v1/explorer/records/${item.id}` });
    };
    const first = await detailForRecord("json-row-01");
    assert.ok(rawList.json().items.some((item: { sourceRecordId: string }) => item.sourceRecordId === "json-row-02"));
    const malformed = await detailForRecord("json-row-02");
    assert.equal(malformed.json().rawRecord.occurredAt, "not-a-timestamp");
    assert.deepEqual(first.json().rawRecord.vendorCode, "V-42");
    assert.deepEqual((await detailForRecord("json-row-03")).json().rawRecord.payload, ["not", "an", "object"]);
  },
);

test(
  "file import rejects disabled or unsupported sources, arbitrary request paths, and symlink escapes",
  { skip: !databaseUrl },
  async (context) => {
    const { app, importDirectory, addSource } = await createFixture(context);
    const enabledId = await addSource("csv_file", "linked.csv");
    const disabledId = await addSource("json_file", "disabled.json", false);
    const manualId = await addSource("manual", "");
    const outsideDirectory = await mkdtemp(join(tmpdir(), "kudu-import-outside-"));
    const outsideFile = join(outsideDirectory, "outside.csv");
    await writeFile(outsideFile, "private path data", "utf8");
    await symlink(outsideFile, join(importDirectory, "linked.csv"));
    context.after(() => rm(outsideDirectory, { recursive: true, force: true }));

    const traversal = await app.inject({
      method: "POST",
      url: `/api/v1/data-sources/${enabledId}/import`,
      payload: { relativePath: "../../etc/passwd" },
    });
    assert.equal(traversal.statusCode, 400);
    assert.equal(traversal.json().error.code, "IMPORT_BODY_NOT_ALLOWED");

    const symlinkEscape = await app.inject({
      method: "POST",
      url: `/api/v1/data-sources/${enabledId}/import`,
    });
    assert.equal(symlinkEscape.statusCode, 400);
    assert.equal(symlinkEscape.json().error.code, "IMPORT_PATH_INVALID");
    assert.equal(JSON.stringify(symlinkEscape.json()).includes(outsideDirectory), false);

    const disabled = await app.inject({
      method: "POST",
      url: `/api/v1/data-sources/${disabledId}/import`,
    });
    assert.equal(disabled.statusCode, 409);
    assert.equal(disabled.json().error.code, "SOURCE_DISABLED");

    const unsupported = await app.inject({
      method: "POST",
      url: `/api/v1/data-sources/${manualId}/import`,
    });
    assert.equal(unsupported.statusCode, 400);
    assert.equal(unsupported.json().error.code, "UNSUPPORTED_SOURCE_TYPE");
  },
);

test(
  "malformed and over-limit files are rejected before any event is ingested",
  { skip: !databaseUrl },
  async (context) => {
    const { app, importDirectory, addSource } = await createFixture(context);
    const relativePath = "limits.json";
    const sourceId = await addSource("json_file", relativePath);
    const filePath = join(importDirectory, relativePath);

    await writeFile(filePath, "[{\"eventType\":\"broken\"", "utf8");
    const malformed = await app.inject({ method: "POST", url: `/api/v1/data-sources/${sourceId}/import` });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error.code, "INVALID_IMPORT_FILE");

    await writeFile(filePath, JSON.stringify(Array.from({ length: 1_001 }, () => ({}))), "utf8");
    const tooManyRecords = await app.inject({ method: "POST", url: `/api/v1/data-sources/${sourceId}/import` });
    assert.equal(tooManyRecords.statusCode, 413);
    assert.equal(tooManyRecords.json().error.code, "IMPORT_RECORD_LIMIT");

    await writeFile(filePath, Buffer.alloc(5 * 1024 * 1024 + 1, 32));
    const tooLarge = await app.inject({ method: "POST", url: `/api/v1/data-sources/${sourceId}/import` });
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(tooLarge.json().error.code, "IMPORT_FILE_TOO_LARGE");
  },
);
