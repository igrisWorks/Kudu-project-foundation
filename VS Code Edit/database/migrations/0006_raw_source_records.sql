CREATE TABLE kudu.source_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES kudu.data_sources(id) ON DELETE RESTRICT,
  mapping_version integer CHECK (mapping_version IS NULL OR mapping_version > 0),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'paused', 'failed')),
  resumable boolean NOT NULL DEFAULT false,
  request_succeeded boolean NOT NULL DEFAULT false,
  config_fingerprint text NOT NULL CHECK (config_fingerprint ~ '^[a-f0-9]{64}$'),
  checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
  pages_completed integer NOT NULL DEFAULT 0 CHECK (pages_completed >= 0),
  fetched integer NOT NULL DEFAULT 0 CHECK (fetched >= 0),
  imported integer NOT NULL DEFAULT 0 CHECK (imported >= 0),
  duplicates integer NOT NULL DEFAULT 0 CHECK (duplicates >= 0),
  failed integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors) = 'array'),
  errors_truncated boolean NOT NULL DEFAULT false,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT source_sync_runs_completion_state CHECK (
    (status IN ('running', 'paused') AND completed_at IS NULL)
    OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
  )
);

INSERT INTO kudu.source_sync_runs (
  id, source_id, mapping_version, status, resumable, request_succeeded, config_fingerprint,
  checkpoint, pages_completed, fetched, imported, duplicates, failed, errors, errors_truncated,
  last_error_code, started_at, updated_at, completed_at
)
SELECT
  id, source_id, mapping_version, status, resumable, request_succeeded, config_fingerprint,
  checkpoint, pages_completed, fetched, imported, duplicates, failed, errors, errors_truncated,
  last_error_code, started_at, updated_at, completed_at
FROM kudu.data_source_sync_runs;

CREATE UNIQUE INDEX source_sync_runs_one_running_per_source
  ON kudu.source_sync_runs (source_id)
  WHERE status = 'running';
CREATE INDEX source_sync_runs_history_idx
  ON kudu.source_sync_runs (source_id, started_at DESC, id DESC);

CREATE TABLE kudu.source_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES kudu.data_sources(id) ON DELETE RESTRICT,
  source_record_id text,
  deduplication_key text NOT NULL CHECK (length(btrim(deduplication_key)) BETWEEN 1 AND 256),
  ingestion_fingerprint text NOT NULL CHECK (ingestion_fingerprint ~ '^[a-f0-9]{64}$'),
  raw_record jsonb NOT NULL CHECK (jsonb_typeof(raw_record) = 'object'),
  raw_bytes integer NOT NULL CHECK (raw_bytes >= 2),
  field_count integer NOT NULL CHECK (field_count >= 0),
  field_names jsonb NOT NULL CHECK (jsonb_typeof(field_names) = 'array'),
  preview jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(preview) = 'object'),
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
  processing_status text NOT NULL DEFAULT 'raw_only'
    CHECK (processing_status IN ('raw_only', 'normalized')),
  normalized_event_id uuid REFERENCES kudu.events(id) ON DELETE RESTRICT,
  sync_run_id uuid REFERENCES kudu.source_sync_runs(id) ON DELETE SET NULL,
  mapping_version integer CHECK (mapping_version IS NULL OR mapping_version > 0),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_records_normalized_link CHECK (
    (processing_status = 'normalized' AND normalized_event_id IS NOT NULL)
    OR (processing_status = 'raw_only' AND normalized_event_id IS NULL)
  )
);

CREATE UNIQUE INDEX source_records_source_deduplication_key_unique
  ON kudu.source_records (source_id, deduplication_key);
CREATE INDEX source_records_source_ingested_at_idx
  ON kudu.source_records (source_id, ingested_at DESC, id DESC);
CREATE INDEX source_records_normalized_event_idx
  ON kudu.source_records (normalized_event_id)
  WHERE normalized_event_id IS NOT NULL;
