CREATE TABLE kudu.data_source_event_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES kudu.data_sources(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'retired')),
  definition jsonb NOT NULL
    CHECK (jsonb_typeof(definition) = 'object'),
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(validation_errors) = 'array'),
  validated_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_source_event_mappings_source_version_unique UNIQUE (source_id, version),
  CONSTRAINT data_source_event_mappings_activation_state CHECK (
    (status = 'draft' AND activated_at IS NULL)
    OR (status IN ('active', 'retired') AND activated_at IS NOT NULL)
  ),
  CONSTRAINT data_source_event_mappings_active_valid CHECK (
    status <> 'active'
    OR (validated_at IS NOT NULL AND jsonb_array_length(validation_errors) = 0)
  )
);

CREATE UNIQUE INDEX data_source_event_mappings_one_active_per_source
  ON kudu.data_source_event_mappings (source_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX data_source_event_mappings_one_draft_per_source
  ON kudu.data_source_event_mappings (source_id)
  WHERE status = 'draft';
CREATE INDEX data_source_event_mappings_history_idx
  ON kudu.data_source_event_mappings (source_id, version DESC);
