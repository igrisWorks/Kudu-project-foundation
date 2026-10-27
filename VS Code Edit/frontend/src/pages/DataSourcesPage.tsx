import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useParams } from "wouter";
import { DATA_SOURCE_TYPES, type DataSourceConfigurationInput, type DataSourceRecord, type DataSourceType, type FileImportResult, type Page } from "@kudu/shared";
import { ApiError, createDataSource, getDataSource, importDataSourceFile, listDataSources, updateDataSource } from "../api";
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
    <div className="notice" data-testid="notice-connector-status"><strong>Connector status: not implemented.</strong> Enabling a record is metadata only; it does not start a connection or ingestion.</div>
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
          <td><ConnectorBadge status={source.connectionStatus} /></td><td className="time-label">{formatDate(source.lastSuccessfulSyncAt)}</td>
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
  if (loading) return <main className="page-main"><LoadingState label="Loading the actual data source record…" /></main>;
  if (error || !record) return <main className="page-main"><ErrorState title="Data source unavailable" message={error || "The requested source was not returned by the API."} retry={() => void load()} back="/data-sources" /></main>;
  const cfg = record.configuration;
  const fileFormat = record.sourceType === "csv_file" ? "CSV" : record.sourceType === "json_file" ? "JSON" : null;
  return <main className="page-main">
    <div className="detail-heading"><Link href="/data-sources" className="back-link" data-testid="link-back-data-sources">← All data sources</Link>
      <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />DATA SOURCE RECORD</div><h1>{record.displayName}</h1><span className="detail-key" data-testid="text-data-source-key">{record.sourceKey}</span></div>
        <div className="detail-actions">
          {fileFormat && record.enabled && <button className="button button-primary" type="button" onClick={() => void runFileImport()} disabled={importing} data-testid="button-import-source-file">{importing ? "Importing…" : `Import configured ${fileFormat} file`}</button>}
          <Link className="button" href={`/data-sources/${encodeURIComponent(id)}/edit`} data-testid="button-edit-data-source">Edit record</Link>
        </div>
      </div>
    </div>
    <div className="notice" data-testid="notice-source-import">
      {fileFormat
        ? <><strong>{fileFormat} file import is available.</strong> Imports read the registered relative file from the configured local import directory. {record.enabled ? "Imports run only when requested and are not scheduled." : "Enable this source before importing. No import is started while disabled."}</>
        : <><strong>File import is not supported for this source type.</strong> Only enabled CSV and JSON file sources can be imported. REST API and manual sources do not connect or start outbound traffic.</>}
    </div>
    {importError && <div className="notice error" role="alert" data-testid="error-file-import"><strong>Import failed.</strong> {importError}</div>}
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
          {cfg.kind === "rest_api" && <><dt>Base URL</dt><dd className="mono" data-testid="text-source-base-url">{cfg.baseUrl}</dd><dt>Credential reference</dt><dd>{cfg.credentialConfigured ? "Configured; secret/reference value is not returned by the API." : "No credential reference recorded."}</dd></>}
          {(cfg.kind === "json_file" || cfg.kind === "csv_file") && <><dt>Relative path</dt><dd className="mono" data-testid="text-source-path">{cfg.relativePath}</dd></>}
          {cfg.kind === "manual" && <><dt>Reference</dt><dd>{cfg.referenceOnly ? "Manual reference only" : "Not available"}</dd></>}
        </dl></section>
        {fileFormat
          ? <section className="panel" data-testid="panel-import-status"><h2 className="panel-title">File import status</h2><dl className="definition-list">
            <dt>Supported format</dt><dd>{fileFormat}</dd>
            <dt>Availability</dt><dd>{record.enabled ? "Available for on-demand import" : "Disabled in registry"}</dd>
            <dt>Run history</dt><dd>Not stored; each result is returned after its import request.</dd>
          </dl></section>
          : <section className="panel"><h2 className="panel-title">Connector and ingestion status</h2><dl className="definition-list">
            <dt>Connection</dt><dd><ConnectorBadge status={record.connectionStatus} /></dd><dt>Ingestion</dt><dd><ConnectorBadge status={record.ingestionStatus} /></dd>
            <dt>Last successful sync</dt><dd className="time-label" data-testid="text-last-sync">{formatDate(record.lastSuccessfulSyncAt)}</dd>
            <dt>Last error</dt><dd>{record.lastErrorSummary || <span className="muted">No error reported</span>}</dd>
          </dl></section>}
      </div>
    </div>
  </main>;
}

