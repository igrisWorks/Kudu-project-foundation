import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { sql } from "kysely";
import { createSqliteDatabase, verifySqliteIntegrity, type SqliteDatabaseHandle } from "./sqlite-database.js";

const backupNamePattern = /^kuduns-[A-Za-z0-9TZ-]+-[0-9a-f-]+\.db$/i;
const dataTables = [
  {
    name: "assets",
    columns: [
      "id", "asset_key", "name", "asset_type", "description", "parent_asset_id",
      "external_identifiers", "created_at", "updated_at", "archived_at",
    ],
  },
  {
    name: "data_sources",
    columns: [
      "id", "source_key", "display_name", "source_type", "description", "configuration",
      "enabled", "connection_status", "ingestion_status", "last_successful_sync_at",
      "last_error_summary", "created_at", "updated_at",
    ],
  },
  {
    name: "events",
    columns: [
      "id", "source_id", "asset_id", "source_record_id", "event_type", "occurred_at",
      "ingested_at", "source_timestamp", "deduplication_key", "ingestion_fingerprint",
      "payload", "provenance",
    ],
  },
  {
    name: "data_source_event_mappings",
    columns: [
      "id", "source_id", "version", "status", "definition", "validation_errors",
      "validated_at", "activated_at", "created_at", "updated_at",
    ],
  },
  {
    name: "data_source_sync_runs",
    columns: [
      "id", "source_id", "mapping_version", "status", "resumable", "request_succeeded", "config_fingerprint",
      "checkpoint", "pages_completed", "fetched", "imported", "duplicates", "failed", "errors",
      "errors_truncated", "last_error_code", "started_at", "updated_at", "completed_at",
    ],
  },
] as const;

export interface LocalDatabaseBackup {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  createdAt: string;
}

export interface LocalDatabaseStatus {
  engine: "SQLite";
  connected: true;
  filePath: string;
  dataDirectory: string;
  backupsDirectory: string;
  sqliteVersion: string;
  schemaVersion: string;
  migrationState: "current";
  integrity: "ok";
  lastSuccessfulInitialization: string | null;
}

export class LocalDatabaseManager {
  private readonly initializedAt = new Date().toISOString();
  private maintenance = false;
  private activeMutations = 0;
  private constructor(private readonly handle: SqliteDatabaseHandle) {}

  static async create(dataDirectory?: string): Promise<LocalDatabaseManager> {
    const handle = dataDirectory
      ? await createSqliteDatabase(dataDirectory)
      : await createSqliteDatabase();
    return new LocalDatabaseManager(handle);
  }

  get db() {
    return this.handle.db;
  }

  get filePath(): string {
    return this.handle.filePath;
  }

  tryBeginMutation(): boolean {
    if (this.maintenance) return false;
    this.activeMutations += 1;
    return true;
  }

  endMutation(): void {
    this.activeMutations = Math.max(0, this.activeMutations - 1);
  }

  async initialize(): Promise<void> {
    await sql`select 1`.execute(this.db);
    verifySqliteIntegrity(this.handle.raw);
  }

  async status(): Promise<LocalDatabaseStatus> {
    await sql`select 1`.execute(this.db);
    const sqliteVersion = this.handle.raw.prepare("SELECT sqlite_version() AS version").get() as {
      version: string;
    };
    const latestMigration = this.handle.raw.prepare(
      "SELECT name, applied_at FROM app_schema_migrations ORDER BY name DESC LIMIT 1",
    ).get() as { name: string; applied_at: string } | undefined;
    return {
      engine: "SQLite",
      connected: true,
      filePath: this.handle.filePath,
      dataDirectory: dirname(this.handle.filePath),
      backupsDirectory: this.handle.backupsDirectory,
      sqliteVersion: sqliteVersion.version,
      schemaVersion: latestMigration?.name ?? "none",
      migrationState: "current",
      integrity: "ok",
      lastSuccessfulInitialization: this.initializedAt,
    };
  }

