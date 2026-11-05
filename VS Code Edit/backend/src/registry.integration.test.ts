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

test(
  "migrations apply once and remain repeatable",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await runMigrations(pool, migrationsDirectory);
      assert.deepEqual(await runMigrations(pool, migrationsDirectory), []);
      const result = await pool.query<{ name: string }>(
        "SELECT name FROM kudu.schema_migrations WHERE name IN ($1, $2, $3, $4) ORDER BY name",
        [
          "0001_create_kudu_schema.sql",
          "0002_asset_and_data_source_registries.sql",
          "0005_data_source_sync_runs.sql",
          "0006_raw_source_records.sql",
        ],
      );
      assert.deepEqual(
        result.rows.map((row) => row.name),
        [
          "0001_create_kudu_schema.sql",
          "0002_asset_and_data_source_registries.sql",
          "0005_data_source_sync_runs.sql",
          "0006_raw_source_records.sql",
        ],
      );
      const tables = await pool.query<{ legacy: string | null; current: string | null }>(
        "SELECT to_regclass('kudu.data_source_sync_runs')::text AS legacy, to_regclass('kudu.source_sync_runs')::text AS current",
      );
      assert.deepEqual(tables.rows[0], {
        legacy: "data_source_sync_runs",
        current: "source_sync_runs",
      });
      const mappingNullability = await pool.query<{ table_name: string; is_nullable: string }>(
        `SELECT table_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'kudu'
           AND table_name IN ('data_source_sync_runs', 'source_sync_runs')
           AND column_name = 'mapping_version'
         ORDER BY table_name`,
      );
      assert.deepEqual(mappingNullability.rows, [
        { table_name: "data_source_sync_runs", is_nullable: "NO" },
        { table_name: "source_sync_runs", is_nullable: "YES" },
      ]);
    } finally {
      await pool.end();
    }
  },
);

