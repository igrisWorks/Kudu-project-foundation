"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { runtimeEnvironment, runtimePaths } = require("./local-runtime.cjs");

test("desktop Local uses an owned loopback backend and Electron userData, not PostgreSQL credentials", () => {
  const env = runtimeEnvironment("/user/KuduNS", { frontend: "/bundle/frontend", migrations: "/bundle/migrations" }, {
    DATABASE_URL: "postgres://unused", SESSION_SECRET: "unused", NODE_OPTIONS: "--inspect",
    REST_TOKEN: "test-only-external-credential-reference",
  });
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.PORT, "0");
  assert.equal(env.KUDU_DATA_DIR, "/user/KuduNS");
  assert.equal(env.KUDU_LOCAL_DESKTOP, "true");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.SESSION_SECRET, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.REST_TOKEN, "test-only-external-credential-reference");
  assert.ok(runtimePaths({ isPackaged: false }).entry.endsWith("backend/dist/index.js"));
});
