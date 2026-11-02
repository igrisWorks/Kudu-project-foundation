import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import SettingsPage from "./SettingsPage";

test("background refresh and failed restore preserve recovery inputs; success updates confirmed state", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:3000" });
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let tick: (() => void) | undefined;
  dom.window.setInterval = ((callback: () => void) => { tick = callback; return 1; }) as typeof dom.window.setInterval;
  dom.window.clearInterval = () => {};
  const originalFetch = globalThis.fetch;
  let failRestore = true;
  let version = "0001_initial";
  const status = () => ({
    engine: "SQLite", connected: true, filePath: "/user-data/KuduNS/kuduns.db",
    dataDirectory: "/user-data/KuduNS", backupsDirectory: "/user-data/KuduNS/backups",
    sqliteVersion: "3.53", schemaVersion: version, migrationState: "current",
    integrity: "ok", lastSuccessfulInitialization: "2026-11-02T12:00:00Z",
  });
  const backup = { fileName: "kuduns-example.db", filePath: "/user-data/KuduNS/backups/kuduns-example.db", createdAt: "2026-11-02T12:00:00Z", sizeBytes: 1024 };
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (url.endsWith("/restore")) return new Response(JSON.stringify(failRestore
      ? { error: { code: "LOCAL_DATABASE_ERROR", message: "Simulated restore failure" } }
      : { status: status(), safetyBackup: backup }), { status: failRestore ? 400 : 200 });
    if (url.endsWith("/backups")) return new Response(JSON.stringify(options?.method === "POST"
      ? { backup } : { items: [backup] }));
    return new Response(JSON.stringify(status()));
  };
  try {
    const view = render(<SettingsPage />);
    await waitFor(() => assert.ok(view.getByText("0001_initial")));
    const select = view.getByLabelText("Backup to restore") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: backup.fileName } });
    const confirmation = view.getByRole("checkbox") as HTMLInputElement;
    fireEvent.click(confirmation);
    version = "0002_refreshed";
    await act(async () => { tick?.(); });
    await waitFor(() => assert.ok(view.getByText("0002_refreshed")));
    assert.equal(select.value, backup.fileName);
    assert.equal(confirmation.checked, true);
    fireEvent.click(view.getByRole("button", { name: "Restore selected backup" }));
    await waitFor(() => assert.ok(view.getByText("Simulated restore failure")));
    assert.equal(select.value, backup.fileName);
    assert.equal(confirmation.checked, true);
    failRestore = false;
    fireEvent.click(view.getByRole("button", { name: "Restore selected backup" }));
    await waitFor(() => assert.equal(confirmation.checked, false));
    assert.equal(select.value, backup.fileName);
    assert.equal(view.queryByLabelText("PostgreSQL administrator username"), null);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
