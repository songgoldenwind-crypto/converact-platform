CREATE TABLE IF NOT EXISTS tinode_message_mutation_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  mutation_id TEXT NOT NULL REFERENCES collaboration_message_mutations(id) ON DELETE CASCADE,
  mutation_version INTEGER NOT NULL CHECK (mutation_version > 0),
  action TEXT NOT NULL CHECK (action IN ('edit', 'delete')),
  provider_topic_id TEXT NOT NULL,
  target_provider_message_id TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry_wait', 'delivered', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at TIMESTAMPTZ,
  claim_token TEXT NOT NULL DEFAULT '',
  claimed_until TIMESTAMPTZ,
  provider_operation_id TEXT NOT NULL DEFAULT '',
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, mutation_id),
  UNIQUE (tenant_id, message_id, mutation_version)
);

CREATE INDEX IF NOT EXISTS idx_tinode_message_mutation_due
  ON tinode_message_mutation_outbox(status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'retry_wait', 'processing');

CREATE INDEX IF NOT EXISTS idx_tinode_message_mutation_message
  ON tinode_message_mutation_outbox(tenant_id, message_id, mutation_version);

CREATE TABLE IF NOT EXISTS tinode_message_mutation_replays (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outbox_id TEXT NOT NULL REFERENCES tinode_message_mutation_outbox(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  requested_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE tinode_message_mutation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE tinode_message_mutation_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tinode_message_mutation_outbox;
CREATE POLICY tenant_isolation ON tinode_message_mutation_outbox FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE tinode_message_mutation_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE tinode_message_mutation_replays FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tinode_message_mutation_replays;
CREATE POLICY tenant_isolation ON tinode_message_mutation_replays FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE OR REPLACE FUNCTION opc_tinode_mutation_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT outbox.tenant_id
  FROM public.tinode_message_mutation_outbox AS outbox
  JOIN public.collaboration_messages AS message
    ON message.id = outbox.message_id AND message.tenant_id = outbox.tenant_id
  WHERE message.provider = 'tinode'
    AND message.provider_message_id <> ''
    AND outbox.attempt_count < outbox.max_attempts
    AND (
      outbox.status = 'pending'
      OR (outbox.status = 'retry_wait' AND (outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= p_now))
      OR (outbox.status = 'processing' AND outbox.claimed_until <= p_now)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.tinode_message_mutation_outbox AS earlier
      WHERE earlier.tenant_id = outbox.tenant_id
        AND earlier.message_id = outbox.message_id
        AND earlier.mutation_version < outbox.mutation_version
        AND earlier.status <> 'delivered'
    )
  GROUP BY outbox.tenant_id
  ORDER BY min(coalesce(outbox.next_attempt_at, outbox.created_at))
  LIMIT least(greatest(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION opc_tinode_mutation_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_tinode_mutation_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
  END IF;
END
$$;
