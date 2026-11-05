import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import type {
  DataSourceRecord,
  EventDetail,
  ExplorerEventQuery,
  ExplorerQualityReport,
  Page,
} from "@kudu/shared";
import {
  downloadExplorerEvents,
  getEvent,
  getExplorerQuality,
  listDataSources,
  listExplorerEvents,
} from "../api";
import "./data-workspace.css";

type ExplorerQuery = ExplorerEventQuery & {
  page: number;
  pageSize: number;
  sortBy: NonNullable<ExplorerEventQuery["sortBy"]>;
  sortDirection: NonNullable<ExplorerEventQuery["sortDirection"]>;
};

const JSON_TREE_PAGE_SIZE = 50;

function JsonArrayTree({ label, value }: { label: string; value: unknown[] }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(value.length / JSON_TREE_PAGE_SIZE));
  const entries = value.slice(page * JSON_TREE_PAGE_SIZE, (page + 1) * JSON_TREE_PAGE_SIZE);
  return <details className="dw-tree-node">
    <summary>{label} <span>Array · {value.length}</span></summary>
    <div className="dw-tree-children">{entries.map((item, index) => <JsonTree key={page * JSON_TREE_PAGE_SIZE + index} label={`[${page * JSON_TREE_PAGE_SIZE + index}]`} value={item} />)}</div>
    {pageCount > 1 && <div className="dw-tree-pagination"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous items</button><span>{page + 1} / {pageCount}</span><button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>Next items</button></div>}
  </details>;
}

function JsonObjectTree({ label, value }: { label: string; value: Record<string, unknown> }) {
  const [page, setPage] = useState(0);
  const entries = Object.entries(value);
  const pageCount = Math.max(1, Math.ceil(entries.length / JSON_TREE_PAGE_SIZE));
  const visible = entries.slice(page * JSON_TREE_PAGE_SIZE, (page + 1) * JSON_TREE_PAGE_SIZE);
  return <details className="dw-tree-node">
    <summary>{label} <span>Object · {entries.length} fields</span></summary>
    <div className="dw-tree-children">{visible.map(([key, item]) => <JsonTree key={key} label={key} value={item} />)}</div>
    {pageCount > 1 && <div className="dw-tree-pagination"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous fields</button><span>{page + 1} / {pageCount}</span><button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>Next fields</button></div>}
  </details>;
}

function JsonTree({ label, value }: { label: string; value: unknown }) {
  if (Array.isArray(value)) {
    return <JsonArrayTree label={label} value={value} />;
  }
  if (typeof value === "object" && value !== null) {
    return <JsonObjectTree label={label} value={value as Record<string, unknown>} />;
  }
  return <div className="dw-tree-value"><code>{label}</code><span>{value === null ? "null" : String(value)}</span></div>;
}

function displayPayloadCell(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "Missing";
  if (Array.isArray(value)) return `Array · ${value.length}`;
  if (typeof value === "object") return `Object · ${Object.keys(value as object).length}`;
  return String(value);
}

type PayloadColumn = { sourceId: string; path: string; label: string; observedTypes: string[] };

function payloadValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

function payloadColumnSpecs(events: EventDetail[], sourceScoped: boolean): PayloadColumn[] {
  const columns = new Map<string, PayloadColumn & { types: Set<string> }>();
  for (const event of events) {
    for (const [path, value] of Object.entries(event.payload)) {
      const label = sourceScoped ? path : `${event.source.sourceKey} · ${path}`;
      const key = `${event.source.id}\u0000${path}`;
      const column = columns.get(key) ?? { sourceId: event.source.id, path, label, types: new Set<string>(), observedTypes: [] };
      column.types.add(payloadValueType(value));
      column.observedTypes = [...column.types].sort();
      columns.set(key, column);
    }
  }
  return [...columns.values()].sort((left, right) => left.label.localeCompare(right.label));
}

type RelatedObjectArray = { path: string; total: number; rows: Record<string, unknown>[] };

function relatedObjectArrays(value: unknown): RelatedObjectArray[] {
  const found: RelatedObjectArray[] = [];
  const visit = (current: unknown, path: string, depth: number) => {
    if (depth > 8 || found.length >= 16 || current === null || typeof current !== "object") return;
    if (Array.isArray(current)) {
      const rows = current.filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item));
      if (rows.length) found.push({ path, total: current.length, rows });
      current.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  visit(value, "$", 0);
  return found;
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  const safe = /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function prettyDate(value: string | null | undefined) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "medium", timeZone: "UTC",
  }).format(date) + " UTC";
}

