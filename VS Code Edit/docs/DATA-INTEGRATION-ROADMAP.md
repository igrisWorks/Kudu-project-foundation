# KuduNS Unified Data Integration

## Milestone 1 — discovery, review, and explicit ingestion

Implemented for REST/JSON/CSV:

- `POST /api/v1/data-sources/discover` performs one bounded REST `GET` or a safe, read-only local file inspection only after an operator selects **Discover & Preview**.
- JSON discovery finds record arrays under nested JSON objects; CSV discovery inspects headers and sample values. More than one candidate requires an explicit selection.
- The preview reports field types, redacted examples, alias-based suggestions and confidence, ambiguity, required-field validation, normalized values, and exact registered asset-key matches. Unmatched asset identifiers are not associated automatically.
- The source form allows changing or excluding suggestions. Saving accepted suggestions creates or updates an editable mapping draft. Validation and activation remain separate operator actions.
- Nested JSON file collections require an active mapping. With no active mapping, the existing top-level CSV/JSON parser and payload behavior remain unchanged.
- Unmapped event fields remain available in the event payload and original-record provenance. REST sync and file import remain explicit, separate actions.
- Mapped timestamps support Unix epoch seconds/milliseconds and explicitly zoned date strings. Timezone-free date strings are rejected instead of guessed.

### `/faults` acceptance

There is no `/faults` service URL, fixture, or credential reference in this checkout. The implementation is verified with disposable local REST and JSON fixtures, but the requested live `/faults` journey has not been run. To complete that check, configure the approved service URL and relative endpoint path, run discovery, choose its `faults` collection, review and activate the mapping, then select **Sync now**. Do not place a token value in the source form; provision a bearer-token environment reference separately if the service requires it.

## Milestone 2 — historical integrity and recovery

Not implemented in this milestone: pagination, date-range backfill jobs, resumable progress, retry controls, richer duplicate reconciliation, source-to-asset identifier matching beyond exact active asset keys, and persistent lineage/run history.

## Milestone 3 — operations and schema governance

Not implemented in this milestone: a source-health dashboard, durable sync history, per-asset event timelines, schema-change monitoring, and reusable mapping templates.

## Milestone 4 — additional transports

Not implemented in this milestone: MQTT, OPC UA, and webhook connectors. They should reuse the same normalized event and provenance boundaries after REST/JSON/CSV behavior is stable.
