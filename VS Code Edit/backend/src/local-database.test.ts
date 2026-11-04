import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalDatabaseManager } from "./local-database.js";
import { localDataDirectory, runSqliteMigrations } from "./sqlite-database.js";
import BetterSqlite3 from "better-sqlite3";

test("Local SQLite initializes, preserves typed values, backs up, restores and survives reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-sqlite-"));
  let manager = await LocalDatabaseManager.create(directory);
  try {
    const sourceId = randomUUID();
    await manager.db.insertInto("data_sources").values({
      id: sourceId,
      source_key: "local-source",
      display_name: "Local source",
      source_type: "manual",
      description: null,
      configuration: JSON.stringify({ kind: "manual" }),
      enabled: true,
      last_successful_sync_at: null,
      last_error_summary: null,
    }).execute();
    const source = await manager.db.selectFrom("data_sources").selectAll().executeTakeFirstOrThrow();
    assert.equal(source.enabled, true);
    assert.deepEqual(source.configuration, { kind: "manual" });
    assert.ok(source.created_at instanceof Date);
    assert.equal((await manager.status()).integrity, "ok");
    assert.equal((await manager.status()).schemaVersion, "0002");
    const backup = await manager.createBackup();
    await manager.db.updateTable("data_sources").set({ display_name: "Changed", enabled: false }).execute();
    assert.equal((await manager.db.selectFrom("data_sources").select("enabled").executeTakeFirstOrThrow()).enabled, false);
    await manager.restoreBackup(backup.fileName);
    assert.equal((await manager.db.selectFrom("data_sources").select("display_name").executeTakeFirstOrThrow()).display_name, "Local source");
    await manager.close();
    manager = await LocalDatabaseManager.create(directory);
    assert.equal((await manager.db.selectFrom("data_sources").select("id").executeTakeFirstOrThrow()).id, sourceId);
    assert.equal((await manager.status()).migrationState, "current");
    await assert.rejects(() => manager.restoreBackup("../not-a-backup.db"), /Choose a backup/);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Local data paths use operating-system user data locations", () => {
  assert.equal(localDataDirectory("linux", {}, "/home/example"), "/home/example/.local/share/KuduNS");
  assert.equal(localDataDirectory("linux", { XDG_DATA_HOME: "/data" }, "/home/example"), "/data/KuduNS");
  assert.equal(localDataDirectory("darwin", {}, "/Users/example"), "/Users/example/Library/Application Support/KuduNS");
  assert.throws(() => localDataDirectory("linux", { KUDU_DATA_DIR: "./relative" }), /absolute/);
});

test("applied SQLite migrations reject changed checksums without resetting data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-migrations-"));
  const raw = new BetterSqlite3(":memory:");
  try {
    const migration = join(directory, "0001_example.sql");
    await writeFile(migration, "CREATE TABLE preserved (value TEXT);");
    await runSqliteMigrations(raw, directory);
    raw.prepare("INSERT INTO preserved VALUES (?)").run("keep");
    await writeFile(migration, "CREATE TABLE preserved (changed TEXT);");
    await assert.rejects(() => runSqliteMigrations(raw, directory), /checksum|changed/i);
    assert.deepEqual(raw.prepare("SELECT value FROM preserved").get(), { value: "keep" });
  } finally { raw.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an inaccessible data directory fails rather than resetting or using a different location", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-permissions-"));
  const locked = join(directory, "locked");
  await mkdir(locked, { mode: 0o500 });
  try {
    await assert.rejects(() => LocalDatabaseManager.create(join(locked, "data")), /EACCES|permission denied/i);
  } finally {
    await chmod(locked, 0o700);
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore drains active writes and rejects an incompatible backup without changing current data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-restore-"));
  const manager = await LocalDatabaseManager.create(directory);
  try {
    const backup = await manager.createBackup();
    assert.equal(manager.tryBeginMutation(), true);
    const restoring = manager.restoreBackup(backup.fileName);
    assert.equal(manager.tryBeginMutation(), false);
    manager.endMutation();
    await restoring;
    assert.equal(manager.tryBeginMutation(), true);
    manager.endMutation();
    const altered = new BetterSqlite3(backup.filePath);
    altered.exec("UPDATE app_schema_migrations SET checksum='incompatible'");
    altered.close();
    await assert.rejects(() => manager.restoreBackup(backup.fileName), /different application schema/);
    assert.equal((await manager.status()).integrity, "ok");
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
