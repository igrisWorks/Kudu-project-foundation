import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  getLocalDatabase,
  initializeLocalDatabase,
  migrateLocalDatabase,
  saveLocalDatabase,
  testLocalDatabase,
  type LocalDatabaseForm,
  type LocalDatabaseResponse,
} from "../api";

const defaults: LocalDatabaseForm = {
  host: "127.0.0.1",
  port: 5432,
  database: "kudu",
  username: "kudu",
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<LocalDatabaseForm>(defaults);
  const [passwordConfigured, setPasswordConfigured] = useState(false);
  const [adminUsername, setAdminUsername] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [confirmInitialization, setConfirmInitialization] = useState(false);
  const [database, setDatabase] = useState<LocalDatabaseResponse["status"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"test" | "save" | "migrate" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await getLocalDatabase();
      setSettings(current => ({
        ...current,
        host: response.settings.host,
        port: response.settings.port,
        database: response.settings.database,
        username: response.settings.username,
      }));
      setPasswordConfigured(response.settings.passwordConfigured);
      setDatabase(response.status);
      setError("");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Database settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const requestInput = (): LocalDatabaseForm => ({
    ...settings,
    port: Number(settings.port),
    ...(settings.password ? { password: settings.password } : {}),
  });

  const runTest = async () => {
    setBusy("test");
    setError("");
    setMessage("");
    try {
      const response = await testLocalDatabase(requestInput());
      setMessage(response.message);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "PostgreSQL connection test failed.");
    } finally {
      setBusy(null);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("save");
    setError("");
    setMessage("");
    try {
      const response = await saveLocalDatabase(requestInput());
      setDatabase(response.status);
      setPasswordConfigured(response.settings.passwordConfigured);
      setSettings(current => ({ ...current, password: "" }));
      setMessage("Connection saved. PostgreSQL was verified and migrations are current.");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The connection could not be saved.");
    } finally {
      setBusy(null);
    }
  };

  const applyMigrations = async () => {
    setBusy("migrate");
    setError("");
    setMessage("");
    try {
      const response = await migrateLocalDatabase();
      setDatabase(response.status);
      setMessage(response.applied.length
        ? `Applied ${response.applied.length} migration${response.applied.length === 1 ? "" : "s"}.`
        : "Database schema is already current.");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Database migrations could not be applied.");
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const initializeDatabase = async () => {
    setBusy("save");
    setError("");
    setMessage("");
    try {
      const response = await initializeLocalDatabase({
        ...requestInput(),
        adminUsername,
        adminPassword,
        confirm: true,
      });
      setDatabase(response.status);
      setPasswordConfigured(response.settings.passwordConfigured);
      setSettings(current => ({ ...current, password: "" }));
      setAdminPassword("");
      setConfirmInitialization(false);
      setMessage("Missing database objects were created. PostgreSQL was verified and migrations are current.");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The database could not be initialized.");
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const update = (key: keyof LocalDatabaseForm, value: string) => {
    setSettings(current => ({
      ...current,
      [key]: key === "port" ? (value === "" ? 0 : Number(value)) : value,
    }));
  };

  const migrationLabel = database?.migrationState === "current"
    ? "Schema current"
    : database?.migrationState === "not_initialized"
      ? "Not initialized"
      : database?.migrationState === "pending"
        ? "Migrations pending"
        : database?.migrationState === "unavailable"
          ? "Unavailable"
          : "Not configured";

  return <main className="page-main settings-page">
    <div className="page-heading">
      <div>
        <div className="eyebrow"><span className="eyebrow-line" />LOCAL CONFIGURATION</div>
        <h1>Database settings</h1>
        <p>Connect KuduNS to PostgreSQL on this computer. The browser never receives the saved password.</p>
      </div>
    </div>

    <section className="panel settings-panel" aria-labelledby="database-settings-heading">
      <div className="panel-heading">
        <div>
          <p className="section-label">POSTGRESQL</p>
          <h2 id="database-settings-heading">Local database connection</h2>
        </div>
        <span className={`status-pill ${database?.connected ? "good" : "bad"}`} role="status">
          {loading ? "Checking" : database?.connected ? "Connected" : "Disconnected"}
        </span>
      </div>

      {error && <p className="notice error" role="alert">{error}</p>}
      {message && <p className="notice settings-success" role="status">{message}</p>}

      <form className="form-panel settings-form" onSubmit={save}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="db-host">Host or address</label>
            <input id="db-host" value={settings.host} onChange={event => update("host", event.target.value)} autoComplete="off" required />
            <span className="field-hint">Loopback only: 127.0.0.1, ::1, or localhost.</span>
          </div>
          <div className="field">
            <label htmlFor="db-port">Port</label>
            <input id="db-port" type="number" min="1" max="65535" value={settings.port || ""} onChange={event => update("port", event.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="db-name">Database name</label>
            <input id="db-name" value={settings.database} onChange={event => update("database", event.target.value)} autoComplete="off" required />
          </div>
          <div className="field">
            <label htmlFor="db-user">Database username</label>
            <input id="db-user" value={settings.username} onChange={event => update("username", event.target.value)} autoComplete="username" required />
          </div>
          <div className="field span-2">
            <label htmlFor="db-password">Database password</label>
            <input
              id="db-password"
              type="password"
              value={settings.password ?? ""}
              onChange={event => update("password", event.target.value)}
              autoComplete="new-password"
              placeholder={passwordConfigured ? "Saved password is protected; leave blank to keep it" : "Enter password if required"}
            />
            <span className="field-hint">Saved only by the backend in a local file restricted to your operating-system account.</span>
          </div>
        </div>

        <div className="settings-state">
          <div>
            <span className="section-label">DATABASE STATUS</span>
            <strong>{migrationLabel}</strong>
            <span className="field-hint">
              {database?.connected
                ? database.migrationState === "current"
                  ? "Connection verified. Data remains intact across restarts."
                  : `${database.pendingMigrations.length} migration${database.pendingMigrations.length === 1 ? "" : "s"} need to be applied.`
                : database?.error ?? "Checking local PostgreSQL availability."}
            </span>
          </div>
          {database?.connected && database.migrationState !== "current" &&
            <button className="button" type="button" onClick={() => void applyMigrations()} disabled={busy !== null}>
              {busy === "migrate" ? "Applying…" : "Apply migrations"}
            </button>}
        </div>

        <div className="form-actions">
          <span className="field-hint">Saving verifies this connection and applies pending versioned migrations. It never deletes or resets data.</span>
          <div className="form-actions-end">
            <button className="button" type="button" onClick={() => void runTest()} disabled={busy !== null}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            <button className="button button-primary" type="submit" disabled={busy !== null}>
              {busy === "save" ? "Saving…" : "Save connection"}
            </button>
          </div>
        </div>
      </form>

      <details className="settings-provisioning">
        <summary>Initialize a missing database or application role</summary>
        <p>
          This uses a PostgreSQL administrator only for this action. Kudu creates missing objects, grants the Kudu schema permissions needed by the application role, and removes temporary database-wide create permission after migration. It never changes an existing role password or deletes/resets a database.
        </p>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="db-admin-user">PostgreSQL administrator username</label>
            <input id="db-admin-user" value={adminUsername} onChange={event => setAdminUsername(event.target.value)} autoComplete="username" />
          </div>
          <div className="field">
            <label htmlFor="db-admin-password">PostgreSQL administrator password</label>
            <input id="db-admin-password" type="password" value={adminPassword} onChange={event => setAdminPassword(event.target.value)} autoComplete="current-password" />
          </div>
        </div>
        <label className="check-row settings-confirm">
          <input type="checkbox" checked={confirmInitialization} onChange={event => setConfirmInitialization(event.target.checked)} />
          <span>I authorize creating only the missing database and/or application role above.</span>
        </label>
          <button className="button button-primary" type="button" disabled={busy !== null || !confirmInitialization || !adminUsername} onClick={() => void initializeDatabase()}>
          {busy === "save" ? "Initializing…" : "Initialize missing objects"}
        </button>
      </details>
    </section>
    <p className="settings-security-note">
      Local Web Edition has no operator sign-in and is only safe on this computer. Keep the server on its default loopback address; do not expose it to a network.
    </p>
  </main>;
}
