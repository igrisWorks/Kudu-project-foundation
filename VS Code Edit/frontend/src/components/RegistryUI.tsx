import type { ReactNode } from "react";
import { Link } from "wouter";
import type { DataSourceRecord } from "@kudu/shared";
import { ApiError } from "../api";

export function formatDate(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit",
    minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
  }).format(date);
}

export function displayError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "The request could not be completed.";
}

export function PageIntro({ eyebrow, title, description, action }: {
  eyebrow: string; title: string; description: string; action?: ReactNode;
}) {
  return <div className="page-heading"><div>
    <div className="eyebrow"><span className="eyebrow-line" />{eyebrow}</div>
    <h1>{title}</h1><p>{description}</p>
  </div>{action}</div>;
}

export function StatusBadge({ state }: { state: "checking" | "unknown" | "online" | "offline" }) {
  const label = { checking: "CHECKING", unknown: "UNKNOWN", online: "OPERATIONAL", offline: "UNAVAILABLE" }[state];
  return <span className={`status-badge status-${state}`}><span className="status-dot" />{label}</span>;
}

export function ConnectorBadge({ status }: { status: DataSourceRecord["connectionStatus"] }) {
  const labels: Record<DataSourceRecord["connectionStatus"], string> = {
    not_implemented: "NOT IMPLEMENTED", connected: "CONNECTED", error: "ERROR", unsupported: "UNSUPPORTED",
  };
  const className = status === "connected" ? "good" : status === "error" ? "bad" : status === "not_implemented" ? "warn" : "";
  return <span className={`status-pill ${className}`} data-testid={`status-connector-${status}`}>{labels[status]}</span>;
}

export function ListPagination({ page, maxPage, total, onChange, testId }: {
  page: number; maxPage: number; total: number; onChange: (page: number) => void; testId: string;
}) {
  return <div className="list-meta" data-testid={`pagination-${testId}`}>
    <span>{total} RECORD{total === 1 ? "" : "S"} · PAGE {page} OF {maxPage}</span>
    <div className="pagination">
      <button type="button" className="button" disabled={page <= 1} onClick={() => onChange(page - 1)} data-testid={`button-${testId}-previous`}>Previous</button>
      <span>{page} / {maxPage}</span>
      <button type="button" className="button" disabled={page >= maxPage} onClick={() => onChange(page + 1)} data-testid={`button-${testId}-next`}>Next</button>
    </div>
  </div>;
}

export function LoadingState({ label }: { label: string }) {
  return <div className="loading-state" role="status" aria-live="polite" data-testid="loading-state">
    <div className="skeleton-line" /><h2>Loading registry</h2><p>{label}</p>
  </div>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state" data-testid="empty-state"><div className="empty-mark" aria-hidden="true">∅</div><h2>{title}</h2><p>{description}</p>{action}</div>;
}

export function ErrorState({ title, message, retry, back }: {
  title: string; message: string; retry: () => void; back: string;
}) {
  return <div className="error-state" role="alert" data-testid="error-state">
    <div className="empty-mark" aria-hidden="true">!</div><h2>{title}</h2><p>{message}</p>
    <div className="detail-actions"><button className="button" type="button" onClick={retry} data-testid="button-retry-detail">Retry</button><Link className="button" href={back} data-testid="link-return-list">Return to list</Link></div>
  </div>;
}

export function Field({ label, name, value, onChange, required, hint, error }: {
  label: string; name: string; value: string; onChange: (value: string) => void;
  required?: boolean; hint?: string; error?: string;
}) {
  return <div className="field">
    <label htmlFor={name}>{label}{required ? " *" : ""}</label>
    <input id={name} data-testid={`input-${name}`} value={value} required={required} onChange={event => onChange(event.target.value)}
      aria-invalid={Boolean(error)} aria-describedby={error ? `${name}-error` : hint ? `${name}-hint` : undefined} />
    {hint && <span className="field-hint" id={`${name}-hint`}>{hint}</span>}
    {error && <span className="field-error" id={`${name}-error`}>{error}</span>}
  </div>;
}
