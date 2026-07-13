CREATE TABLE IF NOT EXISTS ivekit_cc_skills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS ivekit_cc_agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  identity TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  voice_extension_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  voice_capacity INTEGER NOT NULL DEFAULT 1
    CHECK (voice_capacity BETWEEN 1 AND 10),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, voice_extension_id)
    REFERENCES ivekit_voice_extensions(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, identity)
);

CREATE TABLE IF NOT EXISTS ivekit_cc_agent_skills (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  proficiency INTEGER NOT NULL DEFAULT 1 CHECK (proficiency BETWEEN 1 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, agent_id)
    REFERENCES ivekit_cc_agents(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, skill_id)
    REFERENCES ivekit_cc_skills(tenant_id, id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, agent_id, skill_id)
);

CREATE TABLE IF NOT EXISTS ivekit_cc_agent_presence (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'offline'
    CHECK (state IN ('offline', 'available', 'busy', 'after_call', 'away')),
  active_voice_count INTEGER NOT NULL DEFAULT 0 CHECK (active_voice_count >= 0),
  voice_capacity INTEGER NOT NULL DEFAULT 1 CHECK (voice_capacity BETWEEN 1 AND 10),
  current_call_id TEXT,
  idle_since TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  session_ref TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, agent_id)
    REFERENCES ivekit_cc_agents(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, current_call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE RESTRICT,
  CHECK (active_voice_count <= voice_capacity),
  PRIMARY KEY (tenant_id, agent_id)
);

CREATE TABLE IF NOT EXISTS ivekit_cc_queues (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  routing_strategy TEXT NOT NULL DEFAULT 'longest_idle'
    CHECK (routing_strategy IN ('longest_idle', 'least_calls', 'round_robin', 'skill_priority')),
  max_wait_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (max_wait_seconds BETWEEN 1 AND 86400),
  max_size INTEGER NOT NULL DEFAULT 100 CHECK (max_size BETWEEN 1 AND 100000),
  callback_after_seconds INTEGER NOT NULL DEFAULT 120
    CHECK (callback_after_seconds BETWEEN 0 AND 86400),
  overflow_action TEXT NOT NULL DEFAULT 'none'
    CHECK (overflow_action IN ('none', 'queue', 'voicemail', 'hangup', 'external')),
  overflow_queue_id TEXT,
  overflow_target TEXT NOT NULL DEFAULT '',
  service_level_seconds INTEGER NOT NULL DEFAULT 20
    CHECK (service_level_seconds BETWEEN 1 AND 3600),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, overflow_queue_id)
    REFERENCES ivekit_cc_queues(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (overflow_action = 'queue' AND overflow_queue_id IS NOT NULL AND overflow_target = '')
    OR (overflow_action IN ('voicemail', 'external') AND overflow_queue_id IS NULL AND overflow_target <> '')
    OR (overflow_action IN ('none', 'hangup') AND overflow_queue_id IS NULL AND overflow_target = '')
  ),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS ivekit_cc_queue_memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  queue_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, queue_id)
    REFERENCES ivekit_cc_queues(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, agent_id)
    REFERENCES ivekit_cc_agents(tenant_id, id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, queue_id, agent_id)
);

CREATE TABLE IF NOT EXISTS ivekit_cc_queue_skill_requirements (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  queue_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  minimum_proficiency INTEGER NOT NULL DEFAULT 1
    CHECK (minimum_proficiency BETWEEN 1 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, queue_id)
    REFERENCES ivekit_cc_queues(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, skill_id)
    REFERENCES ivekit_cc_skills(tenant_id, id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, queue_id, skill_id)
);

