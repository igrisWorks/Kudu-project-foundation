import { pathToFileURL } from "node:url";
import { Pool, type QueryResult } from "pg";
import { createSqliteDatabase, lockSqliteWrite, sqliteTimestamp, verifySqliteIntegrity } from "./sqlite-database.js";

const tables = [
  "assets",
  "data_sources",
  "events",
  "data_source_event_mappings",
  "data_source_sync_runs",
  "source_sync_runs",
  "source_records",
] as const;
const jsonFields = new Set([
  "external_identifiers", "configuration", "payload", "provenance", "definition", "validation_errors",
  "checkpoint", "errors", "raw_record", "field_names", "preview",
]);
const timestampFields: Record<(typeof tables)[number], string[]> = {
  assets: ["created_at", "updated_at", "archived_at"],
  data_sources: ["created_at", "updated_at", "last_successful_sync_at"],
  events: ["occurred_at", "ingested_at"],
  data_source_event_mappings: ["created_at", "updated_at", "validated_at", "activated_at"],
  data_source_sync_runs: ["started_at", "updated_at", "completed_at"],
  source_sync_runs: ["started_at", "updated_at", "completed_at"],
  source_records: ["ingested_at"],
};

/** Explicit, read-only source import. Never runs during normal Local startup. */
export async function importPostgresLocal(connectionString: string, dataDirectory?: string) {
  const destination = await createSqliteDatabase(dataDirectory);
  const pool = new Pool({ connectionString, max: 1, application_name: "kuduns-readonly-local-import" });
  const counts: Record<string, number> = {};
  try {
    const source = await pool.connect();
    try {
      await source.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await destination.db.transaction().execute(async transaction => {
        await lockSqliteWrite(transaction);
        for (const table of tables) {
          const current = destination.raw.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
          if (current.count !== 0) throw new Error("The SQLite destination already contains application data. Import requires an empty destination; no data was changed.");
        }
        destination.raw.pragma("defer_foreign_keys = ON");
        for (const table of tables) {
          counts[table] = 0;
          let cursor: string | null = null;
          const allowed = new Set((destination.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(item => item.name));
          const timestamps = timestampFields[table].map(column =>
            `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`,
          ).join(", ");
          while (true) {
            const result: QueryResult<Record<string, unknown>> = await source.query(
              `SELECT *, ${timestamps} FROM kudu.${table}
               WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 500`,
              [cursor],
            );
            if (result.rows.length === 0) break;
            for (const row of result.rows as Record<string, unknown>[]) {
              const columns = Object.keys(row);
              // Column identifiers come only from the fixed, application-owned source schema.
              if (columns.some(column => !allowed.has(column))) {
                throw new Error(`Legacy ${table} contains columns this application cannot safely import.`);
              }
              const values = columns.map(column => {
                const value = row[column];
                if (value === null) return null;
                if (jsonFields.has(column)) return JSON.stringify(value);
                if (column === "occurred_at") return sqliteTimestamp(String(value));
                if (typeof value === "boolean") return Number(value);
                return value instanceof Date ? value.toISOString() : value;
              });
              destination.raw.prepare(
                `INSERT INTO ${table} (${columns.map(column => `"${column}"`).join(",")})
                 VALUES (${columns.map(() => "?").join(",")})`,
              ).run(...values);
              counts[table]! += 1;
              cursor = String(row.id);
            }
          }
        }
        verifySqliteIntegrity(destination.raw);
      });
      // Source is intentionally rolled back: it is a read-only snapshot, never migrated.
      await source.query("ROLLBACK");
      return { imported: counts, filePath: destination.filePath };
    } finally { source.release(); }
  } finally {
    await pool.end();
    await destination.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceUrl = process.env.KUDU_LEGACY_DATABASE_URL;
  if (!sourceUrl || process.env.KUDU_CONFIRM_LOCAL_IMPORT !== "YES") {
    console.error("Stop KuduNS Local, set KUDU_LEGACY_DATABASE_URL and KUDU_CONFIRM_LOCAL_IMPORT=YES, then run this explicit import again. The destination must be empty.");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await importPostgresLocal(sourceUrl, process.env.KUDU_DATA_DIR), null, 2));
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith("The SQLite destination")
        ? error.message
        : "Legacy PostgreSQL import failed. No source database was changed. SQLite application-data inserts were rolled back. Check source SELECT privileges, schema compatibility and destination file permissions.";
      console.error(message);
      process.exitCode = 1;
    }
  }
}
