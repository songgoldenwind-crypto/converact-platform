ALTER TABLE collaboration_messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id TEXT REFERENCES collaboration_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS forwarded_from_message_id TEXT REFERENCES collaboration_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_collaboration_messages_reply
  ON collaboration_messages(tenant_id, session_id, reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_collaboration_messages_forward
  ON collaboration_messages(tenant_id, session_id, forwarded_from_message_id)
  WHERE forwarded_from_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS collaboration_message_reactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  identity TEXT NOT NULL,
  emoji TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, message_id, identity, emoji)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_message_reactions_message
  ON collaboration_message_reactions(tenant_id, session_id, message_id, created_at ASC);

ALTER TABLE collaboration_message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_message_reactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_message_reactions;
CREATE POLICY tenant_isolation ON collaboration_message_reactions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE TABLE IF NOT EXISTS collaboration_message_pins (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  pinned_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, session_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_message_pins_session
  ON collaboration_message_pins(tenant_id, session_id, created_at DESC, id DESC);

ALTER TABLE collaboration_message_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_message_pins FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_message_pins;
CREATE POLICY tenant_isolation ON collaboration_message_pins FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
