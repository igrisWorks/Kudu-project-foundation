import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

test("loads a valid PostgreSQL URL and applies local defaults", () => {
  assert.deepEqual(
    loadConfig({ DATABASE_URL: "postgresql://localhost/kudu" }),
    {
      databaseUrl: "postgresql://localhost/kudu",
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      auth: {
        passwordHash: undefined,
        sessionSecret: undefined,
        cookieSecure: true,
      },
    },
  );
});

test("rejects missing or invalid database configuration", () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL is required/);
  assert.throws(
    () => loadConfig({ DATABASE_URL: "mysql://localhost/kudu" }),
    /must use the postgres/,
  );
});

test("rejects invalid port values", () => {
  assert.throws(
    () => loadConfig({ DATABASE_URL: "postgres://localhost/kudu", PORT: "70000" }),
    /PORT must be an integer/,
  );
});

test("loads auth settings without supplying a default password", () => {
  assert.deepEqual(
    loadConfig({
      DATABASE_URL: "postgres://localhost/kudu",
      KUDU_AUTH_PASSWORD_HASH: "scrypt$hash",
      SESSION_SECRET: "operator-configured-session-secret-value",
      KUDU_COOKIE_SECURE: "false",
    }).auth,
    {
      passwordHash: "scrypt$hash",
      sessionSecret: "operator-configured-session-secret-value",
      cookieSecure: false,
    },
  );
  assert.throws(
    () => loadConfig({ DATABASE_URL: "postgres://localhost/kudu", KUDU_COOKIE_SECURE: "maybe" }),
    /KUDU_COOKIE_SECURE must be true or false/,
  );
});
