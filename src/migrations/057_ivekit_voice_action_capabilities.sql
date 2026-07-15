-- Versioned, provider-specific call-control capabilities. Legacy snapshots remain
-- readable but their empty action matrix fails closed until the next preflight.
ALTER TABLE ivekit_voice_capability_snapshots
  ADD COLUMN IF NOT EXISTS capability_schema_version INTEGER NOT NULL DEFAULT 1
    CHECK (capability_schema_version = 1),
  ADD COLUMN IF NOT EXISTS action_capabilities JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(action_capabilities) = 'object');

COMMENT ON COLUMN ivekit_voice_capability_snapshots.capability_schema_version IS
  'Schema version for action_capabilities; currently version 1.';
COMMENT ON COLUMN ivekit_voice_capability_snapshots.action_capabilities IS
  'Fail-closed command and conference-operation support captured by provider preflight.';
