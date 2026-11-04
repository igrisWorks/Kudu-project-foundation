import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import {
  Kysely,
  OperationNodeTransformer,
  SqliteDialect,
  ValueNode,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type PrimitiveValueListNode,
  type QueryResult,
  type RootOperationNode,
  type Transaction,
  type UnknownRow,
} from "kysely";
import { sql } from "kysely";
import type { Database } from "./database.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationNamePattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const migrationChecksum = (contents: string): string =>
  createHash("sha256").update(contents).digest("hex");

function migrationChecksums(contents: string): { current: string; accepted: string[] } {
  const normalized = contents.replace(/\r\n?/g, "\n");
  const accepted = [...new Set([
    contents,
    normalized,
    normalized.replace(/\n/g, "\r\n"),
  ].map(migrationChecksum))];
  return { current: migrationChecksum(normalized), accepted };
}

const jsonColumns = new Set([
  "external_identifiers",
  "configuration",
  "payload",
  "provenance",
  "definition",
  "validation_errors",
  "checkpoint",
  "errors",
]);
const booleanColumns = new Set(["enabled", "resumable", "request_succeeded", "errors_truncated"]);
const dateColumns = new Set([
  "created_at",
  "updated_at",
  "archived_at",
  "last_successful_sync_at",
  "ingested_at",
  "validated_at",
  "activated_at",
  "started_at",
  "completed_at",
]);

export interface SqliteDatabaseHandle {
  db: Kysely<Database>;
  raw: BetterSqlite3.Database;
  filePath: string;
  backupsDirectory: string;
  migrationsDirectory: string;
  close(): Promise<void>;
}

export function sqliteTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("A valid timestamp is required.");
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  return `${date.toISOString().slice(0, 19)}.${fraction.padEnd(6, "0").slice(0, 6)}Z`;
}

export function localDataDirectory(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const override = environment.KUDU_DATA_DIR?.trim();
  if (override) {
    if (!isAbsolute(override)) throw new Error("KUDU_DATA_DIR must be an absolute path.");
    return resolve(override);
  }
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA?.trim();
    if (!localAppData) throw new Error("LOCALAPPDATA is not available for KuduNS data storage.");
    return join(localAppData, "KuduNS");
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "KuduNS");
  const xdgDataHome = environment.XDG_DATA_HOME?.trim();
  return join(xdgDataHome && isAbsolute(xdgDataHome) ? xdgDataHome : join(home, ".local", "share"), "KuduNS");
}

class SqliteValueTransformer extends OperationNodeTransformer {
  protected override transformPrimitiveValueList(node: PrimitiveValueListNode): PrimitiveValueListNode {
    return {
      ...node,
      values: node.values.map(value =>
        typeof value === "boolean" ? Number(value) : value instanceof Date ? value.toISOString() : value),
    };
  }

  protected override transformValue(node: ValueNode): ValueNode {
    const transformed = super.transformValue(node);
    if (typeof transformed.value === "boolean") {
      return ValueNode.create(transformed.value ? 1 : 0) as ValueNode;
    }
    if (transformed.value instanceof Date) {
      return ValueNode.create(transformed.value.toISOString()) as ValueNode;
    }
    return transformed;
  }
}

class SqliteValuePlugin implements KyselyPlugin {
  private readonly transformer = new SqliteValueTransformer();

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.transformer.transformNode(args.node);
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return {
      ...args.result,
      rows: args.result.rows.map((source) => {
        const row = { ...source } as Record<string, unknown>;
        for (const [column, value] of Object.entries(row)) {
          if (typeof value === "string" && jsonColumns.has(column)) row[column] = JSON.parse(value) as unknown;
          else if (typeof value === "number" && booleanColumns.has(column)) row[column] = value !== 0;
          else if (typeof value === "string" && dateColumns.has(column)) row[column] = new Date(value);
        }
        return row;
      }),
    };
  }
}

function migrationDirectory(environment: NodeJS.ProcessEnv): string {
  const configured = environment.KUDU_SQLITE_MIGRATIONS_DIR?.trim();
  return configured ? resolve(configured) : resolve(sourceRoot, "database/sqlite-migrations");
}

