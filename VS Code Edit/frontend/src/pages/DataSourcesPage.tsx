import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useParams } from "wouter";
import { DATA_SOURCE_TYPES, SUGGESTED_PAYLOAD_TARGETS, type DataSourceConfigurationInput, type DataSourceDiscoveryResult, type DataSourceEventMapping, type DataSourceRecord, type DataSourceType, type EventMappingDefinition, type FileImportResult, type Page, type RestApiAuthMode, type RestPaginationConfiguration, type RestSyncResult, type SuggestedTargetField } from "@kudu/shared";
import { activateDataSourceEventMapping, ApiError, createDataSource, createDataSourceEventMapping, deleteDataSource, discoverDataSource, getDataSource, importDataSourceFile, listDataSourceEventMappings, listDataSources, listRestSyncRuns, resumeRestSyncRun, syncRestDataSource, updateDataSource, updateDataSourceEventMapping, validateDataSourceEventMapping } from "../api";
import { ConnectorBadge, displayError, EmptyState, ErrorState, Field, formatDate, ListPagination, LoadingState, PageIntro } from "../components/RegistryUI";

const PAGE_SIZE = 15;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type PaginationMode = "" | "offset" | "page" | "cursor";
const sourceLabels: Record<DataSourceType, string> = {
  rest_api: "REST API", json_file: "JSON file", csv_file: "CSV file", manual: "Manual",
};
const suggestionLabels: Record<SuggestedTargetField, string> = {
  eventType: "Event type",
  occurredAt: "Occurrence time",
  sourceRecordId: "Source record ID",
  assetKey: "Asset identifier",
  message: "Message",
  severity: "Severity",
  errorCode: "Error code",
  assetName: "Asset name",
  status: "Asset or event state",
  measurementName: "Measurement name",
  measurementValue: "Measurement value",
  measurementUnit: "Measurement unit",
  measurements: "Measurement group",
  relationships: "Relationships",
  sourceMetadata: "Source metadata",
};

function mapDataSourceErrors(fields: Record<string, string>): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [rawKey, message] of Object.entries(fields)) {
    const key = rawKey.replace(/\[(\w+)\]/g, ".$1");
    if (key === "configuration.baseUrl") mapped.baseUrl = message;
    else if (key === "configuration.relativePath") mapped.relativePath = message;
    else if (key === "configuration.credentialRef") mapped.credentialRef = message;
    else if (key.startsWith("configuration.")) mapped[key.slice("configuration.".length)] = message;
    else mapped[key] = message;
  }
  return mapped;
}

function DataSourceListPage() {
  const [search, setSearch] = useState("");
  const [sourceType, setSourceType] = useState("");
  const [enabled, setEnabled] = useState<"all" | "enabled" | "disabled">("all");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<DataSourceRecord> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const removalOutcome = new URLSearchParams(window.location.search).get("removed");
  const load = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true); setError(""); setResult(null);
    try {
      const data = await listDataSources({ search, page, pageSize: PAGE_SIZE, sourceType: sourceType ? sourceType as DataSourceType : undefined, enabled });
      if (current === requestId.current) setResult(data);
    } catch (cause) {
      if (current === requestId.current) setError(displayError(cause));
    } finally { if (current === requestId.current) setLoading(false); }
  }, [search, page, sourceType, enabled]);
  useEffect(() => { void load(); }, [load]);
  const maxPage = Math.max(1, Math.ceil((result?.total ?? 0) / (result?.pageSize ?? PAGE_SIZE)));
  return <main className="page-main">
    <PageIntro eyebrow="REGISTRY / 02" title="Data sources" description="Describe where operational information lives. Registration and enablement do not connect, ingest, or generate outbound traffic." action={<Link className="button button-primary" href="/data-sources/new" data-testid="button-create-data-source"><span aria-hidden="true">＋</span> Add data source</Link>} />
    {removalOutcome === "archived" && <div className="notice" role="status" data-testid="notice-source-archived">The connection was disabled. Imported events, original payloads, mappings, and sync history remain available.</div>}
    {removalOutcome === "deleted" && <div className="notice" role="status" data-testid="notice-source-deleted">The source record was removed because it had no linked events, mappings, or sync history.</div>}
    <div className="notice" data-testid="notice-connector-status"><strong>Source actions are on demand.</strong> REST sync and local CSV/JSON imports run only when requested. Registration and enablement never start polling or ingestion.</div>
    <div className="toolbar">
      <div className="field field-search"><label htmlFor="source-search">Search registry</label><input id="source-search" data-testid="input-data-source-search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Search key or display name…" /></div>
      <div className="field field-filter"><label htmlFor="source-type-filter">Source type</label><select id="source-type-filter" data-testid="filter-data-source-type" value={sourceType} onChange={event => { setSourceType(event.target.value); setPage(1); }}><option value="">All types</option>{DATA_SOURCE_TYPES.map(type => <option value={type} key={type}>{sourceLabels[type]}</option>)}</select></div>
      <div className="field field-filter"><label htmlFor="source-enabled-filter">Enabled state</label><select id="source-enabled-filter" data-testid="filter-data-source-enabled" value={enabled} onChange={event => { setEnabled(event.target.value as typeof enabled); setPage(1); }}><option value="all">All states</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></div>
    </div>
    {error && <div className="notice error" role="alert" data-testid="error-data-sources"><strong>Could not load data sources.</strong> {error} <button type="button" className="button button-quiet" onClick={() => void load()} data-testid="button-retry-data-sources">Retry</button></div>}
    {loading ? <LoadingState label="Loading registered source metadata…" /> : error ? null : result?.items.length ? <>
      <div className="table-frame"><table>
        <thead><tr><th>SOURCE</th><th>TYPE</th><th>ENABLED</th><th>CONNECTOR STATUS</th><th>LAST SUCCESSFUL SYNC</th></tr></thead>
        <tbody>{result.items.map(source => <tr key={source.id} data-testid={`row-data-source-${source.id}`}>
          <td><Link className="record-link" href={`/data-sources/${encodeURIComponent(source.id)}`} data-testid={`link-data-source-name-${source.id}`}>{source.displayName}</Link><br /><span className="field-hint mono" data-testid={`text-data-source-key-${source.id}`}>{source.sourceKey}</span></td>
          <td>{sourceLabels[source.sourceType]}</td><td><span className={`status-pill ${source.enabled ? "good" : ""}`}>{source.enabled ? "ENABLED" : "DISABLED"}</span></td>
          <td>{source.sourceType === "rest_api" ? <span className="status-pill good">ON-DEMAND</span> : <ConnectorBadge status={source.connectionStatus} />}</td>
          <td className="time-label">{formatDate(source.lastSuccessfulSyncAt)}</td>
        </tr>)}</tbody>
      </table></div>
      <ListPagination page={page} maxPage={maxPage} total={result.total} onChange={setPage} testId="data-sources" />
    </> : <EmptyState title={search ? "No matching data sources" : "No data sources in this view"} description={search ? "Try a different key or display name. Search is sent to the server." : "Register source metadata to document how this registry relates to your operational systems."} action={!search ? <Link className="button button-primary" href="/data-sources/new" data-testid="button-empty-create-data-source">Add a data source</Link> : undefined} />}
  </main>;
}

function DataSourceDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const detailSearch = new URLSearchParams(window.location.search);
  const requestedNamespaceAssetId = detailSearch.get("namespaceAssetId");
  const suggestedMappingStatus = detailSearch.get("suggestedMapping");
  const namespaceAssetId = requestedNamespaceAssetId && UUID_PATTERN.test(requestedNamespaceAssetId)
    ? requestedNamespaceAssetId
    : null;
  const returnHref = namespaceAssetId
    ? `/namespace?assetId=${encodeURIComponent(namespaceAssetId)}`
    : "/data-sources";
  const returnLabel = namespaceAssetId ? "← Unified Namespace" : "← All data sources";
  const [record, setRecord] = useState<DataSourceRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importResult, setImportResult] = useState<FileImportResult | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [syncResult, setSyncResult] = useState<RestSyncResult | null>(null);
  const [syncRuns, setSyncRuns] = useState<RestSyncResult[]>([]);
  const [syncHistoryError, setSyncHistoryError] = useState("");
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const source = await getDataSource(id);
      setRecord(source);
      if (source.sourceType === "rest_api") {
        try {
          setSyncRuns((await listRestSyncRuns(id)).items);
          setSyncHistoryError("");
        } catch (cause) {
          setSyncHistoryError(displayError(cause));
        }
      } else {
        setSyncRuns([]);
      }
    } catch (cause) { setError(displayError(cause)); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  async function runFileImport() {
    setImporting(true); setImportError(""); setImportResult(null);
    try { setImportResult(await importDataSourceFile(id)); }
    catch (cause) { setImportError(displayError(cause)); }
    finally { setImporting(false); }
  }
  async function runRestSync() {
    setSyncing(true); setSyncError(""); setSyncResult(null);
    try {
      const result = await syncRestDataSource(id);
      setSyncResult(result);
      setSyncRuns(current => [result, ...current.filter(run => run.runId !== result.runId)].slice(0, 25));
    }
    catch (cause) { setSyncError(displayError(cause)); }
    finally { setSyncing(false); }
  }
  async function resumeRestSync(runId: string) {
    setSyncing(true); setSyncError(""); setSyncResult(null);
    try {
      const result = await resumeRestSyncRun(id, runId);
      setSyncResult(result);
      setSyncRuns(current => [result, ...current.filter(run => run.runId !== result.runId)].slice(0, 25));
    } catch (cause) { setSyncError(displayError(cause)); }
    finally { setSyncing(false); }
  }
  async function removeSource() {
    if (!record) return;
    const confirmed = window.confirm(
      `Remove "${record.displayName}" (${record.sourceKey})?\n\nIf it has imported events, mappings, or sync history, KuduNS will disable the connection and retain that history, payloads, and provenance. Only a source with no linked history is permanently deleted.`,
    );
    if (!confirmed) return;
    setRemoving(true);
    setRemoveError("");
    try {
      const result = await deleteDataSource(id);
      navigate(`/data-sources?removed=${result.outcome}`);
    } catch (cause) {
      setRemoveError(displayError(cause));
    } finally {
      setRemoving(false);
    }
  }
  if (loading) return <main className="page-main"><LoadingState label="Loading the actual data source record…" /></main>;
  if (error || !record) return <main className="page-main"><ErrorState title="Data source unavailable" message={error || "The requested source was not returned by the API."} retry={() => void load()} back={returnHref} /></main>;
  const cfg = record.configuration;
  const fileFormat = record.sourceType === "csv_file" ? "CSV" : record.sourceType === "json_file" ? "JSON" : null;
  const isRestSource = record.sourceType === "rest_api" && cfg.kind === "rest_api";
  return <main className="page-main">
    <div className="detail-heading"><Link href={returnHref} className="back-link" data-testid="link-back-data-sources">{returnLabel}</Link>
      <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />DATA SOURCE RECORD</div><h1>{record.displayName}</h1><span className="detail-key" data-testid="text-data-source-key">{record.sourceKey}</span></div>
        <div className="detail-actions">
          {(fileFormat || isRestSource) && <Link
            className="button"
            href={`/data-sources/${encodeURIComponent(id)}/edit?step=discover#discover-data`}
            data-testid="button-discover-data"
          >Discover data</Link>}
          {fileFormat && record.enabled && <button className="button button-primary" type="button" onClick={() => void runFileImport()} disabled={importing} data-testid="button-import-source-file">{importing ? "Importing…" : `Import configured ${fileFormat} file`}</button>}
          {isRestSource && record.enabled && <button className="button button-primary" type="button" onClick={() => void runRestSync()} disabled={syncing} data-testid="button-sync-rest-source">{syncing ? "Syncing…" : "Sync now"}</button>}
          <Link className="button" href={`/data-sources/${encodeURIComponent(id)}/edit`} data-testid="button-edit-data-source">Edit record</Link>
          <button className="button button-danger" type="button" onClick={() => void removeSource()} disabled={removing} data-testid="button-delete-data-source">{removing ? "Removing…" : "Delete data source"}</button>
        </div>
      </div>
    </div>
    {(fileFormat || isRestSource) && <section className="panel source-workflow" data-testid="panel-data-source-workflow">
      <div className="panel-heading-row">
        <div><p className="section-label">NEXT STEPS</p><h2 className="panel-title">Discover and prepare this source</h2></div>
        <span className={`status-pill ${record.enabled ? "good" : "warn"}`}>{record.enabled ? "CONNECTION SAVED" : "DISABLED"}</span>
      </div>
      <ol className="source-workflow-steps">
        <li><strong>Connection saved</strong><span>Configuration is stored. Saving did not contact the source.</span></li>
        <li><strong>Discover and review fields</strong><span>Choose the collection, inspect recognition suggestions, and exclude irrelevant fields.</span></li>
        <li><strong>Validate and activate mapping</strong><span>Only an approved, activated mapping is used for mapped imports and REST sync.</span></li>
        <li><strong>Import or sync</strong><span>Ingestion starts only when you choose the action above.</span></li>
      </ol>
      <p className="field-hint">Discovery is an explicit, bounded request. It does not import records, create assets, or activate a mapping.</p>
    </section>}
    <div className="notice" data-testid="notice-source-import">
      {fileFormat
        ? <><strong>{fileFormat} file import is available.</strong> Imports read the registered relative file from the configured local import directory. {record.enabled ? "Imports run only when requested and are not scheduled." : "Enable this source before importing. No import is started while disabled."}</>
        : isRestSource
          ? <><strong>REST sync is read-only and on demand.</strong> Kudu sends a bounded GET request only when you select Sync now. No source is polled or scheduled.</>
          : <><strong>Manual source.</strong> This reference record does not connect or start ingestion.</>}
    </div>
    {cfg.kind === "json_file" && cfg.recordsPath && <div className="notice">
      <strong>Nested JSON collection selected.</strong> Import requires an active event mapping. Discovery and draft creation do not activate it.
    </div>}
    {suggestedMappingStatus === "failed" && <div className="notice error" role="status" data-testid="notice-suggested-mapping">
      The source was saved, but its suggested mapping draft could not be saved. Review or create a draft in Event mapping.
    </div>}
    {suggestedMappingStatus === "incomplete" && <div className="notice" role="status" data-testid="notice-suggested-mapping">
      The source was saved. Discovery did not provide both required event fields, so no mapping draft was created. Add them in Event mapping.
    </div>}
    {importError && <div className="notice error" role="alert" data-testid="error-file-import"><strong>Import failed.</strong> {importError}</div>}
    {syncError && <div className="notice error" role="alert" data-testid="error-rest-sync"><strong>Sync could not run.</strong> {syncError}</div>}
    {removeError && <div className="notice error" role="alert" data-testid="error-delete-data-source"><strong>Source could not be removed.</strong> {removeError}</div>}
    {importResult && <section className="panel file-import-result" data-testid="panel-file-import-result">
      <h2 className="panel-title">Import result · {importResult.format.toUpperCase()}</h2>
      <p data-testid="text-file-import-counts">
        {importResult.records} records processed: {importResult.imported} imported, {importResult.skipped} skipped as duplicates, {importResult.failed} failed.
      </p>
      {importResult.errors.length > 0 && <ul className="file-import-errors" data-testid="list-file-import-errors">
        {importResult.errors.map((item, index) => <li key={`${item.record}-${item.code}-${index}`}>
          <strong>Record {item.record} · {item.code}</strong>: {item.message}
          {item.fields && <span className="file-import-field-errors"> {Object.values(item.fields).join(" ")}</span>}
        </li>)}
      </ul>}
      {importResult.errorsTruncated && <p className="field-hint">Only the first {importResult.errors.length} record errors are displayed.</p>}
    </section>}
    {syncResult && <section className="panel file-import-result" data-testid="panel-rest-sync-result">
      <h2 className="panel-title">REST sync · {syncResult.status === "paused" ? "paused for continuation" : syncResult.status === "failed" ? "stopped with an error" : syncResult.failed ? "completed with record failures" : "completed"}</h2>
      <p data-testid="text-rest-sync-counts">
        {syncResult.pagesCompleted} pages · {syncResult.fetched} fetched · {syncResult.imported} imported · {syncResult.duplicates} duplicates · {syncResult.failed} failed.
      </p>
      <p className="field-hint">Run {syncResult.runId} · mapping version {syncResult.mappingVersion} · request {syncResult.requestSucceeded ? "succeeded" : "not yet successful"}.</p>
      {syncResult.errors.length > 0 && <ul className="file-import-errors" data-testid="list-rest-sync-errors">
        {syncResult.errors.map((item, index) => <li key={`${item.record}-${item.code}-${index}`}>
          <strong>{item.record === 0 ? "Request" : `Record ${item.record}`} · {item.code}</strong>: {item.message}
          {item.fields && <span className="file-import-field-errors"> {Object.values(item.fields).join(" ")}</span>}
        </li>)}
      </ul>}
      {syncResult.errorsTruncated && <p className="field-hint">Only the first {syncResult.errors.length} errors are displayed.</p>}
    </section>}
    {isRestSource && <section className="panel" data-testid="panel-rest-sync-history">
      <h2 className="panel-title">Recent sync runs</h2>
      <p className="field-hint">History is stored locally and loaded when this page opens. Remote APIs are never polled.</p>
      {syncHistoryError && <div className="notice error" role="alert">{syncHistoryError}</div>}
      {syncRuns.length === 0
        ? <p className="muted">No sync runs are recorded for this source.</p>
        : <ul className="sync-run-list">{syncRuns.map(run => {
          const recoverStale = run.status === "running" && Date.now() - new Date(run.updatedAt).getTime() > 60_000;
          const canResume = run.resumable || recoverStale;
          return <li key={run.runId} data-testid={`sync-run-${run.runId}`}>
            <div className="sync-run-heading">
              <span className={`status-pill ${run.status === "completed" ? "good" : ""}`}>{recoverStale ? "PAUSED · INTERRUPTED" : run.status.toUpperCase()}</span>
              <span className="time-label">{formatDate(run.startedAt)}</span>
            </div>
            <p>{run.pagesCompleted} pages · {run.fetched} fetched · {run.imported} imported · {run.duplicates} duplicates · {run.failed} failed</p>
            <p className="field-hint">Mapping version {run.mappingVersion} · run {run.runId}</p>
            {run.errors.length > 0 && <details>
              <summary>{run.errors.length} recorded errors{run.errorsTruncated ? " (truncated)" : ""}</summary>
              <ul className="file-import-errors">{run.errors.map((item, index) => <li key={`${item.record}-${item.code}-${index}`}>
                <strong>{item.record === 0 ? "Request" : `Record ${item.record}`} · {item.code}</strong>: {item.message}
              </li>)}</ul>
            </details>}
            {canResume && <button className="button" type="button" onClick={() => void resumeRestSync(run.runId)} disabled={syncing} data-testid={`button-resume-sync-run-${run.runId}`}>
              {syncing ? "Resuming…" : recoverStale ? "Recover interrupted run" : "Resume run"}
            </button>}
          </li>;
        })}</ul>}
    </section>}
    <div className="detail-grid">
      <section className="panel"><h2 className="panel-title">Source metadata</h2><dl className="definition-list">
        <dt>Source key</dt><dd className="mono">{record.sourceKey}</dd><dt>Type</dt><dd>{sourceLabels[record.sourceType]}</dd>
        <dt>Enabled</dt><dd><span className={`status-pill ${record.enabled ? "good" : ""}`}>{record.enabled ? "ENABLED" : "DISABLED"}</span></dd>
        <dt>Description</dt><dd>{record.description || <span className="muted">No description recorded</span>}</dd>
        <dt>Created</dt><dd className="time-label">{formatDate(record.createdAt)}</dd><dt>Last updated</dt><dd className="time-label">{formatDate(record.updatedAt)}</dd>
      </dl></section>
      <div className="stack">
        <section className="panel"><h2 className="panel-title">Configuration metadata</h2><dl className="definition-list">
          <dt>Configuration type</dt><dd>{sourceLabels[cfg.kind]}</dd>
          {cfg.kind === "rest_api" && <>
            <dt>Base URL</dt><dd className="mono" data-testid="text-source-base-url">{cfg.baseUrl}</dd>
            <dt>Private-network trust</dt><dd data-testid="text-source-trusted-private-host">{cfg.trustedPrivateHost
              ? `Trusted exact host: ${cfg.trustedPrivateHost}`
              : "No private-network host trust configured"}</dd>
            <dt>Endpoint path</dt><dd className="mono">{cfg.endpointPath || "Not configured"}</dd>
            <dt>Method</dt><dd>{cfg.method ?? "GET"}</dd>
            <dt>Response format</dt><dd>{(cfg.responseFormat ?? "json").toUpperCase()}</dd>
            <dt>Records path</dt><dd className="mono">{cfg.recordsPath || "Top-level JSON array"}</dd>
            <dt>Authentication</dt><dd>{cfg.authMode === "bearer"
              ? cfg.credentialConfigured ? "Bearer token via environment variable is configured." : "Bearer token reference is unavailable."
              : cfg.credentialConfigured ? "No authentication; an inactive credential reference is recorded." : "None."}</dd>
            <dt>Request limits</dt><dd>{cfg.timeoutMs ?? 10000} ms · {((cfg.maxResponseBytes ?? 1048576) / 1048576).toFixed(1)} MiB · {cfg.maxRecords ?? 500} records</dd>
            <dt>Pagination</dt><dd>{cfg.pagination
              ? `${cfg.pagination.strategy} · ${cfg.pagination.pageSize} records/page · up to 3 pages per action`
              : "Single response; pagination not configured"}</dd>
          </>}
          {(cfg.kind === "json_file" || cfg.kind === "csv_file") && <><dt>Relative path</dt><dd className="mono" data-testid="text-source-path">{cfg.relativePath}</dd>{cfg.kind === "json_file" && <><dt>Records path</dt><dd className="mono">{cfg.recordsPath || "Top-level JSON array"}</dd></>}</>}
          {cfg.kind === "manual" && <><dt>Reference</dt><dd>{cfg.referenceOnly ? "Manual reference only" : "Not available"}</dd></>}
        </dl></section>
        {fileFormat
          ? <section className="panel" data-testid="panel-import-status"><h2 className="panel-title">File import status</h2><dl className="definition-list">
            <dt>Supported format</dt><dd>{fileFormat}</dd>
            <dt>Availability</dt><dd>{record.enabled ? "Available for on-demand import" : "Disabled in registry"}</dd>
            <dt>Run history</dt><dd>Not stored; each result is returned after its import request.</dd>
          </dl></section>
        : isRestSource
          ? <section className="panel" data-testid="panel-rest-sync-status"><h2 className="panel-title">REST sync</h2><dl className="definition-list">
            <dt>Availability</dt><dd>{record.enabled ? "Available for operator-triggered sync" : "Disabled in registry"}</dd>
             <dt>Last sync</dt><dd className="time-label">{formatDate(record.lastSuccessfulSyncAt)}</dd>
             <dt>Last error</dt><dd>{record.lastErrorSummary || <span className="muted">No error reported</span>}</dd>
             <dt>Run history</dt><dd>Stored with page checkpoints and mapping-version lineage.</dd>
          </dl></section>
          : <section className="panel"><h2 className="panel-title">Connector and ingestion status</h2><dl className="definition-list">
            <dt>Connection</dt><dd><ConnectorBadge status={record.connectionStatus} /></dd><dt>Ingestion</dt><dd><ConnectorBadge status={record.ingestionStatus} /></dd>
            <dt>Last successful sync</dt><dd className="time-label" data-testid="text-last-sync">{formatDate(record.lastSuccessfulSyncAt)}</dd>
            <dt>Last error</dt><dd>{record.lastErrorSummary || <span className="muted">No error reported</span>}</dd>
          </dl></section>}
      </div>
    </div>
    {(fileFormat || isRestSource) && <EventMappingPanel sourceId={id} restSource={isRestSource} />}
  </main>;
}

