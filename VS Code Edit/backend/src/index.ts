import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { LocalDatabaseManager } from "./local-database.js";

const config = loadConfig(process.env);
const localDatabase = config.localMode
  ? await LocalDatabaseManager.create(config.databaseUrl)
  : undefined;
if (localDatabase) await localDatabase.initialize();
const database = localDatabase
  ? { db: localDatabase.db, close: () => localDatabase.close() }
  : createDatabase(config.databaseUrl!);
const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const staticDirectory = resolve(currentDirectory, "../../frontend/dist");
const app = await createApp({
  db: database.db,
  staticDirectory,
  logLevel: config.logLevel,
  auth: config.auth,
  localMode: config.localMode,
  ...(localDatabase ? { localDatabase } : {}),
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down Kudu");
  await app.close();
  await database.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, "Kudu failed to start");
  await database.close();
  process.exitCode = 1;
}
