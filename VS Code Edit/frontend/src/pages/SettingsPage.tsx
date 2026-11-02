import { useCallback, useEffect, useState } from "react";
import {
  createLocalDatabaseBackup,
  getLocalDatabase,
  listLocalDatabaseBackups,
  restoreLocalDatabaseBackup,
  type LocalDatabaseBackup,
  type LocalDatabaseResponse,
} from "../api";

export default function SettingsPage({ dockerMode = false }: { dockerMode?: boolean }) {
  const [database, setDatabase] = useState<LocalDatabaseResponse | null>(null);
  const [backups, setBackups] = useState<LocalDatabaseBackup[]>([]);
  const [selected, setSelected] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    try {
      const [status, saved] = await Promise.all([getLocalDatabase(), listLocalDatabaseBackups()]);
      setDatabase(status);
      setBackups(saved.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Local database status is unavailable.");
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function backup() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await createLocalDatabaseBackup();
      setMessage(`Consistent backup created: ${result.backup.filePath}`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Backup failed.");
    } finally { setBusy(false); }
  }

  async function restore() {
    if (!selected || !confirmed) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await restoreLocalDatabaseBackup(selected);
      setDatabase(result.status);
      setConfirmed(false);
      setMessage(`Backup restored. The previous data is preserved at ${result.safetyBackup.filePath}`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Restore failed. Your selection has been preserved.");
    } finally { setBusy(false); }
  }

  return <main className="registry-shell">
    <div className="page-heading">
      <div>
        <div className="eyebrow"><span className="eyebrow-line" />LOCAL CONFIGURATION</div>
        <h1>Local database</h1>
        <p>KuduNS manages its embedded SQLite database automatically. No database server, users or passwords are required.</p>
        <p className="field-hint">Upgrading from PostgreSQL Local? Existing PostgreSQL data has not been imported or deleted. Stop Local and use the explicit <code>pnpm local:import-postgres</code> migration described in <code>docs/LOCAL-SQLITE.md</code> before relying on this database.</p>
      </div>
    </div>
    {error && <p className="error-note" role="alert">{error}</p>}
    {message && <p className="settings-security-note" role="status">{message}</p>}
    <section className="panel settings-panel" aria-labelledby="database-settings-heading">
      <div className="panel-heading">
        <div><p className="section-label">EMBEDDED STORAGE</p><h2 id="database-settings-heading">SQLite database</h2></div>
        <span className={`status-pill ${database?.connected ? "good" : "bad"}`} role="status">
          {database ? "Ready" : "Checking"}
        </span>
      </div>
      <dl className="settings-status-grid">
        <div><dt>Database file</dt><dd><code>{database?.filePath ?? "Checking…"}</code></dd></div>
        <div><dt>SQLite version</dt><dd>{database?.sqliteVersion ?? "—"}</dd></div>
        <div><dt>Schema version</dt><dd>{database?.schemaVersion ?? "—"}</dd></div>
        <div><dt>Migrations</dt><dd>{database?.migrationState ?? "Checking…"}</dd></div>
        <div><dt>Integrity</dt><dd>{database?.integrity ?? "Checking…"}</dd></div>
        <div><dt>Last successful initialization</dt><dd>{database?.lastSuccessfulInitialization ?? "—"}</dd></div>
      </dl>
      <div className="form-actions">
        <button className="button button-secondary" type="button" onClick={() => void refresh()} disabled={busy}>Check status</button>
        <button className="button button-secondary" type="button" disabled={!database} onClick={() => {
          if (!navigator.clipboard?.writeText) { setError("Copy is unavailable in this browser. Select the database location above."); return; }
          if (database) void navigator.clipboard.writeText(database.dataDirectory)
            .then(() => setMessage("Database folder path copied."))
            .catch(() => setError("The browser cannot copy this path. Select the database location above."));
        }}>Copy folder path</button>
        {window.kuduLocal && <button className="button button-secondary" type="button" onClick={() => {
          void window.kuduLocal?.revealDataDirectory().catch(() => setError("The database folder could not be opened."));
        }}>Open data folder</button>}
      </div>
      <p className="field-hint">{dockerMode
        ? "The database and backups are stored in the persistent Docker data volume. Container recreation does not remove them."
        : "Data is stored in your operating-system user application data folder, not in the project or current working directory."}</p>
    </section>
    <section className="panel settings-panel" aria-labelledby="backup-heading">
      <div className="panel-heading">
        <div><p className="section-label">RECOVERY</p><h2 id="backup-heading">Backups and restore</h2></div>
        <button className="button button-primary" type="button" disabled={busy || !database} onClick={() => void backup()}>
          {busy ? "Working…" : "Create backup"}
        </button>
      </div>
      <p>Backups use SQLite's consistent backup API. Existing backups are never automatically deleted.</p>
      <p className="field-hint">Backup folder: <code>{database?.backupsDirectory ?? "Checking…"}</code></p>
      <div className="field">
        <label htmlFor="local-backup">Backup to restore</label>
        <select id="local-backup" value={selected} disabled={busy} onChange={event => {
          setSelected(event.target.value); setConfirmed(false);
        }}>
          <option value="">Choose a backup</option>
          {backups.map(item => <option key={item.fileName} value={item.fileName}>
            {item.createdAt} · {Math.ceil(item.sizeBytes / 1024)} KB · {item.fileName}
          </option>)}
        </select>
      </div>
      <label className="check-row settings-confirm">
        <input type="checkbox" checked={confirmed} disabled={busy || !selected} onChange={event => setConfirmed(event.target.checked)} />
        <span>I understand this replaces current local data. KuduNS will first create a recoverable safety backup.</span>
      </label>
      <button className="button button-secondary" type="button" disabled={busy || !selected || !confirmed} onClick={() => void restore()}>
        Restore selected backup
      </button>
    </section>
    <p className="settings-security-note">Local Edition has no operator sign-in. Keep it bound to loopback and do not expose it to a LAN or public network. PostgreSQL Server and Enterprise deployments remain separate.</p>
  </main>;
}
