CREATE TABLE IF NOT EXISTS ivekit_voice_deployment_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  adapter TEXT NOT NULL
    CHECK (adapter IN ('rustpbx', 'livekit_sip', 'active_call', 'livekit_agents', 'controlled')),
  status TEXT NOT NULL DEFAULT 'disabled'
    CHECK (status IN ('disabled', 'enabled', 'degraded', 'archived')),
  base_url TEXT NOT NULL DEFAULT '',
  desired_version TEXT NOT NULL DEFAULT '',
  config JSONB NOT NULL DEFAULT '{}'::JSONB,
  secret_refs JSONB NOT NULL DEFAULT '{}'::JSONB,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_capability_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL
    CHECK (status IN ('ready', 'degraded', 'not_available', 'failed')),
  capabilities JSONB NOT NULL DEFAULT '{}'::JSONB,
  config_hash TEXT NOT NULL CHECK (char_length(config_hash) = 64),
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, profile_id)
    REFERENCES ivekit_voice_deployment_profiles(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_routes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'both')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'disabled', 'archived')),
  draft_revision INTEGER NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  draft_rules JSONB NOT NULL DEFAULT '{}'::JSONB,
  current_published_version INTEGER CHECK (current_published_version > 0),
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, profile_id)
    REFERENCES ivekit_voice_deployment_profiles(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_route_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  rules JSONB NOT NULL,
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  deployment_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (deployment_state IN ('pending', 'applying', 'applied', 'failed')),
  provider_revision TEXT NOT NULL DEFAULT '',
  published_by TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, route_id)
    REFERENCES ivekit_voice_routes(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, route_id, version),
  UNIQUE (tenant_id, route_id, payload_hash)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_sip_trunks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider_ref TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'both')),
  transport TEXT NOT NULL DEFAULT 'udp' CHECK (transport IN ('udp', 'tcp', 'tls')),
  codecs TEXT[] NOT NULL DEFAULT ARRAY['PCMU', 'PCMA']::TEXT[],
  max_channels INTEGER NOT NULL DEFAULT 1 CHECK (max_channels > 0),
  credential_secret_ref TEXT NOT NULL DEFAULT '',
  desired_state JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'applying', 'active', 'degraded', 'disabled', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, profile_id)
    REFERENCES ivekit_voice_deployment_profiles(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_dids (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  trunk_id TEXT NOT NULL,
  route_id TEXT,
  e164_ciphertext TEXT NOT NULL,
  e164_hmac TEXT NOT NULL CHECK (char_length(e164_hmac) = 64),
  e164_redacted TEXT NOT NULL,
  provider_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'porting', 'released')),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, trunk_id)
    REFERENCES ivekit_voice_sip_trunks(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, route_id)
    REFERENCES ivekit_voice_routes(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, e164_hmac)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_extensions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  extension TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  credential_secret_ref TEXT NOT NULL DEFAULT '',
  permissions JSONB NOT NULL DEFAULT '{}'::JSONB,
  webrtc_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, profile_id)
    REFERENCES ivekit_voice_deployment_profiles(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, profile_id, extension),
  UNIQUE (tenant_id, identity)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  require_outbound_consent BOOLEAN NOT NULL DEFAULT FALSE,
  recording_mode TEXT NOT NULL DEFAULT 'disabled'
    CHECK (recording_mode IN ('disabled', 'consent_required', 'always')),
  recording_retention_days INTEGER NOT NULL DEFAULT 30
    CHECK (recording_retention_days BETWEEN 0 AND 3650),
  require_ai_disclosure BOOLEAN NOT NULL DEFAULT TRUE,
  allowed_calling_windows JSONB NOT NULL DEFAULT '[]'::JSONB,
  masking_policy JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_ref_type TEXT NOT NULL,
  business_ref_id TEXT NOT NULL,
  provider_profile_id TEXT NOT NULL,
  provider_call_id TEXT NOT NULL DEFAULT '',
  provider_dialog_id TEXT NOT NULL DEFAULT '',
  media_call_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  state TEXT NOT NULL DEFAULT 'planned'
    CHECK (state IN (
      'planned', 'queued', 'dialing', 'ringing', 'active', 'held', 'transferring',
      'completed', 'cancelled', 'missed', 'rejected', 'failed', 'timed_out'
    )),
  from_address_kind TEXT NOT NULL CHECK (from_address_kind IN ('e164', 'extension', 'sip_uri')),
  from_address_ciphertext TEXT NOT NULL,
  from_address_hmac TEXT NOT NULL CHECK (char_length(from_address_hmac) = 64),
  from_address_redacted TEXT NOT NULL,
  to_address_kind TEXT NOT NULL CHECK (to_address_kind IN ('e164', 'extension', 'sip_uri')),
  to_address_ciphertext TEXT NOT NULL,
  to_address_hmac TEXT NOT NULL CHECK (char_length(to_address_hmac) = 64),
  to_address_redacted TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  initiated_by TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  ringing_at TIMESTAMPTZ,
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  termination_reason TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, provider_profile_id)
    REFERENCES ivekit_voice_deployment_profiles(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, media_call_id)
    REFERENCES ivekit_media_calls(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_call_participants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  participant_kind TEXT NOT NULL
    CHECK (participant_kind IN ('pstn', 'sip', 'webrtc', 'livekit', 'agent', 'ai')),
  role TEXT NOT NULL
    CHECK (role IN ('caller', 'callee', 'agent', 'supervisor', 'observer', 'ai')),
  state TEXT NOT NULL DEFAULT 'invited'
    CHECK (state IN ('invited', 'ringing', 'joined', 'held', 'left', 'failed')),
  provider_participant_id TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, call_id, identity)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_call_commands (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN (
      'originate', 'answer', 'hangup', 'dtmf', 'hold', 'resume', 'blind_transfer',
      'warm_transfer', 'conference', 'park', 'pickup', 'recording_start',
      'recording_pause', 'recording_resume', 'recording_stop', 'livekit_bridge_create'
    )),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'retry_wait', 'succeeded', 'failed', 'cancelled', 'uncertain')),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  worker_id TEXT NOT NULL DEFAULT '',
  provider_command_id TEXT NOT NULL DEFAULT '',
  result JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE CASCADE,
  CHECK (attempt_count <= max_attempts),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_provider_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  call_id TEXT,
  external_event_id TEXT NOT NULL DEFAULT '',
  canonical_hash TEXT NOT NULL CHECK (char_length(canonical_hash) = 64),
  event_type TEXT NOT NULL,
  provider_state TEXT NOT NULL DEFAULT '',
  safe_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  processing_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_state IN ('pending', 'processing', 'processed', 'retry_wait', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  worker_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, profile_id)
    REFERENCES ivekit_voice_deployment_profiles(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, profile_id, canonical_hash)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_livekit_bridges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  media_call_id TEXT NOT NULL,
  sip_participant_id TEXT NOT NULL DEFAULT '',
  room_name TEXT NOT NULL,
  provider_bridge_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'creating', 'active', 'completed', 'failed', 'cancelled')),
  idempotency_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, media_call_id)
    REFERENCES ivekit_media_calls(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, call_id, media_call_id)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_ref_type TEXT NOT NULL,
  subject_ref_id TEXT NOT NULL,
  business_ref_type TEXT NOT NULL DEFAULT '',
  business_ref_id TEXT NOT NULL DEFAULT '',
  consent_type TEXT NOT NULL
    CHECK (consent_type IN ('outbound_call', 'recording', 'ai_disclosure')),
  status TEXT NOT NULL DEFAULT 'granted'
    CHECK (status IN ('granted', 'revoked', 'expired')),
  evidence_ref TEXT NOT NULL,
  granted_by TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_recordings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  provider_recording_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'available', 'archived', 'deleted', 'expired', 'failed')),
  recording_mode TEXT NOT NULL
    CHECK (recording_mode IN ('consent_required', 'always')),
  consent_id TEXT,
  object_ref TEXT NOT NULL DEFAULT '',
  evidence_ref TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER CHECK (duration_ms >= 0),
  retention_until TIMESTAMPTZ,
  captured_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, profile_id)
    REFERENCES ivekit_voice_deployment_profiles(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, consent_id)
    REFERENCES ivekit_voice_consents(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, profile_id, provider_recording_id)
);

