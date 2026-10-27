import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { createApp } from "./app.js";
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
        "SELECT name FROM kudu.schema_migrations WHERE name IN ($1, $2) ORDER BY name",
        ["0001_create_kudu_schema.sql", "0002_asset_and_data_source_registries.sql"],
      );
      assert.deepEqual(
        result.rows.map((row) => row.name),
        ["0001_create_kudu_schema.sql", "0002_asset_and_data_source_registries.sql"],
      );
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
    const pool = new Pool({ connectionString: databaseUrl });
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const app = await createApp({ db, logLevel: "silent" });

    context.after(async () => {
      await db
        .deleteFrom("assets")
        .where("asset_key", "=", `${prefix}-child`)
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
    assert.equal(firstPage.statusCode, 200);
    assert.equal(firstPage.json().total, 2);
    assert.equal(firstPage.json().items.length, 1);
    assert.equal(secondPage.json().items.length, 1);
    assert.notEqual(firstPage.json().items[0].id, secondPage.json().items[0].id);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/assets/${parent.id}`,
    });
    assert.equal(detailResponse.json().children[0].id, child.id);

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
  },
);
