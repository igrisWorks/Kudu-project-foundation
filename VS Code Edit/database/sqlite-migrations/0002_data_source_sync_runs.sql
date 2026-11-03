CREATE TABLE data_source_sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE RESTRICT,
  mapping_version INTEGER NOT NULL CHECK (mapping_version > 0),
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
  CONSTRAINT data_source_sync_runs_completion_state CHECK (
    (status IN ('running', 'paused') AND completed_at IS NULL)
    OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX data_source_sync_runs_one_running_per_source
  ON data_source_sync_runs (source_id)
  WHERE status = 'running';
CREATE INDEX data_source_sync_runs_history_idx
  ON data_source_sync_runs (source_id, started_at DESC, id DESC);
