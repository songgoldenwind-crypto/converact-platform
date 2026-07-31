CREATE TABLE IF NOT EXISTS collaboration_provider_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL REFERENCES collaboration_chat_bindings(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, session_id, provider, identity),
  UNIQUE (tenant_id, session_id, provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_provider_users_lookup
  ON collaboration_provider_users(tenant_id, provider, provider_user_id, status);

CREATE TABLE IF NOT EXISTS tinode_inbound_cursors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL REFERENCES collaboration_chat_bindings(id) ON DELETE CASCADE,
  provider_topic_id TEXT NOT NULL,
  last_data_seq BIGINT NOT NULL DEFAULT 0 CHECK (last_data_seq >= 0),
  last_del_id BIGINT NOT NULL DEFAULT 0 CHECK (last_del_id >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'paused')),
  lease_token_hash TEXT NOT NULL DEFAULT ''
    CHECK (lease_token_hash = '' OR char_length(lease_token_hash) = 64),
  lease_until TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  next_retry_at TIMESTAMPTZ,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  last_success_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, binding_id)
);

CREATE INDEX IF NOT EXISTS idx_tinode_inbound_cursors_due
  ON tinode_inbound_cursors(tenant_id, status, next_retry_at, lease_until, updated_at);

CREATE TABLE IF NOT EXISTS tinode_inbound_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL REFERENCES collaboration_chat_bindings(id) ON DELETE CASCADE,
  provider_topic_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('data', 'delete')),
  provider_sequence BIGINT NOT NULL DEFAULT 0 CHECK (provider_sequence >= 0),
  provider_delete_id BIGINT NOT NULL DEFAULT 0 CHECK (provider_delete_id >= 0),
  dedupe_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'projected', 'dead_letter', 'ignored')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_token_hash TEXT NOT NULL DEFAULT ''
    CHECK (claim_token_hash = '' OR char_length(claim_token_hash) = 64),
  lease_until TIMESTAMPTZ,
  message_id TEXT REFERENCES collaboration_messages(id) ON DELETE SET NULL,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, binding_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_tinode_inbound_events_status
  ON tinode_inbound_events(tenant_id, status, received_at, id);

CREATE TABLE IF NOT EXISTS tinode_inbound_dead_letters (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL REFERENCES collaboration_chat_bindings(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES tinode_inbound_events(id) ON DELETE CASCADE,
  error_code TEXT NOT NULL,
  error_message TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_tinode_inbound_dead_letters_retry
  ON tinode_inbound_dead_letters(tenant_id, retryable, next_retry_at, created_at);

ALTER TABLE collaboration_messages
  ADD COLUMN IF NOT EXISTS provider_origin TEXT NOT NULL DEFAULT ''
    CHECK (provider_origin IN ('', 'ivekit', 'tinode')),
  ADD COLUMN IF NOT EXISTS provider_sequence BIGINT NOT NULL DEFAULT 0
    CHECK (provider_sequence >= 0),
  ADD COLUMN IF NOT EXISTS provider_version BIGINT NOT NULL DEFAULT 0
    CHECK (provider_version >= 0),
  ADD COLUMN IF NOT EXISTS provider_sender_id TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_collaboration_messages_provider_sequence
  ON collaboration_messages(tenant_id, provider, provider_topic_id, provider_sequence)
  WHERE provider = 'tinode' AND provider_sequence > 0;

CREATE INDEX IF NOT EXISTS idx_collaboration_messages_provider_sender
  ON collaboration_messages(tenant_id, provider, provider_topic_id, provider_sender_id, provider_sequence);

ALTER TABLE collaboration_provider_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_provider_users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_provider_users;
CREATE POLICY tenant_isolation ON collaboration_provider_users FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE tinode_inbound_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE tinode_inbound_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tinode_inbound_cursors;
CREATE POLICY tenant_isolation ON tinode_inbound_cursors FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE tinode_inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tinode_inbound_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tinode_inbound_events;
CREATE POLICY tenant_isolation ON tinode_inbound_events FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE tinode_inbound_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE tinode_inbound_dead_letters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tinode_inbound_dead_letters;
CREATE POLICY tenant_isolation ON tinode_inbound_dead_letters FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE OR REPLACE FUNCTION opc_tinode_inbound_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT binding.tenant_id
  FROM public.collaboration_chat_bindings AS binding
  LEFT JOIN public.tinode_inbound_cursors AS cursor
    ON cursor.tenant_id = binding.tenant_id
   AND cursor.binding_id = binding.id
  WHERE binding.provider = 'tinode'
    AND binding.provider_status = 'bound'
    AND (
      cursor.id IS NULL
      OR (
        cursor.status IN ('active', 'error')
        AND (cursor.next_retry_at IS NULL OR cursor.next_retry_at <= p_now)
        AND (cursor.lease_until IS NULL OR cursor.lease_until <= p_now)
      )
    )
  GROUP BY binding.tenant_id
  ORDER BY min(coalesce(cursor.next_retry_at, cursor.updated_at, binding.created_at))
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

REVOKE ALL ON FUNCTION opc_tinode_inbound_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_tinode_inbound_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
  END IF;
END
$$;
