import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { runMigrations } from "./migration-runner.js";

const config = loadConfig(process.env);
const pool = new Pool({
  connectionString: config.databaseUrl,
  application_name: "kudu-migrations",
  max: 1,
});
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../database/migrations");

try {
  const newlyApplied = await runMigrations(pool, migrationsDirectory);
  for (const migration of newlyApplied) process.stdout.write(`Applied ${migration}\n`);
} catch (error) {
  process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
