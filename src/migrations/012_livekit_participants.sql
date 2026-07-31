CREATE TABLE IF NOT EXISTS livekit_participants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_name TEXT NOT NULL,
  identity TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'unknown' CHECK (role IN ('agent', 'customer', 'supervisor', 'ai', 'sip', 'unknown')),
  status TEXT NOT NULL DEFAULT 'joined' CHECK (status IN ('joined', 'left')),
  metadata TEXT NOT NULL DEFAULT '{}',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at TIMESTAMPTZ,
  UNIQUE(room_name, identity)
);

CREATE INDEX IF NOT EXISTS idx_livekit_participants_room
  ON livekit_participants(room_name, status, joined_at);

CREATE INDEX IF NOT EXISTS idx_livekit_participants_tenant
  ON livekit_participants(tenant_id, joined_at DESC);

ALTER TABLE livekit_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE livekit_participants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON livekit_participants;
CREATE POLICY tenant_isolation ON livekit_participants FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
