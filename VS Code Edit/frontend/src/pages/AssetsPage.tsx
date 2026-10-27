import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useParams } from "wouter";
import { ASSET_TYPES, type AssetCreateInput, type AssetDetail, type AssetRecord, type AssetStatus, type AssetType, type Page } from "@kudu/shared";
import { ApiError, createAsset, getAsset, listAssets, updateAsset } from "../api";
import { displayError, EmptyState, ErrorState, Field, formatDate, ListPagination, LoadingState, PageIntro } from "../components/RegistryUI";

const PAGE_SIZE = 15;
const PARENT_PAGE_SIZE = 25;
const assetLabels: Record<AssetType, string> = {
  machine: "Machine", production_line: "Production line", plc: "PLC", camera: "Camera", sensor: "Sensor", other: "Other",
};

function mapAssetErrors(fields: Record<string, string>): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [rawKey, message] of Object.entries(fields)) {
    const key = rawKey.replace(/\[(\d+)\]/g, ".$1");
    const indexed = /^externalIdentifiers\.(\d+)(?:\.(sourceKey|externalId))?$/.exec(key);
    if (indexed) {
      const suffix = indexed[2] ? `.${indexed[2]}` : "";
      mapped[`identifier.${indexed[1]}${suffix}`] = message;
    } else mapped[key] = message;
  }
  return mapped;
}

function AssetListPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"active" | "archived" | "all">("active");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<AssetRecord> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true); setError(""); setResult(null);
    try {
      const data = await listAssets({ search, page, pageSize: PAGE_SIZE, status });
      if (current === requestId.current) setResult(data);
    } catch (cause) {
      if (current === requestId.current) setError(displayError(cause));
    } finally { if (current === requestId.current) setLoading(false); }
  }, [search, page, status]);
  useEffect(() => { void load(); }, [load]);
  const maxPage = Math.max(1, Math.ceil((result?.total ?? 0) / (result?.pageSize ?? PAGE_SIZE)));
  return <main className="page-main">
    <PageIntro eyebrow="REGISTRY / 01" title="Assets" description="Stable records for the equipment, systems, and hierarchy of your operation." action={<Link className="button button-primary" href="/assets/new" data-testid="button-create-asset"><span aria-hidden="true">＋</span> Register asset</Link>} />
    <div className="toolbar">
      <div className="field field-search"><label htmlFor="asset-search">Search registry</label><input id="asset-search" data-testid="input-asset-search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Search key or name…" /></div>
      <div className="field field-filter"><label htmlFor="asset-status">Record status</label><select id="asset-status" data-testid="filter-asset-status" value={status} onChange={event => { setStatus(event.target.value as typeof status); setPage(1); }}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All records</option></select></div>
    </div>
    {error && <div className="notice error" role="alert" data-testid="error-assets"><strong>Could not load assets.</strong> {error} <button type="button" className="button button-quiet" onClick={() => void load()} data-testid="button-retry-assets">Retry</button></div>}
    {loading ? <LoadingState label="Loading asset records…" /> : error ? null : result?.items.length ? <>
      <div className="table-frame"><table>
        <thead><tr><th>ASSET KEY</th><th>NAME</th><th>TYPE</th><th>PARENT</th><th>STATUS</th></tr></thead>
        <tbody>{result.items.map(asset => <tr key={asset.id} data-testid={`row-asset-${asset.id}`}>
          <td><Link className="record-link mono" href={`/assets/${encodeURIComponent(asset.id)}`} data-testid={`link-asset-${asset.id}`}>{asset.assetKey}</Link></td>
          <td><Link className="record-link" href={`/assets/${encodeURIComponent(asset.id)}`} data-testid={`link-asset-name-${asset.id}`}>{asset.name}</Link></td>
          <td>{assetLabels[asset.assetType]}</td>
          <td>{asset.parentAsset ? <span><span className="mono">{asset.parentAsset.assetKey}</span><br />{asset.parentAsset.name}</span> : <span className="muted">—</span>}</td>
          <td><span className={`status-pill ${asset.status === "active" ? "good" : "warn"}`}>{asset.status === "active" ? "ACTIVE" : "ARCHIVED"}</span></td>
        </tr>)}</tbody>
      </table></div>
      <ListPagination page={page} maxPage={maxPage} total={result.total} onChange={setPage} testId="assets" />
    </> : <EmptyState title={search ? "No matching assets" : "No assets in this view"} description={search ? "Try a different key, name, or type. Search is applied on the server." : status === "active" ? "Register the first asset to begin building the operational hierarchy." : "There are no records matching this status filter."} action={!search && status !== "archived" ? <Link className="button button-primary" href="/assets/new" data-testid="button-empty-create-asset">Register an asset</Link> : undefined} />}
  </main>;
}

function AssetDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [record, setRecord] = useState<AssetDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setRecord(await getAsset(id)); } catch (cause) { setError(displayError(cause)); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  async function toggleArchived() {
    if (!record) return;
    setSaving(true); setNotice("");
    try {
      const updated = await updateAsset(id, { archived: record.status !== "archived" });
      setRecord(updated); setNotice(updated.status === "archived" ? "Asset archived successfully." : "Asset restored successfully.");
    } catch (cause) { setNotice(`Update failed: ${displayError(cause)}`); }
    finally { setSaving(false); }
  }
  if (loading) return <main className="page-main"><LoadingState label="Loading the actual asset record…" /></main>;
  if (error || !record) return <main className="page-main"><ErrorState title="Asset unavailable" message={error || "The requested asset was not returned by the API."} retry={() => void load()} back="/assets" /></main>;
  return <main className="page-main">
    <div className="detail-heading">
      <Link href="/assets" className="back-link" data-testid="link-back-assets">← All assets</Link>
      <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />ASSET RECORD</div><h1>{record.name}</h1><span className="detail-key" data-testid="text-asset-key">{record.assetKey}</span></div>
        <div className="detail-actions"><Link className="button" href={`/assets/${encodeURIComponent(id)}/edit`} data-testid="button-edit-asset">Edit record</Link><button className={`button ${record.status === "archived" ? "button-primary" : "button-danger"}`} type="button" disabled={saving} onClick={() => void toggleArchived()} data-testid="button-toggle-asset-status">{saving ? "Saving…" : record.status === "archived" ? "Restore asset" : "Archive asset"}</button></div>
      </div>
    </div>
    {notice && <div className={`notice ${notice.startsWith("Update failed") ? "error" : ""}`} role="status" data-testid="status-asset-mutation">{notice}</div>}
    <div className="detail-grid">
      <section className="panel"><h2 className="panel-title">Record details</h2><dl className="definition-list">
        <dt>Status</dt><dd><span className={`status-pill ${record.status === "active" ? "good" : "warn"}`}>{record.status.toUpperCase()}</span></dd>
        <dt>Asset type</dt><dd>{assetLabels[record.assetType]}</dd>
        <dt>Description</dt><dd>{record.description || <span className="muted">No description recorded</span>}</dd>
        <dt>Parent asset</dt><dd>{record.parentAsset ? <Link className="record-link" href={`/assets/${encodeURIComponent(record.parentAsset.id)}`} data-testid="link-parent-asset">{record.parentAsset.assetKey} · {record.parentAsset.name}</Link> : <span className="muted">Root record</span>}</dd>
        <dt>External identifiers</dt><dd>{record.externalIdentifiers.length ? <div className="stack">{record.externalIdentifiers.map((item, index) => <span className="mono" key={`${item.sourceKey}-${index}`} data-testid={`identifier-${index}`}>{item.sourceKey} / {item.externalId}</span>)}</div> : <span className="muted">None recorded</span>}</dd>
        <dt>Created</dt><dd className="time-label">{formatDate(record.createdAt)}</dd><dt>Last updated</dt><dd className="time-label">{formatDate(record.updatedAt)}</dd>
        {record.archivedAt && <><dt>Archived</dt><dd className="time-label">{formatDate(record.archivedAt)}</dd></>}
      </dl></section>
      <div className="stack">
        <section className="panel"><h2 className="panel-title">Child assets <span className="muted">· {record.children.length}</span></h2>
          {record.children.length ? <div className="stack-list">{record.children.map(child => <div className="stack-item" key={child.id} data-testid={`child-asset-${child.id}`}><Link className="record-link" href={`/assets/${encodeURIComponent(child.id)}`} data-testid={`link-child-asset-${child.id}`}>{child.name}</Link><span className="mono">{child.assetKey} · {assetLabels[child.assetType]}</span></div>)}</div> : <div className="stack-list"><p className="muted" data-testid="text-no-children">No child assets are linked to this record.</p></div>}
        </section>
        <section className="panel"><h2 className="panel-title">Provenance</h2><dl className="definition-list"><dt>Record ID</dt><dd className="mono">{record.id}</dd><dt>Updated at</dt><dd className="time-label">{formatDate(record.updatedAt)}</dd></dl></section>
      </div>
    </div>
  </main>;
}

