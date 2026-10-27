import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "wouter";
import type { EventDetail, EventListFilters, EventListItem, Page } from "@kudu/shared";
import { getEvent, listEvents } from "../api";
import {
  displayError,
  EmptyState,
  ErrorState,
  formatDate,
  ListPagination,
  LoadingState,
  PageIntro,
} from "../components/RegistryUI";

const PAGE_SIZE = 20;

function localTimeToUtc(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function EventsListPage() {
  const [sourceKey, setSourceKey] = useState("");
  const [assetKey, setAssetKey] = useState("");
  const [eventType, setEventType] = useState("");
  const [fromLocal, setFromLocal] = useState("");
  const [toLocal, setToLocal] = useState("");
  const [filters, setFilters] = useState<EventListFilters>({});
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<EventListItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await listEvents({ ...filters, page, pageSize: PAGE_SIZE });
      if (current === requestId.current) setResult(response);
    } catch (cause) {
      if (current === requestId.current) setError(displayError(cause));
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setFilters({
      ...(sourceKey.trim() ? { sourceKey: sourceKey.trim() } : {}),
      ...(assetKey.trim() ? { assetKey: assetKey.trim() } : {}),
      ...(eventType.trim() ? { eventType: eventType.trim() } : {}),
      ...(localTimeToUtc(fromLocal) ? { from: localTimeToUtc(fromLocal) } : {}),
      ...(localTimeToUtc(toLocal) ? { to: localTimeToUtc(toLocal) } : {}),
    });
  }

  function clearFilters() {
    setSourceKey("");
    setAssetKey("");
    setEventType("");
    setFromLocal("");
    setToLocal("");
    setFilters({});
    setPage(1);
  }

  const maxPage = Math.max(1, Math.ceil((result?.total ?? 0) / (result?.pageSize ?? PAGE_SIZE)));
  return (
    <main className="page-main">
      <PageIntro
        eyebrow="REGISTRY / 03"
        title="Events"
        description="Browse persisted event records with their source provenance and registered asset context."
      />
      <form className="event-filters" onSubmit={applyFilters} data-testid="form-event-filters">
        <div className="field">
          <label htmlFor="event-source-filter">Source key</label>
          <input
            id="event-source-filter"
            data-testid="filter-event-source"
            value={sourceKey}
            onChange={event => setSourceKey(event.target.value)}
            placeholder="Exact registered key"
          />
        </div>
        <div className="field">
          <label htmlFor="event-asset-filter">Asset key</label>
          <input
            id="event-asset-filter"
            data-testid="filter-event-asset"
            value={assetKey}
            onChange={event => setAssetKey(event.target.value)}
            placeholder="Exact registered key"
          />
        </div>
        <div className="field">
          <label htmlFor="event-type-filter">Event type</label>
          <input
            id="event-type-filter"
            data-testid="filter-event-type"
            value={eventType}
            onChange={event => setEventType(event.target.value)}
            placeholder="For example, alarm.raised"
          />
        </div>
        <div className="field">
          <label htmlFor="event-from-filter">From</label>
          <input
            id="event-from-filter"
            data-testid="filter-event-from"
            type="datetime-local"
            value={fromLocal}
            onChange={event => setFromLocal(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="event-to-filter">To</label>
          <input
            id="event-to-filter"
            data-testid="filter-event-to"
            type="datetime-local"
            value={toLocal}
            onChange={event => setToLocal(event.target.value)}
          />
        </div>
        <p className="field-hint event-time-hint">Date-time filters use your local timezone; event times are displayed in UTC.</p>
        <div className="event-filter-actions">
          <button className="button button-primary" type="submit" data-testid="button-apply-event-filters">Apply filters</button>
          <button className="button" type="button" onClick={clearFilters} data-testid="button-clear-event-filters">Clear</button>
        </div>
      </form>

      {error && (
        <div className="notice error" role="alert" data-testid="error-events">
          <strong>Could not load events.</strong> {error}
          <button type="button" className="button button-quiet" onClick={() => void load()} data-testid="button-retry-events">
            Retry
          </button>
        </div>
      )}
      {loading ? <LoadingState label="Loading persisted event records…" /> : error ? null : result?.items.length ? (
        <>
          <div className="table-frame">
            <table>
              <thead>
                <tr><th>OCCURRED AT · UTC</th><th>EVENT</th><th>SOURCE</th><th>ASSET</th><th>SOURCE RECORD</th></tr>
              </thead>
              <tbody>
                {result.items.map(item => (
                  <tr key={item.id} data-testid={`row-event-${item.id}`}>
                    <td className="time-label">{formatDate(item.occurredAt)}</td>
                    <td>
                      <Link className="record-link mono" href={`/events/${encodeURIComponent(item.id)}`} data-testid={`link-event-${item.id}`}>
                        {item.eventType}
                      </Link>
                    </td>
                    <td>
                      <Link className="record-link" href={`/data-sources/${encodeURIComponent(item.source.id)}`} data-testid={`link-event-source-${item.id}`}>
                        <span className="mono">{item.source.sourceKey}</span><br />{item.source.displayName}
                      </Link>
                    </td>
                    <td>{item.asset ? (
                      <Link className="record-link" href={`/assets/${encodeURIComponent(item.asset.id)}`} data-testid={`link-event-asset-${item.id}`}>
                        <span className="mono">{item.asset.assetKey}</span><br />{item.asset.name}
                      </Link>
                    ) : <span className="muted">Not associated</span>}</td>
                    <td className="mono">{item.sourceRecordId ?? "Not provided"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ListPagination page={page} maxPage={maxPage} total={result.total} onChange={setPage} testId="events" />
        </>
      ) : (
        <EmptyState
          title={Object.keys(filters).length ? "No matching events" : "No events recorded"}
          description={Object.keys(filters).length
            ? "No persisted event records match these filters."
            : "Events appear here after they are submitted through the ingestion API. No sample records are shown."}
        />
      )}
    </main>
  );
}

function EventDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [record, setRecord] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void getEvent(id)
      .then(event => { if (active) setRecord(event); })
      .catch(cause => { if (active) setError(displayError(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, attempt]);

  if (loading) return <main className="page-main"><LoadingState label="Loading the stored event and provenance…" /></main>;
  if (error || !record) {
    return <main className="page-main">
      <ErrorState
        title="Event unavailable"
        message={error || "The requested event was not returned by the API."}
        retry={() => setAttempt(value => value + 1)}
        back="/events"
      />
    </main>;
  }

  return (
    <main className="page-main">
      <div className="detail-heading">
        <Link href="/events" className="back-link" data-testid="link-back-events">← All events</Link>
        <PageIntro eyebrow="EVENT RECORD" title={record.eventType} description="Persisted event data and source provenance; records are read-only in this view." />
      </div>
      <div className="detail-grid">
        <section className="panel">
          <h2 className="panel-title">Event metadata</h2>
          <dl className="definition-list">
            <dt>Event ID</dt><dd className="mono">{record.id}</dd>
            <dt>Occurred at · UTC</dt><dd className="time-label" data-testid="text-event-occurred-at">{formatDate(record.occurredAt)}</dd>
            <dt>Ingested at · UTC</dt><dd className="time-label">{formatDate(record.ingestedAt)}</dd>
            <dt>Event type</dt><dd className="mono">{record.eventType}</dd>
            <dt>Source</dt><dd><Link className="record-link" href={`/data-sources/${encodeURIComponent(record.source.id)}`} data-testid="link-detail-event-source">{record.source.sourceKey} · {record.source.displayName}</Link></dd>
            <dt>Source record ID</dt><dd className="mono">{record.sourceRecordId ?? "Not provided"}</dd>
            <dt>Original source timestamp</dt><dd className="mono" data-testid="text-event-source-timestamp">{record.sourceTimestamp}</dd>
            <dt>Deduplication key</dt><dd className="mono">{record.deduplicationKey ?? "Not provided"}</dd>
            <dt>Asset</dt><dd>{record.asset
              ? <Link className="record-link" href={`/assets/${encodeURIComponent(record.asset.id)}`} data-testid="link-detail-event-asset">{record.asset.assetKey} · {record.asset.name}</Link>
              : <span className="muted">Not associated</span>}</dd>
          </dl>
        </section>
        <div className="stack">
          <section className="panel">
            <h2 className="panel-title">Event payload</h2>
            <pre className="event-json" data-testid="event-payload">{JSON.stringify(record.payload, null, 2)}</pre>
          </section>
          <section className="panel">
            <h2 className="panel-title">Source provenance</h2>
            <pre className="event-json" data-testid="event-provenance">{JSON.stringify(record.provenance, null, 2)}</pre>
          </section>
        </div>
      </div>
    </main>
  );
}

export { EventsListPage, EventDetailPage };
