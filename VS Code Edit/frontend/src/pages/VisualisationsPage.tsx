import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import type { DataSourceRecord, EventDetail } from "@kudu/shared";
import { listDataSources, listExplorerEvents } from "../api";
import "./data-workspace.css";

const STORAGE_KEY = "kuduns.saved-visualisations.v1";
const CONFIG_VERSION = 1;

type SavedVisualisation = {
  id: string;
  version: 1;
  name: string;
  sourceId: string;
  eventType: string;
  valuePath: string;
  categoryPath?: string;
  visualisationType?: "line" | "bar" | "distribution" | "table";
  from: string;
  to: string;
  createdAt: string;
};

type NumericValue = { path: string; value: number };
type ScalarValue = { path: string; value: string | number | boolean };

function readSaved(): SavedVisualisation[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedVisualisation =>
      typeof item === "object" && item !== null &&
      (item as SavedVisualisation).version === CONFIG_VERSION &&
      typeof (item as SavedVisualisation).id === "string" &&
      typeof (item as SavedVisualisation).name === "string" &&
      typeof (item as SavedVisualisation).sourceId === "string" &&
      typeof (item as SavedVisualisation).eventType === "string" &&
      typeof (item as SavedVisualisation).valuePath === "string" &&
      typeof (item as SavedVisualisation).from === "string" &&
      typeof (item as SavedVisualisation).to === "string"
    );
  } catch {
    return [];
  }
}

