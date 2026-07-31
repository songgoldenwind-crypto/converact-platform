ALTER TABLE ivekit_capacity_load_shards
  ADD COLUMN IF NOT EXISTS covered_workloads JSONB NOT NULL DEFAULT '[]'::JSONB
    CHECK (jsonb_typeof(covered_workloads) = 'array');
