import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ASSET_TYPES, type AssetDetail, type AssetRecord, type AssetStatusFilter, type AssetType, type EventListItem, type Page } from "@kudu/shared";
import { getAsset, listAssets, listEvents } from "../api";
import { displayError, EmptyState, ErrorState, formatDate, ListPagination, LoadingState, PageIntro } from "../components/RegistryUI";

const ASSET_PAGE_SIZE = 12;
const EVENT_PAGE_SIZE = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const assetLabels: Record<AssetType, string> = {
  machine: "Machine",
  production_line: "Production line",
  plc: "PLC",
  camera: "Camera",
  sensor: "Sensor",
  other: "Other",
};

function initialNamespaceAssetId(): string {
  const id = new URLSearchParams(window.location.search).get("assetId");
  return id && UUID_PATTERN.test(id) ? id : "";
}

export default function NamespacePage() {
  const [search, setSearch] = useState("");
  const [assetType, setAssetType] = useState<AssetType | "">("");
  const [status, setStatus] = useState<AssetStatusFilter>("active");
  const [assetPage, setAssetPage] = useState(1);
  const [assets, setAssets] = useState<Page<AssetRecord> | null>(null);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetsError, setAssetsError] = useState("");
  const [selectedId, setSelectedId] = useState(initialNamespaceAssetId);
  const [detailRetry, setDetailRetry] = useState(0);
  const [assetDetail, setAssetDetail] = useState<AssetDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [eventPage, setEventPage] = useState(1);
  const [events, setEvents] = useState<Page<EventListItem> | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState("");
  const assetRequest = useRef(0);
  const detailRequest = useRef(0);
  const eventRequest = useRef(0);

  function selectAsset(id: string) {
    const params = new URLSearchParams(window.location.search);
    if (id) params.set("assetId", id);
    else params.delete("assetId");
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
    setSelectedId(id);
  }

  const loadAssets = useCallback(async () => {
    const request = ++assetRequest.current;
    setAssetsLoading(true);
    setAssetsError("");
    try {
      const result = await listAssets({
        search,
        page: assetPage,
        pageSize: ASSET_PAGE_SIZE,
        status,
        ...(assetType ? { assetType } : {}),
      });
      if (request === assetRequest.current) setAssets(result);
    } catch (error) {
      if (request === assetRequest.current) setAssetsError(displayError(error));
    } finally {
      if (request === assetRequest.current) setAssetsLoading(false);
    }
  }, [search, assetPage, status, assetType]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    if (!selectedId) {
      setAssetDetail(null);
      setDetailError("");
      setDetailLoading(false);
      setEvents(null);
      setEventsError("");
      setEventsLoading(false);
      return;
    }
    const request = ++detailRequest.current;
    setDetailLoading(true);
    setDetailError("");
    setAssetDetail(null);
    void getAsset(selectedId)
      .then(record => { if (request === detailRequest.current) setAssetDetail(record); })
      .catch(error => { if (request === detailRequest.current) setDetailError(displayError(error)); })
      .finally(() => { if (request === detailRequest.current) setDetailLoading(false); });
  }, [selectedId, detailRetry]);

  const loadEvents = useCallback(async () => {
    if (!selectedId) return;
    const request = ++eventRequest.current;
    setEventsLoading(true);
    setEventsError("");
    try {
      const result = await listEvents({ assetId: selectedId, page: eventPage, pageSize: EVENT_PAGE_SIZE });
      if (request === eventRequest.current) setEvents(result);
    } catch (error) {
      if (request === eventRequest.current) setEventsError(displayError(error));
    } finally {
      if (request === eventRequest.current) setEventsLoading(false);
    }
  }, [selectedId, eventPage]);

  useEffect(() => {
    if (selectedId) void loadEvents();
    else {
      setEvents(null);
      setEventsError("");
      setEventsLoading(false);
    }
  }, [loadEvents, selectedId]);

  const assetMaxPage = Math.max(1, Math.ceil((assets?.total ?? 0) / (assets?.pageSize ?? ASSET_PAGE_SIZE)));
  const eventMaxPage = Math.max(1, Math.ceil((events?.total ?? 0) / (events?.pageSize ?? EVENT_PAGE_SIZE)));

  return <main className="page-main namespace-page">
    <PageIntro
      eyebrow="REGISTRY / 05"
      title="Unified namespace"
      description="Explore registered assets, their explicit hierarchy, and persisted events linked to each asset."
    />
    <div className="namespace-layout">
      <section className="namespace-assets" aria-labelledby="namespace-assets-title">
        <div className="namespace-section-heading">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" />REGISTERED ENTITIES</div>
            <h2 id="namespace-assets-title">Assets</h2>
          </div>
          <span className="namespace-count">{assets?.total ?? "—"} records</span>
        </div>
        <div className="namespace-filters">
          <div className="field namespace-search">
            <label htmlFor="namespace-search">Search assets</label>
            <input id="namespace-search" data-testid="input-namespace-search" value={search} onChange={event => { setSearch(event.target.value); setAssetPage(1); }} placeholder="Asset key or name" />
          </div>
          <div className="field">
            <label htmlFor="namespace-type">Asset type</label>
            <select id="namespace-type" data-testid="filter-namespace-type" value={assetType} onChange={event => { setAssetType(event.target.value as AssetType | ""); setAssetPage(1); }}>
              <option value="">All types</option>
              {ASSET_TYPES.map(type => <option key={type} value={type}>{assetLabels[type]}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="namespace-status">Status</label>
            <select id="namespace-status" data-testid="filter-namespace-status" value={status} onChange={event => { setStatus(event.target.value as AssetStatusFilter); setAssetPage(1); }}>
              <option value="active">Active</option><option value="archived">Archived</option><option value="all">All records</option>
            </select>
          </div>
        </div>
        {assetsError && <div className="notice error" role="alert" data-testid="error-namespace-assets"><strong>Could not load assets.</strong> {assetsError} <button type="button" className="button button-quiet" onClick={() => void loadAssets()} data-testid="button-retry-namespace-assets">Retry</button></div>}
        {assetsLoading ? <LoadingState label="Loading registered assets…" /> : assetsError ? null : assets?.items.length ? <>
          <div className="table-frame namespace-table-frame">
            <table className="namespace-table">
              <thead><tr><th>ASSET</th><th>TYPE</th><th>HIERARCHY</th><th>STATUS</th></tr></thead>
              <tbody>{assets.items.map(asset => <tr key={asset.id} className={selectedId === asset.id ? "namespace-row-selected" : ""} data-testid={`row-namespace-asset-${asset.id}`}>
                <td>
                  <button type="button" className="namespace-select" aria-pressed={selectedId === asset.id} onClick={() => { selectAsset(asset.id); setEventPage(1); }} data-testid={`button-select-namespace-asset-${asset.id}`}>
                    <span className="mono">{asset.assetKey}</span><strong>{asset.name}</strong>
                  </button>
                  <Link className="namespace-detail-link" href={`/assets/${encodeURIComponent(asset.id)}`} data-testid={`link-namespace-asset-detail-${asset.id}`}>Open asset record</Link>
                </td>
                <td>{assetLabels[asset.assetType]}</td>
                <td>{asset.parentAsset ? <span><span className="mono">{asset.parentAsset.assetKey}</span><br />{asset.parentAsset.name}</span> : <span className="muted">Root asset</span>}</td>
                <td><span className={`status-pill ${asset.status === "active" ? "good" : "warn"}`}>{asset.status.toUpperCase()}</span></td>
              </tr>)}</tbody>
            </table>
          </div>
          <ListPagination page={assetPage} maxPage={assetMaxPage} total={assets.total} onChange={setAssetPage} testId="namespace-assets" />
        </> : <EmptyState title={search || assetType ? "No matching assets" : "No assets registered"} description={search || assetType ? "Adjust the search or filters. Results are filtered by the registry API." : "Registered assets will appear here. No sample records are shown."} />}
      </section>

      <section className="namespace-inspector" aria-label="Selected asset details and linked events">
        {!selectedId ? <div className="namespace-selection-prompt">
          <span className="namespace-prompt-mark" aria-hidden="true">ASSET</span>
          <h2>Select an asset</h2>
          <p>Choose a registered asset to inspect its recorded hierarchy and events explicitly associated with it.</p>
        </div> : detailLoading ? <LoadingState label="Loading selected asset details…" /> : detailError || !assetDetail ? <ErrorState title="Asset unavailable" message={detailError || "The asset record was not returned by the API."} retry={() => setDetailRetry(value => value + 1)} back="/assets" /> : <>
          <div className="namespace-detail-header">
            <div className="eyebrow"><span className="eyebrow-line" />SELECTED ASSET</div>
            <h2 data-testid="text-namespace-asset-name">{assetDetail.name}</h2>
            <div className="namespace-detail-key mono" data-testid="text-namespace-asset-key">{assetDetail.assetKey}</div>
            <div className="namespace-detail-actions">
              <Link className="button" href={`/assets/${encodeURIComponent(assetDetail.id)}`} data-testid="link-namespace-open-asset">Asset record</Link>
              <button className="button button-quiet" type="button" onClick={() => { selectAsset(""); setEventPage(1); }} data-testid="button-clear-namespace-selection">Clear selection</button>
            </div>
          </div>
          <section className="namespace-info-section">
            <h3>Record and hierarchy</h3>
            <dl className="definition-list namespace-definition-list">
              <dt>Record ID</dt><dd className="mono">{assetDetail.id}</dd>
              <dt>Type</dt><dd>{assetLabels[assetDetail.assetType]}</dd>
              <dt>Status</dt><dd><span className={`status-pill ${assetDetail.status === "active" ? "good" : "warn"}`}>{assetDetail.status.toUpperCase()}</span></dd>
              <dt>Description</dt><dd>{assetDetail.description || <span className="muted">Not recorded</span>}</dd>
              <dt>Parent</dt><dd>{assetDetail.parentAsset ? <Link className="record-link" href={`/assets/${encodeURIComponent(assetDetail.parentAsset.id)}`} data-testid="link-namespace-parent">{assetDetail.parentAsset.assetKey} · {assetDetail.parentAsset.name}</Link> : <span className="muted">Root asset</span>}</dd>
              <dt>Children</dt><dd>{assetDetail.children.length ? <div className="namespace-child-list">{assetDetail.children.map(child => <Link className="record-link" key={child.id} href={`/assets/${encodeURIComponent(child.id)}`} data-testid={`link-namespace-child-${child.id}`}><span className="mono">{child.assetKey}</span> · {child.name}<span className="muted"> — {assetLabels[child.assetType]}</span></Link>)}</div> : <span className="muted">No child assets recorded</span>}</dd>
              <dt>External IDs</dt><dd>{assetDetail.externalIdentifiers.length ? <div className="namespace-child-list">{assetDetail.externalIdentifiers.map((identifier, index) => <span className="mono" key={`${identifier.sourceKey}-${index}`}>{identifier.sourceKey} / {identifier.externalId}</span>)}</div> : <span className="muted">None recorded</span>}</dd>
              <dt>Created</dt><dd className="time-label">{formatDate(assetDetail.createdAt)}</dd>
              <dt>Updated</dt><dd className="time-label">{formatDate(assetDetail.updatedAt)}</dd>
              {assetDetail.archivedAt && <><dt>Archived</dt><dd className="time-label">{formatDate(assetDetail.archivedAt)}</dd></>}
            </dl>
          </section>
          <section className="namespace-events-section">
            <div className="namespace-section-heading namespace-events-heading">
              <div><div className="eyebrow"><span className="eyebrow-line" />EXPLICIT ASSET RELATIONSHIP</div><h3>Linked events</h3></div>
              <Link className="namespace-detail-link" href="/events" data-testid="link-namespace-all-events">All events</Link>
            </div>
            <p className="namespace-note">Only persisted events whose asset relationship points to this asset are shown. Sources are related through each event, not attached directly to assets.</p>
            {eventsError && <div className="notice error" role="alert" data-testid="error-namespace-events"><strong>Could not load linked events.</strong> {eventsError} <button type="button" className="button button-quiet" onClick={() => void loadEvents()} data-testid="button-retry-namespace-events">Retry</button></div>}
            {eventsLoading ? <LoadingState label="Loading events linked to this asset…" /> : eventsError ? null : events?.items.length ? <>
              <div className="namespace-event-list">
                {events.items.map(event => <article className="namespace-event" key={event.id} data-testid={`row-namespace-event-${event.id}`}>
                  <div className="namespace-event-topline">
                    <Link className="record-link mono" href={`/events/${encodeURIComponent(event.id)}?namespaceAssetId=${encodeURIComponent(assetDetail.id)}`} data-testid={`link-namespace-event-${event.id}`}>{event.eventType}</Link>
                    <time className="time-label">{formatDate(event.occurredAt)}</time>
                  </div>
                  <div className="namespace-event-source">
                    <span className="muted">Source</span>
                    <Link className="record-link" href={`/data-sources/${encodeURIComponent(event.source.id)}?namespaceAssetId=${encodeURIComponent(assetDetail.id)}`} data-testid={`link-namespace-source-${event.id}`}><span className="mono">{event.source.sourceKey}</span> · {event.source.displayName}</Link>
                  </div>
                  <div className="namespace-event-record"><span className="muted">Source record</span><span className="mono">{event.sourceRecordId ?? "Not provided"}</span></div>
                </article>)}
              </div>
              <ListPagination page={eventPage} maxPage={eventMaxPage} total={events.total} onChange={setEventPage} testId="namespace-events" />
            </> : <EmptyState title="No linked events" description="No persisted events are currently associated with this asset. Events without an explicit asset relationship are not included." />}
          </section>
        </>}
      </section>
    </div>
  </main>;
}
