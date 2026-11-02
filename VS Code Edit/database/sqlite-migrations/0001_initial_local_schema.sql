CREATE TABLE assets (
  id TEXT PRIMARY KEY NOT NULL,
  asset_key TEXT NOT NULL,
  name TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  description TEXT,
  parent_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  external_identifiers TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(external_identifiers) AND json_type(external_identifiers) = 'array'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at TEXT,
  CONSTRAINT assets_key_format CHECK (
    length(asset_key) BETWEEN 1 AND 80
    AND asset_key GLOB '[A-Za-z0-9]*'
    AND asset_key NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  CONSTRAINT assets_name_nonempty CHECK (length(trim(name)) BETWEEN 1 AND 160),
  CONSTRAINT assets_type_valid CHECK (
    asset_type IN ('machine', 'production_line', 'plc', 'camera', 'sensor', 'other')
  ),
  CONSTRAINT assets_description_length CHECK (description IS NULL OR length(description) <= 2000)
);

CREATE UNIQUE INDEX assets_asset_key_case_insensitive_unique
  ON assets (lower(asset_key));
CREATE INDEX assets_parent_asset_id_idx ON assets (parent_asset_id);
CREATE INDEX assets_archived_at_idx ON assets (archived_at);

CREATE TABLE data_sources (
  id TEXT PRIMARY KEY NOT NULL,
  source_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  description TEXT,
  configuration TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(configuration) AND json_type(configuration) = 'object'),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  connection_status TEXT NOT NULL DEFAULT 'not_implemented',
  ingestion_status TEXT NOT NULL DEFAULT 'not_implemented',
  last_successful_sync_at TEXT,
  last_error_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT data_sources_key_format CHECK (
    length(source_key) BETWEEN 1 AND 80
    AND source_key GLOB '[A-Za-z0-9]*'
    AND source_key NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  CONSTRAINT data_sources_name_nonempty CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  CONSTRAINT data_sources_type_valid CHECK (
    source_type IN ('rest_api', 'json_file', 'csv_file', 'manual')
  ),
  CONSTRAINT data_sources_description_length CHECK (description IS NULL OR length(description) <= 2000),
  CONSTRAINT data_sources_connection_status_valid CHECK (
    connection_status IN ('not_implemented', 'connected', 'error', 'unsupported')
  ),
  CONSTRAINT data_sources_ingestion_status_valid CHECK (
    ingestion_status IN ('not_implemented', 'connected', 'error', 'unsupported')
  ),
  CONSTRAINT data_sources_error_summary_length CHECK (
    last_error_summary IS NULL OR length(last_error_summary) <= 1000
  )
);

CREATE UNIQUE INDEX data_sources_source_key_case_insensitive_unique
  ON data_sources (lower(source_key));
CREATE INDEX data_sources_type_enabled_idx
  ON data_sources (source_type, enabled);

CREATE TABLE events (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE RESTRICT,
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  source_record_id TEXT,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  source_timestamp TEXT NOT NULL,
  deduplication_key TEXT,
  ingestion_fingerprint TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  provenance TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(provenance) AND json_type(provenance) = 'object'),
  CONSTRAINT events_source_record_id_length CHECK (
    source_record_id IS NULL OR length(trim(source_record_id)) BETWEEN 1 AND 256
  ),
  CONSTRAINT events_type_format CHECK (
    length(event_type) BETWEEN 1 AND 120
    AND event_type GLOB '[A-Za-z0-9]*'
    AND event_type NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CONSTRAINT events_source_timestamp_length CHECK (
    length(trim(source_timestamp)) BETWEEN 1 AND 256
  ),
  CONSTRAINT events_deduplication_key_length CHECK (
    deduplication_key IS NULL OR length(trim(deduplication_key)) BETWEEN 1 AND 256
  ),
  CONSTRAINT events_fingerprint_format CHECK (
    ingestion_fingerprint IS NULL
    OR (length(ingestion_fingerprint) = 64 AND ingestion_fingerprint NOT GLOB '*[^a-f0-9]*')
  ),
  CONSTRAINT events_dedupe_fingerprint_pair CHECK (
    (deduplication_key IS NULL) = (ingestion_fingerprint IS NULL)
  )
);

CREATE UNIQUE INDEX events_source_deduplication_key_unique
  ON events (source_id, deduplication_key)
  WHERE deduplication_key IS NOT NULL;
CREATE INDEX events_occurred_at_idx ON events (occurred_at DESC, id DESC);
CREATE INDEX events_source_occurred_at_idx ON events (source_id, occurred_at DESC, id DESC);
CREATE INDEX events_asset_occurred_at_idx
  ON events (asset_id, occurred_at DESC, id DESC)
  WHERE asset_id IS NOT NULL;
CREATE INDEX events_type_occurred_at_idx ON events (event_type, occurred_at DESC, id DESC);

CREATE TABLE data_source_event_mappings (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  definition TEXT NOT NULL
    CHECK (json_valid(definition) AND json_type(definition) = 'object'),
  validation_errors TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(validation_errors) AND json_type(validation_errors) = 'array'),
  validated_at TEXT,
  activated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT data_source_event_mappings_source_version_unique UNIQUE (source_id, version),
  CONSTRAINT data_source_event_mappings_activation_state CHECK (
    (status = 'draft' AND activated_at IS NULL)
    OR (status IN ('active', 'retired') AND activated_at IS NOT NULL)
  ),
  CONSTRAINT data_source_event_mappings_active_valid CHECK (
    status <> 'active'
    OR (validated_at IS NOT NULL AND json_array_length(validation_errors) = 0)
  )
);

CREATE UNIQUE INDEX data_source_event_mappings_one_active_per_source
  ON data_source_event_mappings (source_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX data_source_event_mappings_one_draft_per_source
  ON data_source_event_mappings (source_id)
  WHERE status = 'draft';
CREATE INDEX data_source_event_mappings_history_idx
  ON data_source_event_mappings (source_id, version DESC);

CREATE TABLE app_write_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL DEFAULT 0
);
INSERT INTO app_write_lock (id, value) VALUES (1, 0);