type IdentifierDraft = { sourceKey: string; externalId: string };
type ParentReference = { id: string; assetKey: string; name: string; status?: AssetStatus };

function AssetParentPicker({ assetId, value, onChange, currentParent }: {
  assetId: string; value: string; onChange: (id: string) => void; currentParent: ParentReference | null;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<AssetRecord> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const requestCounter = useRef(0);
  const load = useCallback(async () => {
    const request = ++requestCounter.current;
    setLoading(true); setError(""); setResult(null);
    try {
      const pageResult = await listAssets({ search, page, pageSize: PARENT_PAGE_SIZE, status: "active" });
      if (request === requestCounter.current) setResult(pageResult);
    } catch (cause) {
      if (request === requestCounter.current) setError(displayError(cause));
    } finally { if (request === requestCounter.current) setLoading(false); }
  }, [search, page, reloadToken]);
  useEffect(() => { void load(); }, [load]);
  const options = (result?.items ?? []).filter(asset => asset.id !== assetId);
  const keepCurrent = currentParent && value === currentParent.id && !options.some(item => item.id === currentParent.id);
  const maxPage = Math.max(1, Math.ceil((result?.total ?? 0) / PARENT_PAGE_SIZE));
  return <div className="parent-picker" data-testid="asset-parent-picker">
    <div className="field"><label htmlFor="asset-parent-search">Find an active parent</label>
      <input id="asset-parent-search" data-testid="input-asset-parent-search" value={search} onChange={event => { requestCounter.current += 1; setSearch(event.target.value); setPage(1); setReloadToken(v => v + 1); }} placeholder="Search active assets by key or name…" />
      <span className="field-hint">Search runs against the full active asset registry. Archived records are excluded.</span>
    </div>
    <div className="field"><label htmlFor="asset-parent">Parent asset</label>
      <select id="asset-parent" data-testid="select-asset-parent" value={value} onChange={event => onChange(event.target.value)}>
        <option value="">No parent (root)</option>
        {keepCurrent && currentParent && <option value={currentParent.id}>{currentParent.assetKey} — {currentParent.name}{currentParent.status === "archived" ? " (existing archived parent; retained)" : " (current parent)"}</option>}
        {options.map(asset => <option value={asset.id} key={asset.id}>{asset.assetKey} — {asset.name}</option>)}
      </select>
    </div>
    {loading && <span className="field-hint" role="status" data-testid="status-parent-search">Searching active assets…</span>}
    {error && <div className="field-error" role="alert" data-testid="error-parent-search">Could not search parent assets: {error} <button type="button" className="button" onClick={() => { requestCounter.current += 1; setReloadToken(value => value + 1); }} data-testid="button-retry-parent-search">Retry search</button></div>}
    {!loading && !error && result && <div className="parent-picker-footer">
      <span className="field-hint">{result.total} active result{result.total === 1 ? "" : "s"}{search ? ` for “${search}”` : ""}</span>
      <div className="pagination"><button type="button" className="button" disabled={page <= 1} onClick={() => { requestCounter.current += 1; setPage(page - 1); }} data-testid="button-parent-previous">Previous</button><span>{page} / {maxPage}</span><button type="button" className="button" disabled={page >= maxPage} onClick={() => { requestCounter.current += 1; setPage(page + 1); }} data-testid="button-parent-next">Next</button></div>
    </div>}
  </div>;
}

function AssetFormPage({ editing }: { editing: boolean }) {
  const { id = "" } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const [initialLoading, setInitialLoading] = useState(editing);
  const [loadError, setLoadError] = useState("");
  const [key, setKey] = useState(""); const [name, setName] = useState("");
  const [type, setType] = useState<AssetType>("machine"); const [description, setDescription] = useState("");
  const [parent, setParent] = useState(""); const [currentParent, setCurrentParent] = useState<ParentReference | null>(null);
  const [identifiers, setIdentifiers] = useState<IdentifierDraft[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [validation, setValidation] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    if (!editing) { setInitialLoading(false); return; }
    let active = true;
    setInitialLoading(true); setLoadError("");
    void getAsset(id).then(record => {
      if (!active) return;
      setKey(record.assetKey); setName(record.name); setType(record.assetType); setDescription(record.description ?? "");
      setParent(record.parentAssetId ?? ""); setIdentifiers(record.externalIdentifiers.map(item => ({ ...item })));
      if (record.parentAsset) {
        setCurrentParent({ ...record.parentAsset });
        void getAsset(record.parentAsset.id).then(parentRecord => {
          if (active) setCurrentParent({ id: parentRecord.id, assetKey: parentRecord.assetKey, name: parentRecord.name, status: parentRecord.status });
        }).catch(() => {
          // The API's parent summary still preserves the existing relationship.
        });
      } else setCurrentParent(null);
    }).catch(cause => { if (active) setLoadError(displayError(cause)); }).finally(() => { if (active) setInitialLoading(false); });
    return () => { active = false; };
  }, [editing, id, loadAttempt]);
  function validate() {
    const errors: Record<string, string> = {};
    if (!key.trim()) errors.assetKey = "Asset key is required.";
    if (!name.trim()) errors.name = "Name is required.";
    identifiers.forEach((item, index) => {
      if (Boolean(item.sourceKey.trim()) !== Boolean(item.externalId.trim())) errors[`identifier.${index}`] = "Enter both identifier fields, or remove the row.";
    });
    setFieldErrors(errors); setValidation(Object.keys(errors).length ? "Review the fields marked below." : "");
    return Object.keys(errors).length === 0;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setValidation("");
    if (!validate()) return;
    const input: AssetCreateInput = {
      assetKey: key.trim(), name: name.trim(), assetType: type, description: description.trim() || null,
      parentAssetId: parent || null,
      externalIdentifiers: identifiers.filter(item => item.sourceKey.trim() && item.externalId.trim()).map(item => ({ sourceKey: item.sourceKey.trim(), externalId: item.externalId.trim() })),
    };
    setBusy(true);
    try {
      const saved = editing ? await updateAsset(id, input) : await createAsset(input);
      navigate(`/assets/${encodeURIComponent(saved.id)}`);
    } catch (cause) {
      setError(displayError(cause));
      setFieldErrors(cause instanceof ApiError ? mapAssetErrors(cause.fields ?? {}) : {});
    } finally { setBusy(false); }
  }
  if (initialLoading) return <main className="page-main"><LoadingState label="Loading asset values for editing…" /></main>;
  if (loadError) return <main className="page-main"><ErrorState title="Could not open asset" message={loadError} retry={() => setLoadAttempt(value => value + 1)} back="/assets" /></main>;
  return <main className="page-main">
    <div className="detail-heading"><Link href={editing ? `/assets/${encodeURIComponent(id)}` : "/assets"} className="back-link" data-testid="link-cancel-asset">← {editing ? "Asset record" : "All assets"}</Link>
      <PageIntro eyebrow={editing ? "REGISTRY / ASSET / EDIT" : "REGISTRY / ASSET / NEW"} title={editing ? "Edit asset" : "Register asset"} description="Keep identifiers stable and relationships explicit. Changes are shown only after the registry accepts them." />
    </div>
    <section className="form-layout">
      {error && <div className="notice error" role="alert" data-testid="error-asset-submit">{error}</div>}
      {validation && <div className="notice error" role="status" data-testid="validation-asset">{validation}</div>}
      <form className="form-panel" onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Asset key" name="asset-key" value={key} onChange={setKey} required hint="A stable registry key, unique within this registry." error={fieldErrors.assetKey} />
          <Field label="Name" name="asset-name" value={name} onChange={setName} required error={fieldErrors.name} />
          <div className="field"><label htmlFor="asset-type">Type</label><select id="asset-type" data-testid="select-asset-type" value={type} onChange={event => setType(event.target.value as AssetType)}>{ASSET_TYPES.map(value => <option value={value} key={value}>{assetLabels[value]}</option>)}</select></div>
          <AssetParentPicker assetId={id} value={parent} onChange={setParent} currentParent={currentParent} />
          <div className="field span-2"><label htmlFor="asset-description">Description</label><textarea id="asset-description" data-testid="input-asset-description" value={description} onChange={event => setDescription(event.target.value)} placeholder="Operational context for this record" /></div>
        </div>
        <div className="form-section"><h2>External identifiers</h2><p>Pairs preserve the source system and its identifier; leave both fields empty or remove the row.</p></div>
        {identifiers.map((item, index) => {
          const rowError = fieldErrors[`identifier.${index}`];
          const sourceError = fieldErrors[`identifier.${index}.sourceKey`];
          const valueError = fieldErrors[`identifier.${index}.externalId`];
          return <div className="identifier-row" key={index} data-testid={`asset-identifier-row-${index}`}>
            <div className="field"><label htmlFor={`identifier-source-${index}`}>Source key</label><input id={`identifier-source-${index}`} data-testid={`input-identifier-source-${index}`} value={item.sourceKey} onChange={event => setIdentifiers(current => current.map((row, i) => i === index ? { ...row, sourceKey: event.target.value } : row))} aria-invalid={Boolean(sourceError || rowError)} />{sourceError && <span className="field-error">{sourceError}</span>}</div>
            <div className="field"><label htmlFor={`identifier-value-${index}`}>External identifier</label><input id={`identifier-value-${index}`} data-testid={`input-identifier-value-${index}`} value={item.externalId} onChange={event => setIdentifiers(current => current.map((row, i) => i === index ? { ...row, externalId: event.target.value } : row))} aria-invalid={Boolean(valueError || rowError)} />{valueError && <span className="field-error">{valueError}</span>}{rowError && <span className="field-error" data-testid={`error-identifier-row-${index}`}>{rowError}</span>}</div>
            <button className="button" type="button" onClick={() => setIdentifiers(current => current.filter((_, i) => i !== index))} aria-label={`Remove external identifier ${index + 1}`} data-testid={`button-remove-identifier-${index}`}>Remove</button>
          </div>;
        })}
        <button className="button" type="button" onClick={() => setIdentifiers(current => [...current, { sourceKey: "", externalId: "" }])} data-testid="button-add-identifier">＋ Add identifier pair</button>
        <div className="form-actions"><Link className="button button-quiet" href={editing ? `/assets/${encodeURIComponent(id)}` : "/assets"} data-testid="button-cancel-asset">Cancel</Link><div className="form-actions-end"><button className="button button-primary" type="submit" disabled={busy} data-testid="button-submit-asset">{busy ? "Saving…" : editing ? "Save changes" : "Create asset"}</button></div></div>
      </form>
    </section>
  </main>;
}

export { AssetListPage, AssetDetailPage, AssetFormPage };
