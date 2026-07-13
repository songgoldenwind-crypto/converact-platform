CREATE TABLE IF NOT EXISTS ivekit_ivr_flows (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'disabled', 'archived')),
  draft_graph JSONB NOT NULL DEFAULT '{}'::JSONB,
  draft_revision INTEGER NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  current_published_version INTEGER CHECK (current_published_version > 0),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS ivekit_ivr_flow_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flow_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  graph JSONB NOT NULL,
  graph_hash TEXT NOT NULL CHECK (char_length(graph_hash) = 64),
  dependencies JSONB NOT NULL DEFAULT '{}'::JSONB,
  published_by TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, flow_id)
    REFERENCES ivekit_ivr_flows(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, flow_id, version),
  UNIQUE (tenant_id, flow_id, graph_hash)
);

CREATE TABLE IF NOT EXISTS ivekit_ivr_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  flow_version INTEGER NOT NULL CHECK (flow_version > 0),
  state TEXT NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  current_node_id TEXT NOT NULL DEFAULT '',
  context JSONB NOT NULL DEFAULT '{}'::JSONB,
  step_count INTEGER NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  waiting_reason TEXT NOT NULL DEFAULT '',
  termination_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, flow_id, flow_version)
    REFERENCES ivekit_ivr_flow_versions(tenant_id, flow_id, version) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, call_id, id)
);

CREATE TABLE IF NOT EXISTS ivekit_ivr_session_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  step_index INTEGER NOT NULL CHECK (step_index >= 0),
  node_id TEXT NOT NULL,
  action JSONB NOT NULL,
  branch_taken TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  error_code TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES ivekit_ivr_sessions(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, session_id, step_index)
);

CREATE TABLE IF NOT EXISTS ivekit_ivr_pending_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  step_index INTEGER NOT NULL CHECK (step_index >= 0),
  node_id TEXT NOT NULL,
  action_kind TEXT NOT NULL
    CHECK (action_kind IN ('play', 'collect', 'queue', 'transfer', 'record', 'webhook', 'media', 'hangup', 'wait')),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'retry_wait', 'succeeded', 'failed', 'cancelled', 'uncertain')),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  result JSONB NOT NULL DEFAULT '{}'::JSONB,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  worker_id TEXT NOT NULL DEFAULT '',
  provider_profile_id TEXT NOT NULL DEFAULT '',
  provider_action_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES ivekit_ivr_sessions(tenant_id, id) ON DELETE CASCADE,
  CHECK (attempt_count <= max_attempts),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, session_id, step_index)
);