  async listBackups(): Promise<LocalDatabaseBackup[]> {
    await mkdir(this.handle.backupsDirectory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.handle.backupsDirectory, { withFileTypes: true });
    const backups: LocalDatabaseBackup[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !backupNamePattern.test(entry.name)) continue;
      const filePath = join(this.handle.backupsDirectory, entry.name);
      const info = await stat(filePath);
      backups.push({
        fileName: entry.name,
        filePath,
        sizeBytes: info.size,
        createdAt: info.mtime.toISOString(),
      });
    }
    return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createBackup(): Promise<LocalDatabaseBackup> {
    await mkdir(this.handle.backupsDirectory, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `kuduns-${stamp}-${randomUUID()}.db`;
    const filePath = join(this.handle.backupsDirectory, fileName);
    await this.handle.raw.backup(filePath);
    const validation = new BetterSqlite3(filePath, { readonly: true, fileMustExist: true });
    try { verifySqliteIntegrity(validation); } finally { validation.close(); }
    if (process.platform !== "win32") await chmod(filePath, 0o600);
    const info = await stat(filePath);
    return {
      fileName,
      filePath,
      sizeBytes: info.size,
      createdAt: info.mtime.toISOString(),
    };
  }

  async restoreBackup(fileName: string): Promise<{ restored: LocalDatabaseBackup; safetyBackup: LocalDatabaseBackup }> {
    if (this.maintenance) throw new Error("Another restore is already in progress.");
    this.maintenance = true;
    try {
      const deadline = Date.now() + 30_000;
      while (this.activeMutations > 0) {
        if (Date.now() > deadline) throw new Error("Active imports or writes did not finish. Wait for them to complete before restoring.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    if (basename(fileName) !== fileName || !backupNamePattern.test(fileName)) {
      throw new Error("Choose a backup created by KuduNS.");
    }
    const selectedPath = join(this.handle.backupsDirectory, fileName);
    if (!(await lstat(selectedPath)).isFile()) throw new Error("Choose a regular KuduNS backup file.");
    const selected = new BetterSqlite3(selectedPath, { readonly: true, fileMustExist: true });
    try {
      verifySqliteIntegrity(selected);
      const hasMigrationHistory = selected.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_schema_migrations'",
      ).get();
      if (!hasMigrationHistory) throw new Error("This backup does not contain KuduNS migration history.");
      const historySql = "SELECT name, checksum FROM app_schema_migrations ORDER BY name";
      if (JSON.stringify(selected.prepare(historySql).all()) !== JSON.stringify(this.handle.raw.prepare(historySql).all())) {
        throw new Error("This backup uses a different application schema. Open a copy with the matching KuduNS version and migrate it before restoring; the current database was not changed.");
      }
    } finally {
      selected.close();
    }

    const safetyBackup = await this.createBackup();
    try {
      this.replaceDataFromBackup(selectedPath);
    } catch (restoreError) {
      throw new Error(
        `Restore was rolled back atomically; current data was not replaced. Safety backup: ${safetyBackup.filePath}. ${restoreError instanceof Error ? restoreError.message : "The backup could not be restored."}`,
      );
    }
    const restored = (await this.listBackups()).find((backup) => backup.fileName === fileName);
    if (!restored) throw new Error("The selected backup disappeared after restore.");
    return { restored, safetyBackup };
    } finally {
      this.maintenance = false;
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  private replaceDataFromBackup(sourcePath: string): void {
    const attach = this.handle.raw.prepare("ATTACH DATABASE ? AS restore_source");
    attach.run(sourcePath);
    try {
      const replace = this.handle.raw.transaction(() => {
        this.handle.raw.pragma("defer_foreign_keys = ON");
        this.handle.raw.exec(`
          DELETE FROM events;
          DELETE FROM data_source_sync_runs;
          DELETE FROM data_source_event_mappings;
          DELETE FROM data_sources;
          DELETE FROM assets;
        `);
        for (const table of dataTables) {
          const columns = table.columns.join(", ");
          this.handle.raw.exec(
            `INSERT INTO main.${table.name} (${columns}) SELECT ${columns} FROM restore_source.${table.name}`,
          );
        }
        this.handle.raw.exec(`
          DELETE FROM app_schema_migrations;
          INSERT INTO app_schema_migrations (name, checksum, applied_at)
            SELECT name, checksum, applied_at FROM restore_source.app_schema_migrations;
        `);
        verifySqliteIntegrity(this.handle.raw);
      });
      replace.immediate();
    } finally {
      this.handle.raw.exec("DETACH DATABASE restore_source");
    }
  }
}
