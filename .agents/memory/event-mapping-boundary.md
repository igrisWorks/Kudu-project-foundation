---
name: Data-first ingestion and mappings
description: Raw source records are accepted without mandatory mappings; canonical event normalization remains evidence-based.
---

Persist each valid supported REST, JSON, and CSV source record before optional event normalization. A missing mapping alone is not a reason to reject or discard a source record.

Only normalize automatically when canonical event type and occurrence time are supported by high-confidence, unambiguous evidence and valid record values. Keep uncertain suggestions unselected; do not infer event types, timestamps, measurements, or asset associations. Never create assets from imported data.

Explicit mappings remain operator-controlled through discovery, validation, and activation, and saved mappings should be reused across compatible sources and formats. Mapping paths may inspect JSON-encoded CSV cells without changing the stored original cell text or source structure.

If normalization fails after raw storage, keep the raw record and surface the failure; do not silently report a failed normalization as a successful event import.

Ingestion deduplication fingerprints must not include per-run lineage metadata such as a sync-run ID. Keep run and mapping lineage in stored provenance, while comparing normalized event content so an identical replay is a duplicate and changed content under a stable source ID remains a conflict.

Keep industrial recognition vendor-independent across the shared REST/JSON/CSV path. Semantic fields outside the canonical event contract belong in the existing payload. Preselect only high-confidence suggestions with adequate sample evidence; leave low-confidence and ambiguous suggestions unselected. Inspect nested structures without flattening array members or inventing field meanings.

**Why:** Industrial sources vary too much for required manual mapping, but uncertain normalization can invent events or associations. Raw-first storage preserves input while evidence thresholds and operator-approved mappings keep canonical event creation trustworthy.

**How to apply:** Test REST, JSON, and CSV for mapped and unmapped ingestion, raw preservation, deduplication, and safe normalization. Keep discovery, validation, activation, and import/sync user-triggered. Preserve nested arrays and original CSV cells. Surface explicit normalization errors while retaining raw records, and verify that run-only lineage changes do not turn a replay into a conflict.
