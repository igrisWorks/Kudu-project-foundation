import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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

test("requires valid authentication and secure cookies in production", () => {
  const validHash = `scrypt$16384$8$1$${randomBytes(16).toString("base64url")}$${randomBytes(32).toString("base64url")}`;
  const productionConfig = {
    DATABASE_URL: "postgresql://localhost/kudu",
    NODE_ENV: "production",
    KUDU_AUTH_PASSWORD_HASH: validHash,
    SESSION_SECRET: randomBytes(32).toString("base64url"),
  };

  assert.throws(
    () => loadConfig({ DATABASE_URL: productionConfig.DATABASE_URL, NODE_ENV: "production" }),
    /valid KUDU_AUTH_PASSWORD_HASH and a SESSION_SECRET/,
  );
  assert.throws(
    () => loadConfig({ ...productionConfig, KUDU_AUTH_PASSWORD_HASH: "invalid" }),
    /valid KUDU_AUTH_PASSWORD_HASH and a SESSION_SECRET/,
  );
  assert.throws(
    () => loadConfig({ ...productionConfig, KUDU_COOKIE_SECURE: "false" }),
    /KUDU_COOKIE_SECURE must be true in production/,
  );
  assert.equal(loadConfig(productionConfig).auth.cookieSecure, true);
});
