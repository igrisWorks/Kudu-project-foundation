import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import type {
  DataSourceDiscoveryResult,
  DataSourceRecord,
  EventDetail,
  ExplorerEventQuery,
  ExplorerQualityReport,
  ExplorerRecordDetail,
  ExplorerRecordPage,
  ExplorerRecordQuery,
  ExplorerRecordSummary,
  Page,
} from "@kudu/shared";
import {
  downloadExplorerEvents,
  downloadExplorerRecords,
  getExplorerQuality,
  getExplorerRecord,
  listDataSources,
  listExplorerEvents,
  listExplorerRecords,
} from "../api";
import RecordVisualization from "./RecordVisualization";
import "./data-workspace.css";

type RecordQuery = ExplorerRecordQuery & {
  page: number;
  pageSize: number;
  sortBy: "ingestedAt" | "source" | "status";
  sortDirection: "asc" | "desc";
};
type EventQuery = ExplorerEventQuery & {
  page: number;
  pageSize: number;
  sortBy: "occurredAt" | "eventType" | "source";
  sortDirection: "asc" | "desc";
};
type ExplorerMode = "records" | "events";

const JSON_TREE_PAGE_SIZE = 50;

function JsonArrayTree({ label, value, pathKey }: { label: string; value: unknown[]; pathKey: string }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(value.length / JSON_TREE_PAGE_SIZE));
  const entries = value.slice(page * JSON_TREE_PAGE_SIZE, (page + 1) * JSON_TREE_PAGE_SIZE);
  return <details className="dw-tree-node" data-testid={`details-json-${pathKey}`}>
    <summary>{label} <span>Array · {value.length} items</span></summary>
    <div className="dw-tree-children">
      {entries.map((item, index) => {
        const itemIndex = page * JSON_TREE_PAGE_SIZE + index;
        return <JsonTree key={itemIndex} label={`[${itemIndex}]`} pathKey={`${pathKey}[${itemIndex}]`} value={item} />;
      })}
    </div>
    {pageCount > 1 && <div className="dw-tree-pagination">
      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} data-testid={`button-json-array-previous-${pathKey}`}>Previous items</button>
      <span>{page + 1} / {pageCount}</span>
      <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)} data-testid={`button-json-array-next-${pathKey}`}>Next items</button>
    </div>}
  </details>;
}

function JsonObjectTree({ label, value, pathKey }: { label: string; value: Record<string, unknown>; pathKey: string }) {
  const [page, setPage] = useState(0);
  const entries = Object.entries(value);
  const pageCount = Math.max(1, Math.ceil(entries.length / JSON_TREE_PAGE_SIZE));
  const visible = entries.slice(page * JSON_TREE_PAGE_SIZE, (page + 1) * JSON_TREE_PAGE_SIZE);
  return <details className="dw-tree-node" data-testid={`details-json-${pathKey}`}>
    <summary>{label} <span>Object · {entries.length} fields</span></summary>
    <div className="dw-tree-children">{visible.map(([key, item]) => <JsonTree key={key} label={key} pathKey={pathKey ? `${pathKey}.${key}` : key} value={item} />)}</div>
    {pageCount > 1 && <div className="dw-tree-pagination">
      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} data-testid={`button-json-fields-previous-${pathKey}`}>Previous fields</button>
      <span>{page + 1} / {pageCount}</span>
      <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)} data-testid={`button-json-fields-next-${pathKey}`}>Next fields</button>
    </div>}
  </details>;
}

function JsonTree({ label, value, pathKey = label }: { label: string; value: unknown; pathKey?: string }) {
  if (Array.isArray(value)) return <JsonArrayTree label={label} value={value} pathKey={pathKey} />;
  if (typeof value === "object" && value !== null) return <JsonObjectTree label={label} value={value as Record<string, unknown>} pathKey={pathKey} />;
  if (typeof value === "string") {
    try {
      const decoded = JSON.parse(value) as unknown;
      if (Array.isArray(decoded) || (typeof decoded === "object" && decoded !== null)) {
        return <details className="dw-tree-node" data-testid={`details-json-cell-${pathKey}`}>
          <summary>{label} <span>JSON-encoded cell</span></summary>
          <div className="dw-tree-children">
            <div className="dw-tree-value"><code>Original cell text</code><span>{value}</span></div>
            <JsonTree label="Decoded structure" pathKey={`${pathKey}.decoded`} value={decoded} />
          </div>
        </details>;
      }
    } catch {
      // Non-JSON cell text stays a scalar, exactly as received.
    }
  }
  return <div className="dw-tree-value"><code>{label}</code><span>{value === null ? "null" : String(value)}</span></div>;
}

function displayValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "Not present in preview";
  if (Array.isArray(value)) return `Array · ${value.length} items`;
  if (typeof value === "object") return `Object · ${Object.keys(value as object).length} fields`;
  return String(value);
}

type SourceFieldColumn = { sourceId: string; path: string; label: string };
type EventPayloadColumn = { sourceId: string; path: string; label: string; observedTypes: string[] };

