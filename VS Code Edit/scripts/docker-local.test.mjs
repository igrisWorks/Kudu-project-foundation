import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { configuredPort, isPortAvailable, parsePort } from "./docker-local.mjs";

test("local Docker host port accepts valid values and rejects invalid values", () => {
  assert.equal(parsePort("3002"), 3002);
  assert.throws(() => parsePort("0"), /between 1 and 65535/);
  assert.throws(() => parsePort("not-a-port"), /between 1 and 65535/);
});

test("local Docker startup detects a port already bound on loopback", async () => {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object");

  try {
    assert.equal(await isPortAvailable(address.port), false);
  } finally {
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
});

test("local Docker startup reports a port conflict without changing the listener", async () => {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object");

  try {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("./docker-local.mjs", import.meta.url)),
    ], {
      env: { ...process.env, KUDU_LOCAL_WEB_PORT: String(address.port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { output += chunk; });
    const exitCode = await new Promise(resolve => child.once("close", resolve));

    assert.equal(exitCode, 1);
    assert.match(output, /is already in use or unavailable/);
    assert.match(output, /did not stop or modify the service/);
    assert.equal(listener.listening, true);
  } finally {
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
});

test("local Docker startup reads its host port from the project env file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kudu-docker-port-test-"));
  const envFile = join(directory, ".env");
  try {
    await writeFile(envFile, "KUDU_LOCAL_WEB_PORT=3002\n", "utf8");
    assert.equal(await configuredPort({}, envFile), 3002);
    assert.equal(await configuredPort({ KUDU_LOCAL_WEB_PORT: "3003" }, envFile), 3003);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
