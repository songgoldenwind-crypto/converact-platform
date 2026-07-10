CREATE TABLE IF NOT EXISTS rustdesk_gateway_events (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL REFERENCES rustdesk_gateway_sessions(external_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT 'system',
  event_type TEXT NOT NULL,
  actor_identity TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rustdesk_gateway_events_session_time
  ON rustdesk_gateway_events(external_id, occurred_at ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_rustdesk_gateway_events_tenant_time
  ON rustdesk_gateway_events(tenant_id, occurred_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rustdesk_gateway_events_idempotency
  ON rustdesk_gateway_events(external_id, idempotency_key)
  WHERE idempotency_key <> '';
