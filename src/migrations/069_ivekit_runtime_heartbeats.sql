CREATE TABLE IF NOT EXISTS ivekit_runtime_heartbeats (
  instance_id TEXT PRIMARY KEY CHECK (char_length(instance_id) BETWEEN 1 AND 255),
  source_commit TEXT NOT NULL DEFAULT '' CHECK (
    source_commit = '' OR source_commit ~ '^[a-f0-9]{40}$'
  ),
  state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'draining', 'stopped')),
  components JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(components) = 'array'),
  started_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ivekit_runtime_heartbeats_freshness
  ON ivekit_runtime_heartbeats(state, heartbeat_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_runtime_heartbeats TO opc_runtime;
  END IF;
END
$$;