function recordFieldColumns(records: ExplorerRecordSummary[], sourceScoped: boolean): SourceFieldColumn[] {
  const columns = new Map<string, SourceFieldColumn>();
  for (const record of records) {
    for (const path of record.fieldNames) {
      const label = sourceScoped ? path : `${record.source.displayName} [${record.source.sourceKey}] · ${path}`;
      const key = `${record.source.id}\u0000${path}`;
      if (!columns.has(key)) columns.set(key, { sourceId: record.source.id, path, label });
    }
  }
  return [...columns.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function eventPayloadColumns(events: EventDetail[], sourceScoped: boolean): EventPayloadColumn[] {
  const columns = new Map<string, EventPayloadColumn & { types: Set<string> }>();
  for (const event of events) {
    for (const [path, value] of Object.entries(event.payload)) {
      const label = sourceScoped ? path : `${event.source.displayName} [${event.source.sourceKey}] · ${path}`;
      const key = `${event.source.id}\u0000${path}`;
      const column = columns.get(key) ?? { sourceId: event.source.id, path, label, types: new Set<string>(), observedTypes: [] };
      column.types.add(value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
      column.observedTypes = [...column.types].sort();
      columns.set(key, column);
    }
  }
  return [...columns.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  const safe = /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: unknown[][]) {
  const blob = new Blob(["\uFEFF", rows.map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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

function statusLabel(status: ExplorerRecordSummary["processingStatus"]) {
  if (status === "raw_only") return "Raw only";
  if (status === "normalized") return "Normalized";
  return "Legacy event";
}

function StatusPill({ status }: { status: ExplorerRecordSummary["processingStatus"] }) {
  return <span className={`dw-record-status ${status.replace("_", "-")}`}>{statusLabel(status)}</span>;
}

function StateMessage({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return <section className="dw-state" role="status">
    <span className="dw-state-index" aria-hidden="true">/</span>
    <h2>{title}</h2><p>{message}</p>{action}
  </section>;
}

function RecognitionPanel({ recognition, loading }: { recognition: DataSourceDiscoveryResult | null; loading: boolean }) {
  if (loading) return <section className="dw-recognition-panel" aria-label="Loading recognition summary" aria-busy="true">
    <div className="dw-recognition-heading"><div><span className="section-label">ADVISORY CONTEXT</span><h2>Recognition</h2></div></div>
    <p className="dw-recognition-empty">Reading contextual observations for this record set…</p>
  </section>;
  if (!recognition) return <section className="dw-recognition-panel" aria-labelledby="recognition-title">
    <div className="dw-recognition-heading"><div><span className="section-label">ADVISORY CONTEXT</span><h2 id="recognition-title">Recognition</h2></div><span className="dw-advisory-chip">NOT A CLASSIFICATION GATE</span></div>
    <p className="dw-recognition-empty">No recognition summary was returned for this record set. The source records remain available above, unchanged.</p>
  </section>;

  return <section className="dw-recognition-panel" aria-labelledby="recognition-title">
    <div className="dw-recognition-heading">
      <div><span className="section-label">ADVISORY CONTEXT</span><h2 id="recognition-title">Recognition</h2></div>
      <span className="dw-advisory-chip">POSSIBLE MEANINGS · NOT A CLASSIFICATION GATE</span>
    </div>
    <p className="dw-recognition-intro">These observations help orient unfamiliar data. They do not alter, classify, or restrict access to the original records.</p>
    <div className="dw-recognition-summary">
      <div><span>Source format</span><strong>{recognition.sourceType.replaceAll("_", " ")}</strong></div>
      <div><span>Sampled pages</span><strong>{recognition.sampledPageCount}</strong></div>
      <div><span>Recognized fields</span><strong>{recognition.fields.length}</strong></div>
      <div><span>Candidate structures</span><strong>{recognition.structures.length}</strong></div>
    </div>
    {recognition.warnings.length > 0 && <ul className="dw-recognition-warnings">{recognition.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>}
    {recognition.recordPaths.length > 0 && <details className="dw-recognition-details" data-testid="details-recognition-record-paths">
      <summary>Detected record paths <span>{recognition.recordPaths.length}</span></summary>
      <div className="dw-recognition-paths">{recognition.recordPaths.map((path) => <div key={path.path}>
        <code>{path.path || "Root"}</code><span>{path.recordCount} records</span><span className={path.supported ? "dw-supported" : "dw-unsupported"}>{path.supported ? "Inspectable" : "Not inspectable"}</span>
      </div>)}</div>
    </details>}
    {recognition.fields.length > 0 && <details className="dw-recognition-details" open data-testid="details-recognition-fields">
      <summary>Observed fields <span>{recognition.fields.length}</span></summary>
      <div className="dw-discovered-fields"><table>
        <thead><tr><th scope="col">Original path</th><th scope="col">Observed type</th><th scope="col">Examples</th></tr></thead>
        <tbody>{recognition.fields.map((field) => <tr key={field.path}>
          <td><code>{field.path}</code></td><td>{field.valueType}</td><td>{field.examples.length ? field.examples.join(" · ") : "No example supplied"}</td>
        </tr>)}</tbody>
      </table></div>
    </details>}
    {recognition.structures.length > 0 && <details className="dw-recognition-details" data-testid="details-recognition-structures">
      <summary>Possible structures <span>{recognition.structures.length}</span></summary>
      <div className="dw-structure-list">{recognition.structures.map((structure) => <article key={structure.path}>
        <div className="dw-structure-main"><code>{structure.path || "Root"}</code><span>{structure.kind} · {structure.itemCount} items · {structure.sampleCount} samples</span><span>{structure.possibleMeaning.replaceAll("-", " ")}</span></div>
        <p>{structure.note}</p>
        <div className="dw-confidence-track" role="img" aria-label={`Confidence ${Math.round(structure.confidenceScore * 100)} percent`}><i style={{ width: `${Math.max(0, Math.min(100, structure.confidenceScore * 100))}%` }} /><span>{Math.round(structure.confidenceScore * 100)}% confidence</span></div>
        {structure.childFields.length > 0 && <ul>{structure.childFields.map((field) => <li key={field.path}><code>{field.path}</code><span>{field.valueType}{field.possibleTarget ? ` · possible ${field.possibleTarget}` : ""}</span></li>)}</ul>}
      </article>)}</div>
    </details>}
    {recognition.suggestions.length > 0 && <details className="dw-recognition-details" data-testid="details-recognition-suggestions">
      <summary>Possible field meanings <span>{recognition.suggestions.length}</span></summary>
      <div className="dw-suggestion-list">{recognition.suggestions.map((suggestion, index) => <article key={`${suggestion.target}:${index}`}>
        <div className="dw-suggestion-heading"><strong>{suggestion.target}</strong><span className={`dw-confidence-label ${suggestion.confidence}`}>{suggestion.confidence} confidence · {Math.round(suggestion.confidenceScore * 100)}%</span></div>
        <div className="dw-suggestion-path"><span>Possible source path</span><code>{suggestion.sourcePath ?? "No path suggested"}</code></div>
        <p>{suggestion.note}</p>
        {suggestion.ambiguous && <span className="dw-ambiguity-note">More than one interpretation is plausible.</span>}
        {suggestion.examples.length > 0 && <div className="dw-suggestion-examples"><span>Examples</span>{suggestion.examples.map((example, exampleIndex) => <code key={`${exampleIndex}:${example}`}>{example}</code>)}</div>}
        {suggestion.alternatives.length > 0 && <div className="dw-suggestion-examples"><span>Other candidates</span>{suggestion.alternatives.map((alternative) => <code key={alternative}>{alternative}</code>)}</div>}
      </article>)}</div>
    </details>}
  </section>;
}

export default function DataExplorerPage() {
  const [mode, setMode] = useState<ExplorerMode>("records");
  const requestedSourceId = new URLSearchParams(window.location.search).get("sourceId") || undefined;
  const [recordQuery, setRecordQuery] = useState<RecordQuery>({
    ...(requestedSourceId ? { sourceId: requestedSourceId } : {}),
    page: 1, pageSize: 25, sortBy: "ingestedAt", sortDirection: "desc",
  });
  const [eventQuery, setEventQuery] = useState<EventQuery>({
    ...(requestedSourceId ? { sourceId: requestedSourceId } : {}),
    page: 1, pageSize: 25, sortBy: "occurredAt", sortDirection: "desc",
  });
  const [draftSearch, setDraftSearch] = useState("");
  const [sources, setSources] = useState<DataSourceRecord[]>([]);
  const [sourceError, setSourceError] = useState("");
  const [records, setRecords] = useState<ExplorerRecordPage | null>(null);
  const [events, setEvents] = useState<Page<EventDetail> | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [recordError, setRecordError] = useState("");
  const [eventError, setEventError] = useState("");
  const [selectedRecordId, setSelectedRecordId] = useState("");
  const [selectedRecord, setSelectedRecord] = useState<ExplorerRecordDetail | null>(null);
  const [recordDetailLoading, setRecordDetailLoading] = useState(false);
  const [recordDetailError, setRecordDetailError] = useState("");
  const [selectedEventId, setSelectedEventId] = useState("");
  const [payloadView, setPayloadView] = useState<"tree" | "raw">("tree");
  const [provenanceView, setProvenanceView] = useState<"tree" | "raw">("tree");
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

  const loadRecords = useCallback(async (current: RecordQuery) => {
    setRecordsLoading(true);
    setRecordError("");
    try {
      const result = await listExplorerRecords(current);
      setRecords(result);
      setSelectedRecordId((previous) => result.items.some((record) => record.id === previous) ? previous : result.items[0]?.id ?? "");
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : "Source records could not be loaded.");
      setRecords(null);
      setSelectedRecordId("");
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  const loadEvents = useCallback(async (current: EventQuery) => {
    setEventsLoading(true);
    setEventError("");
    try {
      const result = await listExplorerEvents(current);
      setEvents(result);
      setSelectedEventId((previous) => result.items.some((event) => event.id === previous) ? previous : result.items[0]?.id ?? "");
    } catch (err) {
      setEventError(err instanceof Error ? err.message : "Normalized events could not be loaded.");
      setEvents(null);
      setSelectedEventId("");
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => { if (mode === "records") void loadRecords(recordQuery); }, [mode, recordQuery, loadRecords]);
  useEffect(() => { if (mode === "events") void loadEvents(eventQuery); }, [mode, eventQuery, loadEvents]);

  useEffect(() => {
    let active = true;
    setQualityLoading(true);
    setQualityError("");
    getExplorerQuality(recordQuery.sourceId).then((report) => { if (active) setQuality(report); })
      .catch((err: unknown) => { if (active) setQualityError(err instanceof Error ? err.message : "Quality report could not be loaded."); })
      .finally(() => { if (active) setQualityLoading(false); });
    return () => { active = false; };
  }, [recordQuery.sourceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = draftSearch.trim() || undefined;
      setRecordQuery((current) => ({ ...current, search, page: 1 }));
      setEventQuery((current) => ({ ...current, search, page: 1 }));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draftSearch]);

  useEffect(() => {
    if (mode !== "records" || !selectedRecordId) { setSelectedRecord(null); return; }
    let active = true;
    setRecordDetailLoading(true);
    setRecordDetailError("");
    getExplorerRecord(selectedRecordId).then((detail) => {
      if (active) setSelectedRecord(detail);
    }).catch((err: unknown) => {
      if (active) setRecordDetailError(err instanceof Error ? err.message : "Record detail could not be loaded.");
    }).finally(() => { if (active) setRecordDetailLoading(false); });
    return () => { active = false; };
  }, [mode, selectedRecordId]);

  const selectedEvent = events?.items.find((event) => event.id === selectedEventId) ?? null;
  const currentSourceId = mode === "records" ? recordQuery.sourceId : eventQuery.sourceId;
  const currentSource = sources.find((source) => source.id === currentSourceId);
  const recordColumns = useMemo(
    () => recordFieldColumns(records?.items ?? [], Boolean(recordQuery.sourceId)),
    [records, recordQuery.sourceId],
  );
  const eventColumns = useMemo(
    () => eventPayloadColumns(events?.items ?? [], Boolean(eventQuery.sourceId)),
    [events, eventQuery.sourceId],
  );

  const activeLoading = mode === "records" ? recordsLoading : eventsLoading;
  const activeError = mode === "records" ? recordError : eventError;
  const activePage = mode === "records" ? records : events;
  const activePageCount = activePage ? Math.max(1, Math.ceil(activePage.total / activePage.pageSize)) : 1;
  const recognition = mode === "records" ? records?.recognition ?? null : null;

  const setSourceFilter = (sourceId: string) => {
    setRecordQuery((current) => ({ ...current, sourceId: sourceId || undefined, page: 1 }));
    setEventQuery((current) => ({ ...current, sourceId: sourceId || undefined, page: 1 }));
  };

  const setModeSortDirection = (direction: "asc" | "desc") => {
    if (mode === "records") setRecordQuery((current) => ({ ...current, sortDirection: direction, page: 1 }));
    else setEventQuery((current) => ({ ...current, sortDirection: direction, page: 1 }));
  };

  const exportData = async (format: "json" | "csv" | "xlsx") => {
    setExporting(format);
    setRecordError("");
    setEventError("");
    try {
      const blob = mode === "records"
        ? await downloadExplorerRecords(format, recordQuery)
        : await downloadExplorerEvents(format, eventQuery);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `kuduns-${mode === "records" ? "source-records" : "events"}.${format}`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The export could not be created.";
      if (mode === "records") setRecordError(message);
      else setEventError(message);
    } finally {
      setExporting("");
    }
  };

  const exportSelectedFields = () => {
    if (mode === "records" && records?.items.length) {
      const chosen = recordColumns.filter((column) => selectedFields.includes(`${column.sourceId}\u0000${column.path}`));
      if (!chosen.length) return;
      const rows: unknown[][] = [
        ["ingested_at", "source_key", "source_record_id", "processing_status", ...chosen.map((column) => column.label)],
        ...records.items.map((record) => [
          record.ingestedAt,
          record.source.sourceKey,
          record.sourceRecordId ?? "",
          record.processingStatus,
          ...chosen.map((column) => record.source.id === column.sourceId ? record.preview[column.path] ?? "" : ""),
        ]),
      ];
      downloadCsv("kuduns-selected-preview-fields-current-page.csv", rows);
    } else if (mode === "events" && events?.items.length) {
      const chosen = eventColumns.filter((column) => selectedFields.includes(`${column.sourceId}\u0000${column.path}`));
      if (!chosen.length) return;
      const rows: unknown[][] = [
        ["occurred_at", "ingested_at", "source_key", "source_record_id", "event_type", ...chosen.map((column) => column.label)],
        ...events.items.map((event) => [
          event.occurredAt,
          event.ingestedAt,
          event.source.sourceKey,
          event.sourceRecordId ?? "",
          event.eventType,
          ...chosen.map((column) => event.source.id === column.sourceId ? event.payload[column.path] : ""),
        ]),
      ];
      downloadCsv("kuduns-selected-event-fields-current-page.csv", rows);
    }
  };

  const refreshWorkspace = () => {
    if (mode === "records") void loadRecords(recordQuery);
    else void loadEvents(eventQuery);
    setQualityLoading(true);
    setQualityError("");
    listDataSources({ page: 1, pageSize: 100 })
      .then((page) => { setSources(page.items); setSourceError(""); })
      .catch((err: unknown) => setSourceError(err instanceof Error ? err.message : "Data sources could not be loaded."));
    getExplorerQuality(currentSourceId)
      .then((report) => { setQuality(report); setQualityError(""); })
      .catch((err: unknown) => setQualityError(err instanceof Error ? err.message : "Quality report could not be loaded."))
      .finally(() => setQualityLoading(false));
  };

  const retryRecordDetail = () => {
    if (!selectedRecordId) return;
    setRecordDetailLoading(true);
    setRecordDetailError("");
    getExplorerRecord(selectedRecordId).then(setSelectedRecord)
      .catch((err: unknown) => setRecordDetailError(err instanceof Error ? err.message : "Record detail could not be loaded."))
      .finally(() => setRecordDetailLoading(false));
  };

  const selectedCount = selectedFields.length;
  const activeColumns = mode === "records" ? recordColumns : eventColumns;

  return <main className="page-main dw-page">
    <div className="dw-page-topline">
      <div className="eyebrow"><span className="eyebrow-line" />{mode === "records" ? "SOURCE RECORDS · BEFORE CLASSIFICATION" : "NORMALIZED EVENTS · LINKED LINEAGE"}</div>
      <nav className="dw-crossnav" aria-label="Data workspace">
        <Link href="/visualisations" data-testid="link-open-visualisations">Saved visualisations <span aria-hidden="true">↗</span></Link>
      </nav>
    </div>
    <header className="page-heading dw-heading">
      <div><h1>Data explorer</h1><p>Read operational records in their source shape first. Recognition offers context; original data stays directly inspectable regardless of classification.</p></div>
      <button type="button" className="button" onClick={refreshWorkspace} disabled={activeLoading || qualityLoading} data-testid="button-refresh-records">Refresh workspace</button>
    </header>

    <div className="dw-mode-switch" role="group" aria-label="Explorer data mode">
      <button type="button" aria-pressed={mode === "records"} className={mode === "records" ? "active" : ""} onClick={() => { setMode("records"); setSelectedFields([]); }} data-testid="button-mode-records">
        <strong>Source records</strong><span>Original imported data</span>
      </button>
      <button type="button" aria-pressed={mode === "events"} className={mode === "events" ? "active" : ""} onClick={() => { setMode("events"); setSelectedFields([]); }} data-testid="button-mode-events">
        <strong>Normalized events</strong><span>Classified event view</span>
      </button>
    </div>

    {activeError && <div className="notice error dw-notice" role="alert"><span>{activeError}</span><button type="button" className="button button-danger" onClick={() => mode === "records" ? void loadRecords(recordQuery) : void loadEvents(eventQuery)} data-testid={`button-retry-${mode}`}>Retry {mode}</button></div>}

    <section className="dw-filterbar" aria-label={`${mode === "records" ? "Source record" : "Event"} filters`}>
      <div className="field dw-search-field">
        <label htmlFor="explorer-search">Search {mode === "records" ? "records" : "events"}</label>
        <input id="explorer-search" type="search" placeholder={mode === "records" ? "Record ID, source key, or source content" : "Source record, event type, or payload"} value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)} data-testid="input-explorer-search" />
      </div>
      <div className="field">
        <label htmlFor="explorer-source">Source scope</label>
        <select id="explorer-source" value={currentSourceId ?? ""} onChange={(event) => setSourceFilter(event.target.value)} data-testid="select-explorer-source">
          <option value="">All sources</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.displayName} · {source.sourceKey}</option>)}
        </select>
      </div>
      {mode === "records" ? <>
        <div className="field"><label htmlFor="explorer-sort-by">Sort records by</label>
          <select id="explorer-sort-by" value={recordQuery.sortBy} onChange={(event) => setRecordQuery((current) => ({ ...current, sortBy: event.target.value as RecordQuery["sortBy"], page: 1 }))} data-testid="select-explorer-sort-by">
            <option value="ingestedAt">Ingested time</option><option value="source">Source</option><option value="status">Processing status</option>
          </select>
        </div>
        <div className="field"><label htmlFor="explorer-sort-direction">Direction</label>
          <select id="explorer-sort-direction" value={recordQuery.sortDirection} onChange={(event) => setModeSortDirection(event.target.value as "asc" | "desc")} data-testid="select-explorer-sort-direction">
            <option value="desc">Descending</option><option value="asc">Ascending</option>
          </select>
        </div>
      </> : <>
        <div className="field"><label htmlFor="explorer-event-type">Event type</label>
          <input id="explorer-event-type" list="explorer-event-types" value={eventQuery.eventType ?? ""} onChange={(event) => setEventQuery((current) => ({ ...current, eventType: event.target.value || undefined, page: 1 }))} placeholder="All event types" data-testid="input-explorer-event-type" />
          <datalist id="explorer-event-types">{[...new Set((events?.items ?? []).map((event) => event.eventType))].sort().map((type) => <option key={type} value={type} />)}</datalist>
        </div>
        <div className="field"><label htmlFor="explorer-event-from">Occurred from</label><input id="explorer-event-from" type="datetime-local" value={eventQuery.from ?? ""} onChange={(event) => setEventQuery((current) => ({ ...current, from: event.target.value || undefined, page: 1 }))} data-testid="input-explorer-event-from" /></div>
        <div className="field"><label htmlFor="explorer-event-to">Occurred to</label><input id="explorer-event-to" type="datetime-local" value={eventQuery.to ?? ""} onChange={(event) => setEventQuery((current) => ({ ...current, to: event.target.value || undefined, page: 1 }))} data-testid="input-explorer-event-to" /></div>
        <div className="field"><label htmlFor="explorer-sort-by">Sort events by</label>
          <select id="explorer-sort-by" value={eventQuery.sortBy} onChange={(event) => setEventQuery((current) => ({ ...current, sortBy: event.target.value as EventQuery["sortBy"], page: 1 }))} data-testid="select-explorer-sort-by">
            <option value="occurredAt">Occurred time</option><option value="eventType">Event type</option><option value="source">Source</option>
          </select>
        </div>
        <div className="field"><label htmlFor="explorer-sort-direction">Direction</label>
          <select id="explorer-sort-direction" value={eventQuery.sortDirection} onChange={(event) => setModeSortDirection(event.target.value as "asc" | "desc")} data-testid="select-explorer-sort-direction">
            <option value="desc">Descending</option><option value="asc">Ascending</option>
          </select>
        </div>
      </>}
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
        </div> : <p>{sources.length ? `${sources.length} registered sources · each record remains independently attributed` : "Loading registered source context…"}</p>}
    </section>

    <div className="dw-explorer-layout dw-record-layout">
      <section className="dw-records-area" aria-label={mode === "records" ? "Persisted source records" : "Persisted events"}>
        <div className="dw-section-head">
          <div><span className="section-label">{mode === "records" ? "PERSISTED SOURCE DATA" : "NORMALIZED EVENT DATA"}</span><h2>{mode === "records" ? "Source records" : "Events"}</h2></div>
          <div className="dw-export-actions" aria-label="Export matching data">
            {(["json", "csv", "xlsx"] as const).map((format) => <button key={format} type="button" className="button button-quiet" onClick={() => void exportData(format)} disabled={Boolean(exporting) || activeLoading} data-testid={`button-export-${mode}-${format}`}>{exporting === format ? "Preparing…" : format.toUpperCase()}</button>)}
          </div>
        </div>
        <div className="dw-table-meta">
          <span>{activeLoading ? `Reading persisted ${mode}…` : `${activePage?.total ?? 0} matching ${mode === "records" ? "records" : "events"}`}</span>
          <span>PAGE {mode === "records" ? recordQuery.page : eventQuery.page} / {activePageCount}</span>
        </div>
        {mode === "records" && <p className="dw-preview-note">The list contains summaries and previews only. Full raw payloads load after selecting a record.</p>}
        {activeLoading ? <div className="dw-table-skeleton" aria-label={`Loading ${mode}`}><i /><i /><i /><i /></div> :
          mode === "records" ? records?.items.length ? <div className="table-frame dw-table-frame"><table className="dw-event-table dw-record-table">
            <thead><tr>
              <th scope="col">INGESTED · UTC</th><th scope="col">SOURCE</th><th scope="col">SOURCE RECORD ID</th><th scope="col">PROCESSING STATUS</th><th scope="col">FIELDS</th>
              {recordColumns.map((column) => <th key={`${column.sourceId}:${column.path}`} scope="col" title={`${column.label} · preview value`}>{column.label}<small className="dw-type-label">preview</small></th>)}
            </tr></thead>
            <tbody>{records.items.map((record) => <tr key={record.id} className={selectedRecordId === record.id ? "dw-row-selected" : ""}>
              <td><button type="button" className="dw-row-select" onClick={() => setSelectedRecordId(record.id)} data-testid={`button-select-record-${record.id}`} aria-pressed={selectedRecordId === record.id}>{prettyDate(record.ingestedAt)}</button></td>
              <td><span className="dw-table-source">{record.source.displayName}</span><code>{record.source.sourceKey}</code></td>
              <td><code className="dw-record-key">{record.sourceRecordId ?? "Not supplied"}</code></td>
              <td><StatusPill status={record.processingStatus} /></td>
              <td><span className="dw-field-count">{record.fieldCount}</span></td>
              {recordColumns.map((column) => {
                const value = record.source.id === column.sourceId ? record.preview[column.path] : undefined;
                const display = value === undefined
                  ? record.source.id === column.sourceId && record.fieldNames.includes(column.path)
                    ? "Open record"
                    : "Not present"
                  : displayValue(value);
                return <td key={`${column.sourceId}:${column.path}`} title={value ?? display}>{display}</td>;
              })}
            </tr>)}</tbody>
          </table></div> : <StateMessage title={recordQuery.search || recordQuery.sourceId ? "No matching source records" : "No persisted source records"} message={recordQuery.search || recordQuery.sourceId ? "Change the source scope or search terms. This view reads persisted source records only." : "Persisted records will appear here before semantic classification is required."} /> :
          events?.items.length ? <div className="table-frame dw-table-frame"><table className="dw-event-table">
            <thead><tr><th scope="col">OCCURRED · UTC</th><th scope="col">SOURCE / RECORD</th><th scope="col">EVENT TYPE</th><th scope="col">ASSET</th><th scope="col">INGESTED · UTC</th>{eventColumns.map((column) => <th key={`${column.sourceId}:${column.path}`} scope="col" title={`${column.label} · ${column.observedTypes.join(", ")}`}>{column.label}<small className="dw-type-label">{column.observedTypes.join(" / ")}</small></th>)}</tr></thead>
            <tbody>{events.items.map((event) => <tr key={event.id} className={selectedEventId === event.id ? "dw-row-selected" : ""}>
              <td><button type="button" className="dw-row-select" onClick={() => setSelectedEventId(event.id)} data-testid={`button-select-event-${event.id}`} aria-pressed={selectedEventId === event.id}>{prettyDate(event.occurredAt)}</button></td>
              <td><span className="dw-table-source">{event.source.displayName}</span><code>{event.sourceRecordId ?? "No source record ID"}</code></td>
              <td><span className="dw-event-type">{event.eventType}</span></td>
              <td>{event.asset ? <><span>{event.asset.name}</span><code>{event.asset.assetKey}</code></> : <span className="muted">Unassigned</span>}</td>
              <td className="dw-table-time">{prettyDate(event.ingestedAt)}</td>
              {eventColumns.map((column) => {
                const value = event.source.id === column.sourceId ? event.payload[column.path] : undefined;
                return <td key={`${column.sourceId}:${column.path}`} title={typeof value === "object" && value !== null ? JSON.stringify(value) : undefined}>{displayValue(value)}</td>;
              })}
            </tr>)}</tbody>
          </table></div> : <StateMessage title="No matching events" message="Change the source, event type, search, or occurrence time range. Event mode shows normalized events that are already persisted." />}
        <div className="dw-pagination">
          <span>{activePage ? `Showing ${activePage.items.length ? ((mode === "records" ? recordQuery.page : eventQuery.page) - 1) * activePage.pageSize + 1 : 0}–${Math.min((mode === "records" ? recordQuery.page : eventQuery.page) * activePage.pageSize, activePage.total)} of ${activePage.total}` : "—"}</span>
          <div>
            <button type="button" className="button" disabled={(mode === "records" ? recordQuery.page : eventQuery.page) <= 1 || activeLoading} onClick={() => mode === "records" ? setRecordQuery((current) => ({ ...current, page: current.page - 1 })) : setEventQuery((current) => ({ ...current, page: current.page - 1 }))} data-testid={`button-${mode}-previous`}>Previous</button>
            <button type="button" className="button" disabled={(mode === "records" ? recordQuery.page : eventQuery.page) >= activePageCount || activeLoading} onClick={() => mode === "records" ? setRecordQuery((current) => ({ ...current, page: current.page + 1 })) : setEventQuery((current) => ({ ...current, page: current.page + 1 }))} data-testid={`button-${mode}-next`}>Next</button>
          </div>
        </div>
        {activeColumns.length > 0 && <details className="dw-field-picker" data-testid="details-selected-field-export">
          <summary>{mode === "records" ? "Choose preview fields for selected-field CSV" : "Choose event fields for selected-field CSV"}</summary>
          <div className="dw-field-picker-options">{activeColumns.map((column) => {
            const key = `${column.sourceId}\u0000${column.path}`;
            return <label key={key}>
              <input type="checkbox" checked={selectedFields.includes(key)} onChange={(event) => setSelectedFields((current) => event.target.checked ? [...new Set([...current, key])] : current.filter((item) => item !== key))} data-testid={`checkbox-export-field-${column.sourceId}-${column.path}`} />
              <span>{column.label}</span><small>{mode === "records" ? "summary preview" : (column as EventPayloadColumn).observedTypes.join(" / ")}</small>
            </label>;
          })}</div>
          <div className="dw-field-picker-footer">
            <span>{mode === "records" ? "Selected-field CSV uses the summary preview for this visible page; it does not fetch full payloads." : "Selected-field CSV includes the visible event page. Full exports include all matched records."}</span>
            <button type="button" className="button" disabled={!selectedCount || activeLoading} onClick={exportSelectedFields} data-testid="button-export-selected-fields">Export selected fields · page</button>
          </div>
        </details>}
      </section>

      <aside className="dw-inspector" aria-label={mode === "records" ? "Source record inspection" : "Event inspection"}>
        <div className="dw-inspector-head"><div><span className="section-label">RECORD INSPECTION</span><h2>{mode === "records" ? "Original data & lineage" : "Event payload & lineage"}</h2></div><span className="dw-inspector-mark">01</span></div>
        {activeLoading || (mode === "records" && (recordDetailLoading || Boolean(selectedRecordId && selectedRecord?.id !== selectedRecordId && !recordDetailError))) ? <div className="dw-inspector-loading" aria-label="Loading selected record"><i /><i /><i /></div> :
          mode === "records" ? recordDetailError
            ? <StateMessage title="Record detail unavailable" message={recordDetailError} action={<button type="button" className="button" onClick={retryRecordDetail} data-testid="button-retry-record-detail">Retry detail</button>} />
            : selectedRecord ? <div className="dw-inspector-content">
              <div className="dw-inspector-source"><span>SOURCE IDENTITY</span><strong>{selectedRecord.source.displayName}</strong><code>{selectedRecord.source.sourceKey} · {selectedRecord.source.id}</code></div>
              <dl className="dw-event-meta">
                <dt>Record ID</dt><dd className="mono">{selectedRecord.id}</dd>
                <dt>Source record ID</dt><dd className="mono">{selectedRecord.sourceRecordId ?? "Not supplied"}</dd>
                <dt>Deduplication key</dt><dd className="mono">{selectedRecord.deduplicationKey ?? "Not supplied"}</dd>
                <dt>Ingested</dt><dd>{prettyDate(selectedRecord.ingestedAt)}</dd>
                <dt>Processing state</dt><dd><StatusPill status={selectedRecord.processingStatus} /></dd>
                <dt>Field count</dt><dd>{selectedRecord.fieldCount}</dd>
                <dt>Missing fields</dt><dd>{selectedRecord.missingFields.length ? selectedRecord.missingFields.join(", ") : "None reported"}</dd>
              </dl>
              {selectedRecord.normalizedEvent && <div className="dw-linked-event"><span>LINKED NORMALIZED EVENT</span><strong>{selectedRecord.normalizedEvent.eventType}</strong><code>{selectedRecord.normalizedEvent.id}</code><time>{prettyDate(selectedRecord.normalizedEvent.occurredAt)}</time></div>}
              <section className="dw-json-section">
                <div className="dw-json-title"><h3>Original source record</h3><span>AS RECEIVED · UNMODIFIED</span></div>
                <div className="dw-view-toggle" role="group" aria-label="Original record display">
                  <button type="button" aria-pressed={payloadView === "tree"} onClick={() => setPayloadView("tree")} data-testid="button-record-tree">Tree</button>
                  <button type="button" aria-pressed={payloadView === "raw"} onClick={() => setPayloadView("raw")} data-testid="button-record-raw">Raw JSON</button>
                </div>
                {payloadView === "tree"
                  ? <div className="dw-json-tree" data-testid="tree-source-record"><JsonTree label="raw record" value={selectedRecord.rawRecord} /></div>
                  : <pre className="event-json" data-testid="json-source-record">{stringify(selectedRecord.rawRecord)}</pre>}
              </section>
              <section className="dw-json-section">
                <div className="dw-json-title"><h3>Provenance</h3><span>TRACE DATA</span></div>
                <div className="dw-view-toggle" role="group" aria-label="Provenance display">
                  <button type="button" aria-pressed={provenanceView === "tree"} onClick={() => setProvenanceView("tree")} data-testid="button-provenance-tree">Tree</button>
                  <button type="button" aria-pressed={provenanceView === "raw"} onClick={() => setProvenanceView("raw")} data-testid="button-provenance-raw">Raw JSON</button>
                </div>
                {provenanceView === "tree"
                  ? <div className="dw-json-tree" data-testid="tree-record-provenance"><JsonTree label="provenance" value={selectedRecord.provenance} /></div>
                  : <pre className="event-json" data-testid="json-record-provenance">{stringify(selectedRecord.provenance)}</pre>}
              </section>
            </div> : <StateMessage title="Choose a source record" message="Select a summary row to load and inspect the complete original payload, provenance, missing-field details, and linked event." />
          : selectedEvent ? <div className="dw-inspector-content">
            <div className="dw-inspector-source"><span>SOURCE IDENTITY</span><strong>{selectedEvent.source.displayName}</strong><code>{selectedEvent.source.sourceKey} · {selectedEvent.source.id}</code></div>
            <dl className="dw-event-meta">
              <dt>Event ID</dt><dd className="mono">{selectedEvent.id}</dd>
              <dt>Source record</dt><dd className="mono">{selectedEvent.sourceRecordId ?? "Not supplied"}</dd>
              <dt>Event type</dt><dd>{selectedEvent.eventType}</dd>
              <dt>Occurred</dt><dd>{prettyDate(selectedEvent.occurredAt)}</dd>
              <dt>Source timestamp</dt><dd>{prettyDate(selectedEvent.sourceTimestamp)}</dd>
              <dt>Ingested</dt><dd>{prettyDate(selectedEvent.ingestedAt)}</dd>
              <dt>Deduplication key</dt><dd className="mono">{selectedEvent.deduplicationKey ?? "Not supplied"}</dd>
            </dl>
            {selectedEvent.asset && <div className="dw-asset-context"><span>ASSET CONTEXT</span><strong>{selectedEvent.asset.name}</strong><code>{selectedEvent.asset.assetKey}</code></div>}
            <section className="dw-json-section"><div className="dw-json-title"><h3>Event payload</h3><span>NESTED STRUCTURE RETAINED</span></div><pre className="event-json" data-testid="json-event-payload">{stringify(selectedEvent.payload)}</pre></section>
            <section className="dw-json-section"><div className="dw-json-title"><h3>Provenance</h3><span>TRACE DATA</span></div><pre className="event-json" data-testid="json-event-provenance">{stringify(selectedEvent.provenance)}</pre></section>
          </div> : <StateMessage title="Choose an event" message="Select an event row to inspect its normalized event fields, payload, and traceable source lineage." />}
      </aside>
    </div>

    {mode === "records" && <RecordVisualization query={recordQuery} />}
    {mode === "records" && <RecognitionPanel recognition={recognition} loading={recordsLoading} />}

    <section className="dw-quality-panel" aria-labelledby="quality-heading">
      <div className="dw-section-head">
        <div><span className="section-label">INTEGRITY REVIEW</span><h2 id="quality-heading">Data quality</h2></div>
        <span className="dw-quality-context">{currentSource ? currentSource.displayName : "All sources"}</span>
      </div>
      {qualityLoading ? <div className="dw-quality-skeleton" aria-label="Loading data quality"><i /><i /><i /></div> :
        qualityError ? <div className="notice error" role="alert"><span>{qualityError}</span><button className="button button-danger" type="button" onClick={() => {
          setQualityLoading(true);
          getExplorerQuality(currentSourceId).then((report) => { setQuality(report); setQualityError(""); }).catch((err: unknown) => setQualityError(err instanceof Error ? err.message : "Quality report could not be loaded.")).finally(() => setQualityLoading(false));
        }} data-testid="button-retry-quality">Retry quality report</button></div> :
          !quality?.sources.length ? <p className="dw-quality-note">No persisted event history is available for this scope yet.</p> :
            <div className="dw-quality-report" data-testid="explorer-quality-report">
              {quality.sourcesTruncated && <p className="dw-quality-note">The report is limited to the first 50 registered sources. Select a source to inspect it directly.</p>}
              {quality.sources.map((sourceReport) => <article key={sourceReport.source.id} className="dw-quality-source">
                <header><strong>{sourceReport.source.displayName}</strong><code>{sourceReport.sampledEvents} total · {sourceReport.recentSampledEvents} recent / {sourceReport.previousSampledEvents} prior</code></header>
                {sourceReport.insufficientHistory && <p className="dw-quality-note">Not enough historical samples for a stable comparison. Reported differences are observational, not a confirmed upstream schema change.</p>}
                {(sourceReport.fieldsTruncated || sourceReport.schemaChangesTruncated) && <p className="dw-quality-note">This report is bounded to protect responsiveness; some field paths or schema differences are omitted from the summary, not from stored records.</p>}
                <div className="dw-quality-table-wrap"><table className="dw-quality-table">
                  <thead><tr><th scope="col">Field path</th><th scope="col">Observed type</th><th scope="col">Recent sample presence</th></tr></thead>
                  <tbody>{sourceReport.fields.map((field) => <tr key={field.path}><td><code>{field.path}</code></td><td>{field.observedTypes.join(", ")}</td><td>{field.recordsPresent} / {sourceReport.recentSampledEvents}</td></tr>)}</tbody>
                </table></div>
                {sourceReport.schemaChanges.length > 0 && <ul className="dw-schema-changes">{sourceReport.schemaChanges.map((change) => <li key={`${change.path}:${change.change}`}><strong>{change.change.replace("_", " ")}</strong><code>{change.path}</code><span>{change.previousTypes.join(", ") || "not observed"} → {change.currentTypes.join(", ") || "not observed"}</span></li>)}</ul>}
              </article>)}
            </div>}
      <p className="dw-quality-note">Quality review is descriptive. It does not block access to source records.</p>
    </section>
  </main>;
}
