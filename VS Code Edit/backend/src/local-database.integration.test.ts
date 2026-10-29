import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import test from "node:test";
import { LocalDatabaseManager, type LocalDatabaseSettings } from "./local-database.js";

const adminUrl = process.env.KUDU_LOCAL_DATABASE_TEST_URL;
const enabled = Boolean(adminUrl);

test("disposable PostgreSQL provisions a least-privilege role and applies migrations", {
  skip: !enabled && "Set KUDU_LOCAL_DATABASE_TEST_URL to a disposable loopback PostgreSQL instance.",
}, async () => {
  const parsed = new URL(adminUrl!);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  assert.ok(["127.0.0.1", "::1", "localhost"].includes(host), "integration tests require loopback PostgreSQL");
  assert.equal(parsed.pathname, "/postgres", "integration tests must use the maintenance database");
  assert.match(username, /^kudu_disposable_[a-z0-9_]+$/i, "use a disposable-only PostgreSQL administrator");
  assert.ok(password.length >= 12, "the disposable administrator must use a test-only password");

  const token = randomUUID().replaceAll("-", "").slice(0, 18);
  const databaseName = `kudu_disposable_${token}`;
  const applicationRole = `kudu_disposable_${token}_app`;
  const applicationPassword = `disposable_app_${token}_password`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "kudu-local-db-test-"));
  const previousSettingsPath = process.env.KUDU_LOCAL_DATABASE_SETTINGS_PATH;
  process.env.KUDU_LOCAL_DATABASE_SETTINGS_PATH = join(temporaryDirectory, "settings.json");

  const admin = new Pool({
    host,
    port: Number(parsed.port || 5432),
    database: "postgres",
    user: username,
    password,
  });
  let manager: LocalDatabaseManager | undefined;
  let provisioningAttempted = false;
  try {
    await admin.query("SELECT 1");
    const existing = await admin.query(
      "SELECT (SELECT count(*) FROM pg_database WHERE datname = $1) AS databases, " +
        "(SELECT count(*) FROM pg_roles WHERE rolname = $2) AS roles",
      [databaseName, applicationRole],
    );
    assert.equal(Number(existing.rows[0].databases), 0);
    assert.equal(Number(existing.rows[0].roles), 0);

    const settings: LocalDatabaseSettings = {
      host,
      port: Number(parsed.port || 5432),
      database: databaseName,
      username: applicationRole,
      password: applicationPassword,
    };
    manager = await LocalDatabaseManager.create(undefined, { allowRemoteHosts: true });
    provisioningAttempted = true;
    await manager.initializeMissingObjects(settings, username, password);

    const status = await manager.status();
    assert.equal(status.status.connected, true);
    assert.equal(status.status.migrationState, "current");
    assert.equal(status.settings.passwordConfigured, true);
    assert.equal("password" in status.settings, false);
    assert.equal((await stat(process.env.KUDU_LOCAL_DATABASE_SETTINGS_PATH)).mode & 0o777, 0o600);

    const appPool = new Pool({
      host,
      port: settings.port,
      database: databaseName,
      user: applicationRole,
      password: applicationPassword,
    });
    try {
      const privileges = await appPool.query(
        "SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, " +
          "has_database_privilege(current_user, current_database(), 'CREATE') AS database_create " +
          "FROM pg_roles r WHERE r.rolname = current_user",
      );
      assert.deepEqual(privileges.rows[0], {
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        database_create: false,
      });
      const migrations = await appPool.query("SELECT count(*)::int AS count FROM kudu.schema_migrations");
      assert.ok(migrations.rows[0].count > 0, "migrations must have run as the application role");
    } finally {
      await appPool.end();
    }
  } finally {
    await manager?.close();
    if (provisioningAttempted) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS "${applicationRole}"`);
    }
    await admin.end();
    if (previousSettingsPath === undefined) delete process.env.KUDU_LOCAL_DATABASE_SETTINGS_PATH;
    else process.env.KUDU_LOCAL_DATABASE_SETTINGS_PATH = previousSettingsPath;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