function stringify(value: unknown) {
  return JSON.stringify(value, null, 2) ?? "null";
}

function originalSourcePayload(event: EventDetail): unknown {
  return event.provenance.originalRecord ?? event.payload;
}

function StateMessage({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return <section className="dw-state" role="status">
    <span className="dw-state-index" aria-hidden="true">/</span>
    <h2>{title}</h2><p>{message}</p>{action}
  </section>;
}

export default function DataExplorerPage() {
  const [query, setQuery] = useState<ExplorerQuery>({
    page: 1, pageSize: 25, sortBy: "occurredAt", sortDirection: "desc",
  });
  const [draftSearch, setDraftSearch] = useState("");
  const [sources, setSources] = useState<DataSourceRecord[]>([]);
  const [sourceError, setSourceError] = useState("");
  const [events, setEvents] = useState<Page<EventDetail> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<EventDetail | null>(null);
  const [payloadView, setPayloadView] = useState<"tree" | "raw">("tree");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [quality, setQuality] = useState<ExplorerQualityReport | null>(null);
  const [qualityLoading, setQualityLoading] = useState(true);
  const [qualityError, setQualityError] = useState("");
  const [exporting, setExporting] = useState("");
  const [selectedFields, setSelectedFields] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    listDataSources({ page: 1, pageSize: 100 }).then((page) => {
      if (active) { setSources(page.items); setSourceError(""); }
    }).catch((err: unknown) => {
      if (active) setSourceError(err instanceof Error ? err.message : "Data sources could not be loaded.");
    });
    return () => { active = false; };
  }, []);

  const loadEvents = useCallback(async (current: ExplorerQuery) => {
    setLoading(true);
    setError("");
    try {
      const result = await listExplorerEvents(current);
      setEvents(result);
      setSelectedId((previous) => result.items.some((item) => item.id === previous) ? previous : result.items[0]?.id ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Imported events could not be loaded.");
      setEvents(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadEvents(query); }, [query, loadEvents]);

  useEffect(() => {
    let active = true;
    setQualityLoading(true);
    setQualityError("");
    getExplorerQuality(query.sourceId).then((report) => {
      if (active) setQuality(report);
    }).catch((err: unknown) => {
      if (active) setQualityError(err instanceof Error ? err.message : "Quality report could not be loaded.");
    }).finally(() => { if (active) setQualityLoading(false); });
    return () => { active = false; };
  }, [query.sourceId]);

  useEffect(() => {
    if (!selectedId) { setSelected(null); return; }
    let active = true;
    setDetailLoading(true);
    setDetailError("");
    getEvent(selectedId).then((event) => {
      if (active) setSelected(event);
    }).catch((err: unknown) => {
      if (active) setDetailError(err instanceof Error ? err.message : "Event detail could not be loaded.");
    }).finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId]);

  const updateFilter = (key: "sourceId" | "eventType" | "from" | "to", value: string) => {
    setQuery((current) => ({ ...current, [key]: value || undefined, page: 1 }));
  };
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery((current) => ({ ...current, search: draftSearch.trim() || undefined, page: 1 })), 250);
    return () => window.clearTimeout(timer);
  }, [draftSearch]);

  const currentSource = sources.find((source) => source.id === query.sourceId);
  const payloadColumns = payloadColumnSpecs(events?.items ?? [], Boolean(query.sourceId));
  const relatedArrays = selected ? relatedObjectArrays(originalSourcePayload(selected)) : [];
  const pageCount = events ? Math.max(1, Math.ceil(events.total / events.pageSize)) : 1;

  const exportData = async (format: "json" | "csv" | "xlsx") => {
    setExporting(format);
    try {
      const blob = await downloadExplorerEvents(format, query);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `kuduns-events.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The export could not be created.");
    } finally {
      setExporting("");
    }
  };

  const exportSelectedFields = () => {
    if (!events?.items.length) return;
    const chosen = payloadColumns.filter((column) => selectedFields.includes(`${column.sourceId}\u0000${column.path}`));
    if (!chosen.length) return;
    const rows = [
      ["occurred_at", "source_key", "source_record_id", "event_type", ...chosen.map((column) => column.label)],
      ...events.items.map((event) => [
        event.occurredAt,
        event.source.sourceKey,
        event.sourceRecordId ?? "",
        event.eventType,
        ...chosen.map((column) => event.source.id === column.sourceId ? event.payload[column.path] : ""),
      ]),
    ];
    const blob = new Blob(["\uFEFF", rows.map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "kuduns-selected-fields-current-page.csv";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const refreshWorkspace = () => {
    void loadEvents(query);
    setQualityLoading(true);
    setQualityError("");
    listDataSources({ page: 1, pageSize: 100 })
      .then((page) => { setSources(page.items); setSourceError(""); })
      .catch((err: unknown) => setSourceError(err instanceof Error ? err.message : "Data sources could not be loaded."));
    getExplorerQuality(query.sourceId)
      .then(setQuality)
      .catch((err: unknown) => setQualityError(err instanceof Error ? err.message : "Quality report could not be loaded."))
      .finally(() => setQualityLoading(false));
  };

  return <main className="page-main dw-page">
    <div className="dw-page-topline"><div className="eyebrow"><span className="eyebrow-line" />PERSISTED EVENT RECORDS</div>
      <nav className="dw-crossnav" aria-label="Data workspace">
        <Link href="/visualisations" data-testid="link-open-visualisations">Saved visualisations <span aria-hidden="true">↗</span></Link>
      </nav>
    </div>
    <header className="page-heading dw-heading">
      <div><h1>Data explorer</h1><p>Inspect imported events as they arrived. Every record stays attached to its originating source and original payload.</p></div>
      <button type="button" className="button" onClick={refreshWorkspace} disabled={loading || qualityLoading} data-testid="button-refresh-events">Refresh workspace</button>
    </header>

    {error && <div className="notice error dw-notice" role="alert"><span>{error}</span><button type="button" className="button button-danger" onClick={() => void loadEvents(query)} data-testid="button-retry-events">Retry</button></div>}

    <section className="dw-filterbar" aria-label="Event filters">
      <div className="field dw-search-field"><label htmlFor="explorer-search">Search records</label>
        <input id="explorer-search" type="search" placeholder="Source record, event type, payload…" value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)} data-testid="input-explorer-search" />
      </div>
      <div className="field"><label htmlFor="explorer-source">Source scope</label>
        <select id="explorer-source" value={query.sourceId ?? ""} onChange={(event) => updateFilter("sourceId", event.target.value)} data-testid="select-explorer-source">
          <option value="">All sources</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.displayName} · {source.sourceKey}</option>)}
        </select>
      </div>
      <div className="field"><label htmlFor="explorer-type">Event type</label>
        <input id="explorer-type" list="explorer-event-type-options" value={query.eventType ?? ""} onChange={(event) => updateFilter("eventType", event.target.value)} placeholder="All event types" data-testid="input-explorer-event-type" />
        <datalist id="explorer-event-type-options">{[...new Set((events?.items ?? []).map((item) => item.eventType))].sort().map((type) => <option key={type} value={type} />)}</datalist>
      </div>
      <div className="field"><label htmlFor="explorer-from">Occurred from · browser time</label><input id="explorer-from" type="datetime-local" value={query.from ?? ""} onChange={(event) => updateFilter("from", event.target.value)} data-testid="input-explorer-from" /></div>
      <div className="field"><label htmlFor="explorer-to">Occurred to · browser time</label><input id="explorer-to" type="datetime-local" value={query.to ?? ""} onChange={(event) => updateFilter("to", event.target.value)} data-testid="input-explorer-to" /></div>
      <div className="field"><label htmlFor="explorer-sort-by">Sort by</label><select id="explorer-sort-by" value={query.sortBy} onChange={(event) => setQuery((current) => ({ ...current, sortBy: event.target.value as ExplorerQuery["sortBy"], page: 1 }))} data-testid="select-explorer-sort-by"><option value="occurredAt">Occurred time</option><option value="eventType">Event type</option><option value="source">Source</option></select></div>
      <div className="field"><label htmlFor="explorer-sort">Direction</label><select id="explorer-sort" value={query.sortDirection} onChange={(event) => setQuery((current) => ({ ...current, sortDirection: event.target.value as "asc" | "desc", page: 1 }))} data-testid="select-explorer-sort"><option value="desc">Descending</option><option value="asc">Ascending</option></select></div>
    </section>

    <section className="dw-source-ribbon" aria-label="Source status">
      <div className="dw-source-label"><span className="dw-signal" />SOURCE CONTEXT</div>
      {sourceError ? <div className="dw-source-error" role="alert"><p>{sourceError}</p><button type="button" className="button" onClick={() => {
        setSourceError("");
        listDataSources({ page: 1, pageSize: 100 }).then((page) => setSources(page.items)).catch((err: unknown) => setSourceError(err instanceof Error ? err.message : "Data sources could not be loaded."));
      }} data-testid="button-retry-sources">Retry sources</button></div> :
        currentSource ? <div className="dw-source-context">
          <strong>{currentSource.displayName}</strong><code>{currentSource.sourceKey}</code>
          <span className={`status-pill ${currentSource.enabled && currentSource.connectionStatus !== "error" ? "good" : "warn"}`}>{currentSource.enabled ? currentSource.connectionStatus.replace("_", " ") : "disabled"}</span>
          <span className={`status-pill ${currentSource.ingestionStatus === "error" ? "warn" : "good"}`}>ingestion {currentSource.ingestionStatus.replace("_", " ")}</span>
          <span className="dw-sync-note">Last successful sync · {prettyDate(currentSource.lastSuccessfulSyncAt)}</span>
          {currentSource.lastErrorSummary && <span className="dw-inline-error" role="status">{currentSource.lastErrorSummary}</span>}
        </div> : <p>{sources.length ? `${sources.length} registered sources · records remain attributed independently` : "Loading registered source context…"}</p>}
    </section>

    <div className="dw-explorer-layout">
      <section className="dw-records-area" aria-label="Imported event records">
        <div className="dw-section-head"><div><span className="section-label">EVENT REGISTER</span><h2>Imported records</h2></div>
          <div className="dw-export-actions" aria-label="Download filtered events">
            {(["json", "csv", "xlsx"] as const).map((format) => <button key={format} type="button" className="button button-quiet" onClick={() => void exportData(format)} disabled={Boolean(exporting) || loading} data-testid={`button-export-${format}`}>{exporting === format ? "Preparing…" : format.toUpperCase()}</button>)}
          </div>
        </div>
        <div className="dw-table-meta"><span>{loading ? "Reading persisted records…" : `${events?.total ?? 0} matching records`}</span><span>PAGE {query.page} / {pageCount}</span></div>
        {loading ? <div className="dw-table-skeleton" aria-label="Loading events"><i /><i /><i /><i /></div> :
          events?.items.length ? <div className="table-frame dw-table-frame"><table className="dw-event-table">
            <thead><tr><th scope="col">OCCURRED · UTC</th><th scope="col">SOURCE / RECORD</th><th scope="col">EVENT TYPE</th><th scope="col">ASSET</th><th scope="col">INGESTED · UTC</th>{payloadColumns.map((column) => <th key={`${column.sourceId}:${column.path}`} scope="col" title={`${column.label} · ${column.observedTypes.join(", ")}`}>{column.label}<small className="dw-type-label">{column.observedTypes.join(" / ")}</small></th>)}</tr></thead>
            <tbody>{events.items.map((event) => <tr key={event.id} className={selectedId === event.id ? "dw-row-selected" : ""}>
              <td><button type="button" className="dw-row-select" onClick={() => setSelectedId(event.id)} data-testid={`button-select-event-${event.id}`} aria-pressed={selectedId === event.id}>{prettyDate(event.occurredAt)}</button></td>
              <td><span className="dw-table-source">{event.source.displayName}</span><code>{event.sourceRecordId ?? "No source record ID"}</code></td>
              <td><span className="dw-event-type">{event.eventType}</span></td>
              <td>{event.asset ? <><span>{event.asset.name}</span><code>{event.asset.assetKey}</code></> : <span className="muted">Unassigned</span>}</td>
              <td className="dw-table-time">{prettyDate(event.ingestedAt)}</td>
              {payloadColumns.map((column) => {
                const value = event.source.id === column.sourceId ? event.payload[column.path] : undefined;
                return <td key={`${column.sourceId}:${column.path}`} title={typeof value === "object" ? JSON.stringify(value) : undefined}>{displayPayloadCell(value)}</td>;
              })}
            </tr>)}</tbody>
          </table></div> : <StateMessage title="No imported events in this view" message="Adjust the source, event type, search, or time range. This explorer only reads events already persisted in KuduNS." />}
        <div className="dw-pagination">
          <span>{events ? `Showing ${events.items.length ? (query.page - 1) * events.pageSize + 1 : 0}–${Math.min(query.page * events.pageSize, events.total)} of ${events.total}` : "—"}</span>
          <div><button type="button" className="button" disabled={query.page <= 1 || loading} onClick={() => setQuery((current) => ({ ...current, page: current.page - 1 }))} data-testid="button-events-previous">Previous</button>
            <button type="button" className="button" disabled={query.page >= pageCount || loading} onClick={() => setQuery((current) => ({ ...current, page: current.page + 1 }))} data-testid="button-events-next">Next</button></div>
        </div>
        {payloadColumns.length > 0 && <details className="dw-field-picker">
          <summary>Choose payload fields for this page’s analytical export</summary>
          <div className="dw-field-picker-options">{payloadColumns.map((column) => {
            const key = `${column.sourceId}\u0000${column.path}`;
            return <label key={key}><input type="checkbox" checked={selectedFields.includes(key)} onChange={(event) => setSelectedFields((current) => event.target.checked ? [...new Set([...current, key])] : current.filter((item) => item !== key))} /><span>{column.label}</span><small>{column.observedTypes.join(" / ")}</small></label>;
          })}</div>
          <div className="dw-field-picker-footer"><span>Analytical export includes {events?.items.length ?? 0} visible rows; use full JSON, CSV, or Excel exports above for all fields and matching records.</span><button type="button" className="button" disabled={!selectedFields.length || loading} onClick={exportSelectedFields} data-testid="button-export-selected-fields">Export selected fields · page</button></div>
        </details>}
      </section>

      <aside className="dw-inspector" aria-label="Event inspection">
        <div className="dw-inspector-head"><div><span className="section-label">RECORD INSPECTION</span><h2>Payload &amp; lineage</h2></div><span className="dw-inspector-mark">01</span></div>
        {detailLoading ? <div className="dw-inspector-loading" aria-label="Loading selected event"><i /><i /><i /></div> :
          detailError ? <StateMessage title="Event detail unavailable" message={detailError} action={<button type="button" className="button" onClick={() => {
            setDetailLoading(true);
            setDetailError("");
            getEvent(selectedId).then(setSelected).catch((err: unknown) => setDetailError(err instanceof Error ? err.message : "Event detail could not be loaded.")).finally(() => setDetailLoading(false));
          }} data-testid="button-retry-event-detail">Retry detail</button>} /> :
          selected ? <div className="dw-inspector-content">
            <div className="dw-inspector-source"><span>SOURCE IDENTITY</span><strong>{selected.source.displayName}</strong><code>{selected.source.sourceKey} · {selected.source.id}</code></div>
            <dl className="dw-event-meta">
              <dt>Event ID</dt><dd className="mono">{selected.id}</dd>
              <dt>Source record</dt><dd className="mono">{selected.sourceRecordId ?? "Not supplied"}</dd>
              <dt>Event type</dt><dd>{selected.eventType}</dd>
              <dt>Occurred</dt><dd>{prettyDate(selected.occurredAt)}</dd>
              <dt>Source timestamp</dt><dd>{prettyDate(selected.sourceTimestamp)}</dd>
              <dt>Ingested</dt><dd>{prettyDate(selected.ingestedAt)}</dd>
              <dt>Deduplication key</dt><dd className="mono">{selected.deduplicationKey ?? "Not supplied"}</dd>
            </dl>
            {selected.asset && <div className="dw-asset-context"><span>ASSET CONTEXT</span><strong>{selected.asset.name}</strong><code>{selected.asset.assetKey}</code></div>}
            <section className="dw-json-section">
              <div className="dw-json-title"><h3>Original payload</h3><span>Nested source structure retained</span></div>
              <div className="dw-view-toggle" role="group" aria-label="Payload display">
                <button type="button" aria-pressed={payloadView === "tree"} onClick={() => setPayloadView("tree")} data-testid="button-payload-tree">Tree</button>
                <button type="button" aria-pressed={payloadView === "raw"} onClick={() => setPayloadView("raw")} data-testid="button-payload-raw">Raw JSON</button>
              </div>
              {payloadView === "tree"
                ? <div className="dw-json-tree" data-testid="tree-event-payload"><JsonTree label="source record" value={originalSourcePayload(selected)} /></div>
                : <pre className="event-json" data-testid="json-event-payload">{stringify(originalSourcePayload(selected))}</pre>}
              {payloadView === "tree" && relatedArrays.length > 0 && <div className="dw-related-arrays" data-testid="related-record-tables">
                <h4>Repeated object arrays</h4>
                <p>Child rows are shown separately; their nested structures remain available in the tree and original payload.</p>
                {relatedArrays.map((array) => {
                  const columns = [...new Set(array.rows.slice(0, 50).flatMap((row) => Object.keys(row)))];
                  return <details key={array.path} className="dw-related-table">
                    <summary><code>{array.path}</code><span>{array.rows.length} object rows · {array.total} array items</span></summary>
                    <div className="table-frame"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
                      <tbody>{array.rows.slice(0, 50).map((row, index) => <tr key={`${array.path}:${index}`}>{columns.map((column) => <td key={column}>{displayPayloadCell(row[column])}</td>)}</tr>)}</tbody>
                    </table></div>
                    {array.rows.length > 50 && <p>Showing the first 50 object rows; all items remain in the original payload.</p>}
                  </details>;
                })}
              </div>}
            </section>
            <section className="dw-json-section"><div className="dw-json-title"><h3>Provenance</h3><span>TRACE DATA</span></div><pre className="event-json" data-testid="json-event-provenance">{stringify(selected.provenance)}</pre></section>
          </div> : <StateMessage title="Choose a record" message="Select an event row to inspect its source identity, timestamps, unchanged payload structure, and provenance." />}
      </aside>
    </div>

    <section className="dw-quality-panel" aria-labelledby="quality-heading">
      <div className="dw-section-head"><div><span className="section-label">INTEGRITY REVIEW</span><h2 id="quality-heading">Data quality</h2></div><span className="dw-quality-context">{currentSource ? currentSource.displayName : "All sources"}</span></div>
      {qualityLoading ? <div className="dw-quality-skeleton"><i /><i /><i /></div> :
        qualityError ? <div className="notice error" role="alert"><span>{qualityError}</span><button className="button button-danger" type="button" onClick={() => { setQualityLoading(true); getExplorerQuality(query.sourceId).then((report) => { setQuality(report); setQualityError(""); }).catch((err: unknown) => setQualityError(err instanceof Error ? err.message : "Quality report could not be loaded.")).finally(() => setQualityLoading(false)); }} data-testid="button-retry-quality">Retry</button></div> :
          !quality?.sources.length ? <p className="dw-quality-note">No persisted event history is available for this scope yet.</p> :
            <div className="dw-quality-report" data-testid="explorer-quality-report">
              {quality.sourcesTruncated && <p className="dw-quality-note">The report is limited to the first 50 registered sources. Select a source to inspect it directly.</p>}
              {quality.sources.map((sourceReport) => <article key={sourceReport.source.id} className="dw-quality-source">
                 <header><strong>{sourceReport.source.displayName}</strong><code>{sourceReport.sampledEvents} total · {sourceReport.recentSampledEvents} recent / {sourceReport.previousSampledEvents} prior</code></header>
                {sourceReport.insufficientHistory && <p className="dw-quality-note">Not enough historical samples for a stable comparison. Reported differences are observational, not a confirmed upstream schema change.</p>}
                 {(sourceReport.fieldsTruncated || sourceReport.schemaChangesTruncated) && <p className="dw-quality-note">This report is bounded to protect responsiveness; some field paths or schema differences are omitted from the summary, not from stored events.</p>}
                <div className="dw-quality-table-wrap"><table className="dw-quality-table">
                  <thead><tr><th>Field path</th><th>Observed type</th><th>Present in recent sample</th></tr></thead>
                   <tbody>{sourceReport.fields.map((field) => <tr key={field.path}><td><code>{field.path}</code></td><td>{field.observedTypes.join(", ")}</td><td>{field.recordsPresent} / {sourceReport.recentSampledEvents}</td></tr>)}</tbody>
                </table></div>
                {sourceReport.schemaChanges.length > 0 && <ul className="dw-schema-changes">{sourceReport.schemaChanges.map((change) => <li key={`${change.path}:${change.change}`}><strong>{change.change.replace("_", " ")}</strong><code>{change.path}</code><span>{change.previousTypes.join(", ") || "not observed"} → {change.currentTypes.join(", ") || "not observed"}</span></li>)}</ul>}
              </article>)}
            </div>}
      <p className="dw-quality-note">Quality results reflect persisted records and retain the source-specific context supplied by the API.</p>
    </section>
  </main>;
}
