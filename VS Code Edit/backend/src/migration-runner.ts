import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool } from "pg";

interface AppliedMigration {
  name: string;
  checksum: string;
}

const migrationNamePattern = /^\d{4}_[a-z0-9_]+\.sql$/;

export async function runMigrations(
  pool: Pool,
  migrationsDirectory: string,
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS kudu");
    await client.query(`
      CREATE TABLE IF NOT EXISTS kudu.schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  } finally {
    client.release();
  }

  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  for (const filename of filenames) {
    if (!migrationNamePattern.test(filename)) {
      throw new Error(`Invalid migration filename: ${filename}`);
    }
  }

  const appliedResult = await pool.query<AppliedMigration>(
    "SELECT name, checksum FROM kudu.schema_migrations ORDER BY name",
  );
  const applied = new Map(appliedResult.rows.map((migration) => [migration.name, migration.checksum]));
  const migrationNames = new Set(filenames);

  for (const name of applied.keys()) {
    if (!migrationNames.has(name)) {
      throw new Error(`Applied migration ${name} is missing from database/migrations.`);
    }
  }

  const newlyApplied: string[] = [];
  for (const filename of filenames) {
    const contents = await readFile(resolve(migrationsDirectory, filename), "utf8");
    const checksum = createHash("sha256").update(contents).digest("hex");
    const existingChecksum = applied.get(filename);
    if (existingChecksum) {
      if (existingChecksum !== checksum) {
        throw new Error(`Applied migration ${filename} has changed. Add a new migration instead.`);
      }
      continue;
    }

    const migrationClient = await pool.connect();
    try {
      await migrationClient.query("BEGIN");
      await migrationClient.query("SELECT pg_advisory_xact_lock(7224, 1)");
      const concurrentCheck = await migrationClient.query<{ checksum: string }>(
        "SELECT checksum FROM kudu.schema_migrations WHERE name = $1",
        [filename],
      );
      if (concurrentCheck.rowCount) {
        if (concurrentCheck.rows[0]?.checksum !== checksum) {
          throw new Error(`Applied migration ${filename} has changed.`);
        }
        await migrationClient.query("COMMIT");
        continue;
      }

      await migrationClient.query(contents);
      await migrationClient.query(
        "INSERT INTO kudu.schema_migrations (name, checksum) VALUES ($1, $2)",
        [filename, checksum],
      );
      await migrationClient.query("COMMIT");
      newlyApplied.push(filename);
    } catch (error) {
      await migrationClient.query("ROLLBACK");
      throw error;
    } finally {
      migrationClient.release();
    }
  }
  return newlyApplied;
}
