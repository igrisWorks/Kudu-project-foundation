import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useParams } from "wouter";
import { DATA_SOURCE_TYPES, type DataSourceConfigurationInput, type DataSourceEventMapping, type DataSourceRecord, type DataSourceType, type EventMappingDefinition, type FileImportResult, type Page, type RestApiAuthMode, type RestSyncResult } from "@kudu/shared";
import { activateDataSourceEventMapping, ApiError, createDataSource, createDataSourceEventMapping, getDataSource, importDataSourceFile, listDataSourceEventMappings, listDataSources, syncRestDataSource, updateDataSource, updateDataSourceEventMapping, validateDataSourceEventMapping } from "../api";
import { ConnectorBadge, displayError, EmptyState, ErrorState, Field, formatDate, ListPagination, LoadingState, PageIntro } from "../components/RegistryUI";

const PAGE_SIZE = 15;
const sourceLabels: Record<DataSourceType, string> = {
  rest_api: "REST API", json_file: "JSON file", csv_file: "CSV file", manual: "Manual",
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
    <div className="notice" data-testid="notice-connector-status"><strong>Source actions are on demand.</strong> REST sync and local CSV/JSON imports run only when requested. Registration and enablement never start polling or ingestion.</div>
    <div className="toolbar">
      <div className="field field-search"><label htmlFor="source-search">Search registry</label><input id="source-search" data-testid="input-data-source-search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Search key or display name…" /></div>
      <div className="field field-filter"><label htmlFor="source-type-filter">Source type</label><select id="source-type-filter" data-testid="filter-data-source-type" value={sourceType} onChange={event => { setSourceType(event.target.value); setPage(1); }}><option value="">All types</option>{DATA_SOURCE_TYPES.map(type => <option value={type} key={type}>{sourceLabels[type]}</option>)}</select></div>
      <div className="field field-filter"><label htmlFor="source-enabled-filter">Enabled state</label><select id="source-enabled-filter" data-testid="filter-data-source-enabled" value={enabled} onChange={event => { setEnabled(event.target.value as typeof enabled); setPage(1); }}><option value="all">All states</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></div>
    </div>
    {error && <div className="notice error" role="alert" data-testid="error-data-sources"><strong>Could not load data sources.</strong> {error} <button type="button" className="button button-quiet" onClick={() => void load()} data-testid="button-retry-data-sources">Retry</button></div>}
    {loading ? <LoadingState label="Loading registered source metadata…" /> : error ? null : result?.items.length ? <>
      <div className="table-frame"><table>
        <thead><tr><th>KEY / DISPLAY NAME</th><th>TYPE</th><th>ENABLED</th><th>CONNECTOR STATUS</th><th>LAST SUCCESSFUL SYNC</th></tr></thead>
        <tbody>{result.items.map(source => <tr key={source.id} data-testid={`row-data-source-${source.id}`}>
          <td><Link className="record-link mono" href={`/data-sources/${encodeURIComponent(source.id)}`} data-testid={`link-data-source-${source.id}`}>{source.sourceKey}</Link><br /><Link className="record-link" href={`/data-sources/${encodeURIComponent(source.id)}`} data-testid={`link-data-source-name-${source.id}`}>{source.displayName}</Link></td>
          <td>{sourceLabels[source.sourceType]}</td><td><span className={`status-pill ${source.enabled ? "good" : ""}`}>{source.enabled ? "ENABLED" : "DISABLED"}</span></td>
          <td>{source.sourceType === "rest_api" ? <span className="status-pill good">ON-DEMAND</span> : <ConnectorBadge status={source.connectionStatus} />}</td>
          <td className="time-label">{source.sourceType === "rest_api" ? "Not tracked" : formatDate(source.lastSuccessfulSyncAt)}</td>
        </tr>)}</tbody>
      </table></div>
      <ListPagination page={page} maxPage={maxPage} total={result.total} onChange={setPage} testId="data-sources" />
    </> : <EmptyState title={search ? "No matching data sources" : "No data sources in this view"} description={search ? "Try a different key or display name. Search is sent to the server." : "Register source metadata to document how this registry relates to your operational systems."} action={!search ? <Link className="button button-primary" href="/data-sources/new" data-testid="button-empty-create-data-source">Add a data source</Link> : undefined} />}
  </main>;
}

function DataSourceDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [record, setRecord] = useState<DataSourceRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importResult, setImportResult] = useState<FileImportResult | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [syncResult, setSyncResult] = useState<RestSyncResult | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setRecord(await getDataSource(id)); } catch (cause) { setError(displayError(cause)); }
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
    try { setSyncResult(await syncRestDataSource(id)); }
    catch (cause) { setSyncError(displayError(cause)); }
    finally { setSyncing(false); }
  }
  if (loading) return <main className="page-main"><LoadingState label="Loading the actual data source record…" /></main>;
  if (error || !record) return <main className="page-main"><ErrorState title="Data source unavailable" message={error || "The requested source was not returned by the API."} retry={() => void load()} back="/data-sources" /></main>;
  const cfg = record.configuration;
  const fileFormat = record.sourceType === "csv_file" ? "CSV" : record.sourceType === "json_file" ? "JSON" : null;
  const isRestSource = record.sourceType === "rest_api" && cfg.kind === "rest_api";
  return <main className="page-main">
    <div className="detail-heading"><Link href="/data-sources" className="back-link" data-testid="link-back-data-sources">← All data sources</Link>
      <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />DATA SOURCE RECORD</div><h1>{record.displayName}</h1><span className="detail-key" data-testid="text-data-source-key">{record.sourceKey}</span></div>
        <div className="detail-actions">
          {fileFormat && record.enabled && <button className="button button-primary" type="button" onClick={() => void runFileImport()} disabled={importing} data-testid="button-import-source-file">{importing ? "Importing…" : `Import configured ${fileFormat} file`}</button>}
          {isRestSource && record.enabled && <button className="button button-primary" type="button" onClick={() => void runRestSync()} disabled={syncing} data-testid="button-sync-rest-source">{syncing ? "Syncing…" : "Sync now"}</button>}
          <Link className="button" href={`/data-sources/${encodeURIComponent(id)}/edit`} data-testid="button-edit-data-source">Edit record</Link>
        </div>
      </div>
    </div>
    <div className="notice" data-testid="notice-source-import">
      {fileFormat
        ? <><strong>{fileFormat} file import is available.</strong> Imports read the registered relative file from the configured local import directory. {record.enabled ? "Imports run only when requested and are not scheduled." : "Enable this source before importing. No import is started while disabled."}</>
        : isRestSource
          ? <><strong>REST sync is read-only and on demand.</strong> Kudu sends a bounded GET request only when you select Sync now. No source is polled or scheduled.</>
          : <><strong>Manual source.</strong> This reference record does not connect or start ingestion.</>}
    </div>
    {importError && <div className="notice error" role="alert" data-testid="error-file-import"><strong>Import failed.</strong> {importError}</div>}
    {syncError && <div className="notice error" role="alert" data-testid="error-rest-sync"><strong>Sync could not run.</strong> {syncError}</div>}
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
      <h2 className="panel-title">REST sync · {syncResult.requestSucceeded ? (syncResult.failed ? "completed with failures" : "completed") : "request failed"}</h2>
      <p data-testid="text-rest-sync-counts">
        {syncResult.fetched} fetched, {syncResult.imported} imported, {syncResult.duplicates} duplicates, {syncResult.failed} failed.
      </p>
      {syncResult.errors.length > 0 && <ul className="file-import-errors" data-testid="list-rest-sync-errors">
        {syncResult.errors.map((item, index) => <li key={`${item.record}-${item.code}-${index}`}>
          <strong>{item.record === 0 ? "Request" : `Record ${item.record}`} · {item.code}</strong>: {item.message}
          {item.fields && <span className="file-import-field-errors"> {Object.values(item.fields).join(" ")}</span>}
        </li>)}
      </ul>}
      {syncResult.errorsTruncated && <p className="field-hint">Only the first {syncResult.errors.length} errors are displayed.</p>}
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
            <dt>Endpoint path</dt><dd className="mono">{cfg.endpointPath || "Not configured"}</dd>
            <dt>Method</dt><dd>{cfg.method ?? "GET"}</dd>
            <dt>Response format</dt><dd>{(cfg.responseFormat ?? "json").toUpperCase()}</dd>
            <dt>Records path</dt><dd className="mono">{cfg.recordsPath || "Top-level JSON array"}</dd>
            <dt>Authentication</dt><dd>{cfg.authMode === "bearer"
              ? cfg.credentialConfigured ? "Bearer token via environment variable is configured." : "Bearer token reference is unavailable."
              : cfg.credentialConfigured ? "No authentication; an inactive credential reference is recorded." : "None."}</dd>
            <dt>Request limits</dt><dd>{cfg.timeoutMs ?? 10000} ms · {((cfg.maxResponseBytes ?? 1048576) / 1048576).toFixed(1)} MiB · {cfg.maxRecords ?? 500} records</dd>
          </>}
          {(cfg.kind === "json_file" || cfg.kind === "csv_file") && <><dt>Relative path</dt><dd className="mono" data-testid="text-source-path">{cfg.relativePath}</dd></>}
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
            <dt>Run history</dt><dd>Not stored; each result is returned after the request.</dd>
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
  const [timeoutMs, setTimeoutMs] = useState("10000"); const [maxResponseBytes, setMaxResponseBytes] = useState("1048576"); const [maxRecords, setMaxRecords] = useState("500");
  const [credentialRef, setCredentialRef] = useState(""); const [credentialConfigured, setCredentialConfigured] = useState(false);
  const [clearCredential, setClearCredential] = useState(false); const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [validation, setValidation] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
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
        setTimeoutMs(String(record.configuration.timeoutMs ?? 10000));
        setMaxResponseBytes(String(record.configuration.maxResponseBytes ?? 1048576));
        setMaxRecords(String(record.configuration.maxRecords ?? 500));
        setCredentialConfigured(record.configuration.credentialConfigured);
      }
      if (record.configuration.kind === "json_file" || record.configuration.kind === "csv_file") setRelativePath(record.configuration.relativePath);
    }).catch(cause => { if (active) setLoadError(displayError(cause)); }).finally(() => { if (active) setInitialLoading(false); });
    return () => { active = false; };
  }, [editing, id, loadAttempt]);
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
      if (!Number.isInteger(recordLimit) || recordLimit < 1 || recordLimit > 1000) errors.maxRecords = "Use a whole number from 1 to 1000.";
    }
    if ((type === "json_file" || type === "csv_file") && !relativePath.trim()) errors.relativePath = "Relative path is required.";
    setFieldErrors(errors); setValidation(Object.keys(errors).length ? "Review the fields marked below." : "");
    return Object.keys(errors).length === 0;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setValidation("");
    if (!validate()) return;
    let configuration: DataSourceConfigurationInput;
    if (type === "rest_api") {
      const credential: { credentialRef?: string | null } = {};
      if (clearCredential) credential.credentialRef = null;
      else if (credentialRef.trim()) credential.credentialRef = credentialRef.trim();
      configuration = {
        kind: "rest_api",
        baseUrl: baseUrl.trim(),
        endpointPath: endpointPath.trim(),
        method: "GET",
        authMode,
        timeoutMs: Number(timeoutMs),
        maxResponseBytes: Number(maxResponseBytes),
        maxRecords: Number(maxRecords),
        responseFormat: "json",
        recordsPath: recordsPath.trim(),
        ...credential,
      };
    } else if (type === "json_file" || type === "csv_file") configuration = { kind: type, relativePath: relativePath.trim() };
    else configuration = { kind: "manual" };
    setBusy(true);
    try {
      const input = { sourceKey: sourceKey.trim(), displayName: displayName.trim(), sourceType: type, description: description.trim() || null, configuration, enabled };
      const saved = editing ? await updateDataSource(id, input) : await createDataSource(input);
      navigate(`/data-sources/${encodeURIComponent(saved.id)}`);
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
    <div className="notice"><strong>Actions are on demand.</strong> Saving or enabling a REST source does not contact it; only Sync now sends a GET request.</div>
    {error && <div className="notice error" role="alert" data-testid="error-data-source-submit">{error}</div>}
    {validation && <div className="notice error" role="status" data-testid="validation-data-source">{validation}</div>}
    <section className="form-layout"><form className="form-panel" onSubmit={submit} noValidate>
      <div className="form-grid">
        <Field label="Source key" name="source-key" value={sourceKey} onChange={setSourceKey} required hint="A stable identifier for this source." error={fieldErrors.sourceKey} />
        <Field label="Display name" name="source-display-name" value={displayName} onChange={setDisplayName} required error={fieldErrors.displayName} />
        <div className="field"><label htmlFor="data-source-type">Source type</label><select id="data-source-type" data-testid="select-data-source-type" value={type} onChange={event => { setType(event.target.value as DataSourceType); setFieldErrors({}); setClearCredential(false); }} aria-describedby="source-type-hint">{DATA_SOURCE_TYPES.map(value => <option value={value} key={value}>{sourceLabels[value]}</option>)}</select><span className="field-hint" id="source-type-hint">Changing type replaces the configuration metadata on save.</span></div>
        <div className="field"><label className="field-label">Record state</label><label className="check-row"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} data-testid="checkbox-source-enabled" /><span><strong>Enabled</strong><br /><span className="field-hint">Metadata only; no connector is started.</span></span></label></div>
        <div className="field span-2"><label htmlFor="source-description">Description</label><textarea id="source-description" data-testid="input-source-description" value={description} onChange={event => setDescription(event.target.value)} placeholder="Purpose, ownership, or operational context" /></div>
      </div>
      <div className="form-section"><h2>Type-specific configuration</h2><p>Only configuration fields supported by the selected source type are shown.</p></div>
      {type === "rest_api" && <div className="form-grid">
        <div className="field span-2">
          <label htmlFor="rest-base-url">REST base URL *</label>
          <input id="rest-base-url" data-testid="input-rest-base-url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://host.example/api" aria-invalid={Boolean(fieldErrors.baseUrl)} aria-describedby={fieldErrors.baseUrl ? "rest-base-url-error" : undefined} />
          {fieldErrors.baseUrl && <span className="field-error" id="rest-base-url-error" data-testid="error-source-base-url">{fieldErrors.baseUrl}</span>}
          <span className="field-hint">Registration and editing do not make a request. A request occurs only when an operator starts a sync.</span>
        </div>
        <div className="field span-2">
          <label htmlFor="rest-endpoint-path">Endpoint path *</label>
          <input id="rest-endpoint-path" data-testid="input-rest-endpoint-path" value={endpointPath} onChange={event => setEndpointPath(event.target.value)} placeholder="v1/events" aria-invalid={Boolean(fieldErrors.endpointPath)} />
          {fieldErrors.endpointPath && <span className="field-error">{fieldErrors.endpointPath}</span>}
          <span className="field-hint">Relative to the base URL. Only GET is supported.</span>
        </div>
        <div className="field">
          <label htmlFor="rest-auth-mode">Authentication</label>
          <select id="rest-auth-mode" data-testid="select-rest-auth-mode" value={authMode} onChange={event => setAuthMode(event.target.value as RestApiAuthMode)} aria-invalid={Boolean(fieldErrors.authMode)}>
            <option value="none">None</option><option value="bearer">Bearer token</option>
          </select>
          {fieldErrors.authMode && <span className="field-error">{fieldErrors.authMode}</span>}
          <span className="field-hint">Bearer tokens are sent only over HTTPS.</span>
        </div>
        <div className="field">
          <label htmlFor="credential-reference">Bearer token environment reference</label>
          <input id="credential-reference" data-testid="input-credential-reference" value={credentialRef} onChange={event => { setCredentialRef(event.target.value); setClearCredential(false); }} placeholder={editing && credentialConfigured ? "Existing reference is configured" : "env:KUDU_SOURCE_ERP_TOKEN"} autoComplete="off" aria-invalid={Boolean(fieldErrors.credentialRef)} />
          {fieldErrors.credentialRef && <span className="field-error" data-testid="error-source-credential-ref">{fieldErrors.credentialRef}</span>}
          <span className="field-hint">{editing ? "The reference is redacted. Leave blank to preserve it; entered text replaces it." : "Reference only. Provision the environment variable separately; never enter its secret value here."}</span>
          {editing && credentialConfigured && <label className="check-row"><input type="checkbox" checked={clearCredential} onChange={event => { setClearCredential(event.target.checked); if (event.target.checked) setCredentialRef(""); }} data-testid="checkbox-clear-credential-reference" /><span>Clear existing credential reference on save</span></label>}
        </div>
        <div className="field">
          <label htmlFor="rest-timeout">Timeout (ms)</label>
          <input id="rest-timeout" type="number" min="500" max="30000" step="1" value={timeoutMs} onChange={event => setTimeoutMs(event.target.value)} aria-invalid={Boolean(fieldErrors.timeoutMs)} />
          {fieldErrors.timeoutMs && <span className="field-error">{fieldErrors.timeoutMs}</span>}
        </div>
        <div className="field">
          <label htmlFor="rest-max-response">Maximum response bytes</label>
          <input id="rest-max-response" type="number" min="1024" max="5242880" step="1024" value={maxResponseBytes} onChange={event => setMaxResponseBytes(event.target.value)} aria-invalid={Boolean(fieldErrors.maxResponseBytes)} />
          {fieldErrors.maxResponseBytes && <span className="field-error">{fieldErrors.maxResponseBytes}</span>}
        </div>
        <div className="field">
          <label htmlFor="rest-max-records">Maximum records</label>
          <input id="rest-max-records" type="number" min="1" max="1000" step="1" value={maxRecords} onChange={event => setMaxRecords(event.target.value)} aria-invalid={Boolean(fieldErrors.maxRecords)} />
          {fieldErrors.maxRecords && <span className="field-error">{fieldErrors.maxRecords}</span>}
        </div>
        <div className="field">
          <label htmlFor="rest-records-path">JSON records path</label>
          <input id="rest-records-path" data-testid="input-rest-records-path" value={recordsPath} onChange={event => setRecordsPath(event.target.value)} placeholder="data.events" aria-invalid={Boolean(fieldErrors.recordsPath)} />
          {fieldErrors.recordsPath && <span className="field-error">{fieldErrors.recordsPath}</span>}
          <span className="field-hint">Dot path to the array; leave blank when the response is an array.</span>
        </div>
        <div className="field"><span className="field-label">Response format</span><span className="field-hint">JSON only</span></div>
      </div>}
      {(type === "json_file" || type === "csv_file") && <div className="field"><label htmlFor="source-relative-path">Relative file path *</label><input id="source-relative-path" data-testid="input-source-relative-path" value={relativePath} onChange={event => setRelativePath(event.target.value)} placeholder="data/measurements.csv" aria-invalid={Boolean(fieldErrors.relativePath)} aria-describedby={fieldErrors.relativePath ? "source-relative-path-error" : undefined} />{fieldErrors.relativePath && <span className="field-error" id="source-relative-path-error" data-testid="error-source-relative-path">{fieldErrors.relativePath}</span>}<span className="field-hint">Relative to the configured local data root; no file is read by this workflow.</span></div>}
      {type === "manual" && <div className="notice" data-testid="notice-manual-source">Manual source is a reference record. No external connection or ingestion is available.</div>}
      <div className="form-actions"><Link className="button button-quiet" href={editing ? `/data-sources/${encodeURIComponent(id)}` : "/data-sources"} data-testid="button-cancel-data-source">Cancel</Link><div className="form-actions-end"><button className="button button-primary" type="submit" disabled={busy} data-testid="button-submit-data-source">{busy ? "Saving…" : editing ? "Save changes" : "Create data source"}</button></div></div>
    </form></section>
  </main>;
}

export { DataSourceListPage, DataSourceDetailPage, DataSourceFormPage };
