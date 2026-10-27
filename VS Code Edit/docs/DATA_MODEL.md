# Data model

The initial migration creates the `kudu` PostgreSQL schema and migration history table. No business entities are persisted yet.

The planned first-release concepts are an asset registry, source registry, normalized events and measurements, source provenance, mapping proposals and published mappings, and a browsable unified namespace. Their relationships and retention rules need to be established before adding schema migrations.

Data-model constraints for future work:

- Give internal assets stable identities independent of IP addresses and source identifiers.
- Keep the source-system identity and selected original references with normalized records.
- Normalize stored instants to UTC while retaining original timestamp information where available.
- Preserve unknown source fields rather than silently dropping them.
- Make ingestion idempotent where practical; record schema and mapping versions and explicit error states.
- Store media bytes in local filesystem storage behind a constrained storage interface, not as database blobs.
- Use additive, versioned SQL migrations; do not alter a migration that has already been applied.
