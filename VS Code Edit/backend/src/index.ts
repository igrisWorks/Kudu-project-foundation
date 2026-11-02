import { existsSync } from "node:fs";
import { createLocalDockerProxy } from "./local-docker-proxy.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { LocalDatabaseManager } from "./local-database.js";

const config = loadConfig(process.env);
if (config.localDocker && (process.platform !== "linux" || !existsSync("/.dockerenv"))) {
  throw new Error("KUDU_LOCAL_DOCKER is supported only inside a Docker Linux container.");
}
const localDatabase = config.localMode
  ? await LocalDatabaseManager.create()
  : undefined;
if (localDatabase) await localDatabase.initialize();
const database = localDatabase
  ? { db: localDatabase.db, close: () => localDatabase.close() }
  : createDatabase(config.databaseUrl!);
const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const staticDirectory = resolve(
  process.env.KUDU_FRONTEND_DIST_DIR ?? resolve(currentDirectory, "../../frontend/dist"),
);
const app = await createApp({
  db: database.db,
  staticDirectory,
  logLevel: config.logLevel,
  auth: config.auth,
  localMode: config.localMode,
  localDocker: config.localDocker,
  ...(localDatabase ? { localDatabase } : {}),
});

let localDockerProxy: ReturnType<typeof createLocalDockerProxy> | undefined;
const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down Kudu");
  if (localDockerProxy) {
    await new Promise<void>(resolveClose => localDockerProxy!.close(() => resolveClose()));
    localDockerProxy = undefined;
  }
  await app.close();
  await database.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  const address = await app.listen({ host: config.host, port: config.port });
  if (config.localDesktop) {
    const actualPort = Number(new URL(address).port);
    const parentPort = (process as NodeJS.Process & {
      parentPort?: { postMessage: (message: unknown) => void };
    }).parentPort;
    parentPort?.postMessage({ type: "ready", port: actualPort });
  }
  if (config.localDocker) {
    localDockerProxy = createLocalDockerProxy(config.port);
    await new Promise<void>((resolveListen, rejectListen) => {
      localDockerProxy!.once("error", rejectListen);
      localDockerProxy!.listen(config.localDockerPort, "0.0.0.0", resolveListen);
    });
    app.log.info({ port: config.localDockerPort }, "Loopback-published Docker local web proxy started");
  }
} catch (error) {
  app.log.error({ err: error }, "Kudu failed to start");
  if (localDockerProxy) {
    await new Promise<void>(resolveClose => localDockerProxy!.close(() => resolveClose()));
  }
  await database.close();
  process.exitCode = 1;
}
