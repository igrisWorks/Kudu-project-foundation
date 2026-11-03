# Data model

The initial migration creates the `kudu` PostgreSQL schema and migration history table. Additive migrations add the asset/data-source registries, event ingestion, and versioned source event mappings; applied migrations are never edited.

`kudu.assets` stores stable asset keys, names, types, descriptions, an optional parent link, external identifier pairs, timestamps, and archive state. Keys are unique case-insensitively. Parent deletion is restricted by a foreign key; parent changes are also checked for missing/archived parents and hierarchy cycles by the API.

`kudu.data_sources` stores a stable key, display name, source type, descriptive metadata, type-specific JSON configuration, enablement, connection/ingestion state, timestamps, and last-sync/error metadata. REST configuration stores a URL and optional environment-variable reference, never a secret value. Public responses replace that reference with a boolean. File paths are metadata until an operator explicitly imports a CSV/JSON source beneath the configured local import directory.

`kudu.events` stores a UUID, registered source reference, optional asset reference, original source record ID, event type, occurrence and ingestion timestamps, original source timestamp, optional source-scoped deduplication key, complete JSON payload, and source provenance JSON. A partial unique index on `(source_id, deduplication_key)` applies only when a key is supplied. The API stores a content fingerprint for that key: identical retries return the existing record; changed content with the same key conflicts. Source deletion is restricted; deleting an asset preserves the event and clears its optional asset link.

`kudu.data_source_event_mappings` stores immutable activated mapping versions and editable drafts for REST, CSV, and JSON sources. A source can have at most one active and one draft version. Discovery suggestions are transient; accepting them creates or updates a persisted draft, and activation retires the previous active version. Each mapped import or sync records the mapping version and original source record in event provenance. Mapping changes affect future ingestion only and do not rewrite existing events.

The ingestion API keeps source identifiers distinct from Kudu UUIDs. Event payloads are stored intact as JSONB, including fields Kudu does not interpret. Normalized measurement tables, persistent discovery history, pagination/backfill jobs, and monitoring history remain future concepts; their relationships and retention rules must be defined before adding migrations.

Data-model constraints for future work:

- Give internal assets stable identities independent of IP addresses and source identifiers.
- Keep the source-system identity and selected original references with normalized records.
- Normalize stored instants to UTC while retaining original timestamp information where available.
- Preserve unknown source fields rather than silently dropping them.
- Make ingestion idempotent where practical; record schema and mapping versions and explicit error states.
- Store media bytes in local filesystem storage behind a constrained storage interface, not as database blobs.
- Use additive, versioned SQL migrations; do not alter a migration that has already been applied.
