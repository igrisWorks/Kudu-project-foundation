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
      localMode: false,
    localDesktop: false,
      localDocker: false,
      localDockerPort: 3000,
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

test("local mode does not require database or operator authentication configuration", () => {
  assert.deepEqual(loadConfig({ KUDU_LOCAL_MODE: "true" }), {
    host: "127.0.0.1",
    port: 3000,
    logLevel: "info",
    auth: {
      passwordHash: undefined,
      sessionSecret: undefined,
      cookieSecure: true,
    },
    localMode: true,
    localDesktop: false,
    localDocker: false,
    localDockerPort: 3000,
  });
});

test("Local ignores legacy PostgreSQL URLs and Desktop remains an explicit loopback-only edition", () => {
  const local = loadConfig({ KUDU_LOCAL_MODE: "true", DATABASE_URL: "postgresql://unused/legacy" });
  assert.equal(local.databaseUrl, undefined);
  const desktop = loadConfig({ KUDU_LOCAL_MODE: "true", KUDU_LOCAL_DESKTOP: "true", NODE_ENV: "production", PORT: "0" });
  assert.equal(desktop.host, "127.0.0.1");
  assert.equal(desktop.port, 0);
  assert.throws(() => loadConfig({ KUDU_LOCAL_DESKTOP: "true" }), /requires/);
  assert.throws(() => loadConfig({ KUDU_LOCAL_MODE: "true", KUDU_LOCAL_DESKTOP: "true", KUDU_LOCAL_DOCKER: "true" }), /cannot be enabled together/);
});

test("Docker local mode requires explicit no-login mode and a separate proxy port", () => {
  const config = loadConfig({
    KUDU_LOCAL_MODE: "true",
    KUDU_LOCAL_DOCKER: "true",
    PORT: "3001",
    KUDU_LOCAL_DOCKER_PORT: "3000",
    NODE_ENV: "development",
  });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3001);
  assert.equal(config.localDocker, true);
  assert.equal(config.localDockerPort, 3000);
  assert.throws(
    () => loadConfig({ KUDU_LOCAL_DOCKER: "true" }),
    /requires KUDU_LOCAL_MODE=true/,
  );
  assert.throws(
    () => loadConfig({
      KUDU_LOCAL_MODE: "true",
      KUDU_LOCAL_DOCKER: "true",
      PORT: "3000",
      KUDU_LOCAL_DOCKER_PORT: "3000",
    }),
    /must differ from the loopback API port/,
  );
});

test("local no-login mode fails closed in production and on non-loopback binds", () => {
  assert.throws(
    () => loadConfig({ KUDU_LOCAL_MODE: "true", NODE_ENV: "production" }),
    /only available outside production/,
  );
  assert.throws(
    () => loadConfig({ KUDU_LOCAL_MODE: "true", HOST: "0.0.0.0" }),
    /requires HOST to be loopback/,
  );
  assert.throws(
    () => loadConfig({ KUDU_LOCAL_MODE: "yes" }),
    /KUDU_LOCAL_MODE must be true or false/,
  );
});