function collectNumbers(value: unknown, path = ""): NumericValue[] {
  if (typeof value === "number" && Number.isFinite(value)) return path ? [{ path, value }] : [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => collectNumbers(entry, `${path}[${index}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => collectNumbers(entry, path ? `${path}.${key}` : key));
  }
  return [];
}

function collectScalars(value: unknown, path = ""): ScalarValue[] {
  if (path && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
    return [{ path, value }];
  }
  if (Array.isArray(value)) return [];
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => collectScalars(entry, path ? `${path}.${key}` : key));
  }
  return [];
}

function valueAtPath(root: unknown, path: string): unknown {
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  return segments.reduce<unknown>((value, segment) => {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, root);
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(date) + " UTC";
}

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function VisualisationsPage() {
  const [sources, setSources] = useState<DataSourceRecord[]>([]);
  const [sourceError, setSourceError] = useState("");
  const [saved, setSaved] = useState<SavedVisualisation[]>(() => readSaved());
  const [activeId, setActiveId] = useState("");
  const [name, setName] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [eventType, setEventType] = useState("");
  const [valuePath, setValuePath] = useState("");
  const [categoryPath, setCategoryPath] = useState("");
  const [visualisationType, setVisualisationType] = useState<"line" | "bar" | "distribution" | "table">("line");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [events, setEvents] = useState<EventDetail[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");

  useEffect(() => {
    let active = true;
    listDataSources({ page: 1, pageSize: 100 }).then((page) => {
      if (!active) return;
      setSources(page.items);
      setSourceError("");
      if (!sourceId && page.items[0]) setSourceId(page.items[0].id);
    }).catch((err: unknown) => {
      if (active) setSourceError(err instanceof Error ? err.message : "Data sources could not be loaded.");
    }).finally(() => { if (active) setLoadingSources(false); });
    return () => { active = false; };
  }, []);

  const fetchEvents = useCallback(async (configuration: Pick<SavedVisualisation, "sourceId" | "eventType" | "from" | "to">) => {
    if (!configuration.sourceId || !configuration.eventType) {
      setEvents([]);
      setTotal(0);
      return;
    }
    setLoadingEvents(true);
    setError("");
    try {
      const page = await listExplorerEvents({
        sourceId: configuration.sourceId,
        eventType: configuration.eventType,
        from: configuration.from || undefined,
        to: configuration.to || undefined,
        page: 1,
        pageSize: 100,
        sortBy: "occurredAt",
        sortDirection: "asc",
      });
      setEvents(page.items);
      setTotal(page.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Imported event data could not be loaded.");
      setEvents([]);
      setTotal(0);
    } finally {
      setLoadingEvents(false);
    }
  }, []);

  const currentSource = sources.find((source) => source.id === sourceId);
  const pathOptions = useMemo(() => {
    const candidates = new Map<string, number>();
    events.forEach((event) => collectNumbers(event.payload).forEach(({ path }) => candidates.set(path, (candidates.get(path) ?? 0) + 1)));
    return [...candidates.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path));
  }, [events]);
  const categoryOptions = useMemo(() => {
    const candidates = new Map<string, number>();
    events.forEach((event) => collectScalars(event.payload).forEach(({ path }) => candidates.set(path, (candidates.get(path) ?? 0) + 1)));
    return [...candidates.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path));
  }, [events]);

  useEffect(() => {
    if (valuePath && pathOptions.some((option) => option.path === valuePath)) return;
    if (!activeId) setValuePath(pathOptions[0]?.path ?? "");
  }, [pathOptions, valuePath, activeId]);

  const chartPoints = useMemo(() => events.flatMap((event) => {
    const value = valueAtPath(event.payload, valuePath);
    return typeof value === "number" && Number.isFinite(value) ? [{ id: event.id, at: event.occurredAt, value, sourceRecordId: event.sourceRecordId }] : [];
  }), [events, valuePath]);

  const chartGeometry = useMemo(() => {
    if (!chartPoints.length) return { points: "", min: 0, max: 0, labels: [] as string[] };
    const values = chartPoints.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || Math.max(Math.abs(max) * 0.08, 1);
    const points = chartPoints.map((point, index) => {
      const x = chartPoints.length === 1 ? 50 : 5 + index / (chartPoints.length - 1) * 90;
      const y = 90 - ((point.value - min) / span) * 78;
      return `${x},${y}`;
    }).join(" ");
    return { points, min, max, labels: [chartPoints[0].at, chartPoints[chartPoints.length - 1].at] };
  }, [chartPoints]);
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of events) {
      const value = valueAtPath(event.payload, categoryPath);
      if (value === null || value === undefined || typeof value === "object") continue;
      const label = String(value);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 20);
  }, [events, categoryPath]);

  const chooseSaved = (visual: SavedVisualisation) => {
    setActiveId(visual.id);
    setName(visual.name);
    setSourceId(visual.sourceId);
    setEventType(visual.eventType);
    setValuePath(visual.valuePath);
    setCategoryPath(visual.categoryPath ?? "");
    setVisualisationType(visual.visualisationType ?? "line");
    setFrom(visual.from);
    setTo(visual.to);
    void fetchEvents(visual);
  };

  const saveConfiguration = () => {
    if (!name.trim() || !sourceId || !eventType || !valuePath) return;
    const existing = saved.find((item) => item.id === activeId);
    const config: SavedVisualisation = {
      id: activeId || makeId(),
      version: CONFIG_VERSION,
      name: name.trim(),
      sourceId,
      eventType,
      valuePath,
      categoryPath,
      visualisationType,
      from,
      to,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    const next = activeId ? saved.map((item) => item.id === activeId ? config : item) : [config, ...saved];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setSaved(next);
      setActiveId(config.id);
      setStorageError("");
    } catch {
      setStorageError("This browser could not save the configuration. Check available local storage.");
    }
  };

  const deleteConfiguration = (id: string) => {
    const target = saved.find((visual) => visual.id === id);
    if (target && !window.confirm(`Remove “${target.name}” from this browser profile?`)) return;
    const next = saved.filter((visual) => visual.id !== id);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setSaved(next);
      setStorageError("");
      if (activeId === id) {
        setActiveId("");
        setName("");
      }
    } catch {
      setStorageError("This browser could not update its saved visualisations.");
    }
  };

  const canSave = Boolean(
    name.trim() && sourceId && eventType &&
    (visualisationType === "line" ? valuePath : visualisationType === "table" ? true : categoryPath),
  );
  const selectedSaved = saved.find((visual) => visual.id === activeId);

  return <main className="page-main dw-page dw-viz-page">
    <div className="dw-page-topline"><div className="eyebrow"><span className="eyebrow-line" />PERSISTED DATA · PERSONAL WORKSPACE</div>
      <nav className="dw-crossnav" aria-label="Data workspace"><Link href="/data-explorer" data-testid="link-open-data-explorer">Data explorer <span aria-hidden="true">↗</span></Link></nav>
    </div>
    <header className="page-heading dw-heading">
      <div><h1>Visualisations</h1><p>Build a focused view from imported event measurements. Saved definitions stay in this browser profile.</p></div>
      <span className="dw-version-stamp">CONFIGURATION SCHEMA · V1</span>
    </header>

    <div className="dw-viz-layout">
      <aside className="dw-saved-rail" aria-label="Saved visualisations">
        <div className="dw-saved-heading"><span className="section-label">LOCAL LIBRARY</span><strong>Saved views <span>{saved.length.toString().padStart(2, "0")}</span></strong></div>
        {saved.length ? <ul className="dw-saved-list">{saved.map((visual, index) => <li key={visual.id} className={activeId === visual.id ? "dw-saved-active" : ""}>
          <button type="button" className="dw-saved-open" onClick={() => chooseSaved(visual)} data-testid={`button-open-visualisation-${visual.id}`}><span className="dw-saved-number">{String(index + 1).padStart(2, "0")}</span><span><strong>{visual.name}</strong><small>{visual.eventType} · {sources.find((source) => source.id === visual.sourceId)?.displayName ?? "Source unavailable"}</small></span></button>
          <button type="button" className="dw-saved-delete" aria-label={`Delete ${visual.name}`} onClick={() => deleteConfiguration(visual.id)} data-testid={`button-delete-visualisation-${visual.id}`}>Remove</button>
        </li>)}</ul> : <div className="dw-saved-empty"><span>—</span><p>No saved views yet. Configure a dataset and save its chart.</p></div>}
        <p className="dw-local-note"><strong>Browser-local storage</strong>Configurations are versioned and stored only in this browser profile. Event records remain on the KuduNS server.</p>
      </aside>

      <section className="dw-viz-workbench">
        <div className="dw-section-head"><div><span className="section-label">CHART DEFINITION</span><h2>{selectedSaved ? "Reopen or refine view" : "New visualisation"}</h2></div><span className="dw-definition-id">{selectedSaved ? selectedSaved.id.slice(0, 8) : "UNSAVED"}</span></div>
        <div className="dw-viz-controls">
          <div className="field"><label htmlFor="visual-name">View name</label><input id="visual-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name this visualisation" data-testid="input-visualisation-name" /></div>
          <div className="field"><label htmlFor="visual-source">Data source</label><select id="visual-source" value={sourceId} onChange={(event) => { setSourceId(event.target.value); setEventType(""); setValuePath(""); setActiveId(""); setEvents([]); }} data-testid="select-visualisation-source"><option value="">Choose source</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.displayName} · {source.sourceKey}</option>)}</select></div>
          <div className="field"><label htmlFor="visual-event-type">Event type</label><input id="visual-event-type" value={eventType} onChange={(event) => { setEventType(event.target.value); setActiveId(""); }} placeholder="Enter an imported event type" data-testid="input-visualisation-event-type" /><span className="field-hint">Use the exact event type in imported records.</span></div>
          <div className="field"><label htmlFor="visual-type">Visualisation</label><select id="visual-type" value={visualisationType} onChange={(event) => { setVisualisationType(event.target.value as typeof visualisationType); setActiveId(""); }} data-testid="select-visualisation-type"><option value="line">Time-series line</option><option value="bar">Category bar chart</option><option value="distribution">State/category distribution</option><option value="table">Tabular view</option></select></div>
          <div className="field"><label htmlFor="visual-from">From · optional</label><input id="visual-from" type="datetime-local" value={from} onChange={(event) => { setFrom(event.target.value); setActiveId(""); }} data-testid="input-visualisation-from" /></div>
          <div className="field"><label htmlFor="visual-to">To · optional</label><input id="visual-to" type="datetime-local" value={to} onChange={(event) => { setTo(event.target.value); setActiveId(""); }} data-testid="input-visualisation-to" /></div>
          <div className="field dw-load-field"><label>Dataset preview</label><button type="button" className="button button-primary" onClick={() => void fetchEvents({ sourceId, eventType, from, to })} disabled={!sourceId || !eventType || loadingEvents} data-testid="button-load-visualisation-data">{loadingEvents ? "Loading imported data…" : "Load imported data"}</button></div>
        </div>
        {sourceError && <div className="notice error" role="alert"><span>{sourceError}</span><button type="button" className="button button-danger" onClick={() => {
          setLoadingSources(true);
          listDataSources({ page: 1, pageSize: 100 }).then((page) => { setSources(page.items); setSourceError(""); }).catch((err: unknown) => setSourceError(err instanceof Error ? err.message : "Data sources could not be loaded.")).finally(() => setLoadingSources(false));
        }} data-testid="button-retry-visualisation-sources">Retry sources</button></div>}
        {loadingSources && <p className="dw-subtle-status" role="status">Loading registered sources…</p>}
        {currentSource && <div className="dw-provenance-strip"><span className="dw-signal" /><strong>{currentSource.displayName}</strong><code>{currentSource.sourceKey}</code><span>Separate source lineage preserved</span></div>}
        {error && <div className="notice error" role="alert"><span>{error}</span><button type="button" className="button button-danger" onClick={() => void fetchEvents({ sourceId, eventType, from, to })} data-testid="button-retry-visualisation-data">Retry</button></div>}
        {storageError && <div className="notice error" role="alert">{storageError}</div>}

        <section className="dw-chart-panel" aria-labelledby="chart-title">
          <div className="dw-chart-header"><div><span className="section-label">{visualisationType === "line" ? "TIME SERIES · NUMERICAL TREND" : visualisationType === "bar" ? "BAR CHART · CATEGORY COUNTS" : visualisationType === "distribution" ? "DISTRIBUTION · CATEGORY COUNTS" : "TABULAR · IMPORTED RECORDS"}</span><h3 id="chart-title">{visualisationType === "line" ? valuePath || "Choose a numeric payload field" : visualisationType === "table" ? "Selected source records" : categoryPath || "Choose a category or state field"}</h3></div>
            <div className="dw-chart-count"><strong>{visualisationType === "line" ? chartPoints.length : visualisationType === "table" ? events.length : categoryCounts.length}</strong><span>{visualisationType === "line" ? "numeric points" : visualisationType === "table" ? "records" : "categories"}</span></div>
          </div>
          {visualisationType === "line" && pathOptions.length > 0 && <div className="dw-measure-select"><label htmlFor="visual-measure">Numeric payload field</label><select id="visual-measure" value={valuePath} onChange={(event) => setValuePath(event.target.value)} data-testid="select-visualisation-measure">{pathOptions.map((option) => <option key={option.path} value={option.path}>{option.path} · {option.count} records</option>)}</select></div>}
          {(visualisationType === "bar" || visualisationType === "distribution") && categoryOptions.length > 0 && <div className="dw-measure-select"><label htmlFor="visual-category">Category or state field</label><select id="visual-category" value={categoryPath} onChange={(event) => setCategoryPath(event.target.value)} data-testid="select-visualisation-category"><option value="">Choose an exact payload path</option>{categoryOptions.map((option) => <option key={option.path} value={option.path}>{option.path} · {option.count} records</option>)}</select></div>}
          {visualisationType === "table" && categoryOptions.length > 0 && <div className="dw-measure-select"><label htmlFor="visual-table-field">Optional payload field</label><select id="visual-table-field" value={categoryPath} onChange={(event) => setCategoryPath(event.target.value)} data-testid="select-visualisation-table-field"><option value="">Record metadata only</option>{categoryOptions.map((option) => <option key={option.path} value={option.path}>{option.path} · {option.count} records</option>)}</select></div>}
          {loadingEvents ? <div className="dw-chart-skeleton" aria-label="Loading chart data"><i /><i /><i /></div> :
            visualisationType === "line" && chartPoints.length ? <div className="dw-chart-wrap">
              <svg className="dw-time-chart" viewBox="0 0 100 100" role="img" aria-label={`${chartPoints.length} numeric measurements for ${valuePath}`}>
                <line x1="5" y1="12" x2="95" y2="12" /><line x1="5" y1="51" x2="95" y2="51" /><line x1="5" y1="90" x2="95" y2="90" />
                <polyline points={chartGeometry.points} />
                {chartPoints.map((point, index) => {
                  const x = chartPoints.length === 1 ? 50 : 5 + index / (chartPoints.length - 1) * 90;
                  const span = chartGeometry.max - chartGeometry.min || Math.max(Math.abs(chartGeometry.max) * 0.08, 1);
                  const y = 90 - ((point.value - chartGeometry.min) / span) * 78;
                  return <circle key={point.id} cx={x} cy={y} r="1.45"><title>{`${formatDate(point.at)} · ${point.value}${point.sourceRecordId ? ` · ${point.sourceRecordId}` : ""}`}</title></circle>;
                })}
              </svg>
              <div className="dw-chart-axis"><span>{chartGeometry.min.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span><span>{chartGeometry.max.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span></div>
              <div className="dw-chart-dates"><span>{formatDate(chartGeometry.labels[0])}</span><span>{formatDate(chartGeometry.labels[1])}</span></div>
              <p className="dw-chart-caption">Points are individual persisted events in occurred-time order. Hover a point for timestamp and source record ID. No values are combined across fields or sources.</p>
            </div> : visualisationType === "bar" || visualisationType === "distribution" ? categoryCounts.length ? <div className="dw-category-chart" data-testid="category-visualisation">
              {categoryCounts.map(([label, count]) => <div className="dw-category-row" key={label}><span title={label}>{label}</span><div><i style={{ width: `${Math.max(3, count / categoryCounts[0][1] * 100)}%` }} /></div><strong>{count}</strong></div>)}
            </div> : <div className="dw-chart-empty" role="status"><span>NO CATEGORIES</span><p>Choose a category field with values in the loaded persisted records.</p></div> :
              visualisationType === "table" && events.length ? <div className="table-frame dw-table-frame"><table data-testid="tabular-visualisation"><thead><tr><th>Occurred · UTC</th><th>Source record</th><th>Event type</th><th>{valuePath || categoryPath || "Selected payload values"}</th></tr></thead><tbody>{events.map((event) => { const path = valuePath || categoryPath; return <tr key={event.id}><td>{formatDate(event.occurredAt)}</td><td>{event.sourceRecordId ?? "—"}</td><td>{event.eventType}</td><td>{path ? String(valueAtPath(event.payload, path) ?? "Missing") : event.source.displayName}</td></tr>; })}</tbody></table></div> :
                <div className="dw-chart-empty" role="status"><span>NO SERIES</span><p>{events.length ? "No values were available for the selected field in this loaded page." : total ? `The query matched ${total} persisted events, but this page contains no points.` : "Choose a source and exact event type, then load persisted records to discover fields."}</p></div>}
          <div className="dw-chart-foot"><span>Imported events queried: {total}</span><span>Rendered page: up to 100 records</span></div>
        </section>
        <div className="dw-viz-actions"><p>Saving stores the query definition only; data is re-read from persisted events when reopened.</p><button type="button" className="button button-primary" onClick={saveConfiguration} disabled={!canSave} data-testid="button-save-visualisation">{activeId ? "Update saved view" : "Save visualisation"}</button></div>
      </section>
    </div>
  </main>;
}
