import { useCallback, useEffect, useState } from "react";
import type { HealthResponse } from "@kudu/shared";

type ConnectionState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; health: HealthResponse };

async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/v1/health", {
    headers: { Accept: "application/json" },
  });
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("status" in body) ||
    !("database" in body) ||
    !("checkedAt" in body) ||
    (body.status !== "ok" && body.status !== "degraded") ||
    (body.database !== "connected" && body.database !== "unavailable") ||
    typeof body.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(body.checkedAt))
  ) {
    throw new Error("The API response did not match the health contract.");
  }
  if (!response.ok && response.status !== 503) {
    throw new Error("The API returned an unexpected response.");
  }
  return body as HealthResponse;
}

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

export default function App() {
  const [connection, setConnection] = useState<ConnectionState>({ kind: "loading" });
  const [refreshCount, setRefreshCount] = useState(0);

  const refresh = useCallback(async () => {
    setConnection({ kind: "loading" });
    try {
      const health = await fetchHealth();
      setConnection({ kind: "ready", health });
    } catch (error) {
      setConnection({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not reach the Kudu API.",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => setRefreshCount((count) => count + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (refreshCount > 0) void refresh();
  }, [refreshCount, refresh]);

  const databaseReady =
    connection.kind === "ready" && connection.health.database === "connected";

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Kudu home">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>KUDU</span>
        </a>
        <div className="environment">
          <span className="environment-dot" />
          FOUNDATION
        </div>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <div className="eyebrow">
          <span className="eyebrow-line" />
          INDUSTRIAL DATA PLATFORM
        </div>
        <h1 id="page-title">
          Industrial data,
          <br />
          <span>in context.</span>
        </h1>
        <p className="intro">
          A private foundation for connecting the systems, signals, and events that keep
          operations moving.
        </p>
      </section>

      <section className="status-panel" aria-labelledby="status-title">
        <div className="panel-heading">
          <div>
            <p className="section-label">SYSTEM CHECK</p>
            <h2 id="status-title">Core services</h2>
          </div>
          <button className="refresh-button" type="button" onClick={() => void refresh()}>
            <span aria-hidden="true">↻</span> Check again
          </button>
        </div>

        <div className="service-row">
          <div className="service-icon" aria-hidden="true">
            <span className="api-glyph">/</span>
          </div>
          <div className="service-name">
            <strong>REST API</strong>
            <span>Versioned service · /api/v1</span>
          </div>
          <StatusBadge
            state={
              connection.kind === "loading"
                ? "checking"
                : connection.kind === "error"
                  ? "offline"
                  : "online"
            }
          />
        </div>

        <div className="service-row">
          <div className="service-icon database-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="service-name">
            <strong>PostgreSQL</strong>
            <span>Local data store</span>
          </div>
          <StatusBadge
            state={
              connection.kind === "loading"
                ? "checking"
                : connection.kind === "error"
                  ? "unknown"
                  : databaseReady
                    ? "online"
                    : "offline"
            }
          />
        </div>

        <div className="panel-footer" aria-live="polite">
          <span>
            {connection.kind === "loading"
              ? "Checking service readiness…"
              : connection.kind === "error"
                ? connection.message
                : `Last checked ${formatTime(connection.health.checkedAt)}`}
          </span>
          <span className="utc-label">TIMES IN UTC</span>
        </div>
      </section>

      <section className="next-section" aria-label="Foundation scope">
        <div className="next-marker">01</div>
        <div>
          <p className="section-label">FOUNDATION FIRST</p>
          <p className="next-copy">
            A portable codebase, a versioned database, and a clear path to a unified
            industrial namespace.
          </p>
        </div>
        <div className="scope-tag">ON-PREMISES BY DESIGN</div>
      </section>

      {connection.kind === "error" && (
        <p className="error-note" role="status">
          Start the API, then check again. No sample data is being shown.
        </p>
      )}
      {connection.kind === "ready" && !databaseReady && (
        <p className="error-note" role="status">
          Start PostgreSQL, then check again. No sample data is being shown.
        </p>
      )}

      <footer className="footer">
        <span>KUDU / PROJECT FOUNDATION</span>
        <span>PRIVATE INFRASTRUCTURE. YOUR DATA.</span>
      </footer>
    </main>
  );
}

function StatusBadge({ state }: { state: "checking" | "unknown" | "online" | "offline" }) {
  const label = {
    checking: "CHECKING",
    unknown: "UNKNOWN",
    online: "OPERATIONAL",
    offline: "UNAVAILABLE",
  }[state];
  return (
    <span className={`status-badge status-${state}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}
