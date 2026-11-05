CREATE TABLE source_sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE RESTRICT,
  mapping_version INTEGER CHECK (mapping_version IS NULL OR mapping_version > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'paused', 'failed')),
  resumable INTEGER NOT NULL DEFAULT 0 CHECK (resumable IN (0, 1)),
  request_succeeded INTEGER NOT NULL DEFAULT 0 CHECK (request_succeeded IN (0, 1)),
  config_fingerprint TEXT NOT NULL
    CHECK (length(config_fingerprint) = 64 AND config_fingerprint NOT GLOB '*[^a-f0-9]*'),
  checkpoint TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(checkpoint) AND json_type(checkpoint) = 'object'),
  pages_completed INTEGER NOT NULL DEFAULT 0 CHECK (pages_completed >= 0),
  fetched INTEGER NOT NULL DEFAULT 0 CHECK (fetched >= 0),
  imported INTEGER NOT NULL DEFAULT 0 CHECK (imported >= 0),
  duplicates INTEGER NOT NULL DEFAULT 0 CHECK (duplicates >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  errors TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(errors) AND json_type(errors) = 'array'),
  errors_truncated INTEGER NOT NULL DEFAULT 0 CHECK (errors_truncated IN (0, 1)),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  CONSTRAINT source_sync_runs_completion_state CHECK (
    (status IN ('running', 'paused') AND completed_at IS NULL)
    OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
  )
);

INSERT INTO source_sync_runs (
  id, source_id, mapping_version, status, resumable, request_succeeded, config_fingerprint,
  checkpoint, pages_completed, fetched, imported, duplicates, failed, errors, errors_truncated,
  last_error_code, started_at, updated_at, completed_at
)
SELECT
  id, source_id, mapping_version, status, resumable, request_succeeded, config_fingerprint,
  checkpoint, pages_completed, fetched, imported, duplicates, failed, errors, errors_truncated,
  last_error_code, started_at, updated_at, completed_at
FROM data_source_sync_runs;

CREATE UNIQUE INDEX source_sync_runs_one_running_per_source
  ON source_sync_runs (source_id)
  WHERE status = 'running';
CREATE INDEX source_sync_runs_history_idx
  ON source_sync_runs (source_id, started_at DESC, id DESC);

CREATE TABLE source_records (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE RESTRICT,
  source_record_id TEXT,
  deduplication_key TEXT NOT NULL
    CHECK (length(trim(deduplication_key)) BETWEEN 1 AND 256),
  ingestion_fingerprint TEXT NOT NULL
    CHECK (length(ingestion_fingerprint) = 64 AND ingestion_fingerprint NOT GLOB '*[^a-f0-9]*'),
  raw_record TEXT NOT NULL CHECK (json_valid(raw_record) AND json_type(raw_record) = 'object'),
  raw_bytes INTEGER NOT NULL CHECK (raw_bytes >= 2),
  field_count INTEGER NOT NULL CHECK (field_count >= 0),
  field_names TEXT NOT NULL CHECK (json_valid(field_names) AND json_type(field_names) = 'array'),
  preview TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(preview) AND json_type(preview) = 'object'),
  provenance TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(provenance) AND json_type(provenance) = 'object'),
  processing_status TEXT NOT NULL DEFAULT 'raw_only'
    CHECK (processing_status IN ('raw_only', 'normalized')),
  normalized_event_id TEXT REFERENCES events(id) ON DELETE RESTRICT,
  sync_run_id TEXT REFERENCES source_sync_runs(id) ON DELETE SET NULL,
  mapping_version INTEGER CHECK (mapping_version IS NULL OR mapping_version > 0),
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT source_records_normalized_link CHECK (
    (processing_status = 'normalized' AND normalized_event_id IS NOT NULL)
    OR (processing_status = 'raw_only' AND normalized_event_id IS NULL)
  )
);
CREATE UNIQUE INDEX source_records_source_deduplication_key_unique
  ON source_records (source_id, deduplication_key);
CREATE INDEX source_records_source_ingested_at_idx
  ON source_records (source_id, ingested_at DESC, id DESC);
CREATE INDEX source_records_normalized_event_idx
  ON source_records (normalized_event_id)
  WHERE normalized_event_id IS NOT NULL;