test(
  "registry API persists records, validates hierarchy, paginates, and redacts credentials",
  { skip: !databaseUrl },
  async (context) => {
    const prefix = `kt${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const pool = new Pool({
      connectionString: databaseUrl,
      options: "-c search_path=kudu,public",
    });
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const app = await createAuthenticatedTestApp({ db, logLevel: "silent" });

    context.after(async () => {
      const testSource = await db
        .selectFrom("data_sources")
        .select("id")
        .where("source_key", "=", `${prefix}-source`)
        .executeTakeFirst();
      if (testSource) {
        await db.deleteFrom("events").where("source_id", "=", testSource.id).execute();
      }
      await db
        .deleteFrom("assets")
        .where("asset_key", "=", `${prefix}-child`)
        .execute();
      await db
        .deleteFrom("assets")
        .where("asset_key", "=", `${prefix}-archived-plc`)
        .execute();
      await db
        .deleteFrom("assets")
        .where("asset_key", "=", `${prefix}-parent`)
        .execute();
      await db
        .deleteFrom("data_sources")
        .where("source_key", "=", `${prefix}-source`)
        .execute();
      await app.close();
      await db.destroy();
    });

    await runMigrations(pool, migrationsDirectory);
    const parentResponse = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      payload: {
        assetKey: `${prefix}-parent`,
        name: "Integration test parent",
        assetType: "production_line",
        externalIdentifiers: [{ sourceKey: "erp", externalId: "parent-1" }],
      },
    });
    assert.equal(parentResponse.statusCode, 201);
    const parent = parentResponse.json();

    const duplicateResponse = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      payload: {
        assetKey: `${prefix}-PARENT`,
        name: "Duplicate",
        assetType: "other",
      },
    });
    assert.equal(duplicateResponse.statusCode, 409);
    assert.equal(duplicateResponse.json().error.code, "DUPLICATE_KEY");

    const missingParentResponse = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      payload: {
        assetKey: `${prefix}-missing-parent`,
        name: "Invalid child",
        assetType: "machine",
        parentAssetId: randomUUID(),
      },
    });
    assert.equal(missingParentResponse.statusCode, 400);
    assert.equal(missingParentResponse.json().error.code, "INVALID_PARENT");

    const childResponse = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      payload: {
        assetKey: `${prefix}-child`,
        name: "Integration test child",
        assetType: "plc",
        parentAssetId: parent.id,
      },
    });
    assert.equal(childResponse.statusCode, 201);
    const child = childResponse.json();

    const archivedAssetResponse = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      payload: {
        assetKey: `${prefix}-archived-plc`,
        name: "Integration test archived PLC",
        assetType: "plc",
      },
    });
    assert.equal(archivedAssetResponse.statusCode, 201);
    const archivedAsset = archivedAssetResponse.json();
    const archiveResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/assets/${archivedAsset.id}`,
      payload: { archived: true },
    });
    assert.equal(archiveResponse.statusCode, 200);
    assert.equal(archiveResponse.json().status, "archived");

    const cycleResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/assets/${parent.id}`,
      payload: { parentAssetId: child.id },
    });
    assert.equal(cycleResponse.statusCode, 400);
    assert.equal(cycleResponse.json().error.code, "PARENT_CYCLE");

    const firstPage = await app.inject({
      method: "GET",
      url: `/api/v1/assets?search=${prefix}&status=all&page=1&pageSize=1`,
    });
    const secondPage = await app.inject({
      method: "GET",
      url: `/api/v1/assets?search=${prefix}&status=all&page=2&pageSize=1`,
    });
    const thirdPage = await app.inject({
      method: "GET",
      url: `/api/v1/assets?search=${prefix}&status=all&page=3&pageSize=1`,
    });
    assert.equal(firstPage.statusCode, 200);
    assert.equal(firstPage.json().total, 3);
    assert.equal(firstPage.json().items.length, 1);
    assert.equal(secondPage.json().items.length, 1);
    assert.equal(thirdPage.json().items.length, 1);
    assert.notEqual(firstPage.json().items[0].id, secondPage.json().items[0].id);

    const activePlcResponse = await app.inject({
      method: "GET",
      url: `/api/v1/assets?search=${prefix}&status=active&assetType=plc`,
    });
    assert.equal(activePlcResponse.statusCode, 200);
    assert.equal(activePlcResponse.json().total, 1);
    assert.equal(activePlcResponse.json().items[0].id, child.id);

    const archivedPlcResponse = await app.inject({
      method: "GET",
      url: `/api/v1/assets?search=${prefix}&status=archived&assetType=plc`,
    });
    assert.equal(archivedPlcResponse.statusCode, 200);
    assert.equal(archivedPlcResponse.json().total, 1);
    assert.equal(archivedPlcResponse.json().items[0].id, archivedAsset.id);

    const combinedPageOne = await app.inject({
      method: "GET",
      url: `/api/v1/assets?search=${prefix}&status=all&assetType=plc&page=1&pageSize=1`,
    });
    const combinedPageTwo = await app.inject({
      method: "GET",
      url: `/api/v1/assets?search=${prefix}&status=all&assetType=plc&page=2&pageSize=1`,
    });
    assert.equal(combinedPageOne.json().total, 2);
    assert.equal(combinedPageTwo.json().total, 2);
    assert.deepEqual(
      new Set([combinedPageOne.json().items[0].id, combinedPageTwo.json().items[0].id]),
      new Set([child.id, archivedAsset.id]),
    );

    const emptyAssetsResponse = await app.inject({
      method: "GET",
      url: `/api/v1/assets?search=${prefix}-not-found&status=all`,
    });
    assert.equal(emptyAssetsResponse.statusCode, 200);
    assert.equal(emptyAssetsResponse.json().total, 0);
    assert.deepEqual(emptyAssetsResponse.json().items, []);

    const invalidAssetTypeResponse = await app.inject({
      method: "GET",
      url: `/api/v1/assets?search=${prefix}&status=all&assetType=robot`,
    });
    assert.equal(invalidAssetTypeResponse.statusCode, 400);
    assert.equal(invalidAssetTypeResponse.json().error.code, "INVALID_QUERY");

    const invalidStatusResponse = await app.inject({
      method: "GET",
      url: `/api/v1/assets?search=${prefix}&status=unknown`,
    });
    assert.equal(invalidStatusResponse.statusCode, 400);
    assert.equal(invalidStatusResponse.json().error.code, "INVALID_QUERY");

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/assets/${parent.id}`,
    });
    assert.deepEqual(detailResponse.json().children.map((item: { id: string }) => item.id), [child.id]);

    const archivedDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/assets/${archivedAsset.id}`,
    });
    assert.equal(archivedDetailResponse.statusCode, 200);
    assert.equal(archivedDetailResponse.json().status, "archived");
    assert.ok(archivedDetailResponse.json().archivedAt);

    const missingAssetResponse = await app.inject({
      method: "GET",
      url: "/api/v1/assets/00000000-0000-4000-8000-000000000000",
    });
    assert.equal(missingAssetResponse.statusCode, 404);
    assert.equal(missingAssetResponse.json().error.code, "NOT_FOUND");

    const sourceResponse = await app.inject({
      method: "POST",
      url: "/api/v1/data-sources",
      payload: {
        sourceKey: `${prefix}-source`,
        displayName: "Integration test source",
        sourceType: "rest_api",
        configuration: {
          kind: "rest_api",
          baseUrl: "https://source.example.test/api",
          credentialRef: "env:KUDU_SOURCE_INTEGRATION_TEST_TOKEN",
        },
      },
    });
    assert.equal(sourceResponse.statusCode, 201);
    const source = sourceResponse.json();
    assert.equal(source.configuration.credentialConfigured, true);
    assert.equal(source.connectionStatus, "not_implemented");
    assert.equal(source.ingestionStatus, "not_implemented");
    assert.equal(source.lastSuccessfulSyncAt, null);
    assert.equal(
      JSON.stringify(source).includes("KUDU_SOURCE_INTEGRATION_TEST_TOKEN"),
      false,
    );

    const sourceDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/data-sources/${source.id}`,
    });
    assert.equal(sourceDetailResponse.statusCode, 200);
    assert.equal(sourceDetailResponse.json().id, source.id);

    const missingSourceResponse = await app.inject({
      method: "GET",
      url: "/api/v1/data-sources/00000000-0000-4000-8000-000000000000",
    });
    assert.equal(missingSourceResponse.statusCode, 404);
    assert.equal(missingSourceResponse.json().error.code, "NOT_FOUND");

    const disabledSourceResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/data-sources/${source.id}`,
      payload: { enabled: false },
    });
    assert.equal(disabledSourceResponse.statusCode, 200);
    assert.equal(disabledSourceResponse.json().enabled, false);
    assert.equal(disabledSourceResponse.json().connectionStatus, "not_implemented");

    const unsafeUrlResponse = await app.inject({
      method: "POST",
      url: "/api/v1/data-sources",
      payload: {
        sourceKey: `${prefix}-unsafe-url`,
        displayName: "Unsafe URL",
        sourceType: "rest_api",
        configuration: { kind: "rest_api", baseUrl: "file:///etc/passwd" },
      },
    });
    assert.equal(unsafeUrlResponse.statusCode, 400);

    const unsafePathResponse = await app.inject({
      method: "POST",
      url: "/api/v1/data-sources",
      payload: {
        sourceKey: `${prefix}-unsafe-path`,
        displayName: "Unsafe path",
        sourceType: "csv_file",
        configuration: { kind: "csv_file", relativePath: "../../etc/passwd" },
      },
    });
    assert.equal(unsafePathResponse.statusCode, 400);

    const historicalEventResponse = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      payload: {
        sourceId: source.id,
        assetId: child.id,
        eventType: "machine_fault",
        occurredAt: "2026-11-04T10:00:00Z",
        payload: { faultCode: "F-17", originalText: "Motor overload" },
      },
    });
    assert.equal(historicalEventResponse.statusCode, 201, historicalEventResponse.body);
    const historicalEvent = historicalEventResponse.json().event;

    const removeSourceResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/data-sources/${source.id}`,
    });
    assert.equal(removeSourceResponse.statusCode, 200, removeSourceResponse.body);
    assert.equal(removeSourceResponse.json().outcome, "archived");
    assert.equal(removeSourceResponse.json().preserved.events, 1);
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/data-sources/${source.id}` })).json().enabled, false);
    assert.deepEqual((await app.inject({ method: "GET", url: `/api/v1/events/${historicalEvent.id}` })).json().payload, {
      faultCode: "F-17",
      originalText: "Motor overload",
    });

    const deleteChildResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${child.id}`,
    });
    assert.equal(deleteChildResponse.statusCode, 200, deleteChildResponse.body);
    assert.equal(deleteChildResponse.json().eventsUnassigned, 1);
    const unlinkedEvent = await app.inject({ method: "GET", url: `/api/v1/events/${historicalEvent.id}` });
    assert.equal(unlinkedEvent.statusCode, 200);
    assert.equal(unlinkedEvent.json().asset, null);
    assert.deepEqual(unlinkedEvent.json().payload, { faultCode: "F-17", originalText: "Motor overload" });
    const deleteParentResponse = await app.inject({ method: "DELETE", url: `/api/v1/assets/${parent.id}` });
    assert.equal(deleteParentResponse.statusCode, 200, deleteParentResponse.body);
  },
);
