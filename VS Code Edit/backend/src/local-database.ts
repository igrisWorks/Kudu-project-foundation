import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "./database.js";
import { runMigrations } from "./migration-runner.js";

export interface LocalDatabaseSettings {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export interface SafeLocalDatabaseSettings {
  host: string;
  port: number;
  database: string;
  username: string;
  passwordConfigured: boolean;
}

export interface LocalDatabaseStatus {
  configured: boolean;
  connected: boolean;
  migrationState: "not_configured" | "unavailable" | "not_initialized" | "current" | "pending";
  pendingMigrations: string[];
  checkedAt: string;
  error?: string;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultSettingsPath = resolve(root, ".kudu-local-database.json");
const migrationsDirectory = resolve(root, "database/migrations");
const databaseNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function settingsPath(): string {
  const configured = process.env.KUDU_LOCAL_DATABASE_SETTINGS_PATH?.trim();
  return configured ? resolve(root, configured) : defaultSettingsPath;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function validateLocalDatabaseSettings(
  value: unknown,
  options: { allowRemoteHosts?: boolean } = {},
): LocalDatabaseSettings {
  if (!value || typeof value !== "object") throw new Error("Enter database connection details.");
  const input = value as Record<string, unknown>;
  const host = typeof input.host === "string" ? input.host.trim() : "";
  const port = typeof input.port === "number" ? input.port : Number(input.port);
  const database = typeof input.database === "string" ? input.database.trim() : "";
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const normalizedHost = host.replace(/^\[|\]$/g, "");
  const validRemoteHost = options.allowRemoteHosts === true && (
    isIP(normalizedHost) !== 0 ||
    normalizedHost.length <= 253 &&
      normalizedHost.split(".").every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  );
  if (
    !host || host.length > 253 || /[\s/\\@?#]/.test(host) ||
    (!isLoopbackHost(host) && !validRemoteHost) ||
    (options.allowRemoteHosts && ["0.0.0.0", "::"].includes(normalizedHost))
  ) {
    throw new Error(options.allowRemoteHosts
      ? "Database host must be a valid PostgreSQL hostname or IP address."
      : "Database host must be a loopback address such as 127.0.0.1 or localhost.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Database port must be an integer between 1 and 65535.");
  }
  if (!databaseNamePattern.test(database)) {
    throw new Error("Database name must start with a letter or underscore and contain only letters, numbers, and underscores.");
  }
  if (!databaseNamePattern.test(username)) {
    throw new Error("Database username must start with a letter or underscore and contain only letters, numbers, and underscores.");
  }
  if (Buffer.byteLength(password, "utf8") > 1024) {
    throw new Error("Database password is too long.");
  }
  return { host, port, database, username, password };
}

export function settingsFromDatabaseUrl(
  databaseUrl: string,
  options: { allowRemoteHosts?: boolean } = {},
): LocalDatabaseSettings {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("The configured PostgreSQL URL is invalid.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("The configured URL must use PostgreSQL.");
  }
  return validateLocalDatabaseSettings({
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\/+/, "")),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  }, options);
}

function connectionString(settings: LocalDatabaseSettings): string {
  const url = new URL("postgresql://localhost");
  url.hostname = settings.host.replace(/^\[|\]$/g, "");
  url.port = String(settings.port);
  url.username = settings.username;
  url.password = settings.password;
  url.pathname = `/${settings.database}`;
  return url.toString();
}

function createPool(settings: LocalDatabaseSettings): Pool {
  return new Pool({
    connectionString: connectionString(settings),
    application_name: "kuduns-local",
    max: 10,
    connectionTimeoutMillis: 4_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 8_000,
    statement_timeout: 8_000,
  });
}

export function safeLocalDatabaseError(error: unknown): string {
  if (error instanceof Error && (
    error.message.startsWith("Kudu application role") ||
    error.message.startsWith("A new Kudu database role") ||
    error.message === "Enter a valid PostgreSQL administrator username and password."
  )) return error.message;
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
    return "PostgreSQL is not reachable at this address and port. Check that the local service is running.";
  }
  if (code === "28P01" || /password authentication failed/i.test(error instanceof Error ? error.message : "")) {
    return "PostgreSQL rejected these credentials. Check the database username and password.";
  }
  if (code === "3D000" || /database .* does not exist/i.test(error instanceof Error ? error.message : "")) {
    return "The database does not exist. Create it with your PostgreSQL administrator, then retry.";
  }
  if (["EACCES", "EPERM", "EROFS", "ENOSPC"].includes(code)) {
    return "Kudu cannot write its protected settings file. Check the settings volume ownership and free space.";
  }
  if (code === "42501" || /permission denied/i.test(error instanceof Error ? error.message : "")) {
    return "The database role lacks required permissions. Grant the dedicated Kudu role access and retry.";
  }
  if (/^[0-9A-Z]{5}$/.test(code)) {
    return `PostgreSQL reported error ${code}. Check database permissions and migration status.`;
  }
  return "PostgreSQL connection or migration failed. Check the local service, role permissions, and migration status.";
}

const safeConnectionError = safeLocalDatabaseError;

async function verifyApplicationRole(pool: Pool): Promise<void> {
  const result = await pool.query<{
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(`
    SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    FROM pg_roles
    WHERE rolname = current_user
  `);
  const role = result.rows[0];
  if (!role) throw new Error("Kudu application role could not be verified.");
  if (role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls) {
    throw new Error("Kudu application role has elevated PostgreSQL privileges. Use a dedicated least-privilege role.");
  }
}

async function runCommand(file: string, args: string[], input?: string): Promise<{ code: number; output: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.once("error", reject);
    child.once("close", code => resolvePromise({ code: code ?? 1, output }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function transformWindowsSecret(value: string, protect: boolean): Promise<string> {
  const operation = protect
    ? "[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)"
    : "[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)";
  const script = `$ErrorActionPreference='Stop'; $inputText=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($inputText); $result=${operation}; [Convert]::ToBase64String($result)`;
  const result = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], Buffer.from(value, "utf8").toString("base64"));
  if (result.code !== 0 || !result.output.trim()) {
    throw new Error("Windows current-user credential protection is unavailable; no database credential was saved.");
  }
  try {
    const raw = Buffer.from(result.output.trim(), "base64");
    return protect ? raw.toString("base64") : raw.toString("utf8");
  } catch {
    throw new Error("Windows could not read the protected local database settings.");
  }
}

async function secureFile(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await (await import("node:fs/promises")).chmod(path, 0o600);
    return;
  }
  const identity = await runCommand("whoami.exe", []);
  const principal = identity.output.trim().split(/\r?\n/).at(-1);
  if (identity.code !== 0 || !principal || /[;&|<>]/.test(principal)) {
    throw new Error("Could not determine the current Windows user to secure the local database settings file.");
  }
  const acl = await runCommand("icacls.exe", [
    path,
    "/inheritance:r",
    "/grant:r",
    `${principal}:F`,
    "/grant:r",
    "*S-1-5-18:F",
  ]);
  if (acl.code !== 0) {
    throw new Error("Windows could not restrict access to the local database settings file. No credentials were saved.");
  }
}

async function readStoredSettings(allowRemoteHosts = false): Promise<LocalDatabaseSettings | null> {
  const path = settingsPath();
  try {
    const info = await stat(path);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error("The local database settings file has permissions that are too broad. Restrict it to the current user.");
    }
    const envelope: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!envelope || typeof envelope !== "object" || !("encoding" in envelope) || !("settings" in envelope)) {
      throw new Error("The local database settings file has an unsupported format.");
    }
    const record = envelope as { encoding?: unknown; settings?: unknown; host?: unknown; port?: unknown };
    let parsed: unknown;
    if (process.platform === "win32" && record.encoding === "dpapi-current-user" && typeof record.settings === "string") {
      parsed = JSON.parse(await transformWindowsSecret(record.settings, false));
    } else if (process.platform !== "win32" && record.encoding === "restricted-file") {
      parsed = record.settings;
    } else {
      throw new Error("The local database settings are protected for a different operating system or user.");
    }
    return validateLocalDatabaseSettings(parsed, { allowRemoteHosts });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new Error("The local database settings file is invalid. Move it aside and re-enter the connection in Settings.");
    }
    throw error;
  }
}

