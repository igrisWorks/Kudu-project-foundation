import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import { createLocalDockerProxy } from "./local-docker-proxy.js";

test("Docker local proxy forwards local hosts and rejects non-loopback host headers", async () => {
  const received: { host?: string; origin?: string } = {};
  const api = createServer((request, response) => {
    received.host = request.headers.host;
    received.origin = request.headers.origin;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ host: received.host, origin: received.origin }));
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const apiPort = (api.address() as { port: number }).port;
  const proxy = createLocalDockerProxy(apiPort);
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  const makeRequest = (path: string, host: string, origin?: string) => new Promise<{
    statusCode: number;
    body: string;
  }>((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port: proxyPort,
      path,
      headers: { host, ...(origin ? { origin } : {}) },
    }, incoming => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", chunk => { body += chunk; });
      incoming.on("end", () => resolve({ statusCode: incoming.statusCode ?? 0, body }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });

  try {
    const forwarded = await makeRequest(
      "/api/v1/auth/session",
      "127.0.0.1:3000",
      "http://127.0.0.1:3000",
    );
    assert.equal(forwarded.statusCode, 200);
    assert.deepEqual(JSON.parse(forwarded.body), {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
    });
    assert.equal(received.host, "127.0.0.1:3000");
    assert.equal(received.origin, "http://127.0.0.1:3000");

    const rejected = await makeRequest("/", "kudu.example.test");
    assert.equal(rejected.statusCode, 403);
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await new Promise<void>(resolve => api.close(() => resolve()));
  }
});
