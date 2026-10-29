import assert from "node:assert/strict";
import test from "node:test";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { createApp } from "./app.js";
import type { Database } from "./database.js";
import { LocalDatabaseManager } from "./local-database.js";

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

test("local edition session is authenticated without operator credentials and writes require local origin", async context => {
  const db = unusedDatabase();
  const localDatabase = await LocalDatabaseManager.create();
  const app = await createApp({
    db,
    localMode: true,
    localDatabase,
    databaseCheck: async () => undefined,
    logLevel: "silent",
  });
  context.after(async () => {
    await app.close();
    await localDatabase.close();
    await db.destroy();
  });
  app.get("/api/v1/local-test", async () => ({ permitted: true }));

  const session = await app.inject({
    method: "GET",
    url: "/api/v1/auth/session",
    headers: { host: "127.0.0.1:3000" },
  });
  assert.equal(session.statusCode, 200);
  assert.deepEqual(session.json(), { configured: true, authenticated: true, localMode: true });

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
  assert.equal("password" in settingsResponse.json().settings, false);
  assert.equal(settingsResponse.json().status.connected, false);

  const unauthorizedInitialize = await app.inject({
    method: "POST",
    url: "/api/v1/local/database/initialize",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:5173",
    },
    payload: { adminUsername: "postgres", adminPassword: "admin-secret", confirm: false },
  });
  assert.equal(unauthorizedInitialize.statusCode, 400);
  assert.equal(JSON.stringify(unauthorizedInitialize.json()).includes("admin-secret"), false);

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