CREATE TABLE IF NOT EXISTS ivekit_ivr_audio_assets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('audio_file', 'tts', 'variable')),
  object_ref TEXT NOT NULL DEFAULT '',
  tts_text TEXT NOT NULL DEFAULT '',
  tts_profile_id TEXT NOT NULL DEFAULT '',
  variable_name TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'zh-CN',
  content_type TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT ''
    CHECK (checksum = '' OR char_length(checksum) = 64),
  duration_ms INTEGER CHECK (duration_ms >= 0),
  visibility TEXT NOT NULL DEFAULT 'tenant'
    CHECK (visibility IN ('tenant', 'flow')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'processing', 'failed', 'archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (source_kind = 'audio_file' AND object_ref <> '') OR
    (source_kind = 'tts' AND tts_text <> '') OR
    (source_kind = 'variable' AND variable_name <> '')
  ),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS ivekit_ivr_time_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  schedule JSONB NOT NULL DEFAULT '{}'::JSONB,
  holidays JSONB NOT NULL DEFAULT '[]'::JSONB,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS ivekit_ivr_region_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  regions JSONB NOT NULL DEFAULT '[]'::JSONB,
  match_mode TEXT NOT NULL DEFAULT 'prefix'
    CHECK (match_mode IN ('prefix', 'exact', 'regex')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS ivekit_ivr_ring_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  member_identities JSONB NOT NULL DEFAULT '[]'::JSONB,
  strategy TEXT NOT NULL DEFAULT 'simultaneous'
    CHECK (strategy IN ('simultaneous', 'sequential', 'least_busy', 'random')),
  ring_timeout_seconds INTEGER NOT NULL DEFAULT 20
    CHECK (ring_timeout_seconds BETWEEN 1 AND 300),
  max_rounds INTEGER NOT NULL DEFAULT 1 CHECK (max_rounds BETWEEN 1 AND 20),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS ivekit_ivr_settings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  default_language TEXT NOT NULL DEFAULT 'zh-CN',
  max_steps INTEGER NOT NULL DEFAULT 500 CHECK (max_steps BETWEEN 1 AND 10000),
  max_subflow_depth INTEGER NOT NULL DEFAULT 10
    CHECK (max_subflow_depth BETWEEN 1 AND 100),
  external_action_timeout_ms INTEGER NOT NULL DEFAULT 10000
    CHECK (external_action_timeout_ms BETWEEN 100 AND 300000),
  validation_mode TEXT NOT NULL DEFAULT 'block'
    CHECK (validation_mode IN ('warn', 'block')),
  allowed_webhook_refs JSONB NOT NULL DEFAULT '[]'::JSONB,
  execution_policy JSONB NOT NULL DEFAULT '{}'::JSONB,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_flows_status
  ON ivekit_ivr_flows(tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_flow_versions_flow
  ON ivekit_ivr_flow_versions(tenant_id, flow_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_sessions_call
  ON ivekit_ivr_sessions(tenant_id, call_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_sessions_state
  ON ivekit_ivr_sessions(tenant_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_steps_session
  ON ivekit_ivr_session_steps(tenant_id, session_id, step_index);
CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_actions_due
  ON ivekit_ivr_pending_actions(state, next_attempt_at, created_at)
  WHERE state IN ('pending', 'retry_wait', 'processing', 'uncertain');
CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_audio_status
  ON ivekit_ivr_audio_assets(tenant_id, status, updated_at DESC);

CREATE OR REPLACE FUNCTION opc_ivekit_ivr_reject_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'iveKit IVR published history is immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS ivekit_ivr_flow_versions_immutable
  ON ivekit_ivr_flow_versions;
CREATE TRIGGER ivekit_ivr_flow_versions_immutable
BEFORE UPDATE OR DELETE ON ivekit_ivr_flow_versions
FOR EACH ROW EXECUTE FUNCTION opc_ivekit_ivr_reject_immutable();

DROP TRIGGER IF EXISTS ivekit_ivr_session_steps_immutable
  ON ivekit_ivr_session_steps;
CREATE TRIGGER ivekit_ivr_session_steps_immutable
BEFORE UPDATE OR DELETE ON ivekit_ivr_session_steps
FOR EACH ROW EXECUTE FUNCTION opc_ivekit_ivr_reject_immutable();

ALTER TABLE ivekit_ivr_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_ivr_flows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_ivr_flows;
CREATE POLICY tenant_isolation ON ivekit_ivr_flows FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_ivr_flow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_ivr_flow_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_ivr_flow_versions;
CREATE POLICY tenant_isolation ON ivekit_ivr_flow_versions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_ivr_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_ivr_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_ivr_sessions;
CREATE POLICY tenant_isolation ON ivekit_ivr_sessions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_ivr_session_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_ivr_session_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_ivr_session_steps;
CREATE POLICY tenant_isolation ON ivekit_ivr_session_steps FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_ivr_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_ivr_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_ivr_pending_actions;
CREATE POLICY tenant_isolation ON ivekit_ivr_pending_actions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_ivr_audio_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_ivr_audio_assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_ivr_audio_assets;
CREATE POLICY tenant_isolation ON ivekit_ivr_audio_assets FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_ivr_time_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_ivr_time_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_ivr_time_groups;
CREATE POLICY tenant_isolation ON ivekit_ivr_time_groups FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_ivr_region_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_ivr_region_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_ivr_region_groups;
CREATE POLICY tenant_isolation ON ivekit_ivr_region_groups FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_ivr_ring_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_ivr_ring_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_ivr_ring_groups;
CREATE POLICY tenant_isolation ON ivekit_ivr_ring_groups FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_ivr_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_ivr_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_ivr_settings;
CREATE POLICY tenant_isolation ON ivekit_ivr_settings FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
