import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
    const data = Array.from({ length: 8 }, (_, index) => ({
      sourceRecordId: `browser-${index + 1}`,
      eventType: "machine_fault",
      occurredAt: `2026-11-03T12:00:${String(index).padStart(2, "0")}Z`,
      reading: index + 1,
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
    await click('[data-testid="button-discover-source"]');
    await waitFor("discovery fields", "Boolean(document.querySelector('[data-testid=\"select-discovery-map-eventType\"]'))");
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
  },
);