CREATE TABLE IF NOT EXISTS ivekit_cc_queue_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  queue_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting'
    CHECK (state IN (
      'waiting', 'offered', 'assigned', 'answered', 'completed', 'abandoned',
      'timed_out', 'cancelled', 'overflowed', 'callback_requested'
    )),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  entered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  offered_at TIMESTAMPTZ,
  assigned_at TIMESTAMPTZ,
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  timeout_at TIMESTAMPTZ,
  outcome_reason TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, queue_id)
    REFERENCES ivekit_cc_queues(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ivekit_cc_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  queue_entry_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  capacity_slot INTEGER NOT NULL CHECK (capacity_slot BETWEEN 1 AND 10),
  state TEXT NOT NULL DEFAULT 'offered'
    CHECK (state IN ('offered', 'accepted', 'connected', 'rejected', 'expired', 'revoked', 'completed', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  idempotency_key TEXT NOT NULL,
  offer_expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  outcome_reason TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, queue_entry_id)
    REFERENCES ivekit_cc_queue_entries(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_id)
    REFERENCES ivekit_cc_agents(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, queue_entry_id, attempt)
);

CREATE TABLE IF NOT EXISTS ivekit_cc_callbacks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  queue_id TEXT NOT NULL,
  queue_entry_id TEXT NOT NULL,
  source_call_id TEXT NOT NULL,
  outbound_call_id TEXT,
  business_ref_type TEXT NOT NULL,
  business_ref_id TEXT NOT NULL,
  address_kind TEXT NOT NULL CHECK (address_kind IN ('e164', 'extension', 'sip_uri')),
  address_ciphertext TEXT NOT NULL,
  address_hmac TEXT NOT NULL CHECK (char_length(address_hmac) = 64),
  address_redacted TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'scheduled', 'dialing', 'connected', 'completed', 'cancelled', 'failed')),
  scheduled_for TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  idempotency_key TEXT NOT NULL,
  failure_code TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, queue_id)
    REFERENCES ivekit_cc_queues(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, queue_entry_id)
    REFERENCES ivekit_cc_queue_entries(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, source_call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, outbound_call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ivekit_cc_supervisor_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  supervisor_identity TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('monitor', 'whisper', 'barge')),
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'active', 'denied', 'ended', 'failed')),
  authorization_ref TEXT NOT NULL CHECK (authorization_ref <> ''),
  idempotency_key TEXT NOT NULL,
  provider_session_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, target_agent_id)
    REFERENCES ivekit_cc_agents(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ivekit_cc_routing_cursors (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  queue_id TEXT NOT NULL,
  last_agent_id TEXT,
  sequence BIGINT NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, queue_id)
    REFERENCES ivekit_cc_queues(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, last_agent_id)
    REFERENCES ivekit_cc_agents(tenant_id, id) ON DELETE RESTRICT,
  PRIMARY KEY (tenant_id, queue_id)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_cc_agents_status
  ON ivekit_cc_agents(tenant_id, status, identity);
CREATE INDEX IF NOT EXISTS idx_ivekit_cc_presence_available
  ON ivekit_cc_agent_presence(tenant_id, state, idle_since, agent_id)
  WHERE state = 'available';
CREATE INDEX IF NOT EXISTS idx_ivekit_cc_queue_entries_waiting
  ON ivekit_cc_queue_entries(tenant_id, queue_id, priority DESC, entered_at, id)
  WHERE state IN ('waiting', 'offered');
CREATE INDEX IF NOT EXISTS idx_ivekit_cc_queue_entries_call
  ON ivekit_cc_queue_entries(tenant_id, call_id, entered_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_cc_queue_entries_active_call
  ON ivekit_cc_queue_entries(tenant_id, queue_id, call_id)
  WHERE state IN ('waiting', 'offered', 'assigned', 'answered');
CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_cc_assignments_active_entry
  ON ivekit_cc_assignments(tenant_id, queue_entry_id)
  WHERE state IN ('offered', 'accepted', 'connected');
CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_cc_assignments_active_agent
  ON ivekit_cc_assignments(tenant_id, agent_id, capacity_slot)
  WHERE state IN ('offered', 'accepted', 'connected');
CREATE INDEX IF NOT EXISTS idx_ivekit_cc_assignments_expiring
  ON ivekit_cc_assignments(tenant_id, offer_expires_at, id)
  WHERE state = 'offered';
CREATE INDEX IF NOT EXISTS idx_ivekit_cc_callbacks_due
  ON ivekit_cc_callbacks(tenant_id, scheduled_for, id)
  WHERE state IN ('requested', 'scheduled');
CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_cc_supervisor_active_call_mode
  ON ivekit_cc_supervisor_sessions(tenant_id, call_id, supervisor_identity, mode)
  WHERE state IN ('requested', 'active');

CREATE OR REPLACE FUNCTION opc_ivekit_cc_reject_delete()
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
  RAISE EXCEPTION 'iveKit Contact Center history cannot be deleted'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS ivekit_cc_assignments_immutable_delete ON ivekit_cc_assignments;
CREATE TRIGGER ivekit_cc_assignments_immutable_delete
BEFORE DELETE ON ivekit_cc_assignments
FOR EACH ROW EXECUTE FUNCTION opc_ivekit_cc_reject_delete();

DROP TRIGGER IF EXISTS ivekit_cc_supervisor_sessions_immutable_delete ON ivekit_cc_supervisor_sessions;
CREATE TRIGGER ivekit_cc_supervisor_sessions_immutable_delete
BEFORE DELETE ON ivekit_cc_supervisor_sessions
FOR EACH ROW EXECUTE FUNCTION opc_ivekit_cc_reject_delete();

ALTER TABLE ivekit_cc_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_skills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_skills;
CREATE POLICY tenant_isolation ON ivekit_cc_skills FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_cc_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_agents;
CREATE POLICY tenant_isolation ON ivekit_cc_agents FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_cc_agent_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_agent_skills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_agent_skills;
CREATE POLICY tenant_isolation ON ivekit_cc_agent_skills FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_cc_agent_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_agent_presence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_agent_presence;
CREATE POLICY tenant_isolation ON ivekit_cc_agent_presence FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_cc_queues ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_queues FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_queues;
CREATE POLICY tenant_isolation ON ivekit_cc_queues FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_cc_queue_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_queue_memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_queue_memberships;
CREATE POLICY tenant_isolation ON ivekit_cc_queue_memberships FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_cc_queue_skill_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_queue_skill_requirements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_queue_skill_requirements;
CREATE POLICY tenant_isolation ON ivekit_cc_queue_skill_requirements FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_cc_queue_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_queue_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_queue_entries;
CREATE POLICY tenant_isolation ON ivekit_cc_queue_entries FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_cc_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_assignments;
CREATE POLICY tenant_isolation ON ivekit_cc_assignments FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_cc_callbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_callbacks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_callbacks;
CREATE POLICY tenant_isolation ON ivekit_cc_callbacks FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_cc_supervisor_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_supervisor_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_supervisor_sessions;
CREATE POLICY tenant_isolation ON ivekit_cc_supervisor_sessions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_cc_routing_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_routing_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_routing_cursors;
CREATE POLICY tenant_isolation ON ivekit_cc_routing_cursors FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
