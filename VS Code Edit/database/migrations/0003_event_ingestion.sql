CREATE TABLE kudu.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES kudu.data_sources(id) ON DELETE RESTRICT,
  asset_id uuid REFERENCES kudu.assets(id) ON DELETE SET NULL,
  source_record_id text,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  source_timestamp text NOT NULL,
  deduplication_key text,
  ingestion_fingerprint text,
  payload jsonb NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT events_source_record_id_length CHECK (
    source_record_id IS NULL OR length(btrim(source_record_id)) BETWEEN 1 AND 256
  ),
  CONSTRAINT events_type_format CHECK (
    event_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
  ),
  CONSTRAINT events_source_timestamp_length CHECK (
    length(btrim(source_timestamp)) BETWEEN 1 AND 256
  ),
  CONSTRAINT events_deduplication_key_length CHECK (
    deduplication_key IS NULL OR length(btrim(deduplication_key)) BETWEEN 1 AND 256
  ),
  CONSTRAINT events_fingerprint_format CHECK (
    ingestion_fingerprint IS NULL OR ingestion_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT events_dedupe_fingerprint_pair CHECK (
    (deduplication_key IS NULL) = (ingestion_fingerprint IS NULL)
  ),
  CONSTRAINT events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT events_provenance_object CHECK (jsonb_typeof(provenance) = 'object')
);

CREATE UNIQUE INDEX events_source_deduplication_key_unique
  ON kudu.events (source_id, deduplication_key)
  WHERE deduplication_key IS NOT NULL;
CREATE INDEX events_occurred_at_idx
  ON kudu.events (occurred_at DESC, id DESC);
CREATE INDEX events_source_occurred_at_idx
  ON kudu.events (source_id, occurred_at DESC, id DESC);
CREATE INDEX events_asset_occurred_at_idx
  ON kudu.events (asset_id, occurred_at DESC, id DESC)
  WHERE asset_id IS NOT NULL;
CREATE INDEX events_type_occurred_at_idx
  ON kudu.events (event_type, occurred_at DESC, id DESC);
