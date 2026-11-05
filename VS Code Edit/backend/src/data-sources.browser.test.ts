import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LocalDatabaseManager } from "./local-database.js";
import { createApp } from "./app.js";

function findChromium(): string | undefined {
  const candidates = [
    process.env.KUDU_CHROMIUM_PATH,
    "chromium",
    "chromium-browser",
    "google-chrome",
    "/usr/bin/chromium",
    "/repl/tools/bin/chromium",
  ].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5_000 });
    if (result.status === 0) return candidate;
  }
  return undefined;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return (server.address() as AddressInfo).port;
}

test(
  "Data Sources browser workflow discovers, maps, activates, paginates, imports, and resumes",
  { skip: !findChromium(), timeout: 120_000 },
  async t => {
    const chromium = findChromium();
    assert.ok(chromium, "Chromium must be installed or set KUDU_CHROMIUM_PATH.");
    const frontendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../frontend/dist");
    assert.ok(existsSync(join(frontendDirectory, "index.html")), "Build the frontend before this browser smoke test.");

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "kuduns-browser-smoke-"));
    const importsDirectory = join(temporaryDirectory, "imports");
    await mkdir(importsDirectory);
    await writeFile(join(importsDirectory, "reuse.json"), JSON.stringify([{
      occurrenceId: "browser-json-1",
      alarmName: "machine_fault",
      eventTime: "2026-11-03T13:00:00Z",
      reading: 42,
      operatingState: "running",
      readings: [{ metricName: "bearing_temperature", measurementValue: 42, measurementUnit: "degC" }],
    }]));
    const data = Array.from({ length: 8 }, (_, index) => ({
      sourceRecordId: `browser-${index + 1}`,
      eventType: "machine_fault",
      occurredAt: `2026-11-03T12:00:${String(index).padStart(2, "0")}Z`,
      reading: index + 1,
      status: "running",
      measurements: [{ metricName: "bearing_temperature", measurementValue: index + 1, measurementUnit: "degC" }],
    }));
    const requestedOffsets: number[] = [];
    const fixture = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname !== "/fixture/events") {
        response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "fixture route not found" }));
        return;
      }
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 2));
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      requestedOffsets.push(offset);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ faults: data.slice(offset, offset + limit) }));
    });
    let manager: LocalDatabaseManager | undefined;
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    let browser: ChildProcess | undefined;
    let socket: WebSocket | undefined;
    let closeBrowser: (() => Promise<void>) | undefined;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    let nextCommandId = 0;
    let browserStderr = "";

    t.after(async () => {
      if (socket?.readyState === WebSocket.OPEN) {
        await Promise.race([closeBrowser?.() ?? Promise.resolve(), new Promise(resolveDelay => setTimeout(resolveDelay, 1_000))]);
      }
      if (browser && browser.exitCode === null) {
        const exited = await new Promise<boolean>(resolveExit => {
          if (browser?.exitCode !== null) return resolveExit(true);
          const timer = setTimeout(() => resolveExit(false), 3_000);
          browser?.once("exit", () => { clearTimeout(timer); resolveExit(true); });
        });
        if (!exited) browser.kill("SIGTERM");
      }
      socket?.close();
      await app?.close();
      await manager?.close();
      await new Promise<void>(resolveClose => fixture.close(() => resolveClose()));
      await rm(temporaryDirectory, { recursive: true, force: true });
    });

    const fixturePort = await listen(fixture);
    manager = await LocalDatabaseManager.create(join(temporaryDirectory, "sqlite"));
    await manager.initialize();
    app = await createApp({
      db: manager.db,
      localMode: true,
      localDatabase: manager,
      importDirectory: importsDirectory,
      allowLoopbackRestTests: true,
      staticDirectory: frontendDirectory,
      logLevel: "silent",
    });
    const appAddress = await app.listen({ host: "127.0.0.1", port: 0 });
    const appPort = Number(new URL(appAddress).port);
    const debuggerPort = await freePort();
    browser = spawn(chromium, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${join(temporaryDirectory, "chromium-profile")}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${debuggerPort}`,
      `http://127.0.0.1:${appPort}/data-sources`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    browser.stderr?.setEncoding("utf8");
    browser.stderr?.on("data", (chunk: string) => { browserStderr = `${browserStderr}${chunk}`.slice(-4_000); });

    const deadline = Date.now() + 15_000;
    let pageTarget: { webSocketDebuggerUrl: string } | undefined;
    while (Date.now() < deadline && !pageTarget) {
      if (browser.exitCode !== null) throw new Error(`Chromium exited early: ${browserStderr}`);
      try {
        const targets = await fetch(`http://127.0.0.1:${debuggerPort}/json/list`).then(response => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        pageTarget = targets.find(target => target.type === "page");
      } catch {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
      }
    }
    assert.ok(pageTarget, `Chromium DevTools did not become ready: ${browserStderr}`);

    socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise<void>((resolveOpen, reject) => {
      socket!.addEventListener("open", () => resolveOpen(), { once: true });
      socket!.addEventListener("error", () => reject(new Error("Could not connect to Chromium DevTools.")), { once: true });
    });
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (message.id === undefined) return;
      const command = pending.get(message.id);
      if (!command) return;
      pending.delete(message.id);
      if (message.error) command.reject(new Error(message.error.message ?? "Chromium DevTools command failed."));
      else command.resolve(message.result);
    });
    const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolveCommand, rejectCommand) => {
      const id = ++nextCommandId;
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    closeBrowser = async () => { await send("Browser.close"); };
    const evaluate = async (expression: string): Promise<any> => {
      const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Browser evaluation failed.");
      }
      return response.result?.value;
    };
    await send("Page.enable");
    await send("Runtime.enable");

    const waitFor = async (description: string, expression: string, timeoutMs = 12_000): Promise<any> => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const value = await evaluate(expression);
        if (value) return value;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
      }
      const body = await evaluate("document.body?.innerText?.slice(0, 1200) ?? ''").catch(() => "");
      throw new Error(`Timed out waiting for ${description}. Current page: ${body}`);
    };
    const click = async (selector: string) => {
      const state = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        return { found: Boolean(element), disabled: Boolean(element?.disabled), text: element?.innerText ?? null };
      })()`);
      if (!state.found || state.disabled) {
        const body = await evaluate("document.body?.innerText?.slice(0, 1200) ?? ''");
        assert.fail(`Could not click ${selector}; state=${JSON.stringify(state)}; page=${body}`);
      }
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    };
    const setValue = async (selector: string, value: string) => {
      const actual = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error('Missing field ${selector}');
        const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (!setter) throw new Error('Field cannot be set ${selector}');
        setter.call(element, ${JSON.stringify(value)});
        element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
        if (element instanceof HTMLInputElement) element.dispatchEvent(new Event('change', { bubbles: true }));
        return element.value;
      })()`);
      assert.equal(actual, value, `Could not set ${selector}.`);
    };

    await waitFor("Data Sources list", "Boolean(document.querySelector('[data-testid=\"button-create-data-source\"]'))");
    await click('[data-testid="button-create-data-source"]');
    await waitFor("source registration form", "Boolean(document.querySelector('[data-testid=\"input-source-key\"]'))");
    await setValue('[data-testid="input-source-key"]', "browser-m2-fixture");
    await setValue('[data-testid="input-source-display-name"]', "Browser Milestone 2 Fixture");
    await setValue('[data-testid="select-data-source-type"]', "rest_api");
    await setValue('[data-testid="input-rest-base-url"]', `http://127.0.0.1:${fixturePort}`);
    await setValue('[data-testid="input-rest-endpoint-path"]', "fixture/events");
    await setValue("#rest-pagination-mode", "offset");
    await setValue("#rest-page-size", "2");
    await setValue("#rest-request-interval", "0");
    const sourceEnabled = await evaluate("Boolean(document.querySelector('[data-testid=\"checkbox-source-enabled\"]')?.checked)");
    if (!sourceEnabled) await click('[data-testid="checkbox-source-enabled"]');
    await click('[data-testid="button-submit-data-source"]');
    await waitFor("saved source next step", "Boolean(document.querySelector('[data-testid=\"button-discover-data\"]'))");
    await click('[data-testid="button-discover-data"]');
    await waitFor("saved source discovery screen", "Boolean(document.querySelector('[data-testid=\"section-discover-data\"]'))");
    await click('[data-testid="button-discover-source"]');
    await waitFor("discovery fields", "Boolean(document.querySelector('[data-testid=\"select-discovery-map-eventType\"]'))");
    await waitFor("nested structure preview", "Boolean(document.querySelector('[data-testid=\"panel-discovery-structures\"]'))");
    const initialSuggestions = await evaluate(`JSON.stringify({
      eventType: document.querySelector('[data-testid="select-discovery-map-eventType"]')?.value,
      occurredAt: document.querySelector('[data-testid="select-discovery-map-occurredAt"]')?.value,
      sourceRecordId: document.querySelector('[data-testid="select-discovery-map-sourceRecordId"]')?.value,
      measurementValue: document.querySelector('[data-testid="select-discovery-map-measurementValue"]')?.value
    })`);
    assert.deepEqual(JSON.parse(initialSuggestions), {
      eventType: "eventType",
      occurredAt: "occurredAt",
      sourceRecordId: "sourceRecordId",
      measurementValue: "reading",
    });
    const nestedStructureSummary = await evaluate("document.querySelector('[data-testid=\"panel-discovery-structures\"]')?.innerText ?? ''");
    assert.match(nestedStructureSummary, /measurements/);
    assert.match(nestedStructureSummary, /possible Measurement name/);
    const sampleSummary = await evaluate("document.querySelector('[data-testid=\"list-discovery-preview-records\"]')?.innerText ?? ''");
    assert.match(sampleSummary, /across 3 pages/, "the browser shows that discovery used a bounded multi-page sample");
    await setValue('[data-testid="select-discovery-map-eventType"]', "eventType");
    await setValue('[data-testid="select-discovery-map-occurredAt"]', "occurredAt");
    await setValue('[data-testid="select-discovery-map-sourceRecordId"]', "sourceRecordId");
    await click('[data-testid="button-submit-data-source"]');
    await waitFor("mapping draft", "Boolean(document.querySelector('[data-testid=\"mapping-draft-editor\"]'))");
    await click('[data-testid="button-validate-mapping"]');
    await waitFor("valid mapping", "Boolean(document.querySelector('[data-testid=\"text-mapping-valid\"]'))");
    await click('[data-testid="button-activate-mapping"]');
    await waitFor("active mapping", "Boolean(document.querySelector('[data-testid=\"text-active-mapping\"]'))");
    await waitFor("enabled REST sync action", "Boolean(document.querySelector('[data-testid=\"button-sync-rest-source\"]')) && !document.querySelector('[data-testid=\"button-sync-rest-source\"]').disabled");
    await click('[data-testid="button-sync-rest-source"]');
    await waitFor("first paginated sync to pause", "document.querySelector('[data-testid=\"panel-rest-sync-result\"]')?.innerText.includes('paused for continuation')");
    const firstCounts = await evaluate("document.querySelector('[data-testid=\"text-rest-sync-counts\"]')?.innerText ?? ''");
    assert.match(firstCounts, /3 pages · 6 fetched · 6 imported/);
    const resumeSelector = await waitFor(
      "resume action",
      "document.querySelector('button[data-testid^=\"button-resume-sync-run-\"]')?.getAttribute('data-testid') ?? ''",
    );
    await click(`[data-testid="${resumeSelector}"]`);
    await waitFor("resumed sync completion", "document.querySelector('[data-testid=\"panel-rest-sync-result\"]')?.innerText.includes('completed')");
    const resumedCounts = await evaluate("document.querySelector('[data-testid=\"text-rest-sync-counts\"]')?.innerText ?? ''");
    assert.match(resumedCounts, /5 pages · 8 fetched · 8 imported/);
    assert.ok(requestedOffsets.includes(6), `Expected the resumed request at offset 6; saw ${requestedOffsets.join(",")}.`);
    assert.ok(requestedOffsets.includes(8), `Expected the final empty-page probe at offset 8; saw ${requestedOffsets.join(",")}.`);
    const records = await manager.db.selectFrom("events").select("source_record_id").execute();
    assert.equal(records.length, 8);

    await evaluate("window.location.href = '/data-sources/new'; true");
    await waitFor("new data source form", "Boolean(document.querySelector('[data-testid=\"input-source-key\"]'))");
    await setValue('[data-testid="input-source-key"]', "browser-json-reuse");
    await setValue('[data-testid="input-source-display-name"]', "Browser JSON Reuse");
    await setValue('[data-testid="select-data-source-type"]', "json_file");
    await setValue('[data-testid="input-source-relative-path"]', "reuse.json");
    await click('[data-testid="button-submit-data-source"]');
    await waitFor("saved JSON source next step", "Boolean(document.querySelector('[data-testid=\"button-discover-data\"]'))");
    await click('[data-testid="button-discover-data"]');
    await waitFor("saved JSON discovery screen", "Boolean(document.querySelector('[data-testid=\"section-discover-data\"]'))");
    await click('[data-testid="button-discover-source"]');
    await waitFor("JSON discovery", "Boolean(document.querySelector('[data-testid=\"select-discovery-map-eventType\"]'))");
    await waitFor(
      "approved mapping reuse selector",
      "Boolean(document.querySelector('[data-testid=\"select-reuse-mapping-source\"]'))",
    );
    const templateSourceId = await evaluate(`(() => {
      const select = document.querySelector('[data-testid="select-reuse-mapping-source"]');
      return [...(select?.options ?? [])].find(option => option.textContent?.includes('Browser Milestone 2 Fixture'))?.value ?? '';
    })()`);
    assert.ok(templateSourceId, "the active REST source should be available as a mapping template");
    await setValue('[data-testid="select-reuse-mapping-source"]', templateSourceId);
    await click('[data-testid="button-apply-reuse-mapping"]');
    await waitFor(
      "copied approved mapping",
      "document.querySelector('[data-testid=\"text-reuse-mapping-status\"]')?.innerText.includes('Copied active mapping')",
    );
    const copiedPaths = await evaluate(`JSON.stringify({
      eventType: document.querySelector('[data-testid="select-discovery-map-eventType"]')?.value,
      occurredAt: document.querySelector('[data-testid="select-discovery-map-occurredAt"]')?.value,
      sourceRecordId: document.querySelector('[data-testid="select-discovery-map-sourceRecordId"]')?.value
    })`);
    assert.deepEqual(JSON.parse(copiedPaths), {
      eventType: "alarmName",
      occurredAt: "eventTime",
      sourceRecordId: "occurrenceId",
    });
    await click('[data-testid="button-submit-data-source"]');
    await waitFor("saved JSON source mapping draft", "Boolean(document.querySelector('[data-testid=\"mapping-draft-editor\"]'))");
    const reusedSourceId = await evaluate("window.location.pathname.split('/').filter(Boolean).at(-1) ?? ''");
    const reusedMapping = await manager.db.selectFrom("data_source_event_mappings")
      .select(["status", "definition"])
      .where("source_id", "=", reusedSourceId)
      .executeTakeFirst();
    assert.equal(reusedMapping?.status, "draft", "reusing an approved mapping must not auto-activate it");
    assert.deepEqual(reusedMapping?.definition, {
      eventType: "alarmName",
      occurredAt: "eventTime",
      sourceRecordId: "occurrenceId",
      payload: {
        measurementValue: "reading",
        status: "operatingState",
        measurements: "readings",
      },
    });

    const sourceId = await evaluate("window.location.pathname.split('/').filter(Boolean).at(-1) ?? ''");
    const sourceRecord = await manager.db.selectFrom("data_sources").select("id").where("id", "=", sourceId).executeTakeFirst();
    assert.ok(sourceRecord);
    const assetResponse = await app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: { host: `127.0.0.1:${appPort}`, origin: `http://127.0.0.1:${appPort}` },
      payload: { assetKey: "browser-delete-asset", name: "Browser delete asset", assetType: "machine" },
    });
    assert.equal(assetResponse.statusCode, 201, assetResponse.body);
    const asset = assetResponse.json();
    const eventResponse = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      headers: { host: `127.0.0.1:${appPort}`, origin: `http://127.0.0.1:${appPort}` },
      payload: {
        sourceId,
        assetId: asset.id,
        eventType: "browser_delete_test",
        occurredAt: "2026-11-04T12:00:00Z",
        payload: { original: "preserve-me" },
      },
    });
    assert.equal(eventResponse.statusCode, 201, eventResponse.body);
    const eventId = eventResponse.json().event.id;
    await evaluate("window.location.href = " + JSON.stringify(`/assets/${asset.id}`) + "; true");
    await waitFor("asset detail deletion control", "Boolean(document.querySelector('[data-testid=\"button-delete-asset\"]'))");
    await evaluate("window.confirm = () => true");
    await click('[data-testid="button-delete-asset"]');
    await waitFor("asset deletion success", "Boolean(document.querySelector('[data-testid=\"notice-asset-deleted\"]'))");
    const preservedAfterAssetDelete = await manager.db.selectFrom("events").select(["asset_id", "payload"]).where("id", "=", eventId).executeTakeFirst();
    assert.equal(preservedAfterAssetDelete?.asset_id, null);
    assert.deepEqual(preservedAfterAssetDelete?.payload, { original: "preserve-me" });

    const syncHistoryBeforeRemoval = await manager.db.selectFrom("data_source_sync_runs").select("id").where("source_id", "=", templateSourceId).execute();
    const sourceEventsBeforeRemoval = await manager.db.selectFrom("events").select("id").where("source_id", "=", templateSourceId).execute();
    assert.ok(syncHistoryBeforeRemoval.length > 0 && sourceEventsBeforeRemoval.length > 0);
    const sourceIdentity = await manager.db.selectFrom("data_sources")
      .select(["source_key", "display_name"]).where("id", "=", templateSourceId).executeTakeFirst();
    assert.ok(sourceIdentity);
    await evaluate("window.location.href = " + JSON.stringify(`/data-sources/${templateSourceId}`) + "; true");
    await waitFor("REST source removal control", "Boolean(document.querySelector('[data-testid=\"button-delete-data-source\"]'))");
    await evaluate("window.confirm = message => { window.__lastConfirmation = message; return true; }");
    await click('[data-testid="button-delete-data-source"]');
    await waitFor("source archived with history retained", "Boolean(document.querySelector('[data-testid=\"notice-source-archived\"]'))");
    const sourceConfirmation = await evaluate("window.__lastConfirmation ?? ''");
    assert.ok(sourceConfirmation.includes(sourceIdentity.display_name));
    assert.ok(sourceConfirmation.includes(sourceIdentity.source_key));
    await waitFor("refreshed list keeps the archived source visible", `Boolean(document.querySelector('[data-testid="row-data-source-${templateSourceId}"]'))`);
    const refreshedSourceRow = await evaluate(`document.querySelector('[data-testid="row-data-source-${templateSourceId}"]')?.innerText ?? ''`);
    assert.ok(refreshedSourceRow.includes(sourceIdentity.source_key));
    assert.ok(refreshedSourceRow.includes("DISABLED"));
    const retainedSource = await manager.db.selectFrom("data_sources").select("enabled").where("id", "=", templateSourceId).executeTakeFirst();
    const retainedEvents = await manager.db.selectFrom("events").select("id").where("source_id", "=", templateSourceId).execute();
    assert.equal(retainedSource?.enabled, false);
    assert.equal(retainedEvents.length, sourceEventsBeforeRemoval.length);

    await evaluate("window.location.href = '/data-sources/new'; true");
    await waitFor("new private REST source form", "Boolean(document.querySelector('[data-testid=\"input-source-key\"]'))");
    await setValue('[data-testid="input-source-key"]', "browser-private-host");
    await setValue('[data-testid="input-source-display-name"]', "Browser Private Host");
    await setValue('[data-testid="input-rest-base-url"]', "http://10.11.36.65/api");
    await setValue('[data-testid="input-rest-endpoint-path"]', "events");
    await click('[data-testid="checkbox-trust-private-rest-host"]');
    assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=\"checkbox-trust-private-rest-host\"]')?.checked)"), true);
    await click('[data-testid="button-submit-data-source"]');
    await waitFor(
      "saved exact private-host trust",
      "document.querySelector('[data-testid=\"text-source-trusted-private-host\"]')?.innerText.includes('Trusted exact host: 10.11.36.65')",
    );
    const trustedSource = await manager.db.selectFrom("data_sources").select(["id", "configuration"])
      .where("source_key", "=", "browser-private-host").executeTakeFirst();
    assert.equal(trustedSource?.configuration.kind, "rest_api");
    if (trustedSource?.configuration.kind === "rest_api") {
      assert.equal(trustedSource.configuration.trustedPrivateHost, "10.11.36.65");
    }
    await evaluate("window.location.href = " + JSON.stringify(`/data-sources/${trustedSource?.id}/edit`) + "; true");
    await waitFor(
      "trusted-host setting restored in edit form",
      "Boolean(document.querySelector('[data-testid=\"checkbox-trust-private-rest-host\"]')?.checked)",
    );
    assert.ok(trustedSource?.id);
    const privateSourceIdentity = await manager.db.selectFrom("data_sources")
      .select(["source_key", "display_name"]).where("id", "=", trustedSource.id).executeTakeFirst();
    assert.ok(privateSourceIdentity);
    await evaluate("window.location.href = " + JSON.stringify(`/data-sources/${trustedSource.id}`) + "; true");
    await waitFor("new source removal control", "Boolean(document.querySelector('[data-testid=\"button-delete-data-source\"]'))");
    await evaluate("window.confirm = message => { window.__lastConfirmation = message; return true; }");
    await click('[data-testid="button-delete-data-source"]');
    await waitFor("source with no history deleted", "Boolean(document.querySelector('[data-testid=\"notice-source-deleted\"]'))");
    const privateSourceConfirmation = await evaluate("window.__lastConfirmation ?? ''");
    assert.ok(privateSourceConfirmation.includes(privateSourceIdentity.display_name));
    assert.ok(privateSourceConfirmation.includes(privateSourceIdentity.source_key));
    await waitFor(
      "source list refreshed after deletion",
      "Boolean(document.querySelector('tbody tr') || document.querySelector('[data-testid=\"button-empty-create-data-source\"]'))",
    );
    assert.equal(
      await evaluate(`Boolean(document.querySelector('[data-testid="row-data-source-${trustedSource.id}"]'))`),
      false,
    );

    await evaluate("window.location.href = '/data-explorer'; true");
    await waitFor("data explorer page", `document.querySelector('h1')?.innerText === 'Data explorer'`);
    await waitFor("persisted event rows", `Boolean(document.querySelector('[data-testid^="button-select-event-"]'))`);
    await waitFor("payload tree inspector", `Boolean(document.querySelector('[data-testid="tree-event-payload"]'))`);
    await waitFor("selected field export controls", `Boolean(document.querySelector('[data-testid="button-export-selected-fields"]'))`);
    assert.ok(await evaluate(`Boolean(document.querySelector('[data-testid="select-explorer-sort-by"]'))`));
    const nestedRecordButton = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.dw-event-table tbody tr')].find(item => item.innerText.includes('Browser Milestone 2 Fixture'));
      return row?.querySelector('button[data-testid^="button-select-event-"]')?.getAttribute('data-testid') ?? null;
    })()`);
    assert.ok(nestedRecordButton, "the browser fixture with nested measurement records must be present");
    await click(`[data-testid="${nestedRecordButton}"]`);
    await waitFor("nested object child table", `Boolean(document.querySelector('[data-testid="related-record-tables"]'))`);
    const explorerSummary = await evaluate(`document.querySelector('.dw-event-table')?.innerText ?? ''`);
    assert.ok(explorerSummary.trim().length > 20, "the table renders persisted event values and source attribution");
    assert.ok(await evaluate(`Boolean(document.querySelector('[data-testid="explorer-quality-report"]'))`));
    await click('[data-testid="button-payload-raw"]');
    assert.ok(await evaluate(`Boolean(document.querySelector('[data-testid="json-event-payload"]'))`));

    await evaluate("window.location.href = '/visualisations'; true");
    await waitFor("saved visualisations page", `document.querySelector('h1')?.innerText === 'Visualisations'`);
    assert.ok(await evaluate(`Boolean(document.querySelector('[data-testid="button-load-visualisation-data"]'))`));
    assert.equal(await evaluate(`document.querySelector('[data-testid="select-visualisation-type"]')?.options.length`), 4);
    const persistedSample = await evaluate(`fetch('/api/v1/explorer/events?page=1&pageSize=1').then(response => response.json()).then(page => page.items[0] ? { sourceId: page.items[0].source.id, eventType: page.items[0].eventType } : null)`);
    assert.ok(persistedSample, "visualisations must use an already imported event");
    await setValue('[data-testid="select-visualisation-source"]', persistedSample.sourceId);
    await setValue('[data-testid="input-visualisation-event-type"]', persistedSample.eventType);
    await click('[data-testid="button-load-visualisation-data"]');
    await waitFor("visualisation data count", `Boolean(document.querySelector('.dw-chart-foot')?.innerText.match(/Imported events queried: [1-9]/))`);
    await setValue('[data-testid="select-visualisation-type"]', "distribution");
    const categoryPath = await waitFor("imported category fields", `document.querySelector('[data-testid="select-visualisation-category"]')?.options[1]?.value`);
    await setValue('[data-testid="select-visualisation-category"]', categoryPath);
    await waitFor("imported category chart", `Boolean(document.querySelector('[data-testid="category-visualisation"]'))`);
    await setValue('[data-testid="input-visualisation-name"]', "Browser smoke distribution");
    await click('[data-testid="button-save-visualisation"]');
    await waitFor("saved visualisation configuration", `Boolean(document.querySelector('[data-testid^="button-open-visualisation-"]'))`);
  },
);
