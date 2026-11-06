import { useCallback, useEffect, useMemo, useState } from "react";
import type { DataSourceRecord, ExplorerRecordQuery } from "@kudu/shared";
import { downloadExplorerRecords } from "../api";
import {
  discoverRawFields,
  filterRawRecords,
  formatSourceTimestamp,
  isRawScalarField,
  numericValue,
  observedTypeSummary,
  parseRawFieldPath,
  parseSourceTimestamp,
  rawFieldValue,
  type RawField,
  type RawVisualRecord,
} from "./raw-visualisation";

export type RawVisualisationType = "time" | "frequency" | "distribution" | "table";

export interface RawVisualisationConfig {
  type: RawVisualisationType;
  search: string;
  timestampField: string;
  valueField: string;
  categoryField: string;
  categoryValue: string;
  fromDate: string;
  toDate: string;
}

interface RawRecordVisualisationsProps {
  sources: DataSourceRecord[];
  sourceId: string;
  onSourceChange: (sourceId: string) => void;
  config: RawVisualisationConfig;
  onConfigChange: (config: RawVisualisationConfig) => void;
  autoLoadKey?: string;
}

interface ChartPoint {
  record: RawVisualRecord;
  time: number;
  value: number;
}

function selectedPath(fields: RawField[], key: string): RawField | undefined {
  return fields.find(field => field.key === key);
}

function countByValue(records: RawVisualRecord[], field: RawField): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const value = rawFieldValue(record, field.path);
    if (value === null || value === undefined || typeof value === "object") continue;
    const label = String(value);
    if (!label.trim()) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function TimeSeries({
  records,
  timeField,
  valueField,
  sourceTimezone,
}: {
  records: RawVisualRecord[];
  timeField: RawField;
  valueField: RawField;
  sourceTimezone?: string;
}) {
  const points: ChartPoint[] = records.flatMap(record => {
    const time = parseSourceTimestamp(rawFieldValue(record, timeField.path), sourceTimezone);
    const value = numericValue(rawFieldValue(record, valueField.path));
    return time === null || value === null ? [] : [{ record, time, value }];
  }).sort((left, right) => left.time - right.time);
  const shown = points.length > 500
    ? Array.from({ length: 500 }, (_, index) => points[Math.round(index * (points.length - 1) / 499)]!)
    : points;

  if (shown.length < 2) {
    return <div className="dw-chart-empty" role="status" data-testid="raw-time-empty">
      <span>NO TIME SERIES</span>
      <p>Choose fields with at least two valid timestamp and numeric-value pairs. Timestamps without an explicit offset require the source’s configured time zone.</p>
    </div>;
  }

  const width = 760;
  const height = 250;
  const left = 58;
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
  const pointsWithCoordinates = shown.map(point => ({
    ...point,
    x: left + ((point.time - minTime) / timeRange) * plotWidth,
    y: top + ((maxValue + valueRange * 0.08 - point.value) / (valueRange * 1.16)) * plotHeight,
  }));

  return <div className="dw-chart-wrap" data-testid="raw-time-series-chart">
    <svg className="dw-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`${points.length} raw source measurements for ${valueField.label} by ${timeField.label}`}>
      <line x1={left} y1={top} x2={left} y2={height - bottom} className="dw-chart-axis" />
      <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} className="dw-chart-axis" />
      <text x={left - 8} y={top + 5} textAnchor="end" className="dw-chart-tick">{maxValue.toLocaleString(undefined, { maximumFractionDigits: 3 })}</text>
      <text x={left - 8} y={height - bottom} textAnchor="end" className="dw-chart-tick">{minValue.toLocaleString(undefined, { maximumFractionDigits: 3 })}</text>
      <polyline points={pointsWithCoordinates.map(point => `${point.x},${point.y}`).join(" ")} className="dw-chart-line" />
      {pointsWithCoordinates.map((point, index) => <circle key={`${point.record.id}:${index}`}
        cx={point.x} cy={point.y} r="3" className="dw-chart-point">
        <title>{`${formatSourceTimestamp(point.time, sourceTimezone)} · ${point.value} · ${point.record.source.sourceKey} · ${point.record.sourceRecordId ?? point.record.id}`}</title>
      </circle>)}
      <text x={left} y={height - 10} textAnchor="start" className="dw-chart-tick">{formatSourceTimestamp(minTime, sourceTimezone)}</text>
      <text x={width - right} y={height - 10} textAnchor="end" className="dw-chart-tick">{formatSourceTimestamp(maxTime, sourceTimezone)}</text>
    </svg>
    <p className="dw-chart-caption" data-testid="raw-time-series-caption">
      {points.length} valid time/value pairs from {records.length} filtered raw records.
      {points.length > shown.length ? ` · ${shown.length} points displayed` : ""}
      {" "}Time values come from the selected original field, not ingestion time.
    </p>
  </div>;
}

