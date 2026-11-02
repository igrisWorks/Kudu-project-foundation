import { useCallback, useEffect, useState } from "react";
import type { HealthResponse } from "@kudu/shared";
import { getHealth } from "../api";
import { displayError, formatDate, StatusBadge } from "../components/RegistryUI";

export default function HomePage({ localMode = false }: { localMode?: boolean }) {
  const [connection, setConnection] = useState<
    { kind: "loading" } | { kind: "ready"; health: HealthResponse } | { kind: "error"; message: string }
  >({ kind: "loading" });
  const refresh = useCallback(async () => {
    setConnection({ kind: "loading" });
    try { setConnection({ kind: "ready", health: await getHealth() }); }
    catch (error) { setConnection({ kind: "error", message: displayError(error) }); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const dbReady = connection.kind === "ready" && connection.health.database === "connected";
  return <main className="home-shell">
    <section className="hero" aria-labelledby="page-title">
      <div className="eyebrow"><span className="eyebrow-line" />INDUSTRIAL DATA PLATFORM</div>
      <h1 id="page-title">Industrial data,<br /><span>in context.</span></h1>
      <p className="intro">A private foundation for connecting the systems, signals, and events that keep operations moving.</p>
    </section>
    <section className="status-panel" aria-labelledby="status-title" data-testid="panel-core-services">
      <div className="panel-heading">
        <div><p className="section-label">SYSTEM CHECK</p><h2 id="status-title">Core services</h2></div>
        <button className="refresh-button" type="button" onClick={() => void refresh()} data-testid="button-refresh-health">↻ Check again</button>
      </div>
      <div className="service-row">
        <div className="service-icon" aria-hidden="true"><span className="api-glyph">/</span></div>
        <div className="service-name"><strong>REST API</strong><span>Versioned service · /api/v1</span></div>
        <StatusBadge state={connection.kind === "loading" ? "checking" : connection.kind === "error" ? "offline" : "online"} />
      </div>
      <div className="service-row">
        <div className="service-icon database-icon" aria-hidden="true"><span /><span /><span /></div>
        <div className="service-name"><strong>{localMode ? "SQLite" : "PostgreSQL"}</strong><span>{localMode ? "Embedded local data store" : "Server data store"}</span></div>
        <StatusBadge state={connection.kind === "loading" ? "checking" : connection.kind === "error" ? "unknown" : dbReady ? "online" : "offline"} />
      </div>
      <div className="panel-footer" aria-live="polite" data-testid="health-result">
        <span>{connection.kind === "loading" ? "Checking service readiness…" : connection.kind === "error" ? connection.message : `Last checked ${formatDate(connection.health.checkedAt)}`}</span>
        <span className="utc-label">TIMES IN UTC</span>
      </div>
    </section>
    <section className="next-section" aria-label="Foundation scope">
      <div className="next-marker">01</div>
      <div><p className="section-label">FOUNDATION FIRST</p><p className="next-copy">A portable codebase, a versioned database, and a clear path to a unified industrial namespace.</p></div>
      <div className="scope-tag">ON-PREMISES BY DESIGN</div>
    </section>
    {connection.kind === "error" && <p className="error-note" role="status">Start the API, then check again. No sample data is being shown.</p>}
    {connection.kind === "ready" && !dbReady && <p className="error-note" role="status">{localMode ? "The local database is unavailable. Inspect the application log; do not delete the database file." : "Start PostgreSQL, then check again."} No sample data is being shown.</p>}
  </main>;
}
