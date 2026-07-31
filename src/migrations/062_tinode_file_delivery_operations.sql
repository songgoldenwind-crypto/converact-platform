ALTER TABLE collaboration_messages
  DROP CONSTRAINT IF EXISTS collaboration_messages_provider_delivery_status_check;

ALTER TABLE collaboration_messages
  ADD CONSTRAINT collaboration_messages_provider_delivery_status_check
  CHECK (provider_delivery_status IN (
    'not_required', 'pending', 'blocked_by_file_security', 'blocked',
    'publishing', 'retry_wait', 'delivered', 'failed'
  ));

DROP INDEX IF EXISTS idx_collaboration_messages_provider_due;
CREATE INDEX idx_collaboration_messages_provider_due
  ON collaboration_messages(provider_delivery_status, provider_next_attempt_at, created_at)
  WHERE provider = 'tinode'
    AND provider_delivery_status IN ('pending', 'publishing', 'retry_wait');

CREATE INDEX IF NOT EXISTS idx_collaboration_messages_file_security_blocked
  ON collaboration_messages(tenant_id, provider_delivery_status, provider_delivery_updated_at, id)
  WHERE provider = 'tinode'
    AND provider_delivery_status IN ('blocked_by_file_security', 'blocked');

CREATE INDEX IF NOT EXISTS idx_tinode_inbound_cursors_operations
  ON tinode_inbound_cursors(tenant_id, updated_at, id);

CREATE INDEX IF NOT EXISTS idx_tinode_inbound_dead_letters_operations
  ON tinode_inbound_dead_letters(tenant_id, resolved_at, created_at, id);

CREATE TABLE IF NOT EXISTS tinode_inbound_dead_letter_replays (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dead_letter_id TEXT NOT NULL REFERENCES tinode_inbound_dead_letters(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  requested_by TEXT NOT NULL CHECK (char_length(requested_by) BETWEEN 1 AND 255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_tinode_dead_letter_replays_target
  ON tinode_inbound_dead_letter_replays(tenant_id, dead_letter_id, created_at, id);

ALTER TABLE tinode_inbound_dead_letter_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE tinode_inbound_dead_letter_replays FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tinode_inbound_dead_letter_replays;
CREATE POLICY tenant_isolation ON tinode_inbound_dead_letter_replays FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE OR REPLACE FUNCTION opc_tinode_delivery_worker_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(tenant_id TEXT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT message.tenant_id
  FROM public.collaboration_messages AS message
  WHERE message.provider = 'tinode'
    AND (
      message.provider_delivery_status IN ('pending', 'blocked_by_file_security')
      OR (
        message.provider_delivery_status = 'retry_wait'
        AND (message.provider_next_attempt_at IS NULL OR message.provider_next_attempt_at <= p_now)
      )
      OR (
        message.provider_delivery_status = 'publishing'
        AND message.provider_delivery_lease_until <= p_now
      )
    )
  GROUP BY message.tenant_id
  ORDER BY MIN(COALESCE(message.provider_next_attempt_at, message.created_at)), message.tenant_id
  LIMIT GREATEST(1, LEAST(p_limit, 1000))
$$;

REVOKE ALL ON FUNCTION opc_tinode_delivery_worker_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON tinode_inbound_dead_letter_replays TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_tinode_delivery_worker_tenant_ids(TIMESTAMPTZ, INTEGER)
      TO opc_runtime;
  END IF;
END
$$;
