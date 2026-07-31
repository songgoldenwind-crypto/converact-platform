CREATE TABLE IF NOT EXISTS rustdesk_gateway_sessions (
  external_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'system',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  target_type TEXT NOT NULL DEFAULT 'device',
  target_id TEXT NOT NULL,
  target_display_name TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  actor_identity TEXT NOT NULL DEFAULT '',
  launch_url TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMPTZ,
  ended_by TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_rustdesk_gateway_sessions_tenant_created
  ON rustdesk_gateway_sessions(tenant_id, created_at DESC);
