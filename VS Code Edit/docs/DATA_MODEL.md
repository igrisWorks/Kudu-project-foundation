# Data model

The initial migration creates the `kudu` PostgreSQL schema and migration history table. Additive migration `0002_asset_and_data_source_registries.sql` adds the first persisted registry entities.

`kudu.assets` stores stable asset keys, names, types, descriptions, an optional parent link, external identifier pairs, timestamps, and archive state. Keys are unique case-insensitively. Parent deletion is restricted by a foreign key; parent changes are also checked for missing/archived parents and hierarchy cycles by the API.

`kudu.data_sources` stores a stable key, display name, source type, descriptive metadata, type-specific JSON configuration, enablement, connection/ingestion state, timestamps, and last-sync/error metadata. REST configuration stores a URL and optional environment-variable reference, never a secret value. Public responses replace that reference with a boolean. File paths are metadata only; no file access or ingestion occurs.

`kudu.events` stores a UUID, registered source reference, optional asset reference, original source record ID, event type, occurrence and ingestion timestamps, original source timestamp, optional source-scoped deduplication key, complete JSON payload, and source provenance JSON. A partial unique index on `(source_id, deduplication_key)` applies only when a key is supplied. The API stores a content fingerprint for that key: identical retries return the existing record; changed content with the same key conflicts. Source deletion is restricted; deleting an asset preserves the event and clears its optional asset link.

The ingestion API keeps source identifiers distinct from Kudu UUIDs. Event payloads are stored intact as JSONB, including fields Kudu does not interpret. Normalized measurements, mapping proposals, published mappings, and a browsable unified namespace remain future concepts; their relationships and retention rules must be defined before adding migrations.

Data-model constraints for future work:

- Give internal assets stable identities independent of IP addresses and source identifiers.
- Keep the source-system identity and selected original references with normalized records.
- Normalize stored instants to UTC while retaining original timestamp information where available.
- Preserve unknown source fields rather than silently dropping them.
- Make ingestion idempotent where practical; record schema and mapping versions and explicit error states.
- Store media bytes in local filesystem storage behind a constrained storage interface, not as database blobs.
- Use additive, versioned SQL migrations; do not alter a migration that has already been applied.
