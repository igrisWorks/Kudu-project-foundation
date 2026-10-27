import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./database.js";

const config = loadConfig(process.env);
const { db, close } = createDatabase(config.databaseUrl);
const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const staticDirectory = resolve(currentDirectory, "../../frontend/dist");
const app = await createApp({ db, staticDirectory, logLevel: config.logLevel });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down Kudu");
  await app.close();
  await close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, "Kudu failed to start");
  await close();
  process.exitCode = 1;
}
