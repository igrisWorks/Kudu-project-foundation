import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { hashPassword } from "./auth.js";
import type { Database } from "./database.js";
import { createAuthenticatedTestApp } from "./test-support/authenticated-app.js";

const testPassword = randomBytes(24).toString("base64url");
const testSessionSecret = randomBytes(48).toString("base64url");
const testPasswordHash = hashPassword(testPassword);

function unusedDatabase(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ max: 1 }) }),
  });
}

function responseCookies(response: { headers: { "set-cookie"?: unknown } }) {
  const setCookie = response.headers["set-cookie"];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .filter((value): value is string => typeof value === "string");
}

function requestCookie(response: { headers: { "set-cookie"?: unknown } }): string {
  return responseCookies(response).map(value => value.split(";")[0]).join("; ");
}

test("health stays public while API reads and writes require a valid session and CSRF token", async context => {
  const db = unusedDatabase();
  const app = await createApp({
    db,
    logLevel: "silent",
    databaseCheck: async () => undefined,
    auth: { passwordHash: await testPasswordHash, sessionSecret: testSessionSecret, cookieSecure: true },
  });
  app.get("/api/v1/auth-test", async () => ({ permitted: true }));
  app.post("/api/v1/auth-test", async () => ({ changed: true }));
  context.after(async () => {
    await app.close();
    await db.destroy();
  });

  assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode, 200);
  const publicSession = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
  assert.deepEqual(publicSession.json(), { configured: true, authenticated: false });

  const unauthenticatedRead = await app.inject({ method: "GET", url: "/api/v1/events" });
  const unauthenticatedWrite = await app.inject({
    method: "POST",
    url: "/api/v1/assets",
    payload: { assetKey: "auth-test", name: "Auth test", assetType: "other" },
  });
  assert.equal(unauthenticatedRead.statusCode, 401);
  assert.equal(unauthenticatedWrite.statusCode, 401);
  for (const url of [
    "/api/v1/assets?status=all&assetType=plc",
    "/api/v1/events/00000000-0000-4000-8000-000000000000",
    "/api/v1/data-sources/00000000-0000-4000-8000-000000000000",
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 401, `Expected ${url} to require authentication.`);
  }

  const invalidLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { password: "incorrect password" },
  });
  assert.equal(invalidLogin.statusCode, 401);
  assert.equal(invalidLogin.json().error.code, "INVALID_CREDENTIALS");

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { password: testPassword },
  });
  assert.equal(login.statusCode, 200);
  const loginBody = login.body;
  assert.equal(loginBody.includes(testPassword), false);
  assert.equal(loginBody.includes(await testPasswordHash), false);
  assert.equal(loginBody.includes(testSessionSecret), false);
  assert.equal("csrfToken" in login.json(), false);

  const setCookies = responseCookies(login);
  const sessionCookie = setCookies.find(value => value.startsWith("kudu_session="));
  const csrfCookie = setCookies.find(value => value.startsWith("kudu_csrf="));
  assert.ok(sessionCookie?.includes("HttpOnly"));
  assert.ok(sessionCookie?.includes("SameSite=Strict"));
  assert.ok(sessionCookie?.includes("Secure"));
  assert.ok(csrfCookie?.includes("SameSite=Strict"));
  assert.ok(csrfCookie?.includes("Secure"));
  assert.equal(csrfCookie?.includes("HttpOnly"), false);
  const cookie = requestCookie(login);
  const csrfToken = cookie.match(/(?:^|;\s*)kudu_csrf=([^;]+)/)?.[1];
  assert.ok(csrfToken);

  const missingReadCsrf = await app.inject({
    method: "GET",
    url: "/api/v1/auth-test",
    headers: { cookie },
  });
  assert.equal(missingReadCsrf.statusCode, 403);
  const authenticatedRead = await app.inject({
    method: "GET",
    url: "/api/v1/auth-test",
    headers: { cookie, "x-kudu-csrf": csrfToken },
  });
  assert.equal(authenticatedRead.statusCode, 200);
  assert.deepEqual(authenticatedRead.json(), { permitted: true });
  const tamperedSession = await app.inject({
    method: "GET",
    url: "/api/v1/auth-test",
    headers: { cookie: cookie.replace(/kudu_session=[^;]+/, "kudu_session=invalid") },
  });
  assert.equal(tamperedSession.statusCode, 401);

  const missingCsrf = await app.inject({
    method: "POST",
    url: "/api/v1/auth-test",
    headers: { cookie },
  });
  assert.equal(missingCsrf.statusCode, 403);
  const invalidCsrf = await app.inject({
    method: "POST",
    url: "/api/v1/auth-test",
    headers: { cookie, "x-kudu-csrf": "invalid-csrf-token" },
  });
  assert.equal(invalidCsrf.statusCode, 403);
  const authenticatedWrite = await app.inject({
    method: "POST",
    url: "/api/v1/auth-test",
    headers: { cookie, "x-kudu-csrf": csrfToken },
  });
  assert.equal(authenticatedWrite.statusCode, 200);

  const logout = await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: { cookie, "x-kudu-csrf": csrfToken },
  });
  assert.equal(logout.statusCode, 204);
  const expiredSession = await app.inject({
    method: "GET",
    url: "/api/v1/auth-test",
    headers: { cookie },
  });
  assert.equal(expiredSession.statusCode, 401);
});

test("missing auth configuration fails closed and login attempts are throttled", async context => {
  const db = unusedDatabase();
  const unconfiguredApp = await createApp({
    db,
    logLevel: "silent",
    databaseCheck: async () => undefined,
    auth: { cookieSecure: true },
  });
  context.after(async () => {
    await unconfiguredApp.close();
    await db.destroy();
  });
  assert.equal((await unconfiguredApp.inject({ method: "GET", url: "/api/v1/health" })).statusCode, 200);
  assert.equal((await unconfiguredApp.inject({ method: "GET", url: "/api/v1/auth/session" })).json().configured, false);
  assert.equal((await unconfiguredApp.inject({ method: "GET", url: "/api/v1/events" })).statusCode, 503);

  const limitedDb = unusedDatabase();
  const limitedApp = await createApp({
    db: limitedDb,
    logLevel: "silent",
    auth: { passwordHash: await testPasswordHash, sessionSecret: testSessionSecret, cookieSecure: false },
  });
  context.after(async () => {
    await limitedApp.close();
    await limitedDb.destroy();
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await limitedApp.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password: "wrong password" },
    });
    assert.equal(response.statusCode, 401);
  }
  const rateLimited = await limitedApp.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { password: "wrong password" },
  });
  assert.equal(rateLimited.statusCode, 429);
  assert.ok(Number(rateLimited.headers["retry-after"]) > 0);
});

test("authenticated integration helper attaches the session and CSRF cookies", async context => {
  const db = unusedDatabase();
  const app = await createAuthenticatedTestApp({
    db,
    logLevel: "silent",
    databaseCheck: async () => undefined,
  }, testApp => {
    testApp.get("/api/v1/auth-test-fixture", async () => ({ permitted: true }));
  });
  context.after(async () => {
    await app.close();
    await db.destroy();
  });

  const response = await app.inject({ method: "GET", url: "/api/v1/auth-test-fixture" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { permitted: true });
});
