import assert from "node:assert/strict";
import test from "node:test";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { createApp } from "./app.js";
import type { Database } from "./database.js";
import { LocalDatabaseManager } from "./local-database.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function unusedDatabase(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ max: 1 }) }),
  });
}

test("health endpoint reports database readiness", async (context) => {
  const db = unusedDatabase();
  const app = await createApp({
    db,
    databaseCheck: async () => undefined,
  });
  context.after(async () => {
    await app.close();
    await db.destroy();
  });

  const response = await app.inject({ method: "GET", url: "/api/v1/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    database: "connected",
    checkedAt: response.json().checkedAt,
  });
  assert.ok(Number.isFinite(Date.parse(response.json().checkedAt)));
});

test("health endpoint returns a safe degraded response when the database is down", async (context) => {
  const db = unusedDatabase();
  const app = await createApp({
    db,
    databaseCheck: async () => {
      throw new Error("private connection details");
    },
  });
  context.after(async () => {
    await app.close();
    await db.destroy();
  });

  const response = await app.inject({ method: "GET", url: "/api/v1/health" });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().status, "degraded");
  assert.equal(response.json().database, "unavailable");
  assert.equal(JSON.stringify(response.json()).includes("private connection details"), false);
});

test("Local database status reports actionable failure text without leaking internal errors", async context => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-local-status-error-"));
  const localDatabase = await LocalDatabaseManager.create(directory);
  Object.defineProperty(localDatabase, "status", {
    value: async () => { throw new Error("private /home/operator/KuduNS/kuduns.db failure detail"); },
  });
  const app = await createApp({
    db: localDatabase.db,
    localMode: true,
    localDatabase,
    logLevel: "silent",
  });
  context.after(async () => {
    await app.close();
    await localDatabase.close();
    await rm(directory, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/local/database",
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(response.statusCode, 503);
  assert.match(response.json().error.message, /KuduNS data folder/);
  assert.equal(JSON.stringify(response.json()).includes("private /home/operator"), false);
});

test("local edition session is authenticated without operator credentials and writes require local origin", async context => {
  const db = unusedDatabase();
  const directory = await mkdtemp(join(tmpdir(), "kuduns-local-origin-"));
  const localDatabase = await LocalDatabaseManager.create(directory);
  const app = await createApp({
    db,
    localMode: true,
    localDocker: true,
    localDatabase,
    databaseCheck: async () => undefined,
    logLevel: "silent",
  });
  context.after(async () => {
    await app.close();
    await localDatabase.close();
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  app.get("/api/v1/local-test", async () => ({ permitted: true }));

  const session = await app.inject({
    method: "GET",
    url: "/api/v1/auth/session",
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(session.statusCode, 200);
  assert.deepEqual(session.json(), {
    configured: true,
    authenticated: true,
    localMode: true,
    localDocker: true,
  });

  const unauthenticatedRead = await app.inject({
    method: "GET",
    url: "/api/v1/local-test",
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(unauthenticatedRead.statusCode, 200);

  const settingsResponse = await app.inject({
    method: "GET",
    url: "/api/v1/local/database",
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(settingsResponse.statusCode, 200);
  assert.equal("password" in settingsResponse.json(), false);
  assert.equal(settingsResponse.json().engine, "SQLite");
  assert.equal(settingsResponse.json().connected, true);

  const unauthorizedInitialize = await app.inject({
    method: "POST",
    url: "/api/v1/local/database/restore",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:5173",
    },
    payload: { backupName: "not-selected.db", confirm: false },
  });
  assert.equal(unauthorizedInitialize.statusCode, 400);
  assert.equal(JSON.stringify(unauthorizedInitialize.json()).includes("adminPassword"), false);

  const crossOriginWrite = await app.inject({
    method: "POST",
    url: "/api/v1/local/database/test",
    headers: { host: "127.0.0.1:3000", origin: "https://attacker.example" },
    payload: {
      host: "127.0.0.1",
      port: 5432,
      database: "kudu",
      username: "kudu",
      password: "do-not-return-this",
    },
  });
  assert.equal(crossOriginWrite.statusCode, 403);
  assert.equal(JSON.stringify(crossOriginWrite.json()).includes("do-not-return-this"), false);

  const nonLoopbackHost = await app.inject({
    method: "GET",
    url: "/api/v1/auth/session",
    headers: { host: "192.0.2.12:3000" },
  });
  assert.equal(nonLoopbackHost.statusCode, 403);
});
