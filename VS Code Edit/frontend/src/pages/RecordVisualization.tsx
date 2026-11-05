import { useEffect, useMemo, useState } from "react";
import type { ExplorerRecordQuery, JsonObject } from "@kudu/shared";
import { downloadExplorerRecords } from "../api";

interface VisualRecord {
  rawRecord: JsonObject;
}

interface FieldOption {
  key: string;
  path: string[];
  label: string;
  values: unknown[];
}

function scalarFields(records: VisualRecord[]): FieldOption[] {
  const fields = new Map<string, FieldOption>();
  const visit = (value: unknown, path: string[], rowIndex: number) => {
    if (Array.isArray(value)) return;
    if (typeof value === "object" && value !== null) {
      for (const [key, nested] of Object.entries(value)) visit(nested, [...path, key], rowIndex);
      return;
    }
    const key = JSON.stringify(path);
    const field = fields.get(key) ?? { key, path, label: path.join("."), values: Array(records.length).fill(undefined) };
    field.values[rowIndex] = value;
    fields.set(key, field);
  };
  records.forEach((record, index) => visit(record.rawRecord, [], index));
  return [...fields.values()].filter(field => field.path.length > 0);
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).getUTCFullYear() <= 1) return null;
  return parsed;
}

function fieldValue(record: VisualRecord, path: string[]): unknown {
  let value: unknown = record.rawRecord;
  for (const part of path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function shortNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function shortDate(value: number): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function TimeSeriesChart({
  records,
  timeField,
  valueField,
}: {
  records: VisualRecord[];
  timeField: FieldOption;
  valueField: FieldOption;
}) {
  const points = records.flatMap(record => {
    const time = timestamp(fieldValue(record, timeField.path));
    const value = numeric(fieldValue(record, valueField.path));
    return time === null || value === null ? [] : [{ time, value }];
  }).sort((a, b) => a.time - b.time);
  const shown = points.length > 500
    ? Array.from({ length: 500 }, (_, index) => points[Math.round(index * (points.length - 1) / 499)]!)
    : points;
  if (shown.length < 2) {
    return <p className="dw-chart-empty">Not enough valid time/value pairs in these records. Choose fields with compatible values.</p>;
  }
  const width = 760;
  const height = 250;
  const left = 54;
  const right = 18;
  const top = 20;
  const bottom = 38;
  const values = shown.map(point => point.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueRange = maxValue === minValue ? Math.max(1, Math.abs(minValue) * 0.1) : maxValue - minValue;
  const minTime = shown[0]!.time;
  const maxTime = shown[shown.length - 1]!.time;
  const timeRange = Math.max(1, maxTime - minTime);
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const coordinates = shown.map(point => ({
    ...point,
    x: left + ((point.time - minTime) / timeRange) * plotWidth,
    y: top + ((maxValue + valueRange * 0.08 - point.value) / (valueRange * 1.16)) * plotHeight,
  }));
  return <div className="dw-chart-wrap">
    <svg className="dw-chart-svg" data-testid="source-time-chart" viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`${valueField.label} over ${timeField.label}; ${points.length} valid points`}>
      <line x1={left} y1={top} x2={left} y2={height - bottom} className="dw-chart-axis" />
      <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} className="dw-chart-axis" />
      <text x={left - 8} y={top + 5} textAnchor="end" className="dw-chart-tick">{shortNumber(maxValue)}</text>
      <text x={left - 8} y={height - bottom} textAnchor="end" className="dw-chart-tick">{shortNumber(minValue)}</text>
      <polyline points={coordinates.map(point => `${point.x},${point.y}`).join(" ")} className="dw-chart-line" />
      {coordinates.map((point, index) => <circle key={`${point.time}:${index}`}
        cx={point.x} cy={point.y} r="3" className="dw-chart-point">
        <title>{`${shortDate(point.time)} · ${shortNumber(point.value)}`}</title>
      </circle>)}
      <text x={left} y={height - 10} textAnchor="start" className="dw-chart-tick">{shortDate(minTime)}</text>
      <text x={width - right} y={height - 10} textAnchor="end" className="dw-chart-tick">{shortDate(maxTime)}</text>
    </svg>
    <p className="dw-chart-caption">
      {points.length} valid time/value pairs from {records.length} source records
      {points.length > shown.length ? ` · ${shown.length} points displayed` : ""}.
      Values that are missing or incompatible are excluded, not substituted.
    </p>
  </div>;
}

function CategoryChart({ field }: { field: FieldOption }) {
  const counts = new Map<string, number>();
  for (const value of field.values) {
    if (value === null || value === undefined || (typeof value === "string" && !value.trim())) continue;
    const label = String(value);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = ranked.slice(0, 10);
  const maximum = Math.max(1, ...shown.map(([, count]) => count));
  return shown.length === 0
    ? <p className="dw-chart-empty">No values are available for this field.</p>
    : <div className="dw-category-chart" data-testid="source-category-chart" role="img" aria-label={`Counts by ${field.label}`}>
      {shown.map(([label, count]) => <div className="dw-category-row" key={label} title={`${label}: ${count}`}>
        <span>{label.length > 54 ? `${label.slice(0, 51)}…` : label}</span>
        <div className="dw-category-track"><i style={{ width: `${(count / maximum) * 100}%` }} /></div>
        <strong>{count}</strong>
      </div>)}
      <p className="dw-chart-caption">
        {counts.size > shown.length ? `Top ${shown.length} of ${counts.size} values shown. ` : ""}
        {field.values.filter(value => value === null || value === undefined || value === "").length} empty or missing values excluded.
      </p>
    </div>;
}

export default function RecordVisualization({ query }: { query: ExplorerRecordQuery }) {
  const [records, setRecords] = useState<VisualRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [chartKind, setChartKind] = useState<"time" | "category">("time");
  const [timeFieldKey, setTimeFieldKey] = useState("");
  const [valueFieldKey, setValueFieldKey] = useState("");
  const [categoryFieldKey, setCategoryFieldKey] = useState("");
  const fields = useMemo(() => scalarFields(records), [records]);
  const timeFields = fields.filter(field =>
    /time|date|timestamp|occurred/i.test(field.label) && field.values.some(value => timestamp(value) !== null),
  );
  const numericFields = fields.filter(field =>
    field.values.some(value => numeric(value) !== null) && !timeFields.includes(field),
  );
  const timeField = timeFields.find(field => field.key === timeFieldKey) ?? timeFields[0];
  const valueField = numericFields.find(field => field.key === valueFieldKey) ?? numericFields[0];
  const categoryField = fields.find(field => field.key === categoryFieldKey) ?? fields[0];
  const queryKey = JSON.stringify({ sourceId: query.sourceId, search: query.search });

  useEffect(() => {
    setRecords([]);
    setLoaded(false);
    setError("");
  }, [queryKey]);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const blob = await downloadExplorerRecords("json", query);
      const parsed = JSON.parse(await blob.text()) as { items?: Array<{ rawRecord?: JsonObject }> };
      const next = (parsed.items ?? []).flatMap(item =>
        item.rawRecord && typeof item.rawRecord === "object" ? [{ rawRecord: item.rawRecord }] : [],
      );
      setRecords(next);
      setLoaded(true);
      setTimeFieldKey("");
      setValueFieldKey("");
      setCategoryFieldKey("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Matching records could not be loaded for visualization.");
      setRecords([]);
      setLoaded(false);
    } finally {
      setLoading(false);
    }
  };

  return <section className="dw-visualization" aria-label="Visualize source data" data-testid="source-record-visualization">
    <div className="dw-visualization-head">
      <div><span className="section-label">ON-DEMAND VIEW</span><h2>Visualize source records</h2></div>
      <button type="button" className="button" onClick={() => void load()} disabled={loading}>
        {loading ? "Loading records…" : loaded ? "Reload chart data" : "Load chart data"}
      </button>
    </div>
    <p className="dw-chart-caption">Charts use the exact raw records matching the current source and search filters. Data is loaded only when requested; time-series exports are limited to 10,000 records and 25 MiB.</p>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!loaded ? <p className="dw-chart-empty">Choose a source or search filter, then load matching records to build a chart.</p> :
      records.length === 0 ? <p className="dw-chart-empty">No records match the current filters.</p> : <>
        <div className="dw-chart-controls">
          <label>Chart type
            <select value={chartKind} onChange={event => setChartKind(event.target.value as "time" | "category")} data-testid="select-chart-kind">
              <option value="time">Measurement over time</option>
              <option value="category">Category / fault-code counts</option>
            </select>
          </label>
          {chartKind === "time" ? <>
            <label>Timestamp field
              <select value={timeField?.key ?? ""} onChange={event => setTimeFieldKey(event.target.value)} data-testid="select-chart-time-field">
                {timeFields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
              </select>
            </label>
            <label>Numeric field
              <select value={valueField?.key ?? ""} onChange={event => setValueFieldKey(event.target.value)} data-testid="select-chart-value-field">
                {numericFields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
              </select>
            </label>
          </> : <label>Category or code field
            <select value={categoryField?.key ?? ""} onChange={event => setCategoryFieldKey(event.target.value)} data-testid="select-chart-category-field">
              {fields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
            </select>
          </label>}
        </div>
        {chartKind === "time"
          ? timeField && valueField
            ? <TimeSeriesChart records={records} timeField={timeField} valueField={valueField} />
            : <p className="dw-chart-empty">No suitable timestamp and numeric fields were detected. Original values remain available in the record inspector.</p>
          : categoryField
            ? <CategoryChart field={categoryField} />
            : <p className="dw-chart-empty">No category fields are available in these records.</p>}
      </>}
  </section>;
}
