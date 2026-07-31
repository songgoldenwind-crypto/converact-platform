CREATE TABLE IF NOT EXISTS ivekit_voice_dialog_ownership (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cell_id TEXT NOT NULL,
  call_session_ref TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile = 'VOICE-HA-T1'),
  owner_node_id TEXT NOT NULL,
  owner_fault_domain TEXT NOT NULL,
  owner_epoch BIGINT NOT NULL CHECK (owner_epoch BETWEEN 1 AND 4294967295),
  owner_epoch_high_watermark BIGINT NOT NULL
    CHECK (
      owner_epoch_high_watermark >= owner_epoch AND
      owner_epoch_high_watermark BETWEEN 1 AND 4294967295
    ),
  shadow_pair_hash TEXT NOT NULL CHECK (char_length(shadow_pair_hash) = 64),
  terminal BOOLEAN NOT NULL DEFAULT FALSE,
  pending_takeover_id TEXT,
  pending_owner_node_id TEXT,
  pending_owner_fault_domain TEXT,
  pending_owner_epoch BIGINT CHECK (
    pending_owner_epoch IS NULL OR
    pending_owner_epoch BETWEEN 2 AND 4294967295
  ),
  pending_token_sha256 TEXT CHECK (
    pending_token_sha256 IS NULL OR
    char_length(pending_token_sha256) = 64
  ),
  pending_expires_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, cell_id, call_session_ref),
  UNIQUE (tenant_id, pending_takeover_id),
  CHECK (
    (
      pending_takeover_id IS NULL AND
      pending_owner_node_id IS NULL AND
      pending_owner_fault_domain IS NULL AND
      pending_owner_epoch IS NULL AND
      pending_token_sha256 IS NULL AND
      pending_expires_at IS NULL
    ) OR (
      pending_takeover_id IS NOT NULL AND
      pending_owner_node_id IS NOT NULL AND
      pending_owner_fault_domain IS NOT NULL AND
      pending_owner_epoch IS NOT NULL AND
      pending_token_sha256 IS NOT NULL AND
      pending_expires_at IS NOT NULL AND
      pending_owner_epoch > owner_epoch AND
      pending_owner_epoch <= owner_epoch_high_watermark
    )
  )
);

CREATE TABLE IF NOT EXISTS ivekit_voice_dialog_node_leases (
  cell_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  fault_domain TEXT NOT NULL,
  spiffe_id TEXT NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  PRIMARY KEY (cell_id, node_id),
  UNIQUE (spiffe_id),
  CHECK (lease_expires_at > heartbeat_at)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_dialog_takeovers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cell_id TEXT NOT NULL,
  call_session_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (char_length(request_hash) = 64),
  previous_owner_node_id TEXT NOT NULL,
  previous_owner_fault_domain TEXT NOT NULL,
  previous_owner_epoch BIGINT NOT NULL
    CHECK (previous_owner_epoch BETWEEN 1 AND 4294967294),
  owner_node_id TEXT NOT NULL,
  owner_fault_domain TEXT NOT NULL,
  owner_epoch BIGINT NOT NULL CHECK (owner_epoch BETWEEN 2 AND 4294967295),
  shadow_pair_hash TEXT NOT NULL CHECK (char_length(shadow_pair_hash) = 64),
  prepared_pair_hash TEXT CHECK (
    prepared_pair_hash IS NULL OR
    char_length(prepared_pair_hash) = 64
  ),
  token_key_id TEXT NOT NULL,
  token_sha256 TEXT NOT NULL CHECK (char_length(token_sha256) = 64),
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'shadow_prepared', 'consumed', 'expired')
  ),
  claimed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, cell_id, call_session_ref, idempotency_key),
  FOREIGN KEY (tenant_id, cell_id, call_session_ref)
    REFERENCES ivekit_voice_dialog_ownership(
      tenant_id,
      cell_id,
      call_session_ref
    ) ON DELETE CASCADE,
  CHECK (expires_at > claimed_at),
  CHECK (
    (
      state = 'consumed' AND
      consumed_at IS NOT NULL AND
      prepared_pair_hash IS NOT NULL
    ) OR (
      state = 'shadow_prepared' AND
      consumed_at IS NULL AND
      prepared_pair_hash IS NOT NULL
    ) OR (
      state IN ('prepared', 'expired') AND
      consumed_at IS NULL AND
      prepared_pair_hash IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_ivekit_voice_dialog_node_leases_expiry
  ON ivekit_voice_dialog_node_leases(cell_id, lease_expires_at, node_id);

CREATE INDEX IF NOT EXISTS idx_ivekit_voice_dialog_takeovers_pending
  ON ivekit_voice_dialog_takeovers(
    tenant_id,
    cell_id,
    expires_at,
    id
  )
  WHERE state IN ('prepared', 'shadow_prepared');

ALTER TABLE ivekit_voice_dialog_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_dialog_ownership FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_dialog_ownership;
CREATE POLICY tenant_isolation ON ivekit_voice_dialog_ownership FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_dialog_takeovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_dialog_takeovers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_dialog_takeovers;
CREATE POLICY tenant_isolation ON ivekit_voice_dialog_takeovers FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON ivekit_voice_dialog_node_leases TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON ivekit_voice_dialog_ownership TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON ivekit_voice_dialog_takeovers TO opc_runtime;
  END IF;
END
$$;
