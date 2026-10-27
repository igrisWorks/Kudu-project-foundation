CREATE TABLE kudu.assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_key text NOT NULL,
  name text NOT NULL,
  asset_type text NOT NULL,
  description text,
  parent_asset_id uuid REFERENCES kudu.assets(id) ON DELETE RESTRICT,
  external_identifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT assets_key_format CHECK (asset_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  CONSTRAINT assets_name_nonempty CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT assets_type_valid CHECK (
    asset_type IN ('machine', 'production_line', 'plc', 'camera', 'sensor', 'other')
  ),
  CONSTRAINT assets_description_length CHECK (description IS NULL OR length(description) <= 2000),
  CONSTRAINT assets_external_identifiers_array CHECK (
    jsonb_typeof(external_identifiers) = 'array'
  )
);

CREATE UNIQUE INDEX assets_asset_key_case_insensitive_unique
  ON kudu.assets (lower(asset_key));
CREATE INDEX assets_parent_asset_id_idx ON kudu.assets (parent_asset_id);
CREATE INDEX assets_archived_at_idx ON kudu.assets (archived_at);

CREATE TABLE kudu.data_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL,
  display_name text NOT NULL,
  source_type text NOT NULL,
  description text,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  connection_status text NOT NULL DEFAULT 'not_implemented',
  ingestion_status text NOT NULL DEFAULT 'not_implemented',
  last_successful_sync_at timestamptz,
  last_error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_sources_key_format CHECK (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  CONSTRAINT data_sources_name_nonempty CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  CONSTRAINT data_sources_type_valid CHECK (
    source_type IN ('rest_api', 'json_file', 'csv_file', 'manual')
  ),
  CONSTRAINT data_sources_description_length CHECK (description IS NULL OR length(description) <= 2000),
  CONSTRAINT data_sources_configuration_object CHECK (jsonb_typeof(configuration) = 'object'),
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
  ON kudu.data_sources (lower(source_key));
CREATE INDEX data_sources_type_enabled_idx
  ON kudu.data_sources (source_type, enabled);
