import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { sql } from "kysely";
import { createSqliteDatabase, runSqliteMigrations, verifySqliteIntegrity, type SqliteDatabaseHandle } from "./sqlite-database.js";

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

  async initialize(): Promise<void> {
    await sql`select 1`.execute(this.db);
    verifySqliteIntegrity(this.handle.raw);
  }

  async status(): Promise<LocalDatabaseStatus> {
    await sql`select 1`.execute(this.db);
    verifySqliteIntegrity(this.handle.raw);
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
      lastSuccessfulInitialization: latestMigration?.applied_at ?? null,
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
    if (basename(fileName) !== fileName || !backupNamePattern.test(fileName)) {
      throw new Error("Choose a backup created by KuduNS.");
    }
    const selectedPath = join(this.handle.backupsDirectory, fileName);
    const selected = new BetterSqlite3(selectedPath, { readonly: true, fileMustExist: true });
    try {
      verifySqliteIntegrity(selected);
      const hasMigrationHistory = selected.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_schema_migrations'",
      ).get();
      if (!hasMigrationHistory) throw new Error("This backup does not contain KuduNS migration history.");
    } finally {
      selected.close();
    }

    const safetyBackup = await this.createBackup();
    try {
      this.replaceDataFromBackup(selectedPath);
      await runSqliteMigrations(this.handle.raw, this.handle.migrationsDirectory);
      verifySqliteIntegrity(this.handle.raw);
    } catch (restoreError) {
      try {
        this.replaceDataFromBackup(safetyBackup.filePath);
        await runSqliteMigrations(this.handle.raw, this.handle.migrationsDirectory);
        verifySqliteIntegrity(this.handle.raw);
      } catch (rollbackError) {
        throw new AggregateError(
          [restoreError, rollbackError],
          "Restore failed, and automatic recovery from the safety backup also failed. Keep all database and backup files unchanged.",
        );
      }
      throw new Error(
        `Restore was not applied. The current database was restored from its safety backup. ${restoreError instanceof Error ? restoreError.message : "The backup could not be restored."}`,
      );
    }
    const restored = (await this.listBackups()).find((backup) => backup.fileName === fileName);
    if (!restored) throw new Error("The selected backup disappeared after restore.");
    return { restored, safetyBackup };
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  private replaceDataFromBackup(sourcePath: string): void {
    const attach = this.handle.raw.prepare("ATTACH DATABASE ? AS restore_source");
    attach.run(sourcePath);
    try {
      const replace = this.handle.raw.transaction(() => {
        this.handle.raw.exec(`
          DELETE FROM events;
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
      });
      replace.immediate();
    } finally {
      this.handle.raw.exec("DETACH DATABASE restore_source");
    }
  }
}
