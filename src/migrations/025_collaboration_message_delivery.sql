ALTER TABLE collaboration_messages
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS idempotency_payload_hash TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS provider_topic_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider_payload TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider_delivery_metadata TEXT NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS provider_delivery_status TEXT NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS provider_delivery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_delivery_claim_token_hash TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider_delivery_lease_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_last_error_code TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider_last_error_message TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider_delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_delivery_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'collaboration_messages_provider_delivery_status_check'
  ) THEN
    ALTER TABLE collaboration_messages
      ADD CONSTRAINT collaboration_messages_provider_delivery_status_check
      CHECK (provider_delivery_status IN ('not_required', 'pending', 'publishing', 'retry_wait', 'delivered', 'failed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'collaboration_messages_provider_delivery_attempts_check'
  ) THEN
    ALTER TABLE collaboration_messages
      ADD CONSTRAINT collaboration_messages_provider_delivery_attempts_check
      CHECK (provider_delivery_attempts >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_messages_idempotency
  ON collaboration_messages(tenant_id, session_id, idempotency_key)
  WHERE idempotency_key <> '';

CREATE INDEX IF NOT EXISTS idx_collaboration_messages_provider_due
  ON collaboration_messages(provider_delivery_status, provider_next_attempt_at, created_at)
  WHERE provider = 'tinode'
    AND provider_delivery_status IN ('pending', 'publishing', 'retry_wait');

CREATE TABLE IF NOT EXISTS collaboration_message_delivery_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'delivered', 'retry_wait', 'failed', 'lease_expired')),
  provider_message_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  metadata TEXT NOT NULL DEFAULT '{}',
  UNIQUE (message_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_message_delivery_attempts_message
  ON collaboration_message_delivery_attempts(tenant_id, message_id, attempt_number);

ALTER TABLE collaboration_message_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_message_delivery_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_message_delivery_attempts;
CREATE POLICY tenant_isolation ON collaboration_message_delivery_attempts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
