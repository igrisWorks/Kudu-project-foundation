import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { createAuthenticatedTestApp } from "./test-support/authenticated-app.js";
import type { Database } from "./database.js";
import { ApiFailure } from "./errors.js";
import { runMigrations } from "./migration-runner.js";
import { validateDataSourceCreate } from "./registry-validation.js";

const databaseUrl = process.env.KUDU_TEST_DATABASE_URL;
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../database/migrations",
);

interface TestLifecycle {
  after(callback: () => void | Promise<void>): void;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function createFixture(context: TestLifecycle) {
  if (!databaseUrl) throw new Error("KUDU_TEST_DATABASE_URL is required for REST sync integration tests.");
  const prefix = `rs${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(pool, migrationsDirectory);
  const app = await createAuthenticatedTestApp({ db, logLevel: "silent", allowLoopbackRestTests: true });
  const sourceIds: string[] = [];
  const assetIds: string[] = [];

  context.after(async () => {
    if (sourceIds.length) {
      await db.deleteFrom("data_source_sync_runs").where("source_id", "in", sourceIds).execute();
      await db.deleteFrom("data_source_event_mappings").where("source_id", "in", sourceIds).execute();
      await db.deleteFrom("events").where("source_id", "in", sourceIds).execute();
      await db.deleteFrom("data_sources").where("id", "in", sourceIds).execute();
    }
    if (assetIds.length) await db.deleteFrom("assets").where("id", "in", assetIds).execute();
    await app.close();
    await db.destroy();
  });

  async function addSource(
    port: number,
    endpointPath: string,
    baseUrl = `http://127.0.0.1:${port}/api`,
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/data-sources",
      payload: {
        sourceKey: `${prefix}-${sourceIds.length + 1}`,
        displayName: "REST sync integration source",
        sourceType: "rest_api",
        configuration: {
          kind: "rest_api",
          baseUrl,
          endpointPath,
          method: "GET",
          authMode: "none",
          timeoutMs: 5000,
          maxResponseBytes: 100_000,
          maxRecords: 100,
          responseFormat: "json",
          recordsPath: "data.items",
        },
        enabled: true,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json().id as string;
    sourceIds.push(id);
    return id;
  }

  async function addAsset(): Promise<{ id: string; assetKey: string }> {
    const assetKey = `${prefix}-asset`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      payload: { assetKey, name: "REST sync test asset", assetType: "machine" },
    });
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json().id as string;
    assetIds.push(id);
    return { id, assetKey };
  }

  async function activateMapping(sourceId: string): Promise<void> {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/data-sources/${sourceId}/mappings`,
      payload: {
        definition: {
          eventType: "type",
          occurredAt: "time",
          sourceRecordId: "id",
          assetKey: "assetKey",
          payload: { temperatureC: "readings.temperature" },
        },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const validated = await app.inject({
      method: "POST",
      url: `/api/v1/data-sources/${sourceId}/mappings/1/validate`,
    });
    assert.equal(validated.statusCode, 200, validated.body);
    assert.equal(validated.json().valid, true, validated.body);
    const activated = await app.inject({
      method: "POST",
      url: `/api/v1/data-sources/${sourceId}/mappings/1/activate`,
    });
    assert.equal(activated.statusCode, 200, activated.body);
  }

  return { app, db, addAsset, addSource, activateMapping };
}

test("REST source configuration accepts bounded GET/JSON and rejects write methods", () => {
  const valid = validateDataSourceCreate({
    sourceKey: "rest-config-test",
    displayName: "REST configuration test",
    sourceType: "rest_api",
    configuration: {
      kind: "rest_api",
      baseUrl: "https://api.example.test/v1",
      endpointPath: "events",
      method: "GET",
      authMode: "bearer",
      credentialRef: "env:KUDU_SOURCE_REST_TEST_TOKEN",
      timeoutMs: 500,
      maxResponseBytes: 1024,
      maxRecords: 1,
      responseFormat: "json",
      recordsPath: "data.items",
    },
  });
  assert.equal(valid.configuration.kind, "rest_api");
  if (valid.configuration.kind === "rest_api") {
    assert.equal(valid.configuration.authMode, "bearer");
    assert.equal(valid.configuration.method, "GET");
    assert.equal(valid.configuration.credentialRef, "env:KUDU_SOURCE_REST_TEST_TOKEN");
  }

  function assertFieldRejected(configuration: Record<string, unknown>, field: string) {
    assert.throws(
      () => validateDataSourceCreate({
        sourceKey: "rest-config-test",
        displayName: "REST configuration test",
        sourceType: "rest_api",
        configuration: { kind: "rest_api", baseUrl: "https://api.example.test", ...configuration },
      }),
      (cause: unknown) => cause instanceof ApiFailure && Boolean(cause.fields?.[`configuration.${field}`]),
    );
  }
  assertFieldRejected({ method: "POST" }, "method");
  assertFieldRejected({ authMode: "bearer", baseUrl: "http://api.example.test" }, "authMode");
  assertFieldRejected({ maxRecords: 100_001 }, "maxRecords");
});

test(
  "REST sync imports mapped events and deterministically counts duplicate records",
  { skip: !databaseUrl },
  async (context) => {
    const records = [
      {
        id: "remote-1",
        type: "machine.temperature",
        time: "2026-10-27T12:00:00.123456Z",
        assetKey: "press-7",
        readings: { temperature: 31.5 },
        payload: { line: "north" },
      },
      {
        id: "remote-1",
        type: "machine.temperature",
        time: "2026-10-27T12:00:00.123456Z",
        assetKey: "press-7",
        readings: { temperature: 31.5 },
        payload: { line: "north" },
      },
    ];
    const server = createServer((request, response) => {
      assert.equal(request.method, "GET");
      assert.equal(request.url, "/api/events");
      assert.equal(request.headers.authorization, undefined);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { items: records } }));
    });
    const port = await listen(server);
    context.after(() => closeServer(server));

    const { app, db, addAsset, addSource, activateMapping } = await createFixture(context);
    const asset = await addAsset();
    records[0]!.assetKey = asset.assetKey;
    records[1]!.assetKey = asset.assetKey;
    const sourceId = await addSource(port, "events");
    await activateMapping(sourceId);

    const response = await app.inject({ method: "POST", url: `/api/v1/data-sources/${sourceId}/sync` });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      {
        requestSucceeded: response.json().requestSucceeded,
        fetched: response.json().fetched,
        imported: response.json().imported,
        duplicates: response.json().duplicates,
        failed: response.json().failed,
      },
      { requestSucceeded: true, fetched: 2, imported: 1, duplicates: 1, failed: 0 },
    );

    const storedEvents = await db
      .selectFrom("events")
      .select(["source_id", "source_record_id", "occurred_at", "source_timestamp", "payload", "provenance"])
      .where("source_id", "=", sourceId)
      .execute();
    assert.equal(storedEvents.length, 1);
    assert.equal(storedEvents[0]!.source_id, sourceId);
    assert.equal(storedEvents[0]!.source_record_id, "remote-1");
    assert.equal(storedEvents[0]!.source_timestamp, "2026-10-27T12:00:00.123456Z");
    assert.equal(storedEvents[0]!.payload.temperatureC, 31.5);
    assert.equal(storedEvents[0]!.payload.line, "north");
    assert.equal(storedEvents[0]!.provenance.mappingVersion, 1);
    assert.equal((storedEvents[0]!.provenance.originalRecord as { id: string }).id, "remote-1");
  },
);

test(
  "REST sync reports malformed JSON and remote HTTP failures without exposing response bodies",
  { skip: !databaseUrl },
  async (context) => {
    const server = createServer((request, response) => {
      if (request.url === "/api/bad-json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{not json");
        return;
      }
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("sensitive remote body");
    });
    const port = await listen(server);
    context.after(() => closeServer(server));

    const { app, addSource, activateMapping } = await createFixture(context);
    for (const [path, expectedCode, expectedRequestSucceeded] of [
      ["bad-json", "REST_INVALID_JSON", true],
      ["http-error", "REST_HTTP_ERROR", false],
    ] as const) {
      const sourceId = await addSource(port, path);
      await activateMapping(sourceId);
      const response = await app.inject({ method: "POST", url: `/api/v1/data-sources/${sourceId}/sync` });
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json();
      assert.equal(result.requestSucceeded, expectedRequestSucceeded);
      assert.equal(result.fetched, 0);
      assert.equal(result.errors[0].code, expectedCode);
      assert.equal(response.body.includes("sensitive remote body"), false, response.body);
    }
  },
);

test(
  "REST sync blocks non-public destinations and unsafe redirects",
  { skip: !databaseUrl },
  async (context) => {
    let localRequests = 0;
    const server = createServer((_request, response) => {
      localRequests += 1;
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      response.end();
    });
    const port = await listen(server);
    context.after(() => closeServer(server));

    const { app, addSource, activateMapping } = await createFixture(context);
    const blockedSourceId = await addSource(1, "latest/meta-data", "http://169.254.169.254");
    await activateMapping(blockedSourceId);

    const blocked = await app.inject({ method: "POST", url: `/api/v1/data-sources/${blockedSourceId}/sync` });
    assert.equal(blocked.statusCode, 200, blocked.body);
    assert.equal(blocked.json().requestSucceeded, false);
    assert.equal(blocked.json().errors[0].code, "REST_DESTINATION_BLOCKED");

    const redirectSource = await addSource(port, "redirect");
    await activateMapping(redirectSource);
    const redirected = await app.inject({ method: "POST", url: `/api/v1/data-sources/${redirectSource}/sync` });
    assert.equal(redirected.statusCode, 200, redirected.body);
    assert.equal(redirected.json().requestSucceeded, false);
    assert.equal(redirected.json().errors[0].code, "REST_DESTINATION_BLOCKED");
    assert.equal(localRequests, 1);
  },
);