function CategoryCounts({ counts, field, kind }: {
  counts: Array<[string, number]>;
  field: RawField;
  kind: "frequency" | "distribution";
}) {
  const shown = counts.slice(0, 20);
  const maximum = Math.max(1, ...shown.map(([, count]) => count));
  if (!shown.length) {
    return <div className="dw-chart-empty" role="status">
      <span>NO VALUES</span>
      <p>Choose an observed scalar field with non-empty values.</p>
    </div>;
  }
  return <div className="dw-category-chart" role="img" aria-label={`Raw ${kind} counts for ${field.label}`} data-testid={`raw-${kind}-chart`}>
    {shown.map(([label, count]) => <div className="dw-category-row" key={label} title={`${label}: ${count}`}>
      <span title={label}>{label.length > 54 ? `${label.slice(0, 51)}…` : label}</span>
      <div className="dw-category-track"><i style={{ width: `${(count / maximum) * 100}%` }} /></div>
      <strong>{count}</strong>
    </div>)}
    <p className="dw-chart-caption">{field.label} · {counts.length} observed values; null, missing, and empty values are excluded.</p>
  </div>;
}

export default function RawRecordVisualisations({
  sources,
  sourceId,
  onSourceChange,
  config,
  onConfigChange,
  autoLoadKey = "",
}: RawRecordVisualisationsProps) {
  const [records, setRecords] = useState<RawVisualRecord[]>([]);
  const [exportTotal, setExportTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const source = sources.find(item => item.id === sourceId);
  const sourceTimezone = source && "sourceTimezone" in source.configuration
    ? source.configuration.sourceTimezone
    : undefined;
  const fields = useMemo(() => discoverRawFields(records), [records]);
  const scalarFields = useMemo(() => fields.filter(isRawScalarField), [fields]);
  const timeFields = useMemo(() => scalarFields.filter(field =>
    field.values.some(value => parseSourceTimestamp(value, sourceTimezone) !== null),
  ), [scalarFields, sourceTimezone]);
  const numericFields = useMemo(() => scalarFields.filter(field =>
    field.values.some(value => numericValue(value) !== null),
  ), [scalarFields]);
  const timestampField = selectedPath(fields, config.timestampField);
  const valueField = selectedPath(fields, config.valueField);
  const categoryField = selectedPath(fields, config.categoryField);
  const dateFilteredRecords = useMemo(() => filterRawRecords(records, {
    timestampField: config.timestampField,
    sourceTimezone,
    fromDate: config.fromDate,
    toDate: config.toDate,
    categoryField: "",
    categoryValue: "",
  }), [records, config.timestampField, config.fromDate, config.toDate, sourceTimezone]);
  const categoryValues = useMemo(() => {
    if (!categoryField) return [];
    return [...new Set(dateFilteredRecords.flatMap(record => {
      const value = rawFieldValue(record, categoryField.path);
      return value === null || value === undefined || typeof value === "object" || !String(value).trim()
        ? []
        : [String(value)];
    }))].sort((left, right) => left.localeCompare(right));
  }, [categoryField, dateFilteredRecords]);
  const filteredRecords = useMemo(() => filterRawRecords(records, {
    timestampField: config.timestampField,
    sourceTimezone,
    fromDate: config.fromDate,
    toDate: config.toDate,
    categoryField: config.categoryField,
    categoryValue: config.categoryValue,
  }), [records, config.timestampField, config.categoryField, config.categoryValue, config.fromDate, config.toDate, sourceTimezone]);
  const categoryCounts = useMemo(
    () => categoryField ? countByValue(filteredRecords, categoryField) : [],
    [filteredRecords, categoryField],
  );
  const queryKey = `${sourceId}\u0000${config.search}`;

  const load = useCallback(async () => {
    if (!sourceId) {
      setRecords([]);
      setExportTotal(0);
      setLoaded(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const query: ExplorerRecordQuery = {
        sourceId,
        ...(config.search.trim() ? { search: config.search.trim() } : {}),
        page: 1,
        pageSize: 100,
        sortBy: "ingestedAt",
        sortDirection: "desc",
      };
      const blob = await downloadExplorerRecords("json", query);
      const payload: unknown = JSON.parse(await blob.text());
      const exported = typeof payload === "object" && payload !== null
        ? payload as { items?: unknown; total?: unknown }
        : {};
      const next = Array.isArray(exported.items)
        ? exported.items.flatMap(item => {
          if (typeof item !== "object" || item === null) return [];
          const record = item as Partial<RawVisualRecord>;
          if (
            typeof record.id !== "string" ||
            typeof record.source !== "object" ||
            record.source === null ||
            typeof record.rawRecord !== "object" ||
            record.rawRecord === null ||
            Array.isArray(record.rawRecord)
          ) return [];
          return [{
            id: record.id,
            source: record.source as RawVisualRecord["source"],
            sourceRecordId: typeof record.sourceRecordId === "string" ? record.sourceRecordId : null,
            ingestedAt: typeof record.ingestedAt === "string" ? record.ingestedAt : "",
            processingStatus: typeof record.processingStatus === "string" ? record.processingStatus : "raw_only",
            rawRecord: record.rawRecord as Record<string, unknown>,
          }];
        })
        : [];
      setRecords(next);
      setExportTotal(typeof exported.total === "number" ? exported.total : next.length);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Raw source records could not be loaded.");
      setRecords([]);
      setExportTotal(0);
      setLoaded(false);
    } finally {
      setLoading(false);
    }
  }, [config.search, sourceId]);

  useEffect(() => {
    setRecords([]);
    setExportTotal(0);
    setLoaded(false);
    setError("");
  }, [queryKey]);

  useEffect(() => {
    if (autoLoadKey) void load();
  }, [autoLoadKey, load]);

  const update = (partial: Partial<RawVisualisationConfig>) => onConfigChange({ ...config, ...partial });

  return <section className="dw-raw-viz" aria-label="Raw source record visualisations" data-testid="raw-visualisations">
    <div className="dw-raw-viz-controls">
      <div className="field">
        <label htmlFor="raw-visual-source">Data source</label>
        <select id="raw-visual-source" value={sourceId} onChange={event => onSourceChange(event.target.value)} data-testid="select-raw-visualisation-source">
          <option value="">Choose source</option>
          {sources.map(item => <option key={item.id} value={item.id}>{item.displayName} · {item.sourceKey}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="raw-visual-search">Source-record search</label>
        <input id="raw-visual-search" value={config.search} onChange={event => update({ search: event.target.value })} maxLength={200}
          placeholder="Search this source’s raw records" data-testid="input-raw-visualisation-search" />
      </div>
      <div className="field">
        <label htmlFor="raw-visual-type">Visualisation</label>
        <select id="raw-visual-type" value={config.type} onChange={event => update({ type: event.target.value as RawVisualisationType })} data-testid="select-raw-visualisation-type">
          <option value="time">Time series</option>
          <option value="frequency">Fault / message frequency</option>
          <option value="distribution">State distribution</option>
          <option value="table">Raw record table</option>
        </select>
      </div>
      {config.type === "time" && <>
        <div className="field">
          <label htmlFor="raw-visual-timestamp">Timestamp field · select explicitly</label>
          <select id="raw-visual-timestamp" value={config.timestampField} onChange={event => update({ timestampField: event.target.value })} data-testid="select-raw-visualisation-timestamp">
            <option value="">Choose a timestamp field</option>
            {timeFields.map(field => <option key={field.key} value={field.key}>{field.label} · {observedTypeSummary(field, records.length)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="raw-visual-value">Numeric field</label>
          <select id="raw-visual-value" value={config.valueField} onChange={event => update({ valueField: event.target.value })} data-testid="select-raw-visualisation-value">
            <option value="">Choose a numeric field</option>
            {numericFields.map(field => <option key={field.key} value={field.key}>{field.label} · {observedTypeSummary(field, records.length)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="raw-visual-from">From date · {sourceTimezone || "UTC"}</label>
          <input id="raw-visual-from" type="date" value={config.fromDate} onChange={event => update({ fromDate: event.target.value })}
            disabled={!config.timestampField} data-testid="input-raw-visualisation-from" />
        </div>
        <div className="field">
          <label htmlFor="raw-visual-to">To date · {sourceTimezone || "UTC"}</label>
          <input id="raw-visual-to" type="date" value={config.toDate} onChange={event => update({ toDate: event.target.value })}
            disabled={!config.timestampField} data-testid="input-raw-visualisation-to" />
        </div>
      </>}
      {(config.type === "frequency" || config.type === "distribution") && <>
        <div className="field">
          <label htmlFor="raw-visual-category">Category, message, code, machine, or state field</label>
          <select id="raw-visual-category" value={config.categoryField} onChange={event => update({ categoryField: event.target.value, categoryValue: "" })} data-testid="select-raw-visualisation-category">
            <option value="">Choose a scalar field</option>
            {scalarFields.map(field => <option key={field.key} value={field.key}>{field.label} · {observedTypeSummary(field, records.length)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="raw-visual-category-filter">Optional exact value filter</label>
          <select id="raw-visual-category-filter" value={config.categoryValue} onChange={event => update({ categoryValue: event.target.value })} disabled={!categoryField}
            data-testid="select-raw-visualisation-category-filter">
            <option value="">All values</option>
            {categoryValues.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
      </>}
      <div className="field dw-raw-load-field">
        <label>Dataset preview</label>
        <button type="button" className="button button-primary" onClick={() => void load()} disabled={!sourceId || loading} data-testid="button-load-raw-visualisation-data">
          {loading ? "Loading raw records…" : loaded ? "Reload raw records" : "Load raw records"}
        </button>
      </div>
    </div>

    {source && <div className="dw-provenance-strip" data-testid="raw-visualisation-source-identity">
      <span className="dw-signal" /><strong>{source.displayName}</strong><code>{source.sourceKey}</code>
      <span>Raw source identity · {sourceTimezone ? `time zone ${sourceTimezone}` : "no source time zone configured"}</span>
    </div>}
    {error && <div className="notice error" role="alert" data-testid="raw-visualisation-error">{error}
      <button type="button" className="button button-danger" onClick={() => void load()} data-testid="button-retry-raw-visualisation">Retry</button>
    </div>}
    {loading && <div className="dw-chart-skeleton" aria-label="Loading raw records"><i /><i /><i /></div>}

    {loaded && <>
      <div className="dw-raw-field-catalog" data-testid="raw-field-catalog">
        <div><span className="section-label">OBSERVED PAYLOAD FIELDS</span><strong>{fields.length} fields · original nested structures retained</strong></div>
        {fields.length ? <ul>{fields.map(field => <li key={field.key} data-testid={`raw-field-${field.key}`}>
          <code>{field.label}</code><span>{observedTypeSummary(field, records.length) || "no observed values"}</span>
        </li>)}</ul> : <p>No payload fields were discovered in the loaded records.</p>}
      </div>
      <section className="dw-chart-panel" aria-labelledby="raw-chart-title">
        <div className="dw-chart-header">
          <div>
            <span className="section-label">{config.type === "time" ? "RAW TIME SERIES · ORIGINAL TIMESTAMP" : config.type === "frequency" ? "RAW FIELD · FREQUENCY" : config.type === "distribution" ? "RAW STATE · DISTRIBUTION" : "RAW RECORDS · SOURCE PAYLOADS"}</span>
            <h3 id="raw-chart-title">
              {config.type === "time"
                ? `${timestampField?.label || "Choose timestamp"}${valueField ? ` · ${valueField.label}` : ""}`
                : config.type === "table"
                  ? "Source identity and original payload"
                  : categoryField?.label || "Choose a category field"}
            </h3>
          </div>
          <div className="dw-chart-count"><strong data-testid="raw-filtered-count">{filteredRecords.length}</strong><span>matching raw records</span></div>
        </div>
        {config.type === "time" && timestampField && valueField
          ? <TimeSeries records={filteredRecords} timeField={timestampField} valueField={valueField} sourceTimezone={sourceTimezone} />
          : config.type === "frequency" || config.type === "distribution"
            ? categoryField
              ? <CategoryCounts counts={categoryCounts} field={categoryField} kind={config.type} />
              : <div className="dw-chart-empty" role="status"><span>CHOOSE A FIELD</span><p>Select an observed category or state field.</p></div>
            : config.type === "table"
              ? filteredRecords.length
                ? <div className="table-frame dw-table-frame">
                  <table data-testid="raw-visualisation-table">
                    <thead><tr><th>Source / source record</th><th>Status</th><th>Original time</th><th>Original nested payload</th></tr></thead>
                    <tbody>{filteredRecords.slice(0, 100).map(record => {
                      const timestampPath = parseRawFieldPath(config.timestampField);
                      const timestamp = timestampPath.length ? parseSourceTimestamp(rawFieldValue(record, timestampPath), sourceTimezone) : null;
                      return <tr key={record.id} data-testid={`raw-visualisation-row-${record.id}`}>
                        <td><strong>{record.sourceRecordId ?? record.id}</strong><small>{record.source.sourceKey} · {record.source.id}</small></td>
                        <td>{record.processingStatus}</td>
                        <td>{timestamp === null ? "—" : formatSourceTimestamp(timestamp, sourceTimezone)}</td>
                        <td><details><summary>Inspect original payload</summary><pre>{JSON.stringify(record.rawRecord, null, 2)}</pre></details></td>
                      </tr>;
                    })}</tbody>
                  </table>
                  {filteredRecords.length > 100 && <p className="dw-chart-caption">Showing the first 100 of {filteredRecords.length} matching records.</p>}
                </div>
                : <div className="dw-chart-empty" role="status"><span>NO MATCHING RECORDS</span><p>Change or clear the selected filters.</p></div>
              : <div className="dw-chart-empty" role="status"><span>CHOOSE FIELDS</span><p>Select an explicit timestamp and a numeric field to plot original source values.</p></div>}
        <div className="dw-chart-foot" data-testid="raw-visualisation-summary">
          <span>Raw records loaded: {records.length} / {exportTotal}</span>
          <span>Normalized event status is not required · ingestion time is not used as occurrence time</span>
        </div>
      </section>
    </>}

    {!loaded && !loading && !error && <div className="dw-chart-empty" role="status" data-testid="raw-visualisation-empty">
      <span>RAW RECORDS</span><p>Choose a source and load its original records. This view does not require event types, mappings, or normalized events.</p>
    </div>}
    {exportTotal >= 10_000 && <p className="dw-chart-caption" role="note">The export limit is 10,000 records. Narrow the source-record search to visualize a smaller set.</p>}
    {fields.some(field => field.typeCounts.array || field.typeCounts.object) && <p className="dw-chart-caption" data-testid="raw-nested-data-note">
      Object and array fields stay structured in the original payload; array members are not flattened into synthetic event fields.
    </p>}
  </section>;
}