function DataSourceFormPage({ editing }: { editing: boolean }) {
  const { id = "" } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const [initialLoading, setInitialLoading] = useState(editing);
  const [loadError, setLoadError] = useState("");
  const [sourceKey, setSourceKey] = useState(""); const [displayName, setDisplayName] = useState("");
  const [type, setType] = useState<DataSourceType>("rest_api"); const [description, setDescription] = useState("");
  const [baseUrl, setBaseUrl] = useState(""); const [relativePath, setRelativePath] = useState("");
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
      if (record.configuration.kind === "rest_api") { setBaseUrl(record.configuration.baseUrl); setCredentialConfigured(record.configuration.credentialConfigured); }
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
      configuration = { kind: "rest_api", baseUrl: baseUrl.trim(), ...credential };
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
    <div className="notice"><strong>Connector status: not implemented.</strong> Enabled only records intended state; it does not initiate outbound traffic.</div>
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
        <div className="field span-2"><label htmlFor="rest-base-url">REST base URL *</label><input id="rest-base-url" data-testid="input-rest-base-url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://host.example/api" aria-invalid={Boolean(fieldErrors.baseUrl)} aria-describedby={fieldErrors.baseUrl ? "rest-base-url-error" : undefined} />{fieldErrors.baseUrl && <span className="field-error" id="rest-base-url-error" data-testid="error-source-base-url">{fieldErrors.baseUrl}</span>}<span className="field-hint">Stored as metadata only. Kudu will not make a request to this URL.</span></div>
        <div className="field span-2"><label htmlFor="credential-reference">Credential environment-variable reference</label><input id="credential-reference" data-testid="input-credential-reference" value={credentialRef} onChange={event => { setCredentialRef(event.target.value); setClearCredential(false); }} placeholder={editing && credentialConfigured ? "Existing reference is configured" : "Optional environment-variable name"} autoComplete="off" aria-invalid={Boolean(fieldErrors.credentialRef)} aria-describedby={fieldErrors.credentialRef ? "credential-reference-error" : undefined} /><span className="field-hint">{editing ? "The API redacts this value. Leave blank to preserve the existing reference; entered text replaces it." : "Optional name/reference only. Do not enter a secret value."}</span>{fieldErrors.credentialRef && <span className="field-error" id="credential-reference-error" data-testid="error-source-credential-ref">{fieldErrors.credentialRef}</span>}
          {editing && credentialConfigured && <label className="check-row"><input type="checkbox" checked={clearCredential} onChange={event => { setClearCredential(event.target.checked); if (event.target.checked) setCredentialRef(""); }} data-testid="checkbox-clear-credential-reference" /><span>Clear existing credential reference on save</span></label>}
        </div>
      </div>}
      {(type === "json_file" || type === "csv_file") && <div className="field"><label htmlFor="source-relative-path">Relative file path *</label><input id="source-relative-path" data-testid="input-source-relative-path" value={relativePath} onChange={event => setRelativePath(event.target.value)} placeholder="data/measurements.csv" aria-invalid={Boolean(fieldErrors.relativePath)} aria-describedby={fieldErrors.relativePath ? "source-relative-path-error" : undefined} />{fieldErrors.relativePath && <span className="field-error" id="source-relative-path-error" data-testid="error-source-relative-path">{fieldErrors.relativePath}</span>}<span className="field-hint">Relative to the configured local data root; no file is read by this workflow.</span></div>}
      {type === "manual" && <div className="notice" data-testid="notice-manual-source">Manual source is a reference record. No external connection or ingestion is available.</div>}
      <div className="form-actions"><Link className="button button-quiet" href={editing ? `/data-sources/${encodeURIComponent(id)}` : "/data-sources"} data-testid="button-cancel-data-source">Cancel</Link><div className="form-actions-end"><button className="button button-primary" type="submit" disabled={busy} data-testid="button-submit-data-source">{busy ? "Saving…" : editing ? "Save changes" : "Create data source"}</button></div></div>
    </form></section>
  </main>;
}

export { DataSourceListPage, DataSourceDetailPage, DataSourceFormPage };