export async function runSqliteMigrations(
  raw: BetterSqlite3.Database,
  directory: string,
): Promise<string[]> {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS app_schema_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  if (names.some((name) => !migrationNamePattern.test(name))) {
    throw new Error("SQLite migration directory contains an invalid migration filename.");
  }
  const available = new Set(names);
  const appliedRows = raw.prepare("SELECT name, checksum FROM app_schema_migrations ORDER BY name").all() as {
    name: string;
    checksum: string;
  }[];
  const applied = new Map(appliedRows.map((row) => [row.name, row.checksum]));
  for (const name of applied.keys()) {
    if (!available.has(name)) throw new Error(`Applied SQLite migration ${name} is missing from the application.`);
  }

  const executeMigration = raw.transaction((
    name: string,
    checksum: string,
    acceptedChecksums: string[],
    contents: string,
  ) => {
    const current = raw.prepare("SELECT checksum FROM app_schema_migrations WHERE name = ?").get(name) as
      | { checksum: string }
      | undefined;
    if (current) {
      if (!acceptedChecksums.includes(current.checksum)) {
        throw new Error(`Applied SQLite migration ${name} has changed.`);
      }
      return false;
    }
    raw.exec(contents);
    raw.prepare("INSERT INTO app_schema_migrations (name, checksum) VALUES (?, ?)").run(name, checksum);
    return true;
  });

  const newlyApplied: string[] = [];
  for (const name of names) {
    const contents = await readFile(join(directory, name), "utf8");
    const checksums = migrationChecksums(contents);
    if (applied.has(name)) {
      if (!checksums.accepted.includes(applied.get(name)!)) {
        throw new Error(`Applied SQLite migration ${name} has changed.`);
      }
      continue;
    }
    if (executeMigration.immediate(name, checksums.current, checksums.accepted, contents)) {
      newlyApplied.push(name);
    }
  }
  return newlyApplied;
}

export function verifySqliteIntegrity(raw: BetterSqlite3.Database): void {
  const integrity = raw.pragma("integrity_check") as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("The local SQLite database failed its integrity check. The database was not reset or deleted.");
  }
  const foreignKeys = raw.pragma("foreign_key_check") as unknown[];
  if (foreignKeys.length > 0) {
    throw new Error("The local SQLite database contains foreign-key errors. The database was not reset or deleted.");
  }
  const requiredTables = ["assets", "data_sources", "events", "data_source_event_mappings"];
  const present = new Set((raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all() as { name: string }[]).map((row) => row.name));
  if (requiredTables.some((table) => !present.has(table))) {
    throw new Error("The local SQLite database is missing required application tables.");
  }
}

export async function createSqliteDatabase(
  directory = localDataDirectory(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SqliteDatabaseHandle> {
  const dataDirectory = resolve(directory);
  const filePath = join(dataDirectory, "kuduns.db");
  const backupsDirectory = join(dataDirectory, "backups");
  const migrationsDirectory = migrationDirectory(environment);
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await mkdir(backupsDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(dataDirectory, 0o700);
    await chmod(backupsDirectory, 0o700);
  }
  const raw = new BetterSqlite3(filePath, { timeout: 5_000 });
  try {
    raw.pragma("foreign_keys = ON");
    raw.pragma("journal_mode = WAL");
    raw.pragma("busy_timeout = 5000");
    raw.pragma("synchronous = FULL");
    await runSqliteMigrations(raw, migrationsDirectory);
    verifySqliteIntegrity(raw);
    if (process.platform !== "win32") await chmod(filePath, 0o600);
    const db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: raw }),
      plugins: [new SqliteValuePlugin()],
    });
    return {
      db,
      raw,
      filePath,
      backupsDirectory,
      migrationsDirectory,
      close: async () => {
        await db.destroy();
        raw.close();
      },
    };
  } catch (error) {
    raw.close();
    throw error;
  }
}

export function isSqliteDatabase(
  database: Kysely<Database> | Transaction<Database>,
): boolean {
  return database.getExecutor().adapter.constructor.name === "SqliteAdapter";
}

export async function lockSqliteWrite(
  database: Kysely<Database> | Transaction<Database>,
): Promise<void> {
  if (isSqliteDatabase(database)) {
    await sql`UPDATE app_write_lock SET value = value WHERE id = 1`.execute(database);
  }
}
