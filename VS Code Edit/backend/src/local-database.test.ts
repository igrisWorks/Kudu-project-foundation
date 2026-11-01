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
    ssl: false,
  }), {
    host: "127.0.0.1",
    port: 5432,
    database: "kudu",
    username: "kudu_app",
    password: "",
    ssl: false,
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

test("Docker local mode accepts explicit PostgreSQL network names but rejects wildcard binds", () => {
  assert.equal(validateLocalDatabaseSettings({
    host: "db",
    port: 5432,
    database: "kudu",
    username: "kudu_app",
    password: "a-local-only-password",
  }, { allowRemoteHosts: true }).host, "db");
  assert.equal(validateLocalDatabaseSettings({
    host: "host.docker.internal",
    port: 5432,
    database: "kudu",
    username: "kudu_app",
    password: "a-local-only-password",
  }, { allowRemoteHosts: true }).host, "host.docker.internal");
  assert.throws(() => validateLocalDatabaseSettings({
    host: "0.0.0.0",
    port: 5432,
    database: "kudu",
    username: "kudu_app",
    password: "a-local-only-password",
  }, { allowRemoteHosts: true }), /valid PostgreSQL hostname or IP/);
  assert.throws(() => validateLocalDatabaseSettings({
    host: "db/path",
    port: 5432,
    database: "kudu",
    username: "kudu_app",
    password: "a-local-only-password",
  }, { allowRemoteHosts: true }), /valid PostgreSQL hostname or IP/);
});

test("database URL parsing decodes credentials without exposing them in returned safe form", () => {
  const settings = settingsFromDatabaseUrl("postgresql://kudu_user:p%40ss%3Aword@localhost:5433/kudu");
  assert.deepEqual(settings, {
    host: "localhost",
    port: 5433,
    database: "kudu",
    username: "kudu_user",
    password: "p@ss:word",
    ssl: false,
  });
});

test("database URL parsing supports verified TLS modes", () => {
  assert.equal(
    settingsFromDatabaseUrl("postgresql://kudu_user:secret@localhost:5432/kudu?sslmode=verify-full").ssl,
    true,
  );
  assert.equal(
    settingsFromDatabaseUrl("postgresql://kudu_user:secret@localhost:5432/kudu?sslmode=disable").ssl,
    false,
  );
  assert.throws(
    () => settingsFromDatabaseUrl("postgresql://kudu_user:secret@localhost:5432/kudu?sslmode=prefer"),
    /sslmode must be/,
  );
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

test("PostgreSQL and Linux settings-storage errors expose safe actionable codes", () => {
  assert.match(safeLocalDatabaseError(Object.assign(new Error("database operation failed"), {
    code: "XX000",
  })), /error XX000/);
  assert.match(safeLocalDatabaseError(Object.assign(new Error("permission denied"), {
    code: "EACCES",
  })), /settings file/);
  assert.match(safeLocalDatabaseError(Object.assign(new Error("temporary DNS lookup failure"), {
    code: "EAI_AGAIN",
  })), /not reachable/);
  assert.equal(
    safeLocalDatabaseError(new Error("PostgreSQL is not reachable at this address and port. Check that the local service is running.")),
    "PostgreSQL is not reachable at this address and port. Check that the local service is running.",
  );
});