function EventMappingPanel({ sourceId, restSource = false }: { sourceId: string; restSource?: boolean }) {
  const [mappings, setMappings] = useState<DataSourceEventMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [eventTypeField, setEventTypeField] = useState("");
  const [occurredAtField, setOccurredAtField] = useState("");
  const [sourceRecordIdField, setSourceRecordIdField] = useState("");
  const [assetKeyField, setAssetKeyField] = useState("");
  const [payloadMappingsText, setPayloadMappingsText] = useState("{}");

  const loadMappings = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await listDataSourceEventMappings(sourceId);
      setMappings(result.items);
      const draft = result.items.find((mapping) => mapping.status === "draft");
      if (draft) {
        const definition = draft.definition as EventMappingDefinition;
        setEventTypeField(typeof definition.eventType === "string" ? definition.eventType : "");
        setOccurredAtField(typeof definition.occurredAt === "string" ? definition.occurredAt : "");
        setSourceRecordIdField(typeof definition.sourceRecordId === "string" ? definition.sourceRecordId : "");
        setAssetKeyField(typeof definition.assetKey === "string" ? definition.assetKey : "");
        setPayloadMappingsText(JSON.stringify(definition.payload ?? {}, null, 2));
      }
      setDirty(false);
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setLoading(false);
    }
  }, [sourceId]);

  useEffect(() => { void loadMappings(); }, [loadMappings]);

  const activeMapping = mappings.find((mapping) => mapping.status === "active");
  const draftMapping = mappings.find((mapping) => mapping.status === "draft");
  const definitionFromForm = (): EventMappingDefinition => {
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payloadMappingsText);
    } catch {
      throw new Error("Payload field mappings must be valid JSON.");
    }
    if (
      typeof parsedPayload !== "object" ||
      parsedPayload === null ||
      Array.isArray(parsedPayload) ||
      Object.values(parsedPayload).some((value) => typeof value !== "string")
    ) {
      throw new Error("Payload mappings must be a JSON object whose values are source field paths.");
    }
    return {
      eventType: eventTypeField,
      occurredAt: occurredAtField,
      ...(sourceRecordIdField.trim() ? { sourceRecordId: sourceRecordIdField } : {}),
      ...(assetKeyField.trim() ? { assetKey: assetKeyField } : {}),
      payload: parsedPayload as Record<string, string>,
    };
  };

  async function createDraft() {
    setBusy(true); setError("");
    try {
      const definition = activeMapping
        ? activeMapping.definition as EventMappingDefinition
        : { eventType: "eventType", occurredAt: "occurredAt", sourceRecordId: "sourceRecordId", payload: {} };
      await createDataSourceEventMapping(sourceId, definition);
      await loadMappings();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!draftMapping) return;
    setBusy(true); setError("");
    try {
      await updateDataSourceEventMapping(sourceId, draftMapping.version, definitionFromForm());
      await loadMappings();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function validateDraft() {
    if (!draftMapping) return;
    setBusy(true); setError("");
    try {
      const definition = definitionFromForm();
      await updateDataSourceEventMapping(sourceId, draftMapping.version, definition);
      const result = await validateDataSourceEventMapping(sourceId, draftMapping.version);
      if (!result.valid) {
        setError(`Mapping validation found ${result.errors.length} issue${result.errors.length === 1 ? "" : "s"}.`);
      }
      await loadMappings();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function activateDraft() {
    if (!draftMapping || dirty || !draftMapping.validatedAt || draftMapping.validationErrors.length > 0) return;
    setBusy(true); setError("");
    try {
      await activateDataSourceEventMapping(sourceId, draftMapping.version);
      await loadMappings();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(false);
    }
  }

  const setField = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setDirty(true);
  };

  return <section className="panel mapping-panel" data-testid="panel-event-mappings">
    <div className="panel-heading-row">
      <div>
        <h2 className="panel-title">Event mapping</h2>
        <p className="field-hint">Explicit field paths normalize new CSV/JSON imports and REST syncs. Prior events are never rewritten.</p>
      </div>
      {!draftMapping && <button className="button" type="button" onClick={() => void createDraft()} disabled={busy || loading} data-testid="button-create-mapping-draft">
        {activeMapping ? "Create next version" : "Create mapping draft"}
      </button>}
    </div>
    {loading && <p className="muted">Loading mapping versions…</p>}
    {error && <div className="notice error" role="alert" data-testid="error-event-mapping">{error}</div>}
    {!loading && <>
      {activeMapping
        ? <p data-testid="text-active-mapping">Active version {activeMapping.version}. New imports and REST syncs use this version; existing events are unchanged.</p>
        : <p data-testid="text-no-active-mapping">{restSource ? "No active mapping. REST sync requires an active event mapping." : "No active mapping. File imports keep the existing field behavior."}</p>}
      <ul className="mapping-version-list" data-testid="list-mapping-versions">
        {mappings.map((mapping) => <li key={mapping.id}>
          <strong>v{mapping.version}</strong>
          <span className={`status-pill ${mapping.status === "active" ? "good" : ""}`}>{mapping.status.toUpperCase()}</span>
        </li>)}
      </ul>
      {draftMapping && <div className="mapping-draft" data-testid="mapping-draft-editor">
        <h3>Draft version {draftMapping.version}</h3>
        <p className="field-hint">Use source field names; nested JSON fields use dot paths such as <code>metadata.timestamp</code>.</p>
        <div className="mapping-fields">
          <label className="field"><span>Event type source field</span><input value={eventTypeField} onChange={(event) => setField(setEventTypeField)(event.target.value)} data-testid="input-mapping-event-type" /></label>
          <label className="field"><span>Occurrence timestamp source field</span><input value={occurredAtField} onChange={(event) => setField(setOccurredAtField)(event.target.value)} data-testid="input-mapping-occurred-at" /></label>
          <label className="field"><span>Source-record ID source field</span><input value={sourceRecordIdField} onChange={(event) => setField(setSourceRecordIdField)(event.target.value)} data-testid="input-mapping-source-record-id" /></label>
          <label className="field"><span>Registered asset key source field</span><input value={assetKeyField} onChange={(event) => setField(setAssetKeyField)(event.target.value)} data-testid="input-mapping-asset-key" /></label>
        </div>
        <label className="field mapping-payload-field"><span>Payload output names and source paths</span>
          <textarea rows={5} value={payloadMappingsText} onChange={(event) => { setPayloadMappingsText(event.target.value); setDirty(true); }} data-testid="textarea-mapping-payload" />
        </label>
        <p className="field-hint">Payload mappings are JSON, for example <code>{"{ \"temperatureC\": \"measurements.temp\" }"}</code>. Unknown and unmapped fields remain stored.</p>
        {draftMapping.validationErrors.length > 0 && <ul className="mapping-validation-errors" role="alert" data-testid="list-mapping-validation-errors">
          {draftMapping.validationErrors.map((item, index) => <li key={`${item.field}-${index}`}><strong>{item.field}:</strong> {item.message}</li>)}
        </ul>}
        {draftMapping.validatedAt && draftMapping.validationErrors.length === 0 && <p className="mapping-valid-message" data-testid="text-mapping-valid">Validated {formatDate(draftMapping.validatedAt)}.</p>}
        <div className="mapping-actions">
          <button className="button" type="button" onClick={() => void saveDraft()} disabled={busy} data-testid="button-save-mapping-draft">Save draft</button>
          <button className="button" type="button" onClick={() => void validateDraft()} disabled={busy} data-testid="button-validate-mapping">Save and validate</button>
          <button className="button button-primary" type="button" onClick={() => void activateDraft()} disabled={busy || dirty || !draftMapping.validatedAt || draftMapping.validationErrors.length > 0} data-testid="button-activate-mapping">Activate version {draftMapping.version}</button>
        </div>
      </div>}
      {mappings.length === 0 && <p className="field-hint">{restSource ? "Create, validate, and activate a mapping before syncing." : "Without an active mapping, imports use the current CSV/JSON field behavior."}</p>}
    </>}
  </section>;
}

function DiscoveryReview({
  result,
  selectedPath,
  onSelectPath,
  mappingPaths,
  onChangeMappingPath,
  mappingTemplateSources,
  mappingTemplateSourceId,
  onMappingTemplateSourceChange,
  onApplyMappingTemplate,
  mappingTemplateBusy,
  mappingTemplateMessage,
}: {
  result: DataSourceDiscoveryResult;
  selectedPath: string;
  onSelectPath: (path: string) => void;
  mappingPaths: Record<string, string>;
  onChangeMappingPath: (target: SuggestedTargetField, path: string) => void;
  mappingTemplateSources: DataSourceRecord[];
  mappingTemplateSourceId: string;
  onMappingTemplateSourceChange: (sourceId: string) => void;
  onApplyMappingTemplate: () => void;
  mappingTemplateBusy: boolean;
  mappingTemplateMessage: string;
}) {
  const selected = result.recordPaths.find(item => item.path === selectedPath);
  const suggestedPaths = Object.fromEntries(result.suggestions.map(item => [item.target, item.sourcePath ?? ""]));
  const usable = (value: string | undefined) => Boolean(value && value !== "(missing)" && value !== "[hidden]" && value !== "[object]" && value !== "null" && !value.startsWith("[array:"));
  const fieldTypes = new Map(result.fields.map(field => [field.path, field.valueType]));
  const timestampToUtc = (value: string | undefined) => {
    if (!usable(value)) return undefined;
    if (/^-?\d{9,16}$/.test(value!)) {
      const epoch = Number(value);
      const date = new Date(Math.abs(epoch) < 100_000_000_000 ? epoch * 1000 : epoch);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    if (!/(?:Z|[+-]\d{2}:?\d{2}|(?:UTC|GMT))$/i.test(value!)) return undefined;
    const date = new Date(value!);
    if (Number.isNaN(date.getTime())) return undefined;
    return /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value!) ? value! : date.toISOString();
  };
  const duplicateSourceIds = new Set<string>();
  const sourceIdCounts = new Map<string, number>();
  for (const row of result.preview) {
    const path = mappingPaths.sourceRecordId;
    const value = path ? row.values[path] : undefined;
    if (usable(value)) sourceIdCounts.set(value!, (sourceIdCounts.get(value!) ?? 0) + 1);
  }
  for (const [value, count] of sourceIdCounts) if (count > 1) duplicateSourceIds.add(value);
  const previewFor = (row: DataSourceDiscoveryResult["preview"][number]) => {
    const values: Record<string, string> = {};
    const issues = row.issues.filter(issue =>
      !/Choose a source for required|must be a non-empty string|not a supported date|source record ID repeats/i.test(issue),
    );
    let invalid = false;
    const eventPath = mappingPaths.eventType;
    const eventType = eventPath ? row.values[eventPath] : undefined;
    if (!eventPath) issues.push("Choose a source for required Event type.");
    else if (
      !usable(eventType) ||
      (eventPath === suggestedPaths.eventType && row.issues.some(issue => issue.startsWith("Event type must"))) ||
      ["number", "boolean", "object", "array", "mixed", "unknown"].includes(fieldTypes.get(eventPath) ?? "")
    ) {
      issues.push("Event type must be a non-empty string in every sampled record."); invalid = true;
    }
    else values.eventType = eventType!;
    const timePath = mappingPaths.occurredAt;
    const occurredAt = timePath ? timestampToUtc(row.values[timePath]) : undefined;
    if (!timePath) issues.push("Choose a source for required Occurrence time.");
    else if (!occurredAt) { issues.push("Occurrence time needs a timezone or a valid Unix timestamp."); invalid = true; }
    else values.occurredAt = occurredAt;
    const sourceIdPath = mappingPaths.sourceRecordId;
    const sourceId = sourceIdPath ? row.values[sourceIdPath] : undefined;
    if (usable(sourceId)) {
      values.sourceRecordId = sourceId!;
      if (duplicateSourceIds.has(sourceId!)) issues.push("This source record ID repeats in the preview; imports will be deduplicated.");
    } else if (sourceIdPath && sourceId !== "(missing)" && sourceId !== undefined && sourceId !== "null") {
      issues.push("Source record ID must be a string or finite number."); invalid = true;
    }
    const assetPath = mappingPaths.assetKey;
    const originalAssetPath = suggestedPaths.assetKey;
    const assetValue = assetPath ? row.values[assetPath] : undefined;
    if (usable(assetValue) && assetPath) {
      values.assetKey = assetValue!;
      if (assetPath !== originalAssetPath) {
        issues.push("This alternative identifier is checked against exact asset keys and this source’s registered identifiers during import; unmatched values remain unassociated.");
      } else if (row.assetMatch?.status === "matched") {
        issues.push(row.assetMatch.matchType === "registered_external_identifier"
          ? "Matches a registered external identifier for this source."
          : "Matches an active registered asset key.");
      } else if (row.assetMatch?.status === "ambiguous") {
        issues.push("The asset identifier is ambiguous; no asset association will be made.");
      } else if (row.assetMatch?.matchType === "name_suggestion") {
        issues.push("A name match is only a suggestion; no automatic asset association will be made.");
      } else if (row.assetMatch?.status === "unmatched") {
        issues.push("No registered asset identifier matched; the event may be imported without an asset association.");
      }
    } else if (assetPath && assetValue !== "(missing)" && assetValue !== undefined && assetValue !== "null") {
      issues.push("Asset key must be a string or finite number."); invalid = true;
    }
    for (const target of SUGGESTED_PAYLOAD_TARGETS) {
      const path = mappingPaths[target];
      const value = path ? row.values[path] : undefined;
      if (path && value === "(missing)") { issues.push(`Mapped ${target} field is missing.`); invalid = true; }
      else if (value && value !== "[hidden]") values[target] = value;
    }
    return {
      values,
      issues,
      state: invalid ? "rejected" as const : issues.length ? "warning" as const : "valid" as const,
    };
  };
  return <section className="panel discovery-review" aria-labelledby="discovery-review-title" data-testid="panel-discovery-review">
    <div className="panel-heading-row">
      <div>
        <h2 className="panel-title" id="discovery-review-title">Discovery preview</h2>
        <p className="field-hint">Choose the record collection, review examples, then accept, change, or exclude each suggestion. Nothing is imported by discovery.</p>
      </div>
      <span className="status-pill">{result.sourceType.replace("_", " ").toUpperCase()}</span>
    </div>
    {selectedPath && mappingTemplateSources.length > 0 && <div className="mapping-reuse-control">
      <label className="field"><span>Reuse an approved mapping</span>
        <select
          value={mappingTemplateSourceId}
          onChange={event => onMappingTemplateSourceChange(event.target.value)}
          data-testid="select-reuse-mapping-source"
        >
          <option value="">Choose a source mapping</option>
          {mappingTemplateSources.map(source => <option value={source.id} key={source.id}>
            {source.displayName} · {source.sourceType.replace("_", " ")}
          </option>)}
        </select>
      </label>
      <button
        type="button"
        className="button-secondary"
        onClick={onApplyMappingTemplate}
        disabled={!mappingTemplateSourceId || mappingTemplateBusy}
        data-testid="button-apply-reuse-mapping"
      >
        {mappingTemplateBusy ? "Loading mapping…" : "Use approved mapping"}
      </button>
      <p className="field-hint">Copies field paths from an active mapping into this source’s draft selections. Review the examples, then validate and activate separately.</p>
      {mappingTemplateMessage && <p className="field-hint" role="status" data-testid="text-reuse-mapping-status">{mappingTemplateMessage}</p>}
    </div>}
    <label className="field"><span>Record collection</span>
      <select value={selectedPath} onChange={event => onSelectPath(event.target.value)} data-testid="select-discovery-record-path">
        <option value="">Choose a record collection</option>
        {result.recordPaths.map(item => <option key={item.path} value={item.path} disabled={!item.supported}>
          {item.path === "$" ? "Top-level array" : item.path} · {item.recordCount} {result.sourceType === "rest_api" ? "sampled records" : "records"}{item.supported ? "" : " · unsupported path"}
        </option>)}
      </select>
    </label>
    {result.warnings.map((warning, index) => <p className="field-hint" key={`${index}-${warning}`} data-testid="text-discovery-warning">{warning}</p>)}
    {selected && result.structures.length > 0 && <section className="panel" data-testid="panel-discovery-structures">
      <h3 className="panel-title">Nested structure inspection</h3>
      <p className="field-hint">Objects and arrays are inspected within bounded samples. Array members remain intact; structure hints do not map or import them automatically.</p>
      <div className="table-frame discovery-fields"><table>
        <thead><tr><th>Path and shape</th><th>Possible meaning</th><th>Observed child fields</th></tr></thead>
        <tbody>{result.structures.map(structure => <tr key={`${structure.path}:${structure.kind}`} data-testid="row-discovery-structure">
          <td>
            <span className="mono">{structure.path}</span>
            <p className="field-hint">
              {structure.kind === "array"
                ? `Array · ${structure.sampleCount} sampled occurrence${structure.sampleCount === 1 ? "" : "s"} · ${structure.itemCount} item${structure.itemCount === 1 ? "" : "s"}`
                : `Object · ${structure.sampleCount} sampled occurrence${structure.sampleCount === 1 ? "" : "s"}`}
            </p>
          </td>
          <td>
            {structure.possibleMeaning === "unknown"
              ? "Unclassified"
              : structure.possibleMeaning.replace("-", " ")}
            {structure.confidenceScore > 0 && <span className="field-hint"> · {Math.round(structure.confidenceScore * 100)}% clue</span>}
            <p className="field-hint">{structure.note}</p>
          </td>
          <td>{structure.childFields.length
            ? structure.childFields.map(field => (
              <div key={field.path}>
                <span className="mono">{field.path}</span> · {field.valueType}
                {field.possibleTarget && <span className="field-hint"> · possible {suggestionLabels[field.possibleTarget]} by field name</span>}
              </div>
            ))
            : <span className="muted">No object fields in the bounded sample</span>}
          </td>
        </tr>)}</tbody>
      </table></div>
    </section>}
    {selected && result.fields.length > 0 && <>
      <div className="table-frame discovery-fields"><table>
        <thead><tr><th>Mapping target</th><th>Source field</th><th>Confidence</th><th>Examples and review note</th></tr></thead>
        <tbody>{result.suggestions.map(suggestion => <tr key={suggestion.target}>
          <td>{suggestionLabels[suggestion.target]}{suggestion.required ? " · required" : ""}</td>
          <td><select
            value={mappingPaths[suggestion.target] ?? ""}
            onChange={event => onChangeMappingPath(suggestion.target, event.target.value)}
            aria-label={`${suggestionLabels[suggestion.target]} source field`}
            data-testid={`select-discovery-map-${suggestion.target}`}
          >
            <option value="">Do not map</option>
            {suggestion.alternatives.map(path => <option value={path} key={path}>{path}</option>)}
            {result.fields.filter(field => !suggestion.alternatives.includes(field.path)).map(field => <option value={field.path} key={field.path}>{field.path}</option>)}
          </select></td>
          <td><span className={`status-pill ${suggestion.confidence === "high" ? "good" : ""}`}>{suggestion.confidence} · {Math.round(suggestion.confidenceScore * 100)}%</span>{suggestion.ambiguous && <p className="field-hint">Ambiguous</p>}</td>
          <td>{suggestion.examples.join(" · ") || <span className="muted">No example</span>}<p className="field-hint">{suggestion.note}</p></td>
        </tr>)}</tbody>
      </table></div>
      <p className="field-hint">Only high-confidence, unambiguous matches with adequate sample coverage are preselected. Medium-confidence fields remain for operator review.</p>
      <div className="discovery-preview-records" data-testid="list-discovery-preview-records">
        <h3>Sample records · first {result.preview.length} of {selected.recordCount}{result.sourceType === "rest_api" ? ` across ${result.sampledPageCount} page${result.sampledPageCount === 1 ? "" : "s"}` : ""}</h3>
        {result.preview.map(row => {
          const preview = previewFor(row);
          return <article className="discovery-preview-record" key={row.recordNumber}>
          <div><strong>Record {row.recordNumber}</strong> <span className={`status-pill ${preview.state === "valid" ? "good" : preview.state === "rejected" ? "bad" : "warn"}`}>{preview.state.toUpperCase()}</span></div>
          {preview.issues.length > 0 && <ul>{preview.issues.map((issue, index) => <li key={`${row.recordNumber}-${index}`}>{issue}</li>)}</ul>}
          <dl>{Object.entries(row.values).slice(0, 8).map(([path, value]) => <div key={path}><dt>{path}</dt><dd>{value}</dd></div>)}</dl>
          {Object.keys(preview.values).length > 0 && <><p className="field-hint">Proposed normalized event</p><dl>{Object.entries(preview.values).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{value}</dd></div>)}</dl></>}
        </article>;
        })}
      </div>
      <p className="field-hint">Fields not mapped here remain in the event payload. A discovered mapping is saved as a draft and never activated automatically.</p>
    </>}
  </section>;
}

function DataSourceFormPage({ editing }: { editing: boolean }) {
  const { id = "" } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const [initialLoading, setInitialLoading] = useState(editing);
  const [loadError, setLoadError] = useState("");
  const [sourceKey, setSourceKey] = useState(""); const [displayName, setDisplayName] = useState("");
  const [type, setType] = useState<DataSourceType>("rest_api"); const [description, setDescription] = useState("");
  const [baseUrl, setBaseUrl] = useState(""); const [relativePath, setRelativePath] = useState("");
  const [endpointPath, setEndpointPath] = useState(""); const [recordsPath, setRecordsPath] = useState("");
  const [authMode, setAuthMode] = useState<RestApiAuthMode>("none");
  const [trustPrivateHost, setTrustPrivateHost] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState("10000"); const [maxResponseBytes, setMaxResponseBytes] = useState("1048576"); const [maxRecords, setMaxRecords] = useState("500");
  const [paginationMode, setPaginationMode] = useState<PaginationMode>("");
  const [pageSize, setPageSize] = useState("100"); const [limitParameter, setLimitParameter] = useState("limit");
  const [requestIntervalMs, setRequestIntervalMs] = useState("250");
  const [offsetParameter, setOffsetParameter] = useState("offset"); const [startOffset, setStartOffset] = useState("0");
  const [pageParameter, setPageParameter] = useState("page"); const [startPage, setStartPage] = useState("1");
  const [cursorParameter, setCursorParameter] = useState("cursor"); const [nextCursorPath, setNextCursorPath] = useState("nextCursor");
  const [dateFromParameter, setDateFromParameter] = useState(""); const [dateFrom, setDateFrom] = useState("");
  const [dateToParameter, setDateToParameter] = useState(""); const [dateTo, setDateTo] = useState("");
  const [credentialRef, setCredentialRef] = useState(""); const [credentialConfigured, setCredentialConfigured] = useState(false);
  const [clearCredential, setClearCredential] = useState(false); const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [validation, setValidation] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [discovery, setDiscovery] = useState<DataSourceDiscoveryResult | null>(null);
  const [selectedRecordPath, setSelectedRecordPath] = useState("");
  const [mappingPaths, setMappingPaths] = useState<Record<string, string>>({});
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [discoveryConfigurationKey, setDiscoveryConfigurationKey] = useState("");
  const [mappingTemplateSources, setMappingTemplateSources] = useState<DataSourceRecord[]>([]);
  const [mappingTemplateSourceId, setMappingTemplateSourceId] = useState("");
  const [mappingTemplateBusy, setMappingTemplateBusy] = useState(false);
  const [mappingTemplateMessage, setMappingTemplateMessage] = useState("");
  const focusDiscovery = editing && new URLSearchParams(window.location.search).get("step") === "discover";
  function clearDiscovery() {
    setDiscovery(null);
    setSelectedRecordPath("");
    setMappingPaths({});
    setDiscoveryError("");
    setDiscoveryConfigurationKey("");
    setMappingTemplateSourceId("");
    setMappingTemplateMessage("");
  }
  function changeConfiguration(setter: (value: string) => void, value: string) {
    setter(value);
    clearDiscovery();
  }
  function hostnameFromUrl(value: string): string {
    try {
      return new URL(value).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    } catch {
      return "";
    }
  }
  function isLoopbackHostname(hostname: string): boolean {
    return hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
      /^::ffff:127(?:\.\d{1,3}){3}$/i.test(hostname);
  }
  const restHostname = hostnameFromUrl(baseUrl);
  function changeBaseUrl(value: string) {
    if (trustPrivateHost && hostnameFromUrl(value) !== restHostname) {
      setTrustPrivateHost(false);
    }
    changeConfiguration(setBaseUrl, value);
  }
  function configurationFromForm(): DataSourceConfigurationInput {
    if (type === "rest_api") {
      const credential: { credentialRef?: string | null } = {};
      let pagination: RestPaginationConfiguration | undefined;
      const dateRange = {
        ...(dateFromParameter.trim() && dateFrom.trim()
          ? { dateFromParameter: dateFromParameter.trim(), dateFrom: dateFrom.trim() }
          : {}),
        ...(dateToParameter.trim() && dateTo.trim()
          ? { dateToParameter: dateToParameter.trim(), dateTo: dateTo.trim() }
          : {}),
      };
      if (paginationMode === "offset") {
        pagination = {
          strategy: "offset", pageSize: Number(pageSize), limitParameter: limitParameter.trim(),
          requestIntervalMs: Number(requestIntervalMs), offsetParameter: offsetParameter.trim(),
          startOffset: Number(startOffset), ...dateRange,
        };
      } else if (paginationMode === "page") {
        pagination = {
          strategy: "page", pageSize: Number(pageSize), limitParameter: limitParameter.trim(),
          requestIntervalMs: Number(requestIntervalMs), pageParameter: pageParameter.trim(),
          startPage: Number(startPage), ...dateRange,
        };
      } else if (paginationMode === "cursor") {
        pagination = {
          strategy: "cursor", pageSize: Number(pageSize), limitParameter: limitParameter.trim(),
          requestIntervalMs: Number(requestIntervalMs), cursorParameter: cursorParameter.trim(),
          nextCursorPath: nextCursorPath.trim(), ...dateRange,
        };
      }
      if (clearCredential) credential.credentialRef = null;
      else if (credentialRef.trim()) credential.credentialRef = credentialRef.trim();
      return {
        kind: "rest_api",
        baseUrl: baseUrl.trim(),
        endpointPath: endpointPath.trim(),
        method: "GET",
        authMode,
        ...(trustPrivateHost && restHostname ? { trustedPrivateHost: restHostname } : {}),
        timeoutMs: Number(timeoutMs),
        maxResponseBytes: Number(maxResponseBytes),
        maxRecords: Number(maxRecords),
        responseFormat: "json",
        recordsPath: recordsPath.trim(),
        ...(pagination ? { pagination } : {}),
        ...credential,
      };
    }
    if (type === "json_file") {
      return { kind: "json_file", relativePath: relativePath.trim(), ...(recordsPath.trim() ? { recordsPath: recordsPath.trim() } : {}) };
    }
    if (type === "csv_file") return { kind: "csv_file", relativePath: relativePath.trim() };
    return { kind: "manual" };
  }
  async function runDiscovery() {
    setDiscoveryError("");
    setMappingTemplateSourceId("");
    setMappingTemplateMessage("");
    if (type === "manual" || !validate()) return;
    setDiscoveryBusy(true);
    try {
      const configuration = configurationFromForm();
      const result = await discoverDataSource(type, configuration, selectedRecordPath || undefined, sourceKey.trim() || undefined);
      const chosenPath = result.selectedRecordPath ?? "";
      setSelectedRecordPath(chosenPath);
      setMappingPaths(Object.fromEntries(result.suggestions.map(suggestion => [suggestion.target, suggestion.sourcePath ?? ""])));
      let confirmedConfiguration = configuration;
      if (result.selectedRecordPath && (type === "rest_api" || type === "json_file")) {
        const path = result.selectedRecordPath === "$" ? "" : result.selectedRecordPath;
        setRecordsPath(path);
        confirmedConfiguration = type === "rest_api"
          ? { ...(configuration as Extract<DataSourceConfigurationInput, { kind: "rest_api" }>), recordsPath: path }
          : { kind: "json_file", relativePath, ...(path ? { recordsPath: path } : {}) };
      }
      setDiscoveryConfigurationKey(JSON.stringify(confirmedConfiguration));
      setDiscovery(result);
    } catch (cause) {
      setDiscoveryError(displayError(cause));
    } finally {
      setDiscoveryBusy(false);
    }
  }
  function selectDiscoveryPath(path: string) {
    setSelectedRecordPath(path);
    setMappingPaths({});
    setMappingTemplateSourceId("");
    setMappingTemplateMessage("");
    setDiscoveryConfigurationKey("");
    if (type === "rest_api" || type === "json_file") setRecordsPath(path === "$" ? "" : path);
    setDiscovery(current => current ? {
      ...current,
      selectedRecordPath: path || null,
      fields: [],
      suggestions: [],
      structures: [],
      preview: [],
      warnings: path ? ["Run discovery again to preview this collection."] : ["Choose a record collection."],
    } : current);
  }
  async function applyMappingTemplate() {
    if (!mappingTemplateSourceId || !discovery) return;
    setMappingTemplateBusy(true);
    setMappingTemplateMessage("");
    try {
      const response = await listDataSourceEventMappings(mappingTemplateSourceId);
      const active = response.items.find(mapping => mapping.status === "active");
      if (!active) {
        setMappingTemplateMessage("That source has no active approved mapping.");
        return;
      }
      const definition = active.definition as unknown as EventMappingDefinition;
      const availablePaths = new Set(discovery.fields.map(field => field.path));
      const copied: Record<string, string> = {};
      const safeCompatiblePath = (target: SuggestedTargetField, approvedPath?: string): string | undefined => {
        if (approvedPath && availablePaths.has(approvedPath)) return approvedPath;
        const suggestion = discovery.suggestions.find(item => item.target === target);
        return suggestion?.confidence === "high" && !suggestion.ambiguous && suggestion.sourcePath
          ? suggestion.sourcePath
          : undefined;
      };
      const eventTypePath = safeCompatiblePath("eventType", definition.eventType);
      const occurredAtPath = safeCompatiblePath("occurredAt", definition.occurredAt);
      if (eventTypePath) copied.eventType = eventTypePath;
      if (occurredAtPath) copied.occurredAt = occurredAtPath;
      if (definition.sourceRecordId) {
        const path = safeCompatiblePath("sourceRecordId", definition.sourceRecordId);
        if (path) copied.sourceRecordId = path;
      }
      if (definition.assetKey) {
        const path = safeCompatiblePath("assetKey", definition.assetKey);
        if (path) copied.assetKey = path;
      }
      for (const [target, approvedPath] of Object.entries(definition.payload ?? {})) {
        const suggestedTarget = (SUGGESTED_PAYLOAD_TARGETS as readonly string[]).includes(target)
          ? target as SuggestedTargetField
          : undefined;
        const path = suggestedTarget
          ? safeCompatiblePath(suggestedTarget, approvedPath)
          : availablePaths.has(approvedPath) ? approvedPath : undefined;
        if (path) copied[target] = path;
      }
      setMappingPaths(copied);
      const requiredNeedsReview = !copied.eventType || !copied.occurredAt;
      setMappingTemplateMessage(
        `Copied active mapping version ${active.version}. ` +
        (requiredNeedsReview
          ? "Required fields without an exact or high-confidence compatible match still need selection."
          : "Exact paths were reused and compatible high-confidence fields were matched across formats.") +
        " Review it as a draft; it is not activated automatically.",
      );
    } catch (cause) {
      setMappingTemplateMessage(displayError(cause));
    } finally {
      setMappingTemplateBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    const loadSources = async () => {
      try {
        const pageSize = 25;
        const first = await listDataSources({ page: 1, pageSize, enabled: "all" });
        const sources = [...first.items];
        const pageCount = Math.ceil(first.total / pageSize);
        for (let page = 2; page <= pageCount; page += 1) {
          const next = await listDataSources({ page, pageSize, enabled: "all" });
          sources.push(...next.items);
        }
        if (active) {
          setMappingTemplateSources(sources.filter(source =>
            source.id !== (editing ? id : "") &&
            (source.sourceType === "rest_api" || source.sourceType === "json_file" || source.sourceType === "csv_file"),
          ));
        }
      } catch {
        if (active) setMappingTemplateSources([]);
      }
    };
    void loadSources();
    return () => { active = false; };
  }, [editing, id]);
  useEffect(() => {
    if (!editing) { setInitialLoading(false); return; }
    let active = true;
    setInitialLoading(true); setLoadError("");
    void getDataSource(id).then(record => {
      if (!active) return;
      setSourceKey(record.sourceKey); setDisplayName(record.displayName); setType(record.sourceType);
      setDescription(record.description ?? ""); setEnabled(record.enabled);
      if (record.configuration.kind === "rest_api") {
        setBaseUrl(record.configuration.baseUrl);
        setEndpointPath(record.configuration.endpointPath ?? "");
        setRecordsPath(record.configuration.recordsPath ?? "");
        setAuthMode(record.configuration.authMode ?? "none");
        setTrustPrivateHost(Boolean(record.configuration.trustedPrivateHost));
        setTimeoutMs(String(record.configuration.timeoutMs ?? 10000));
        setMaxResponseBytes(String(record.configuration.maxResponseBytes ?? 1048576));
        setMaxRecords(String(record.configuration.maxRecords ?? 500));
        const pagination = record.configuration.pagination;
        setPaginationMode(pagination?.strategy ?? "");
        if (pagination) {
          setPageSize(String(pagination.pageSize));
          setLimitParameter(pagination.limitParameter);
          setRequestIntervalMs(String(pagination.requestIntervalMs ?? 250));
          setOffsetParameter(pagination.offsetParameter ?? "offset");
          setStartOffset(String(pagination.startOffset ?? 0));
          setPageParameter(pagination.pageParameter ?? "page");
          setStartPage(String(pagination.startPage ?? 1));
          setCursorParameter(pagination.cursorParameter ?? "cursor");
          setNextCursorPath(pagination.nextCursorPath ?? "nextCursor");
          setDateFromParameter(pagination.dateFromParameter ?? "");
          setDateFrom(pagination.dateFrom ?? "");
          setDateToParameter(pagination.dateToParameter ?? "");
          setDateTo(pagination.dateTo ?? "");
        }
        setCredentialConfigured(record.configuration.credentialConfigured);
      }
      if (record.configuration.kind === "json_file") {
        setRelativePath(record.configuration.relativePath);
        setRecordsPath(record.configuration.recordsPath ?? "");
      }
      if (record.configuration.kind === "csv_file") setRelativePath(record.configuration.relativePath);
    }).catch(cause => { if (active) setLoadError(displayError(cause)); }).finally(() => { if (active) setInitialLoading(false); });
    return () => { active = false; };
  }, [editing, id, loadAttempt]);
  useEffect(() => {
    if (!focusDiscovery || initialLoading) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("discover-data")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusDiscovery, initialLoading]);
  function validate() {
    const errors: Record<string, string> = {};
    if (!sourceKey.trim()) errors.sourceKey = "Source key is required.";
    if (!displayName.trim()) errors.displayName = "Display name is required.";
    if (type === "rest_api") {
      if (!baseUrl.trim()) errors.baseUrl = "REST base URL is required.";
      else { try { const url = new URL(baseUrl); if (url.protocol !== "http:" && url.protocol !== "https:") errors.baseUrl = "Use an HTTP or HTTPS URL."; } catch { errors.baseUrl = "Enter a valid absolute URL."; } }
      if (!endpointPath.trim()) errors.endpointPath = "Endpoint path is required.";
      if (authMode === "bearer" && !credentialConfigured && !credentialRef.trim()) errors.credentialRef = "A bearer token environment-variable reference is required.";
      if (authMode === "bearer" && baseUrl.trim()) {
        try { if (new URL(baseUrl).protocol !== "https:") errors.authMode = "Bearer authentication requires HTTPS."; } catch { /* Base URL error is shown above. */ }
      }
      const timeout = Number(timeoutMs); const responseLimit = Number(maxResponseBytes); const recordLimit = Number(maxRecords);
      if (!Number.isInteger(timeout) || timeout < 500 || timeout > 30000) errors.timeoutMs = "Use a whole number from 500 to 30000.";
      if (!Number.isInteger(responseLimit) || responseLimit < 1024 || responseLimit > 5242880) errors.maxResponseBytes = "Use a whole number from 1024 to 5242880.";
      if (!Number.isInteger(recordLimit) || recordLimit < 1 || recordLimit > 100000) errors.maxRecords = "Use a whole number from 1 to 100000.";
      if (paginationMode) {
        const parameterPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
        const parameters = [limitParameter.trim()];
        if (!Number.isInteger(Number(pageSize)) || Number(pageSize) < 1 || Number(pageSize) > 1000) errors.pageSize = "Use a page size from 1 to 1000.";
        if (!parameterPattern.test(limitParameter.trim())) errors.limitParameter = "Use a safe query parameter name.";
        if (!Number.isInteger(Number(requestIntervalMs)) || Number(requestIntervalMs) < 0 || Number(requestIntervalMs) > 10000) errors.requestIntervalMs = "Use a whole number from 0 to 10000.";
        if (paginationMode === "offset") {
          parameters.push(offsetParameter.trim());
          if (!parameterPattern.test(offsetParameter.trim())) errors.offsetParameter = "Use a safe query parameter name.";
          if (!Number.isInteger(Number(startOffset)) || Number(startOffset) < 0 || Number(startOffset) > 1_000_000_000) errors.startOffset = "Use a whole number from 0 to 1000000000.";
        }
        if (paginationMode === "page") {
          parameters.push(pageParameter.trim());
          if (!parameterPattern.test(pageParameter.trim())) errors.pageParameter = "Use a safe query parameter name.";
          if (!Number.isInteger(Number(startPage)) || Number(startPage) < 0 || Number(startPage) > 1_000_000_000) errors.startPage = "Use a whole number from 0 to 1000000000.";
        }
        if (paginationMode === "cursor") {
          parameters.push(cursorParameter.trim());
          if (!parameterPattern.test(cursorParameter.trim())) errors.cursorParameter = "Use a safe query parameter name.";
          const parts = nextCursorPath.trim().split(".");
          if (!nextCursorPath.trim() || parts.length > 8 || parts.some(part => !/^[A-Za-z0-9_-]{1,128}$/.test(part) || ["__proto__", "prototype", "constructor"].includes(part))) {
            errors.nextCursorPath = "Enter a safe dot-separated path for the next cursor.";
          }
        }
        if (new Set(parameters).size !== parameters.length) errors.limitParameter = "Pagination query parameter names must be distinct.";
        const dateFromConfigured = Boolean(dateFromParameter.trim() || dateFrom.trim());
        if (dateFromConfigured && (!parameterPattern.test(dateFromParameter.trim()) || !dateFrom.trim() || dateFrom.length > 128 || /[\r\n\0]/.test(dateFrom))) {
          errors.dateFrom = "Set a valid query parameter and value for the start date.";
        }
        const dateToConfigured = Boolean(dateToParameter.trim() || dateTo.trim());
        if (dateToConfigured && (!parameterPattern.test(dateToParameter.trim()) || !dateTo.trim() || dateTo.length > 128 || /[\r\n\0]/.test(dateTo))) {
          errors.dateTo = "Set a valid query parameter and value for the end date.";
        }
        if (dateFromParameter.trim()) parameters.push(dateFromParameter.trim());
        if (dateToParameter.trim()) parameters.push(dateToParameter.trim());
        if (new Set(parameters).size !== parameters.length) errors.limitParameter = "Pagination and date query parameter names must be distinct.";
      }
    }
    if ((type === "json_file" || type === "csv_file") && !relativePath.trim()) errors.relativePath = "Relative path is required.";
    setFieldErrors(errors); setValidation(Object.keys(errors).length ? "Review the fields marked below." : "");
    return Object.keys(errors).length === 0;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setValidation("");
    if (!validate()) return;
    const configuration = configurationFromForm();
    setBusy(true);
    try {
      const input = { sourceKey: sourceKey.trim(), displayName: displayName.trim(), sourceType: type, description: description.trim() || null, configuration, enabled };
      const saved = editing ? await updateDataSource(id, input) : await createDataSource(input);
      let mappingNotice = "";
      const discoveryIsCurrent = discovery !== null
        && discoveryConfigurationKey === JSON.stringify(configuration)
        && discovery.selectedRecordPath === selectedRecordPath
        && Boolean(selectedRecordPath);
      if (discoveryIsCurrent) {
        const selected = (target: SuggestedTargetField) => mappingPaths[target]?.trim() ?? "";
        const eventType = selected("eventType");
        const occurredAt = selected("occurredAt");
        if (eventType && occurredAt) {
          const payload: Record<string, string> = {};
          for (const target of SUGGESTED_PAYLOAD_TARGETS) {
            const path = selected(target);
            if (path) payload[target] = path;
          }
          const definition: EventMappingDefinition = {
            eventType,
            occurredAt,
            ...(selected("sourceRecordId") ? { sourceRecordId: selected("sourceRecordId") } : {}),
            ...(selected("assetKey") ? { assetKey: selected("assetKey") } : {}),
            payload,
          };
          try {
            const mappings = await listDataSourceEventMappings(saved.id);
            const draft = mappings.items.find(mapping => mapping.status === "draft");
            if (draft) await updateDataSourceEventMapping(saved.id, draft.version, definition);
            else await createDataSourceEventMapping(saved.id, definition);
          } catch {
            mappingNotice = "suggestedMapping=failed";
          }
        } else {
          mappingNotice = "suggestedMapping=incomplete";
        }
      }
      navigate(`/data-sources/${encodeURIComponent(saved.id)}${mappingNotice ? `?${mappingNotice}` : ""}`);
    } catch (cause) {
      setError(displayError(cause));
      setFieldErrors(cause instanceof ApiError ? mapDataSourceErrors(cause.fields ?? {}) : {});
    } finally { setBusy(false); }
  }
  if (initialLoading) return <main className="page-main"><LoadingState label="Loading source configuration metadata…" /></main>;
  if (loadError) return <main className="page-main"><ErrorState title="Could not open data source" message={loadError} retry={() => setLoadAttempt(value => value + 1)} back="/data-sources" /></main>;
  return <main className="page-main">
    <div className="detail-heading"><Link href={editing ? `/data-sources/${encodeURIComponent(id)}` : "/data-sources"} className="back-link" data-testid="link-cancel-data-source">← {editing ? "Data source record" : "All data sources"}</Link>
      <PageIntro eyebrow={editing ? "REGISTRY / SOURCE / EDIT" : "REGISTRY / SOURCE / NEW"} title={editing ? "Edit data source" : "Register data source"} description="Record configuration metadata. This workflow does not establish a connection or start ingestion." />
    </div>
    <div className="notice"><strong>Actions are on demand.</strong> Saving or enabling a source does not contact it. After saving, choose Discover data to inspect a REST endpoint or local file. Import and sync are separate operator actions.</div>
    {error && <div className="notice error" role="alert" data-testid="error-data-source-submit">{error}</div>}
    {validation && <div className="notice error" role="status" data-testid="validation-data-source">{validation}</div>}
    <section className="form-layout"><form className="form-panel" onSubmit={submit} noValidate>
      <div className="form-grid">
        <Field label="Source key" name="source-key" value={sourceKey} onChange={setSourceKey} required hint="A stable identifier for this source." error={fieldErrors.sourceKey} />
        <Field label="Display name" name="source-display-name" value={displayName} onChange={setDisplayName} required error={fieldErrors.displayName} />
        <div className="field"><label htmlFor="data-source-type">Source type</label><select id="data-source-type" data-testid="select-data-source-type" value={type} onChange={event => { setType(event.target.value as DataSourceType); setFieldErrors({}); setClearCredential(false); setRecordsPath(""); setTrustPrivateHost(false); clearDiscovery(); }} aria-describedby="source-type-hint">{DATA_SOURCE_TYPES.map(value => <option value={value} key={value}>{sourceLabels[value]}</option>)}</select><span className="field-hint" id="source-type-hint">Changing type replaces the configuration metadata on save.</span></div>
        <div className="field"><label className="field-label">Record state</label><label className="check-row"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} data-testid="checkbox-source-enabled" /><span><strong>Enabled</strong><br /><span className="field-hint">Metadata only; no connector is started.</span></span></label></div>
        <div className="field span-2"><label htmlFor="source-description">Description</label><textarea id="source-description" data-testid="input-source-description" value={description} onChange={event => setDescription(event.target.value)} placeholder="Purpose, ownership, or operational context" /></div>
      </div>
      <div className="form-section"><h2>Type-specific configuration</h2><p>Only configuration fields supported by the selected source type are shown.</p></div>
      {type === "rest_api" && <div className="form-grid">
        <div className="field span-2">
          <label htmlFor="rest-base-url">REST base URL *</label>
          <input id="rest-base-url" data-testid="input-rest-base-url" value={baseUrl} onChange={event => changeBaseUrl(event.target.value)} placeholder="https://host.example/api" aria-invalid={Boolean(fieldErrors.baseUrl)} aria-describedby={fieldErrors.baseUrl ? "rest-base-url-error" : undefined} />
          {fieldErrors.baseUrl && <span className="field-error" id="rest-base-url-error" data-testid="error-source-base-url">{fieldErrors.baseUrl}</span>}
          <span className="field-hint">Saving does not make a request. Discovery and sync are separate, explicit GET actions.</span>
          <label className="check-row">
            <input
              type="checkbox"
              checked={trustPrivateHost}
              disabled={!restHostname || isLoopbackHostname(restHostname)}
              onChange={event => { setTrustPrivateHost(event.target.checked); clearDiscovery(); }}
              data-testid="checkbox-trust-private-rest-host"
            />
            <span><strong>Trust this exact host for private-network access</strong><br /><span className="field-hint">
              {isLoopbackHostname(restHostname)
                ? "Loopback hosts cannot be trusted here."
                : restHostname
                  ? `Only ${restHostname} may resolve to private-network addresses for this source. Other private hosts, loopback, and metadata addresses remain blocked. Explicitly trust any redirect host through KUDU_REST_TRUSTED_HOSTS.`
                  : "Enter a valid REST base URL first. This trust applies only to its exact hostname or IP."}
            </span></span>
          </label>
        </div>
        <div className="field span-2">
          <label htmlFor="rest-endpoint-path">Endpoint path *</label>
          <input id="rest-endpoint-path" data-testid="input-rest-endpoint-path" value={endpointPath} onChange={event => changeConfiguration(setEndpointPath, event.target.value)} placeholder="v1/events" aria-invalid={Boolean(fieldErrors.endpointPath)} />
          {fieldErrors.endpointPath && <span className="field-error">{fieldErrors.endpointPath}</span>}
          <span className="field-hint">Relative to the base URL. Only GET is supported.</span>
        </div>
        <div className="field">
          <label htmlFor="rest-auth-mode">Authentication</label>
          <select id="rest-auth-mode" data-testid="select-rest-auth-mode" value={authMode} onChange={event => { setAuthMode(event.target.value as RestApiAuthMode); clearDiscovery(); }} aria-invalid={Boolean(fieldErrors.authMode)}>
            <option value="none">None</option><option value="bearer">Bearer token</option>
          </select>
          {fieldErrors.authMode && <span className="field-error">{fieldErrors.authMode}</span>}
          <span className="field-hint">Bearer tokens are sent only over HTTPS.</span>
        </div>
        <div className="field">
          <label htmlFor="credential-reference">Bearer token environment reference</label>
          <input id="credential-reference" data-testid="input-credential-reference" value={credentialRef} onChange={event => { setCredentialRef(event.target.value); setClearCredential(false); clearDiscovery(); }} placeholder={editing && credentialConfigured ? "Existing reference is configured" : "env:KUDU_SOURCE_ERP_TOKEN"} autoComplete="off" aria-invalid={Boolean(fieldErrors.credentialRef)} />
          {fieldErrors.credentialRef && <span className="field-error" data-testid="error-source-credential-ref">{fieldErrors.credentialRef}</span>}
          <span className="field-hint">{editing ? "The reference is redacted. Leave blank to preserve it; entered text replaces it." : "Reference only. Provision the environment variable separately; never enter its secret value here."}</span>
          {editing && credentialConfigured && <label className="check-row"><input type="checkbox" checked={clearCredential} onChange={event => { setClearCredential(event.target.checked); if (event.target.checked) setCredentialRef(""); clearDiscovery(); }} data-testid="checkbox-clear-credential-reference" /><span>Clear existing credential reference on save</span></label>}
        </div>
        <div className="field">
          <label htmlFor="rest-timeout">Timeout (ms)</label>
          <input id="rest-timeout" type="number" min="500" max="30000" step="1" value={timeoutMs} onChange={event => changeConfiguration(setTimeoutMs, event.target.value)} aria-invalid={Boolean(fieldErrors.timeoutMs)} />
          {fieldErrors.timeoutMs && <span className="field-error">{fieldErrors.timeoutMs}</span>}
        </div>
        <div className="field">
          <label htmlFor="rest-max-response">Maximum response bytes</label>
          <input id="rest-max-response" type="number" min="1024" max="5242880" step="1024" value={maxResponseBytes} onChange={event => changeConfiguration(setMaxResponseBytes, event.target.value)} aria-invalid={Boolean(fieldErrors.maxResponseBytes)} />
          {fieldErrors.maxResponseBytes && <span className="field-error">{fieldErrors.maxResponseBytes}</span>}
        </div>
        <div className="field">
          <label htmlFor="rest-max-records">Maximum records</label>
          <input id="rest-max-records" type="number" min="1" max="100000" step="1" value={maxRecords} onChange={event => changeConfiguration(setMaxRecords, event.target.value)} aria-invalid={Boolean(fieldErrors.maxRecords)} />
          {fieldErrors.maxRecords && <span className="field-error">{fieldErrors.maxRecords}</span>}
        </div>
        <div className="field">
          <label htmlFor="rest-records-path">JSON records path</label>
          <input id="rest-records-path" data-testid="input-rest-records-path" value={recordsPath} onChange={event => changeConfiguration(setRecordsPath, event.target.value)} placeholder="data.events" aria-invalid={Boolean(fieldErrors.recordsPath)} />
          {fieldErrors.recordsPath && <span className="field-error">{fieldErrors.recordsPath}</span>}
          <span className="field-hint">Dot path to the array; leave blank when the response is an array.</span>
        </div>
        <div className="form-section span-2">
          <h2>Historical pagination</h2>
          <p>Pagination is opt-in. Each manual sync processes at most three pages, stores its checkpoint, and can be resumed. No scheduled polling is performed.</p>
        </div>
        <div className="field">
          <label htmlFor="rest-pagination-mode">Pagination strategy</label>
          <select id="rest-pagination-mode" value={paginationMode} onChange={event => { setPaginationMode(event.target.value as PaginationMode); clearDiscovery(); }}>
            <option value="">No pagination</option>
            <option value="offset">Offset</option>
            <option value="page">Page number</option>
            <option value="cursor">Cursor</option>
          </select>
          <span className="field-hint">Use the exact pagination convention documented by the source API.</span>
        </div>
        {paginationMode && <>
          <div className="field">
            <label htmlFor="rest-page-size">Page size</label>
            <input id="rest-page-size" type="number" min="1" max="1000" value={pageSize} onChange={event => changeConfiguration(setPageSize, event.target.value)} aria-invalid={Boolean(fieldErrors.pageSize)} />
            {fieldErrors.pageSize && <span className="field-error">{fieldErrors.pageSize}</span>}
          </div>
          <div className="field">
            <label htmlFor="rest-limit-parameter">Limit query parameter</label>
            <input id="rest-limit-parameter" value={limitParameter} onChange={event => changeConfiguration(setLimitParameter, event.target.value)} aria-invalid={Boolean(fieldErrors.limitParameter)} />
            {fieldErrors.limitParameter && <span className="field-error">{fieldErrors.limitParameter}</span>}
          </div>
          <div className="field">
            <label htmlFor="rest-request-interval">Minimum interval between pages (ms)</label>
            <input id="rest-request-interval" type="number" min="0" max="10000" value={requestIntervalMs} onChange={event => changeConfiguration(setRequestIntervalMs, event.target.value)} aria-invalid={Boolean(fieldErrors.requestIntervalMs)} />
            {fieldErrors.requestIntervalMs && <span className="field-error">{fieldErrors.requestIntervalMs}</span>}
            <span className="field-hint">HTTP 429 responses also honor Retry-After within the request timeout.</span>
          </div>
          {paginationMode === "offset" && <>
            <div className="field"><label htmlFor="rest-offset-parameter">Offset query parameter</label><input id="rest-offset-parameter" value={offsetParameter} onChange={event => changeConfiguration(setOffsetParameter, event.target.value)} aria-invalid={Boolean(fieldErrors.offsetParameter)} />{fieldErrors.offsetParameter && <span className="field-error">{fieldErrors.offsetParameter}</span>}</div>
            <div className="field"><label htmlFor="rest-start-offset">Starting offset</label><input id="rest-start-offset" type="number" min="0" value={startOffset} onChange={event => changeConfiguration(setStartOffset, event.target.value)} aria-invalid={Boolean(fieldErrors.startOffset)} />{fieldErrors.startOffset && <span className="field-error">{fieldErrors.startOffset}</span>}</div>
          </>}
          {paginationMode === "page" && <>
            <div className="field"><label htmlFor="rest-page-parameter">Page-number query parameter</label><input id="rest-page-parameter" value={pageParameter} onChange={event => changeConfiguration(setPageParameter, event.target.value)} aria-invalid={Boolean(fieldErrors.pageParameter)} />{fieldErrors.pageParameter && <span className="field-error">{fieldErrors.pageParameter}</span>}</div>
            <div className="field"><label htmlFor="rest-start-page">Starting page number</label><input id="rest-start-page" type="number" min="0" value={startPage} onChange={event => changeConfiguration(setStartPage, event.target.value)} aria-invalid={Boolean(fieldErrors.startPage)} />{fieldErrors.startPage && <span className="field-error">{fieldErrors.startPage}</span>}</div>
          </>}
          {paginationMode === "cursor" && <>
            <div className="field"><label htmlFor="rest-cursor-parameter">Cursor query parameter</label><input id="rest-cursor-parameter" value={cursorParameter} onChange={event => changeConfiguration(setCursorParameter, event.target.value)} aria-invalid={Boolean(fieldErrors.cursorParameter)} />{fieldErrors.cursorParameter && <span className="field-error">{fieldErrors.cursorParameter}</span>}</div>
            <div className="field"><label htmlFor="rest-next-cursor-path">Next cursor response path</label><input id="rest-next-cursor-path" value={nextCursorPath} onChange={event => changeConfiguration(setNextCursorPath, event.target.value)} aria-invalid={Boolean(fieldErrors.nextCursorPath)} /><span className="field-hint">For example, pagination.nextCursor. Cursor values are stored privately in the run checkpoint.</span>{fieldErrors.nextCursorPath && <span className="field-error">{fieldErrors.nextCursorPath}</span>}</div>
          </>}
          <div className="field">
            <label htmlFor="rest-date-from-parameter">Optional start-date parameter</label>
            <input id="rest-date-from-parameter" value={dateFromParameter} onChange={event => changeConfiguration(setDateFromParameter, event.target.value)} placeholder="from" aria-invalid={Boolean(fieldErrors.dateFrom)} />
            <input aria-label="Start-date value" value={dateFrom} onChange={event => changeConfiguration(setDateFrom, event.target.value)} placeholder="API-specific value" aria-invalid={Boolean(fieldErrors.dateFrom)} />
            {fieldErrors.dateFrom && <span className="field-error">{fieldErrors.dateFrom}</span>}
          </div>
          <div className="field">
            <label htmlFor="rest-date-to-parameter">Optional end-date parameter</label>
            <input id="rest-date-to-parameter" value={dateToParameter} onChange={event => changeConfiguration(setDateToParameter, event.target.value)} placeholder="to" aria-invalid={Boolean(fieldErrors.dateTo)} />
            <input aria-label="End-date value" value={dateTo} onChange={event => changeConfiguration(setDateTo, event.target.value)} placeholder="API-specific value" aria-invalid={Boolean(fieldErrors.dateTo)} />
            {fieldErrors.dateTo && <span className="field-error">{fieldErrors.dateTo}</span>}
            <span className="field-hint">Values are sent as entered; Kudu does not guess a timezone or convert them.</span>
          </div>
        </>}
        <div className="field"><span className="field-label">Response format</span><span className="field-hint">JSON only</span></div>
      </div>}
      {(type === "json_file" || type === "csv_file") && <div className="field"><label htmlFor="source-relative-path">Relative file path *</label><input id="source-relative-path" data-testid="input-source-relative-path" value={relativePath} onChange={event => changeConfiguration(setRelativePath, event.target.value)} placeholder={type === "csv_file" ? "data/measurements.csv" : "data/faults.json"} aria-invalid={Boolean(fieldErrors.relativePath)} aria-describedby={fieldErrors.relativePath ? "source-relative-path-error" : undefined} />{fieldErrors.relativePath && <span className="field-error" id="source-relative-path-error" data-testid="error-source-relative-path">{fieldErrors.relativePath}</span>}<span className="field-hint">Relative to the configured local data root. Saving does not read the file; discovery and import are explicit actions.</span>
        {type === "json_file" && <><label htmlFor="json-records-path">JSON records path</label><input id="json-records-path" data-testid="input-json-records-path" value={recordsPath} onChange={event => changeConfiguration(setRecordsPath, event.target.value)} placeholder="faults" /><span className="field-hint">Dot path to the record array; leave blank for a top-level array.</span></>}
      </div>}
      {type === "manual" && <div className="notice" data-testid="notice-manual-source">Manual source is a reference record. No external connection or ingestion is available.</div>}
      {editing && type !== "manual" && <>
        <div className="form-section" id="discover-data" data-testid="section-discover-data"><h2>Discover data</h2><p>Discovery makes one bounded REST GET or up to three pages using the configured pagination, or reads the selected local file. It does not import, create assets, or activate a mapping.</p></div>
        {discoveryError && <div className="notice error" role="alert" data-testid="error-data-discovery">{discoveryError}</div>}
        <div className="form-actions"><button className="button" type="button" onClick={() => void runDiscovery()} disabled={busy || discoveryBusy} data-testid="button-discover-source">
          {discoveryBusy ? "Discovering…" : "Discover data"}
        </button></div>
        {discovery && <DiscoveryReview
          result={discovery}
          selectedPath={selectedRecordPath}
          onSelectPath={selectDiscoveryPath}
          mappingPaths={mappingPaths}
          onChangeMappingPath={(target, path) => setMappingPaths(current => ({ ...current, [target]: path }))}
          mappingTemplateSources={mappingTemplateSources}
          mappingTemplateSourceId={mappingTemplateSourceId}
          onMappingTemplateSourceChange={sourceId => {
            setMappingTemplateSourceId(sourceId);
            setMappingTemplateMessage("");
          }}
          onApplyMappingTemplate={applyMappingTemplate}
          mappingTemplateBusy={mappingTemplateBusy}
          mappingTemplateMessage={mappingTemplateMessage}
        />}
      </>}
      <div className="form-actions"><Link className="button button-quiet" href={editing ? `/data-sources/${encodeURIComponent(id)}` : "/data-sources"} data-testid="button-cancel-data-source">Cancel</Link><div className="form-actions-end"><button className="button button-primary" type="submit" disabled={busy || discoveryBusy} data-testid="button-submit-data-source">{busy ? "Saving…" : editing ? "Save changes" : "Create data source"}</button></div></div>
    </form></section>
  </main>;
}

export { DataSourceListPage, DataSourceDetailPage, DataSourceFormPage };
