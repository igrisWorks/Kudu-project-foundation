import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "./app.js";
import { LocalDatabaseManager } from "./local-database.js";

test("SQLite Local persists assets, sources, microsecond events, mappings, file imports and REST sync", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-workflows-"));
  const imports = join(directory, "imports");
  await mkdir(imports);
  const remote = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: [{ record: "rest-1", type: "temperature", time: "2026-11-01T12:00:00Z", reading: 42 }] }));
  });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  const address = remote.address() as { port: number };
  let manager = await LocalDatabaseManager.create(join(directory, "data"));
  let app = await createApp({
    db: manager.db, localMode: true, localDatabase: manager,
    importDirectory: imports, allowLoopbackRestTests: true, logLevel: "silent",
  });
  const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: object, expected = method === "POST" ? 201 : 200) => {
    const response = await app.inject({
      method, url, headers: { host: "localhost:3000", origin: "http://localhost:3000" },
      ...(payload ? { payload } : {}),
    });
    assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
    return response.json();
  };
  try {
    const session = await call("GET", "/api/v1/auth/session");
    assert.equal(session.localMode, true);
    const parent = await call("POST", "/api/v1/assets", { assetKey: "line-1", name: "Line", assetType: "production_line" });
    const child = await call("POST", "/api/v1/assets", { assetKey: "sensor-1", name: "Sensor", assetType: "sensor", parentAssetId: parent.id });
    await call("POST", "/api/v1/assets", { assetKey: "LINE-1", name: "Duplicate", assetType: "other" }, 409);
    await call("PATCH", `/api/v1/assets/${parent.id}`, { parentAssetId: child.id }, 400);
    const search = await call("GET", "/api/v1/assets?search=LINE");
    assert.equal(search.total, 1);
    const manual = await call("POST", "/api/v1/data-sources", {
      sourceKey: "manual", displayName: "Manual", sourceType: "manual", configuration: { kind: "manual" },
    });
    const eventInput = {
      sourceId: manual.id, assetId: child.id, eventType: "measurement",
      occurredAt: "2026-11-01T13:00:00.123456+01:00", payload: { temperature: 24 }, deduplicationKey: "one",
    };
    const event = await call("POST", "/api/v1/events", eventInput);
    assert.equal(event.event.occurredAt, "2026-11-01T12:00:00.123456Z");
    assert.equal((await call("POST", "/api/v1/events", eventInput, 200)).duplicate, true);
    await call("POST", "/api/v1/events", { ...eventInput, payload: { temperature: 25 } }, 409);
    const filtered = await call("GET", "/api/v1/events?from=2026-11-01T12%3A00%3A00.123456Z&to=2026-11-01T12%3A00%3A00.123456Z");
    assert.equal(filtered.total, 1);

    const mapping = async (sourceId: string) => {
      await call("POST", `/api/v1/data-sources/${sourceId}/mappings`, { definition: {
        eventType: "type", occurredAt: "time", sourceRecordId: "record", payload: { reading: "reading" },
      } });
      await call("POST", `/api/v1/data-sources/${sourceId}/mappings/1/validate`, undefined, 200);
      await call("POST", `/api/v1/data-sources/${sourceId}/mappings/1/activate`, undefined, 200);
      assert.equal((await call("GET", `/api/v1/data-sources/${sourceId}/mappings`)).items[0].status, "active");
    };
    for (const format of ["json", "csv"] as const) {
      const fileName = `readings.${format}`;
      await writeFile(join(imports, fileName), format === "json"
        ? JSON.stringify([{ record: "json-1", type: "temperature", time: "2026-11-01T12:00:00Z", reading: 31 }])
        : "record,type,time,reading\ncsv-1,temperature,2026-11-01T12:00:00Z,32\n");
      const source = await call("POST", "/api/v1/data-sources", {
        sourceKey: format, displayName: format, sourceType: `${format}_file`,
        configuration: { kind: `${format}_file`, relativePath: fileName },
      });
      await mapping(source.id);
      const imported = await call("POST", `/api/v1/data-sources/${source.id}/import`, undefined, 200);
      assert.equal(imported.imported, 1, JSON.stringify(imported));
    }
    const rest = await call("POST", "/api/v1/data-sources", {
      sourceKey: "rest", displayName: "REST", sourceType: "rest_api", configuration: {
        kind: "rest_api", baseUrl: `http://127.0.0.1:${address.port}`, endpointPath: "/events",
        method: "GET", authMode: "none", recordsPath: "items",
      },
    });
    await mapping(rest.id);
    const synced = await call("POST", `/api/v1/data-sources/${rest.id}/sync`, undefined, 200);
    assert.equal(synced.imported, 1, JSON.stringify(synced));
    assert.equal((await call("GET", `/api/v1/data-sources/${rest.id}`)).sourceKey, "rest");
    const backup = await call("POST", "/api/v1/local/database/backups");
    await call("PATCH", `/api/v1/assets/${child.id}`, { name: "Changed" });
    await call("POST", "/api/v1/local/database/restore", { backupName: backup.backup.fileName, confirm: true }, 200);
    assert.equal((await call("GET", `/api/v1/assets/${child.id}`)).name, "Sensor");
    const before = await call("GET", "/api/v1/events");
    assert.equal(before.total, 4);
    await app.close();
    await manager.close();
    manager = await LocalDatabaseManager.create(join(directory, "data"));
    app = await createApp({ db: manager.db, localMode: true, localDatabase: manager, logLevel: "silent" });
    assert.equal((await call("GET", "/api/v1/events")).total, before.total);
    assert.equal((await call("GET", "/api/v1/assets")).total, 2);
    assert.equal((await call("GET", "/api/v1/data-sources")).total, 4);
    assert.equal((await call("GET", "/api/v1/local/database")).engine, "SQLite");
  } finally {
    await app.close();
    await manager.close();
    await new Promise<void>(resolve => remote.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a damaged SQLite database is rejected without deleting or replacing its bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuduns-damaged-"));
  const file = join(directory, "kuduns.db");
  const damaged = Buffer.from("not a sqlite database");
  await writeFile(file, damaged);
  try {
    await assert.rejects(() => LocalDatabaseManager.create(directory));
    assert.deepEqual(await readFile(file), damaged);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
