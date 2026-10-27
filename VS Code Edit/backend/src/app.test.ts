import assert from "node:assert/strict";
import test from "node:test";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { createApp } from "./app.js";
import type { Database } from "./database.js";

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
