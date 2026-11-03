# KuduNS Unified Data Integration

## Milestone 1 — discovery, review, and explicit ingestion

Implemented for REST/JSON/CSV:

- `POST /api/v1/data-sources/discover` performs one bounded REST `GET` or a safe, read-only local file inspection only after an operator selects **Discover & Preview**.
- JSON discovery finds record arrays under nested JSON objects; CSV discovery inspects headers and sample values. More than one candidate requires an explicit selection.
- The preview reports field types, redacted examples, alias-based suggestions and confidence, ambiguity, required-field validation, normalized values, and registered asset-key matches. Unmatched identifiers are not associated automatically.
- The source form allows changing or excluding suggestions. Saving accepted suggestions creates or updates an editable mapping draft. Validation and activation remain separate operator actions.
- Nested JSON file collections require an active mapping. With no active mapping, the existing top-level CSV/JSON parser and payload behavior remain unchanged.
- Unmapped event fields remain available in the event payload and original-record provenance. REST sync and file import remain explicit, separate actions.
- Mapped timestamps support Unix epoch seconds/milliseconds and explicitly zoned date strings. Timezone-free date strings are rejected instead of guessed.

### `/faults` acceptance

The supplied acceptance URL `http://127.0.0.1:8080/api/faults` returned HTTP 404 with an HTML response during one bounded, read-only request. Its schema and `faults` collection are therefore not verified; no mapping was invented. Disposable local fixtures cover the integration code, but they do not replace the live acceptance journey.

## Milestone 2 — historical integrity and recovery

Implemented:

- Opt-in offset, page-number, and cursor pagination with explicit date query parameters, bounded page sizes, per-action page limits, and operator-controlled request intervals.
- Durable REST sync runs with per-page event commits/checkpoints, an explicit resume action, source/mapping/configuration guards, transient retry handling, and persisted sanitized errors/history.
- Stable source-record-ID deduplication and record-fingerprint fallback. Identical imports remain duplicates across run IDs; changed normalized content with the same ID is a conflict, never an overwrite.
- Event lineage includes sync-run ID and mapping version.
- Asset resolution uses exact active asset keys and unique external identifiers registered for that source. Exact name matches are suggestions only; ambiguous/unmatched records remain unattached and no assets are auto-created.
- Additive PostgreSQL and SQLite migrations; Local SQLite backup/restore includes run history.

Verified with disposable SQLite and HTTP fixtures, including offset/page/cursor strategies, date parameters, restart/resume, retries, duplicate conflicts, and asset-match statuses. The live `/faults` acceptance and PostgreSQL integration execution remain unverified in this environment.

## Milestone 3 — operations and schema governance

Not implemented in this milestone: a source-health dashboard, per-asset event timelines, schema-change monitoring, and reusable mapping templates.

## Milestone 4 — additional transports

Not implemented in this milestone: MQTT, OPC UA, and webhook connectors. They should reuse the same normalized event and provenance boundaries after REST/JSON/CSV behavior is stable.
