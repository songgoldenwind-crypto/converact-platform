CREATE TABLE IF NOT EXISTS collaboration_message_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  identity TEXT NOT NULL,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'ivekit'
    CHECK (source IN ('ivekit', 'tinode', 'system')),
  provider_sequence BIGINT NOT NULL DEFAULT 0 CHECK (provider_sequence >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, message_id, identity)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_message_receipts_session_identity
  ON collaboration_message_receipts(tenant_id, session_id, identity, read_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_collaboration_message_receipts_message
  ON collaboration_message_receipts(tenant_id, message_id, updated_at DESC);

ALTER TABLE collaboration_message_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_message_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_message_receipts;
CREATE POLICY tenant_isolation ON collaboration_message_receipts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE TABLE IF NOT EXISTS collaboration_participant_realtime_state (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  identity TEXT NOT NULL,
  presence_status TEXT NOT NULL DEFAULT 'offline'
    CHECK (presence_status IN ('online', 'away', 'offline')),
  presence_expires_at TIMESTAMPTZ,
  typing_expires_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, session_id, identity)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_participant_realtime_session
  ON collaboration_participant_realtime_state(tenant_id, session_id, updated_at DESC);

ALTER TABLE collaboration_participant_realtime_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_participant_realtime_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_participant_realtime_state;
CREATE POLICY tenant_isolation ON collaboration_participant_realtime_state FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE collaboration_messages
  ADD COLUMN IF NOT EXISTS current_body TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS edit_version INTEGER NOT NULL DEFAULT 0 CHECK (edit_version >= 0),
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT NOT NULL DEFAULT '';

UPDATE collaboration_messages
SET current_body = body
WHERE current_body = '' AND body <> '';

CREATE INDEX IF NOT EXISTS idx_collaboration_messages_state_order
  ON collaboration_messages(tenant_id, session_id, created_at, id);

CREATE TABLE IF NOT EXISTS collaboration_message_mutations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  action TEXT NOT NULL CHECK (action IN ('edit', 'delete')),
  actor_identity TEXT NOT NULL,
  before_body_hash TEXT NOT NULL CHECK (char_length(before_body_hash) = 64),
  after_body_hash TEXT NOT NULL CHECK (char_length(after_body_hash) = 64),
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, message_id, version)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_message_mutations_message
  ON collaboration_message_mutations(tenant_id, message_id, version ASC);

ALTER TABLE collaboration_message_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_message_mutations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_message_mutations;
CREATE POLICY tenant_isolation ON collaboration_message_mutations FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
