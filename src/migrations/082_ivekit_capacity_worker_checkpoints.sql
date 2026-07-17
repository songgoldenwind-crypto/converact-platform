ALTER TABLE ivekit_capacity_load_shards
  ADD COLUMN IF NOT EXISTS execution_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (execution_state IN ('pending', 'running', 'result_ready')),
  ADD COLUMN IF NOT EXISTS execution_result JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(execution_result) = 'object'),
  ADD COLUMN IF NOT EXISTS execution_result_sha256 TEXT NOT NULL DEFAULT ''
    CHECK (
      execution_result_sha256 = ''
      OR execution_result_sha256 ~ '^[a-f0-9]{64}$'
    );

UPDATE ivekit_capacity_load_shards
SET execution_state = 'running'
WHERE state = 'running' AND execution_state = 'pending';

CREATE INDEX IF NOT EXISTS idx_ivekit_capacity_load_shards_worker_outstanding
  ON ivekit_capacity_load_shards
    (run_id, phase_id, lease_owner, fleet_id, state, lease_expires_at)
  WHERE state IN ('leased', 'running');
