CREATE TABLE IF NOT EXISTS converact_platform_identity_sessions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  identity_kind TEXT NOT NULL
    CHECK (identity_kind IN ('human', 'service', 'workload', 'edge', 'provider')),
  token_hash TEXT NOT NULL CHECK (char_length(token_hash) = 64),
  issuer TEXT NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 256),
  audience JSONB NOT NULL CHECK (jsonb_typeof(audience) = 'array'),
  key_id TEXT NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 256),
  policy_version BIGINT NOT NULL CHECK (policy_version > 0),
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch >= 0),
  credential_strength TEXT NOT NULL CHECK (credential_strength IN ('signed_token', 'mtls')),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, session_id),
  UNIQUE (tenant_id, token_hash)
);

CREATE TABLE IF NOT EXISTS converact_platform_revocation_snapshots (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch >= 0),
  snapshot_digest TEXT NOT NULL CHECK (char_length(snapshot_digest) = 64),
  source_identity TEXT NOT NULL CHECK (char_length(source_identity) BETWEEN 1 AND 256),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, revocation_epoch),
  UNIQUE (tenant_id, snapshot_digest)
);

CREATE TABLE IF NOT EXISTS converact_platform_policy_revisions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL,
  policy_version BIGINT NOT NULL CHECK (policy_version > 0),
  policy_digest TEXT NOT NULL CHECK (char_length(policy_digest) = 64),
  authority TEXT NOT NULL CHECK (char_length(authority) BETWEEN 1 AND 256),
  effective_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, policy_id, policy_version),
  UNIQUE (tenant_id, policy_id, policy_digest)
);

CREATE TABLE IF NOT EXISTS converact_platform_consent_evidence (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  consent_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN (
    'phone_audio', 'video', 'recording', 'transcription', 'translation',
    'ai_processing', 'tool_action', 'remote_control'
  )),
  purpose TEXT NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN ('granted', 'pending', 'denied', 'revoked')),
  policy_version BIGINT NOT NULL CHECK (policy_version > 0),
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch >= 0),
  allowed_regions JSONB NOT NULL CHECK (jsonb_typeof(allowed_regions) = 'array'),
  retention_policy TEXT NOT NULL CHECK (char_length(retention_policy) BETWEEN 1 AND 256),
  legal_hold_policy TEXT NOT NULL CHECK (char_length(legal_hold_policy) BETWEEN 1 AND 256),
  evidence_ref TEXT NOT NULL CHECK (char_length(evidence_ref) BETWEEN 1 AND 512),
  actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 256),
  occurred_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  revision BIGINT NOT NULL CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, consent_id, revision),
  UNIQUE (tenant_id, subject_id, scope, purpose, revision),
  CHECK (expires_at IS NULL OR expires_at > occurred_at)
);

CREATE TABLE IF NOT EXISTS converact_platform_consent_leases (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN (
    'phone_audio', 'video', 'recording', 'transcription', 'translation',
    'ai_processing', 'tool_action', 'remote_control'
  )),
  purpose TEXT NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 256),
  region TEXT NOT NULL CHECK (char_length(region) BETWEEN 1 AND 256),
  generation BIGINT NOT NULL CHECK (generation > 0),
  policy_version BIGINT NOT NULL CHECK (policy_version > 0),
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch >= 0),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at),
  monotonic_duration_ms BIGINT NOT NULL CHECK (monotonic_duration_ms > 0),
  issuer_key_id TEXT NOT NULL CHECK (char_length(issuer_key_id) BETWEEN 1 AND 256),
  evidence_digest TEXT NOT NULL CHECK (char_length(evidence_digest) = 64),
  restart_reauthorization_required BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, lease_id, generation)
);

CREATE INDEX IF NOT EXISTS idx_converact_platform_identity_session_expiry
  ON converact_platform_identity_sessions (tenant_id, expires_at, session_id);
CREATE INDEX IF NOT EXISTS idx_converact_platform_consent_subject
  ON converact_platform_consent_evidence (tenant_id, subject_id, scope, purpose, revision DESC);

ALTER TABLE converact_platform_identity_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_identity_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_platform_identity_sessions;
CREATE POLICY tenant_isolation ON converact_platform_identity_sessions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_platform_revocation_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_revocation_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_platform_revocation_snapshots;
CREATE POLICY tenant_isolation ON converact_platform_revocation_snapshots FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_platform_policy_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_policy_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_platform_policy_revisions;
CREATE POLICY tenant_isolation ON converact_platform_policy_revisions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_platform_consent_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_consent_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_platform_consent_evidence;
CREATE POLICY tenant_isolation ON converact_platform_consent_evidence FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_platform_consent_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_consent_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_platform_consent_leases;
CREATE POLICY tenant_isolation ON converact_platform_consent_leases FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT ON converact_platform_identity_sessions TO opc_runtime;
    GRANT SELECT, INSERT ON converact_platform_revocation_snapshots TO opc_runtime;
    GRANT SELECT, INSERT ON converact_platform_policy_revisions TO opc_runtime;
    GRANT SELECT, INSERT ON converact_platform_consent_evidence TO opc_runtime;
    GRANT SELECT, INSERT ON converact_platform_consent_leases TO opc_runtime;
  END IF;
END
$grant$;
