import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { runMigrations } from "./migration-runner.js";
import { importPostgresLocal } from "./import-postgres-local.js";
import { LocalDatabaseManager } from "./local-database.js";
import { createDatabase } from "./database.js";
import { ingestEvent } from "./events.js";

const sourceUrl = process.env.KUDU_SQLITE_IMPORT_TEST_URL;
test("read-only legacy PostgreSQL import preserves records and rejects a nonempty SQLite target", {
  skip: !sourceUrl,
}, async () => {
  // This variable must point only to a newly created disposable PostgreSQL database.
  const pool = new Pool({ connectionString: sourceUrl });
  const directory = await mkdtemp(join(tmpdir(), "kuduns-pg-import-"));
  try {
    await runMigrations(pool, resolve(import.meta.dirname, "../../database/migrations"));
    const parent = randomUUID(), child = randomUUID(), source = randomUUID(), event = randomUUID(), mapping = randomUUID();
    await pool.query("INSERT INTO kudu.assets (id,asset_key,name,asset_type) VALUES ($1,'line','Line','production_line')", [parent]);
    await pool.query("INSERT INTO kudu.assets (id,asset_key,name,asset_type,parent_asset_id) VALUES ($1,'sensor','Sensor','sensor',$2)", [child, parent]);
    await pool.query(`INSERT INTO kudu.data_sources (id,source_key,display_name,source_type,configuration)
      VALUES ($1,'legacy-json','Legacy JSON','json_file','{"kind":"json_file","relativePath":"readings.json"}')`, [source]);
    await pool.query(`INSERT INTO kudu.events (id,source_id,asset_id,event_type,occurred_at,source_timestamp,payload,provenance)
      VALUES ($1,$2,$3,'measurement','2026-11-01T12:00:00.123456Z','original','{"value":42}','{"imported":true}')`, [event, source, child]);
    await pool.query(`INSERT INTO kudu.data_source_event_mappings (id,source_id,version,definition)
      VALUES ($1,$2,1,'{"eventType":"type","occurredAt":"time"}')`, [mapping, source]);
    const serverDatabase = createDatabase(sourceUrl!);
    try {
      const input = {
        sourceId: source, assetId: child, eventType: "server-regression",
        occurredAt: "2026-11-01T12:00:00Z", payload: { server: true }, deduplicationKey: "server-one",
      };
      assert.equal((await ingestEvent(serverDatabase.db, input)).duplicate, false);
      assert.equal((await ingestEvent(serverDatabase.db, input)).duplicate, true);
    } finally { await serverDatabase.close(); }
    await pool.query("CREATE ROLE kudu_import_reader LOGIN PASSWORD 'disposable-test-only'");
    await pool.query("GRANT USAGE ON SCHEMA kudu TO kudu_import_reader");
    await pool.query("GRANT SELECT ON ALL TABLES IN SCHEMA kudu TO kudu_import_reader");
    await pool.query("ALTER ROLE kudu_import_reader SET default_transaction_read_only = on");
    const reader = new URL(sourceUrl!);
    reader.username = "kudu_import_reader";
    reader.password = "disposable-test-only";
    const imported = await importPostgresLocal(reader.toString(), directory);
    assert.deepEqual(imported.imported, { assets: 2, data_sources: 1, events: 2, data_source_event_mappings: 1 });
    const manager = await LocalDatabaseManager.create(directory);
    try {
      const stored = await manager.db.selectFrom("events").selectAll().where("id", "=", event).executeTakeFirstOrThrow();
      assert.equal(stored.id, event);
      assert.equal(stored.asset_id, child);
      assert.equal(stored.occurred_at as unknown, "2026-11-01T12:00:00.123456Z");
      assert.deepEqual(stored.payload, { value: 42 });
    } finally { await manager.close(); }
    await assert.rejects(() => importPostgresLocal(reader.toString(), directory), /already contains application data/);
    assert.equal(Number((await pool.query("SELECT count(*) FROM kudu.events")).rows[0].count), 2);
    assert.equal(Number((await pool.query("SELECT count(*) FROM kudu.assets")).rows[0].count), 2);
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
