import { useState } from "react";
import type { ExplorerRecordSummary, JsonObject } from "@kudu/shared";
import { parseSourceTimestamp } from "./raw-visualisation";

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function scalarArraysAtPath(value: unknown, prefix = ""): Array<{ path: string; values: unknown[] }> {
  if (Array.isArray(value)) {
    return value.length && value.every(item => item === null || ["string", "number", "boolean"].includes(typeof item))
      ? [{ path: prefix, values: value }]
      : [];
  }
  const object = objectValue(value);
  if (!object) return [];
  return Object.entries(object).flatMap(([key, child]) =>
    scalarArraysAtPath(child, prefix ? `${prefix}.${key}` : key),
  );
}

function countValues(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

export function OpenMeteoPreview({ rawRecord, selectedField, onSelectField }: {
  rawRecord: JsonObject;
  selectedField: string;
  onSelectField: (path: string) => void;
}) {
  const hourly = objectValue(rawRecord.hourly);
  const timeValues = hourly?.time;
  const arrays = scalarArraysAtPath(rawRecord).filter(item => item.values.length > 1);
  const timestampArrays = arrays.filter(item =>
    item.values.some(value => typeof value === "string" && parseSourceTimestamp(value, "Europe/Berlin") !== null),
  );
  const timestamp = timestampArrays.find(item => item.path === "hourly.time");
  const measurementArrays = arrays.filter(item =>
    item.path !== timestamp?.path &&
    item.values.length === timestamp?.values.length &&
    item.values.some(value => typeof value === "number" && Number.isFinite(value)),
  );
  const selected = measurementArrays.find(item => item.path === selectedField) ?? measurementArrays[0];
  if (!Array.isArray(timeValues) || !timestamp || !selected) {
    return <p className="api-test-muted" role="status">No aligned timestamp and numeric arrays were found in the stored payload.</p>;
  }
  const points = timestamp.values.flatMap((time, index) => {
    const epoch = parseSourceTimestamp(time, "Europe/Berlin");
    const value = selected.values[index];
    return epoch !== null && typeof value === "number" && Number.isFinite(value)
      ? [{ at: epoch, value, label: String(time) }]
      : [];
  }).sort((left, right) => left.at - right.at);
  if (!points.length) {
    return <p className="api-test-muted" role="status">The selected field has no numeric values aligned to explicit source timestamps.</p>;
  }
  const min = Math.min(...points.map(point => point.value));
  const max = Math.max(...points.map(point => point.value));
  const range = Math.max(max - min, 1);
  const coords = points.map((point, index) => ({
    x: 8 + index / Math.max(points.length - 1, 1) * 84,
    y: 82 - ((point.value - min) / range) * 64,
  }));
  return <div className="api-derived-chart" data-testid="chart-openmeteo-derived">
    <label className="api-test-field"><span>Aligned numeric measurement</span>
      <select value={selected.path} onChange={event => onSelectField(event.target.value)} data-testid="select-openmeteo-measurement">
        {measurementArrays.map(item => <option key={item.path} value={item.path}>{item.path} · {item.values.length} values</option>)}
      </select>
    </label>
    <svg viewBox="0 0 100 100" role="img" aria-label={`${points.length} hourly ${selected.path} values aligned to hourly.time`}>
      <line x1="8" y1="82" x2="92" y2="82" />
      <polyline points={coords.map(point => `${point.x},${point.y}`).join(" ")} />
      {coords.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="1.5"><title>{`${points[index]!.label} · ${points[index]!.value}`}</title></circle>)}
    </svg>
    <p>{points.length} timestamp/value pairs. Index alignment follows the original hourly arrays; the source explicitly specifies Europe/Berlin.</p>
  </div>;
}

export function UsgsFeaturePreview({ rawRecord }: { rawRecord: JsonObject }) {
  const features = Array.isArray(rawRecord.features) ? rawRecord.features : [];
  const places = features.flatMap(item => {
    const properties = objectValue(objectValue(item)?.properties);
    return typeof properties?.place === "string" ? [properties.place] : [];
  });
  const magnitudes = features.flatMap(item => {
    const properties = objectValue(objectValue(item)?.properties);
    return typeof properties?.mag === "number" && Number.isFinite(properties.mag) ? [properties.mag] : [];
  });
  const placeCounts = countValues(places).slice(0, 8);
  return <div className="api-usgs-preview" data-testid="preview-usgs-features">
    <div><strong>{features.length}</strong><span>GeoJSON features in the preserved response</span></div>
    <div className="api-usgs-values"><span>Magnitude values</span>{magnitudes.length ? magnitudes.join(" · ") : "None in this response"}</div>
    <div className="api-usgs-values"><span>Most frequent places</span>{placeCounts.length ? placeCounts.map(([place, count]) => `${place} (${count})`).join(" · ") : "No place values found"}</div>
    <p>FeatureCollection envelope, nested properties, geometry, coordinate arrays, and Unix-millisecond source timestamps remain in the original raw record.</p>
  </div>;
}

export function JsonPlaceholderPreview({ records }: { records: ExplorerRecordSummary[] }) {
  const candidates = [...new Set(records.flatMap(record => Object.entries(record.preview)
    .filter(([, value]) => value && value !== "null" && value !== "Object" && !value.startsWith("Array"))
    .map(([field]) => field)))].sort();
  const preferred = candidates.includes("userId") ? "userId" : candidates[0] ?? "";
  const [field, setField] = useState(preferred);
  const fieldValues = records.flatMap(record => {
    const value = record.preview[field];
    return value && value !== "null" && value !== "Object" && !value.startsWith("Array") ? [value] : [];
  });
  const counts = countValues(fieldValues).slice(0, 10);
  return <div className="api-json-preview" data-testid="preview-jsonplaceholder">
    {candidates.length > 0 && <label className="api-test-field"><span>Observed categorical field</span>
      <select value={field} onChange={event => setField(event.target.value)} data-testid="select-jsonplaceholder-category">
        {candidates.map(candidate => <option key={candidate} value={candidate}>{candidate}</option>)}
      </select>
    </label>}
    <div className="api-test-counts">{counts.map(([value, count]) => <span key={value}><strong>{count}</strong>{value}</span>)}</div>
    <p>Counts use actual persisted record previews for the selected source; nested user fields remain in each original record.</p>
  </div>;
}
