-- Additive AI outbound authority schema. This migration does not switch any writer.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_agent_releases (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('published', 'retired')),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  language TEXT NOT NULL CHECK (char_length(language) BETWEEN 2 AND 35),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  components JSONB NOT NULL CHECK (
    jsonb_typeof(components) = 'object' AND octet_length(components::TEXT) <= 65536
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, definition_id, id)
);

CREATE TABLE IF NOT EXISTS converact_outbound_campaigns (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  audience_id TEXT NOT NULL,
  dial_policy_revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'draft', 'scheduled', 'running', 'paused', 'draining',
    'completed', 'cancelled', 'archived'
  )),
  schedule JSONB NOT NULL CHECK (
    jsonb_typeof(schedule) = 'object' AND octet_length(schedule::TEXT) <= 65536
  ),
  active_attempts INTEGER NOT NULL DEFAULT 0 CHECK (active_attempts >= 0),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS converact_outbound_campaign_contacts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  external_contact_id TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (char_length(destination) BETWEEN 3 AND 255),
  consent_id TEXT NOT NULL CHECK (char_length(consent_id) BETWEEN 1 AND 255),
  recording_mode TEXT NOT NULL CHECK (
    recording_mode IN ('disabled', 'always', 'after_disclosure', 'on_demand')
  ),
  retention_until TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (
    state IN ('queued', 'active', 'completed', 'suppressed', 'cancelled')
  ),
  scheduled_for TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, campaign_id, external_contact_id),
  FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES converact_outbound_campaigns(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS converact_outbound_call_attempts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_contact_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  previous_attempt_id TEXT,
  interaction_id TEXT NOT NULL,
  call_id TEXT,
  channel_agent_session_id TEXT,
  agent_release_id TEXT NOT NULL,
  execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
  state TEXT NOT NULL CHECK (state IN (
    'planned', 'claimed', 'compliance_approved', 'compliance_blocked',
    'agent_capacity_reserved', 'dialing', 'ringing', 'answered',
    'agent_connecting', 'disclosure_pending', 'conversing', 'handoff_pending',
    'human_active', 'ai_resuming', 'finalizing', 'completed', 'cancelled',
    'busy', 'no_answer', 'rejected', 'failed_before_answer',
    'failed_after_answer', 'outcome_unknown', 'reconcile_required'
  )),
  idempotency_key TEXT NOT NULL,
  compliance_reason TEXT,
  consent_id TEXT NOT NULL CHECK (char_length(consent_id) BETWEEN 1 AND 255),
  recording_mode TEXT NOT NULL CHECK (
    recording_mode IN ('disabled', 'always', 'after_disclosure', 'on_demand')
  ),
  retention_until TIMESTAMPTZ NOT NULL,
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_token_hash TEXT NOT NULL DEFAULT '' CHECK (
    lease_token_hash = '' OR lease_token_hash ~ '^[0-9a-f]{64}$'
  ),
  lease_expires_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  scheduled_for TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  terminal_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, campaign_contact_id, attempt_number),
  CHECK (
    (lease_owner = '' AND lease_token_hash = '' AND lease_expires_at IS NULL) OR
    (lease_owner <> '' AND lease_token_hash <> '' AND lease_expires_at IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES converact_outbound_campaigns(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, campaign_contact_id)
    REFERENCES converact_outbound_campaign_contacts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, previous_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS converact_outbound_attempt_events (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
  event_type TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 128),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload JSONB NOT NULL CHECK (octet_length(payload::TEXT) <= 131072),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, call_attempt_id, idempotency_key),
  CHECK (received_at >= occurred_at),
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_converact_outbound_attempt_claim
  ON converact_outbound_call_attempts (tenant_id, scheduled_for, id)
  WHERE state = 'planned';

CREATE INDEX IF NOT EXISTS idx_converact_outbound_attempt_lease_expiry
  ON converact_outbound_call_attempts (tenant_id, lease_expires_at, id)
  WHERE state = 'claimed';

CREATE INDEX IF NOT EXISTS idx_converact_outbound_attempt_events_order
  ON converact_outbound_attempt_events (
    tenant_id, call_attempt_id, execution_generation, occurred_at, event_id
  );

CREATE OR REPLACE FUNCTION converact_outbound_immutable_history_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AI outbound history is immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS converact_outbound_attempt_events_immutable
  ON converact_outbound_attempt_events;
CREATE TRIGGER converact_outbound_attempt_events_immutable
  BEFORE UPDATE OR DELETE ON converact_outbound_attempt_events
  FOR EACH ROW EXECUTE FUNCTION converact_outbound_immutable_history_guard();

ALTER TABLE converact_agent_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_agent_releases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_agent_releases;
CREATE POLICY tenant_isolation ON converact_agent_releases FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_outbound_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_outbound_campaigns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_outbound_campaigns;
CREATE POLICY tenant_isolation ON converact_outbound_campaigns FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_outbound_campaign_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_outbound_campaign_contacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_outbound_campaign_contacts;
CREATE POLICY tenant_isolation ON converact_outbound_campaign_contacts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_outbound_call_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_outbound_call_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_outbound_call_attempts;
CREATE POLICY tenant_isolation ON converact_outbound_call_attempts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_outbound_attempt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_outbound_attempt_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_outbound_attempt_events;
CREATE POLICY tenant_isolation ON converact_outbound_attempt_events FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION converact_outbound_immutable_history_guard() FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON converact_agent_releases TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON converact_outbound_campaigns TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON converact_outbound_campaign_contacts TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON converact_outbound_call_attempts TO opc_runtime;
    GRANT SELECT, INSERT ON converact_outbound_attempt_events TO opc_runtime;
  END IF;
END
$grant$;
