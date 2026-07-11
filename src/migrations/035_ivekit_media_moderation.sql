CREATE TABLE IF NOT EXISTS ivekit_media_moderation_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  room_name TEXT NOT NULL,
  participant_identity TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('mute', 'remove')),
  actor_identity TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  track_sid TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  muted BOOLEAN,
  reason TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, call_id) REFERENCES ivekit_media_calls(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT ivekit_media_moderation_payload_valid CHECK (
    (
      action = 'mute' AND track_sid <> '' AND
      source IN ('camera', 'microphone', 'screen_share', 'screen_share_audio') AND muted IS TRUE
    ) OR (
      action = 'remove' AND track_sid = '' AND source = '' AND muted IS NULL
    )
  ),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_media_moderation_actions_call
  ON ivekit_media_moderation_actions(tenant_id, call_id, created_at, id);

ALTER TABLE ivekit_media_moderation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_media_moderation_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_media_moderation_actions;
CREATE POLICY tenant_isolation ON ivekit_media_moderation_actions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE TABLE IF NOT EXISTS ivekit_media_moderation_commands (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  room_name TEXT NOT NULL,
  participant_identity TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('mute', 'remove')),
  actor_identity TEXT NOT NULL,
  actor_is_system BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  request_payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  result_snapshot JSONB,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, call_id) REFERENCES ivekit_media_calls(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_media_moderation_commands_recovery
  ON ivekit_media_moderation_commands(tenant_id, status, updated_at, id);

ALTER TABLE ivekit_media_moderation_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_media_moderation_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_media_moderation_commands;
CREATE POLICY tenant_isolation ON ivekit_media_moderation_commands FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
