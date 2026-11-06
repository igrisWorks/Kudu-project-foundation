import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverRawFields,
  filterRawRecords,
  parseSourceTimestamp,
  rawFieldKey,
  rawFieldValue,
  type RawVisualRecord,
} from "./raw-visualisation.js";

function record(id: string, rawRecord: Record<string, unknown>): RawVisualRecord {
  return {
    id,
    source: { id: "source-testapi2", sourceKey: "testApi2", displayName: "testApi2 fixture" },
    sourceRecordId: id,
    ingestedAt: "2030-01-01T00:00:00.000Z",
    processingStatus: "raw_only",
    rawRecord,
  };
}

test("raw field discovery reports observed types and retains arrays as nested structures", () => {
  const records = [
    record("1", {
      timestamp: "2025-12-18T09:00:00",
      message: "Motor overload",
      number: 18,
      remark: null,
      cams: [{ cameraId: "front", image: { sequence: 3 } }],
      nested: { state: true },
    }),
    record("2", {
      timestamp: "2025-12-18T09:01:00",
      message: "Motor overload",
      number: 19,
      remark: "cleared",
      cams: [],
      nested: { state: false },
    }),
  ];
  const fields = discoverRawFields(records);
  const byPath = new Map(fields.map(field => [field.label, field]));

  assert.equal(byPath.get("timestamp")?.typeCounts.string, 2);
  assert.equal(byPath.get("number")?.typeCounts.number, 2);
  assert.equal(byPath.get("remark")?.typeCounts.null, 1);
  assert.equal(byPath.get("remark")?.typeCounts.string, 1);
  assert.equal(byPath.get("cams")?.typeCounts.array, 2);
  assert.equal(byPath.has("cams.cameraId"), false, "array members are not flattened into synthetic fields");
  assert.deepEqual(rawFieldValue(records[0]!, ["cams"]), [{ cameraId: "front", image: { sequence: 3 } }]);
  assert.equal(rawFieldValue(records[0]!, ["nested", "state"]), true);
  assert.equal(fields.find(field => field.label === "timestamp")?.key, rawFieldKey(["timestamp"]));
});

test("timestamps require explicit offsets or a configured, unambiguous source timezone", () => {
  assert.equal(parseSourceTimestamp("2025-12-18T09:00:00"), null);
  assert.equal(parseSourceTimestamp("2025-12-18T09:00:00Z"), Date.parse("2025-12-18T09:00:00Z"));
  assert.equal(
    parseSourceTimestamp("2025-12-18T09:00:00", "Europe/Berlin"),
    Date.parse("2025-12-18T08:00:00Z"),
  );
  assert.equal(parseSourceTimestamp("2026-03-29T02:30:00", "Europe/Berlin"), null, "DST gaps are not guessed");
  assert.equal(parseSourceTimestamp("2026-10-25T02:30:00", "Europe/Berlin"), null, "DST overlaps are not guessed");
});

test("raw date and category filters use original fields rather than ingestion time", () => {
  const records = [
    record("fault-a", { timestamp: "2025-12-18T09:00:00", message: "Motor overload", number: 18, cams: [] }),
    record("fault-b", { timestamp: "2025-12-19T09:00:00", message: "Sensor warning", number: 19, cams: [] }),
    record("fault-c", { timestamp: "2025-12-18T10:00:00", message: "Motor overload", number: 20, cams: [] }),
  ];
  const filtered = filterRawRecords(records, {
    timestampField: rawFieldKey(["timestamp"]),
    sourceTimezone: "Europe/Berlin",
    fromDate: "2025-12-18",
    toDate: "2025-12-18",
    categoryField: rawFieldKey(["message"]),
    categoryValue: "Motor overload",
  });

  assert.deepEqual(filtered.map(item => item.id), ["fault-a", "fault-c"]);
  assert.equal(filtered[0]?.ingestedAt, "2030-01-01T00:00:00.000Z");
});
