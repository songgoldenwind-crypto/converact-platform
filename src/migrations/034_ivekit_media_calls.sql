CREATE TABLE IF NOT EXISTS ivekit_media_calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_name TEXT NOT NULL,
  media TEXT NOT NULL CHECK (media IN ('voice', 'video')),
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'ringing', 'accepted', 'active', 'rejected', 'cancelled', 'timed_out', 'ended', 'failed')),
  initiated_by TEXT NOT NULL,
  business_ref_type TEXT NOT NULL,
  business_ref_id TEXT NOT NULL,
  business_ref_display_name TEXT NOT NULL DEFAULT '',
  business_ref_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  title TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ring_timeout_seconds INTEGER NOT NULL DEFAULT 30 CHECK (ring_timeout_seconds BETWEEN 5 AND 300),
  ring_expires_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  end_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, room_name)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_media_calls_business_ref
  ON ivekit_media_calls(tenant_id, business_ref_type, business_ref_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ivekit_media_calls_room
  ON ivekit_media_calls(tenant_id, room_name);
CREATE INDEX IF NOT EXISTS idx_ivekit_media_calls_status_expiry
  ON ivekit_media_calls(tenant_id, status, ring_expires_at);

ALTER TABLE ivekit_media_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_media_calls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_media_calls;
CREATE POLICY tenant_isolation ON ivekit_media_calls FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE TABLE IF NOT EXISTS ivekit_media_call_participants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('host', 'participant', 'observer')),
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'ringing', 'accepted', 'joined', 'declined', 'left', 'missed', 'removed')),
  display_name TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, call_id) REFERENCES ivekit_media_calls(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, call_id, identity)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_media_call_participants_identity
  ON ivekit_media_call_participants(tenant_id, identity, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ivekit_media_call_participants_call
  ON ivekit_media_call_participants(tenant_id, call_id, invited_at, id);

ALTER TABLE ivekit_media_call_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_media_call_participants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_media_call_participants;
CREATE POLICY tenant_isolation ON ivekit_media_call_participants FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE TABLE IF NOT EXISTS ivekit_media_call_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  action TEXT NOT NULL CHECK (action IN ('ring', 'accept', 'reject', 'cancel', 'timeout', 'activate', 'end', 'fail')),
  actor_identity TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  result_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, call_id) REFERENCES ivekit_media_calls(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_media_call_actions_call
  ON ivekit_media_call_actions(tenant_id, call_id, created_at, id);

ALTER TABLE ivekit_media_call_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_media_call_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_media_call_actions;
CREATE POLICY tenant_isolation ON ivekit_media_call_actions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