CREATE TABLE IF NOT EXISTS ivekit_voice_webrtc_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  extension_id TEXT NOT NULL,
  call_id TEXT,
  status TEXT NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued', 'registered', 'connected', 'ended', 'expired', 'revoked')),
  token_hash TEXT NOT NULL CHECK (char_length(token_hash) = 64),
  capabilities JSONB NOT NULL DEFAULT '{}'::JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, extension_id)
    REFERENCES ivekit_voice_extensions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_voice_capabilities_profile
  ON ivekit_voice_capability_snapshots(tenant_id, profile_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_ivekit_voice_routes_profile
  ON ivekit_voice_routes(tenant_id, profile_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ivekit_voice_trunks_profile
  ON ivekit_voice_sip_trunks(tenant_id, profile_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ivekit_voice_dids_lookup
  ON ivekit_voice_dids(tenant_id, e164_hmac) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_ivekit_voice_extensions_identity
  ON ivekit_voice_extensions(tenant_id, identity, status);
CREATE INDEX IF NOT EXISTS idx_ivekit_voice_calls_business_ref
  ON ivekit_voice_calls(tenant_id, business_ref_type, business_ref_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ivekit_voice_calls_provider
  ON ivekit_voice_calls(tenant_id, provider_profile_id, provider_call_id)
  WHERE provider_call_id <> '';
CREATE INDEX IF NOT EXISTS idx_ivekit_voice_calls_state
  ON ivekit_voice_calls(tenant_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ivekit_voice_commands_due
  ON ivekit_voice_call_commands(state, next_attempt_at, created_at)
  WHERE state IN ('pending', 'retry_wait', 'processing', 'uncertain');
CREATE INDEX IF NOT EXISTS idx_ivekit_voice_events_due
  ON ivekit_voice_provider_events(processing_state, next_attempt_at, received_at)
  WHERE processing_state IN ('pending', 'retry_wait', 'processing');
CREATE UNIQUE INDEX IF NOT EXISTS uq_ivekit_voice_events_external
  ON ivekit_voice_provider_events(tenant_id, profile_id, external_event_id)
  WHERE external_event_id <> '';
CREATE INDEX IF NOT EXISTS idx_ivekit_voice_recordings_retention
  ON ivekit_voice_recordings(tenant_id, retention_until, status)
  WHERE retention_until IS NOT NULL;

CREATE OR REPLACE FUNCTION opc_ivekit_voice_route_version_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'iveKit Voice route versions are immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS ivekit_voice_route_versions_immutable
  ON ivekit_voice_route_versions;
CREATE TRIGGER ivekit_voice_route_versions_immutable
BEFORE UPDATE OR DELETE ON ivekit_voice_route_versions
FOR EACH ROW EXECUTE FUNCTION opc_ivekit_voice_route_version_immutable();

ALTER TABLE ivekit_voice_deployment_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_deployment_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_deployment_profiles;
CREATE POLICY tenant_isolation ON ivekit_voice_deployment_profiles FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_capability_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_capability_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_capability_snapshots;
CREATE POLICY tenant_isolation ON ivekit_voice_capability_snapshots FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_sip_trunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_sip_trunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_sip_trunks;
CREATE POLICY tenant_isolation ON ivekit_voice_sip_trunks FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_dids ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_dids FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_dids;
CREATE POLICY tenant_isolation ON ivekit_voice_dids FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_extensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_extensions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_extensions;
CREATE POLICY tenant_isolation ON ivekit_voice_extensions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_routes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_routes;
CREATE POLICY tenant_isolation ON ivekit_voice_routes FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_route_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_route_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_route_versions;
CREATE POLICY tenant_isolation ON ivekit_voice_route_versions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_calls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_calls;
CREATE POLICY tenant_isolation ON ivekit_voice_calls FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_call_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_call_participants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_call_participants;
CREATE POLICY tenant_isolation ON ivekit_voice_call_participants FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_call_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_call_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_call_commands;
CREATE POLICY tenant_isolation ON ivekit_voice_call_commands FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_provider_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_provider_events;
CREATE POLICY tenant_isolation ON ivekit_voice_provider_events FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_livekit_bridges ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_livekit_bridges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_livekit_bridges;
CREATE POLICY tenant_isolation ON ivekit_voice_livekit_bridges FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_recordings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_recordings;
CREATE POLICY tenant_isolation ON ivekit_voice_recordings FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_consents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_consents;
CREATE POLICY tenant_isolation ON ivekit_voice_consents FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_policies;
CREATE POLICY tenant_isolation ON ivekit_voice_policies FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_webrtc_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_webrtc_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_webrtc_sessions;
CREATE POLICY tenant_isolation ON ivekit_voice_webrtc_sessions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
