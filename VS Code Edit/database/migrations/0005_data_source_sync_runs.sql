CREATE TABLE kudu.data_source_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES kudu.data_sources(id) ON DELETE RESTRICT,
  mapping_version integer NOT NULL CHECK (mapping_version > 0),
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
  CONSTRAINT data_source_sync_runs_completion_state CHECK (
    (status IN ('running', 'paused') AND completed_at IS NULL)
    OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX data_source_sync_runs_one_running_per_source
  ON kudu.data_source_sync_runs (source_id)
  WHERE status = 'running';
CREATE INDEX data_source_sync_runs_history_idx
  ON kudu.data_source_sync_runs (source_id, started_at DESC, id DESC);
