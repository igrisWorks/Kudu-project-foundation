export type ObservedValueType = "string" | "number" | "boolean" | "null" | "object" | "array";

export interface RawVisualRecord {
  id: string;
  source: { id: string; sourceKey: string; displayName: string };
  sourceRecordId: string | null;
  ingestedAt: string;
  processingStatus: string;
  rawRecord: Record<string, unknown>;
}

export interface RawField {
  key: string;
  path: string[];
  label: string;
  values: unknown[];
  typeCounts: Partial<Record<ObservedValueType, number>>;
  presentCount: number;
}

export interface RawVisualFilters {
  timestampField: string;
  sourceTimezone?: string;
  fromDate: string;
  toDate: string;
  categoryField: string;
  categoryValue: string;
}

const timestampFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterForTimezone(timezone: string): Intl.DateTimeFormat {
  let formatter = timestampFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    timestampFormatters.set(timezone, formatter);
  }
  return formatter;
}

function objectParts(formatter: Intl.DateTimeFormat, date: Date): Record<string, number> {
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, Number(part.value)]),
  );
}

function parseLocalTimestamp(value: string, timezone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ""] = match;
  const wall = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: Number(secondText),
  };
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  const check = new Date(wallAsUtc);
  if (
    check.getUTCFullYear() !== wall.year ||
    check.getUTCMonth() + 1 !== wall.month ||
    check.getUTCDate() !== wall.day ||
    wall.hour > 23 ||
    wall.minute > 59 ||
    wall.second > 59
  ) return null;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = formatterForTimezone(timezone);
  } catch {
    return null;
  }

  const milliseconds = Number((fraction + "000").slice(0, 3));
  const candidates = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = wallAsUtc + hours * 60 * 60 * 1000;
    const parts = objectParts(formatter, new Date(sample));
    const displayedAsUtc = Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
      parts.second!,
    );
    const offset = displayedAsUtc - Math.floor(sample / 1000) * 1000;
    const candidate = wallAsUtc - offset + milliseconds;
    const actual = objectParts(formatter, new Date(candidate));
    if (
      actual.year === wall.year &&
      actual.month === wall.month &&
      actual.day === wall.day &&
      actual.hour === wall.hour &&
      actual.minute === wall.minute &&
      actual.second === wall.second
    ) candidates.add(candidate);
  }

  // DST gaps and overlaps are not guessed: the source must provide a
  // disambiguated timestamp or a unique local time in its configured zone.
  return candidates.size === 1 ? [...candidates][0]! : null;
}

export function parseSourceTimestamp(value: unknown, sourceTimezone?: string): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1 ? null : date.getTime();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const input = value.trim();
  if (/^-?\d{9,16}$/.test(input)) {
    const epoch = Number(input);
    const date = new Date(Math.abs(epoch) < 100_000_000_000 ? epoch * 1000 : epoch);
    return Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1 ? null : date.getTime();
  }
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2}|(?:UTC|GMT))$/i.test(input);
  if (!hasTimezone) {
    return sourceTimezone ? parseLocalTimestamp(input, sourceTimezone) : null;
  }
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) || new Date(parsed).getUTCFullYear() <= 1 ? null : parsed;
}

export function rawFieldKey(path: string[]): string {
  return JSON.stringify(path);
}

export function parseRawFieldPath(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && parsed.every(part => typeof part === "string") ? parsed : [];
  } catch {
    return [];
  }
}

export function rawFieldLabel(path: string[]): string {
  return path.reduce((label, segment) => {
    if (/^[A-Za-z_$][\w$]*$/.test(segment)) return label ? `${label}.${segment}` : segment;
    return `${label}[${JSON.stringify(segment)}]`;
  }, "");
}

function valueType(value: unknown): ObservedValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  return "null";
}

export function discoverRawFields(records: RawVisualRecord[]): RawField[] {
  const fields = new Map<string, RawField>();
  const visit = (value: unknown, path: string[], rowIndex: number) => {
    if (path.length) {
      const key = rawFieldKey(path);
      const field: RawField = fields.get(key) ?? {
        key,
        path,
        label: rawFieldLabel(path),
        values: Array(records.length).fill(undefined),
        typeCounts: {},
        presentCount: 0,
      };
      field.values[rowIndex] = value;
      field.presentCount += 1;
      const type = valueType(value);
      field.typeCounts[type] = (field.typeCounts[type] ?? 0) + 1;
      fields.set(key, field);
    }

    // Preserve arrays as structures. Their member objects remain available
    // in the raw record table instead of being flattened into false columns.
    if (Array.isArray(value)) return;
    if (typeof value === "object" && value !== null) {
      for (const [key, nested] of Object.entries(value)) visit(nested, [...path, key], rowIndex);
    }
  };
  records.forEach((record, index) => visit(record.rawRecord, [], index));
  return [...fields.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function rawFieldValue(record: RawVisualRecord, path: string[]): unknown {
  let value: unknown = record.rawRecord;
  for (const part of path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function isRawScalarField(field: RawField): boolean {
  return !field.typeCounts.object && !field.typeCounts.array &&
    Boolean(field.typeCounts.string || field.typeCounts.number || field.typeCounts.boolean);
}

export function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() && value.trim() === value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function sourceDateKey(timestamp: number, sourceTimezone?: string): string | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: sourceTimezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = objectParts(formatter, new Date(timestamp));
    return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  } catch {
    return null;
  }
}

export function formatSourceTimestamp(timestamp: number, sourceTimezone?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: sourceTimezone || "UTC",
      timeZoneName: "short",
    }).format(timestamp);
  } catch {
    return new Date(timestamp).toISOString();
  }
}

export function filterRawRecords(records: RawVisualRecord[], filters: RawVisualFilters): RawVisualRecord[] {
  const timestampPath = parseRawFieldPath(filters.timestampField);
  const categoryPath = parseRawFieldPath(filters.categoryField);

  return records.filter(record => {
    if (filters.fromDate || filters.toDate) {
      if (!timestampPath.length) return false;
      const timestamp = parseSourceTimestamp(rawFieldValue(record, timestampPath), filters.sourceTimezone);
      if (timestamp === null) return false;
      const date = sourceDateKey(timestamp, filters.sourceTimezone);
      if (!date) return false;
      if (filters.fromDate && date < filters.fromDate) return false;
      if (filters.toDate && date > filters.toDate) return false;
    }
    if (filters.categoryValue && categoryPath.length) {
      const value = rawFieldValue(record, categoryPath);
      if (value === null || value === undefined || typeof value === "object") return false;
      if (String(value) !== filters.categoryValue) return false;
    }
    return true;
  });
}

export function observedTypeSummary(field: RawField, totalRecords: number): string {
  const observed = (Object.entries(field.typeCounts) as Array<[ObservedValueType, number]>)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type} ${count}`);
  const missing = Math.max(0, totalRecords - field.presentCount);
  if (missing) observed.push(`missing ${missing}`);
  return observed.join(" · ");
}
