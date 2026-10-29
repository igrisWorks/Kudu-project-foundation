import { createServer, request, type Server } from "node:http";

function isLoopbackHostHeader(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const host = new URL(`http://${value}`);
    const normalized = host.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
  } catch {
    return false;
  }
}

export function createLocalDockerProxy(apiPort: number): Server {
  return createServer((incoming, outgoing) => {
    if (!isLoopbackHostHeader(incoming.headers.host)) {
      outgoing.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      outgoing.end("This local service accepts loopback requests only.");
      return;
    }

    const headers = { ...incoming.headers };
    delete headers.connection;
    delete headers["proxy-connection"];
    const upstream = request({
      host: "127.0.0.1",
      port: apiPort,
      method: incoming.method,
      path: incoming.url,
      headers,
      agent: false,
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        outgoing.end("The local Kudu service is not ready.");
      } else {
        outgoing.destroy();
      }
    });
    incoming.pipe(upstream);
  });
}