async function writeStoredSettings(settings: LocalDatabaseSettings): Promise<void> {
  const path = settingsPath();
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const json = JSON.stringify(settings);
  const envelope = process.platform === "win32"
    ? {
        encoding: "dpapi-current-user",
        host: settings.host,
        port: settings.port,
        settings: await transformWindowsSecret(json, true),
      }
    : { encoding: "restricted-file", settings };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await secureFile(temporaryPath);
    await handle.writeFile(JSON.stringify(envelope), "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await secureFile(path);
}

function safeSettings(settings: LocalDatabaseSettings | null): SafeLocalDatabaseSettings {
  return {
    host: settings?.host ?? "127.0.0.1",
    port: settings?.port ?? 5432,
    database: settings?.database ?? "kudu",
    username: settings?.username ?? "kudu",
    passwordConfigured: Boolean(settings?.password),
  };
}

interface ActiveDatabase {
  pool: Pool;
  db: Kysely<Database>;
  settings: LocalDatabaseSettings;
}

export class LocalDatabaseManager {
  private active: ActiveDatabase | null = null;
  private configuredSettings: LocalDatabaseSettings | null = null;
  private lastError: string | undefined;
  private lastCheckedAt = new Date().toISOString();

  readonly db: Kysely<Database>;

  private constructor(
    initialSettings: LocalDatabaseSettings | null,
    private readonly allowRemoteHosts: boolean,
  ) {
    this.configuredSettings = initialSettings;
    if (initialSettings) this.active = this.createActive(initialSettings);
    this.db = new Proxy({} as Kysely<Database>, {
      get: (_target, property) => {
        const current = this.active?.db;
        if (!current) throw new Error("The local PostgreSQL connection is not configured.");
        const value = Reflect.get(current, property, current) as unknown;
        return typeof value === "function" ? value.bind(current) : value;
      },
    });
  }

  static async create(
    initialDatabaseUrl?: string,
    options: { allowRemoteHosts?: boolean } = {},
  ): Promise<LocalDatabaseManager> {
    const allowRemoteHosts = options.allowRemoteHosts === true;
    const storedSettings = await readStoredSettings(allowRemoteHosts);
    const initialSettings = storedSettings ?? (
      initialDatabaseUrl
        ? settingsFromDatabaseUrl(initialDatabaseUrl, { allowRemoteHosts })
        : null
    );
    return new LocalDatabaseManager(initialSettings, allowRemoteHosts);
  }

  private createActive(settings: LocalDatabaseSettings): ActiveDatabase {
    const pool = createPool(settings);
    pool.on("error", error => {
      this.lastError = safeConnectionError(error);
      this.lastCheckedAt = new Date().toISOString();
    });
    return {
      pool,
      db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
      settings,
    };
  }

  settingsFromInput(value: unknown): LocalDatabaseSettings {
    const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const password = typeof input.password === "string" && input.password.length > 0
      ? input.password
      : this.configuredSettings?.password ?? "";
    return validateLocalDatabaseSettings({ ...input, password }, {
      allowRemoteHosts: this.allowRemoteHosts,
    });
  }

  async initializeMissingObjects(
    settings: LocalDatabaseSettings,
    adminUsername: string,
    adminPassword: string,
  ): Promise<void> {
    if (!databaseNamePattern.test(adminUsername) || Buffer.byteLength(adminPassword, "utf8") > 1024) {
      throw new Error("Enter a valid PostgreSQL administrator username and password.");
    }
    const adminSettings: LocalDatabaseSettings = {
      ...settings,
      database: "postgres",
      username: adminUsername,
      password: adminPassword,
    };
    const adminPool = createPool(adminSettings);
    let candidate: ActiveDatabase | undefined;
    let temporaryCreateGranted = false;
    let initializationError: unknown;
    try {
      const state = await adminPool.query<{ role_exists: boolean; database_exists: boolean }>(
        `SELECT
          EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS role_exists,
          EXISTS (SELECT 1 FROM pg_database WHERE datname = $2) AS database_exists`,
        [settings.username, settings.database],
      );
      const roleExists = state.rows[0]?.role_exists === true;
      const databaseExists = state.rows[0]?.database_exists === true;
      if (roleExists) {
        const privilegeResult = await adminPool.query<{
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolreplication: boolean;
          rolbypassrls: boolean;
        }>(
          `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
           FROM pg_roles WHERE rolname = $1`,
          [settings.username],
        );
        const role = privilegeResult.rows[0];
        if (role?.rolsuper || role?.rolcreatedb || role?.rolcreaterole || role?.rolreplication || role?.rolbypassrls) {
          throw new Error("Kudu application role has elevated PostgreSQL privileges. Use a dedicated least-privilege role.");
        }
      }

      if (!roleExists) {
        if (Buffer.byteLength(settings.password, "utf8") < 12) {
          throw new Error("A new Kudu database role needs an application password of at least 12 UTF-8 bytes.");
        }
        const roleDdl = await adminPool.query<{ statement: string }>(
          "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS statement",
          [settings.username, settings.password],
        );
        await adminPool.query(roleDdl.rows[0]!.statement);
      }

      if (!databaseExists) {
        const databaseDdl = await adminPool.query<{ statement: string }>(
          "SELECT format('CREATE DATABASE %I OWNER %I', $1::text, $2::text) AS statement",
          [settings.database, adminUsername],
        );
        await adminPool.query(databaseDdl.rows[0]!.statement);
      }
      const grantDdl = await adminPool.query<{ statement: string }>(
        "SELECT format('GRANT CONNECT, CREATE ON DATABASE %I TO %I', $1::text, $2::text) AS statement",
        [settings.database, settings.username],
      );
      await adminPool.query(grantDdl.rows[0]!.statement);
      temporaryCreateGranted = true;
      const targetAdminPool = createPool({ ...adminSettings, database: settings.database });
      try {
        const schema = await targetAdminPool.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'kudu') AS exists",
        );
        if (schema.rows[0]?.exists) {
          const schemaGrant = await targetAdminPool.query<{ statement: string }>(
            "SELECT format('GRANT USAGE, CREATE ON SCHEMA kudu TO %I', $1::text) AS statement",
            [settings.username],
          );
          await targetAdminPool.query(schemaGrant.rows[0]!.statement);
          for (const sql of [
            "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA kudu TO %I",
            "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA kudu TO %I",
          ]) {
            const grant = await targetAdminPool.query<{ statement: string }>(
              "SELECT format($1::text, $2::text) AS statement",
              [sql, settings.username],
            );
            await targetAdminPool.query(grant.rows[0]!.statement);
          }
        }
      } finally {
        await targetAdminPool.end();
      }

      candidate = await this.prepareActive(settings);
    } catch (error) {
      initializationError = error;
    } finally {
      if (temporaryCreateGranted) {
        try {
          const revokeDdl = await adminPool.query<{ statement: string }>(
            "SELECT format('REVOKE CREATE ON DATABASE %I FROM %I', $1::text, $2::text) AS statement",
            [settings.database, settings.username],
          );
          await adminPool.query(revokeDdl.rows[0]!.statement);
        } catch (error) {
          initializationError ??= error;
        }
      }
      await adminPool.end();
    }
    if (initializationError) {
      await candidate?.db.destroy().catch(() => undefined);
      throw new Error(safeConnectionError(initializationError));
    }
    if (!candidate) throw new Error("PostgreSQL initialization did not produce a verified application connection.");
    await this.persistAndActivate(settings, candidate);
  }

  async test(settings: LocalDatabaseSettings): Promise<void> {
    const candidate = createPool(settings);
    try {
      await candidate.query("select 1");
      await verifyApplicationRole(candidate);
    } catch (error) {
      throw new Error(safeConnectionError(error));
    } finally {
      await candidate.end();
    }
    this.lastError = undefined;
    this.lastCheckedAt = new Date().toISOString();
  }

  async save(settings: LocalDatabaseSettings): Promise<void> {
    const candidate = await this.prepareActive(settings);
    await this.persistAndActivate(settings, candidate);
  }

  private async prepareActive(settings: LocalDatabaseSettings): Promise<ActiveDatabase> {
    const candidate = this.createActive(settings);
    try {
      await candidate.pool.query("select 1");
      await verifyApplicationRole(candidate.pool);
      await runMigrations(candidate.pool, migrationsDirectory);
    } catch (error) {
      await candidate.db.destroy().catch(() => undefined);
      this.lastError = safeConnectionError(error);
      this.lastCheckedAt = new Date().toISOString();
      throw new Error(this.lastError);
    }
    return candidate;
  }

  private async persistAndActivate(settings: LocalDatabaseSettings, candidate: ActiveDatabase): Promise<void> {
    try {
      await writeStoredSettings(settings);
    } catch (error) {
      await candidate.db.destroy().catch(() => undefined);
      this.lastError = safeConnectionError(error);
      this.lastCheckedAt = new Date().toISOString();
      throw new Error(this.lastError);
    }
    const previous = this.active;
    this.active = candidate;
    this.configuredSettings = settings;
    this.lastError = undefined;
    this.lastCheckedAt = new Date().toISOString();
    if (previous) await previous.db.destroy().catch(() => undefined);
  }

  async migrate(): Promise<string[]> {
    if (!this.active) throw new Error("Save a working PostgreSQL connection before applying migrations.");
    try {
      const applied = await runMigrations(this.active.pool, migrationsDirectory);
      this.lastError = undefined;
      this.lastCheckedAt = new Date().toISOString();
      return applied;
    } catch (error) {
      this.lastError = safeConnectionError(error);
      this.lastCheckedAt = new Date().toISOString();
      throw new Error(this.lastError);
    }
  }

  async status(): Promise<{
    settings: SafeLocalDatabaseSettings;
    status: LocalDatabaseStatus;
  }> {
    const settings = safeSettings(this.configuredSettings);
    if (!this.active) {
      return {
        settings,
        status: {
          configured: this.configuredSettings !== null,
          connected: false,
          migrationState: this.configuredSettings ? "unavailable" : "not_configured",
          pendingMigrations: [],
          checkedAt: this.lastCheckedAt,
          error: this.lastError ?? "Set a local PostgreSQL connection to enable data features.",
        },
      };
    }
    try {
      await this.active.pool.query("select 1");
      await verifyApplicationRole(this.active.pool);
      const applied = await this.active.pool.query<{ name: string }>(
        "SELECT name FROM kudu.schema_migrations ORDER BY name",
      ).catch(error => {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "";
        if (code === "42P01" || code === "3F000") return { rows: [] as { name: string }[] };
        throw error;
      });
      const { readdir } = await import("node:fs/promises");
      const migrationFiles = (await readdir(migrationsDirectory)).filter(name => name.endsWith(".sql")).sort();
      const appliedNames = new Set(applied.rows.map(row => row.name));
      const pendingMigrations = migrationFiles.filter(name => !appliedNames.has(name));
      this.lastError = undefined;
      this.lastCheckedAt = new Date().toISOString();
      const migrationState = pendingMigrations.length > 0
        ? (applied.rows.length === 0 ? "not_initialized" : "pending")
        : "current";
      return {
        settings,
        status: {
          configured: true,
          connected: true,
          migrationState,
          pendingMigrations,
          checkedAt: this.lastCheckedAt,
        },
      };
    } catch (error) {
      this.lastError = safeConnectionError(error);
      this.lastCheckedAt = new Date().toISOString();
      return {
        settings,
        status: {
          configured: true,
          connected: false,
          migrationState: "unavailable",
          pendingMigrations: [],
          checkedAt: this.lastCheckedAt,
          error: this.lastError,
        },
      };
    }
  }

  async initialize(): Promise<void> {
    if (!this.active) return;
    try {
      await this.active.pool.query("select 1");
      await verifyApplicationRole(this.active.pool);
      await runMigrations(this.active.pool, migrationsDirectory);
      this.lastError = undefined;
    } catch (error) {
      this.lastError = safeConnectionError(error);
      if (error instanceof Error && error.message.includes("elevated PostgreSQL privileges")) {
        const rejected = this.active;
        this.active = null;
        await rejected?.db.destroy().catch(() => undefined);
      }
    }
    this.lastCheckedAt = new Date().toISOString();
  }

  async close(): Promise<void> {
    if (this.active) await this.active.db.destroy();
  }
}

