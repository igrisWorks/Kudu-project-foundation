import assert from "node:assert/strict";
import test from "node:test";
import {
  safeLocalDatabaseError,
  settingsFromDatabaseUrl,
  validateLocalDatabaseSettings,
} from "./local-database.js";

test("local database settings accept loopback addresses and reject remote or malformed targets", () => {
  assert.deepEqual(validateLocalDatabaseSettings({
    host: "127.0.0.1",
    port: 5432,
    database: "kudu",
    username: "kudu_app",
    password: "",
  }), {
    host: "127.0.0.1",
    port: 5432,
    database: "kudu",
    username: "kudu_app",
    password: "",
  });
  assert.throws(() => validateLocalDatabaseSettings({
    host: "db.example.test",
    port: 5432,
    database: "kudu",
    username: "kudu",
    password: "secret",
  }), /loopback address/);
  assert.throws(() => validateLocalDatabaseSettings({
    host: "127.0.0.1",
    port: 70000,
    database: "kudu",
    username: "kudu",
    password: "secret",
  }), /port must be an integer/);
  assert.throws(() => validateLocalDatabaseSettings({
    host: "127.0.0.1",
    port: 5432,
    database: "kudu; DROP DATABASE postgres",
    username: "kudu",
    password: "secret",
  }), /Database name/);
});

test("database URL parsing decodes credentials without exposing them in returned safe form", () => {
  const settings = settingsFromDatabaseUrl("postgresql://kudu_user:p%40ss%3Aword@localhost:5433/kudu");
  assert.deepEqual(settings, {
    host: "localhost",
    port: 5433,
    database: "kudu",
    username: "kudu_user",
    password: "p@ss:word",
  });
});

test("authentication failures are redacted in database diagnostics", () => {
  const failure = Object.assign(
    new Error('password authentication failed for user "kudu" with password "private-value"'),
    { code: "28P01" },
  );
  const message = safeLocalDatabaseError(failure);
  assert.match(message, /rejected these credentials/);
  assert.equal(message.includes("private-value"), false);
});
