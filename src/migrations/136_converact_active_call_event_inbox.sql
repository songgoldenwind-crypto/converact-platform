-- Durable, generation-fenced Active Call event cursor and bounded replay inbox.
-- Additive only: no existing writer is switched by this migration.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_active_call_event_sessions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_schema_version SMALLINT NOT NULL CHECK (contract_schema_version > 0),
  interaction_id TEXT NOT NULL CHECK (char_length(interaction_id) BETWEEN 1 AND 255),
  campaign_id TEXT NOT NULL CHECK (char_length(campaign_id) BETWEEN 1 AND 255),
  campaign_contact_id TEXT NOT NULL CHECK (char_length(campaign_contact_id) BETWEEN 1 AND 255),
  call_attempt_id TEXT NOT NULL CHECK (char_length(call_attempt_id) BETWEEN 1 AND 255),
  call_id TEXT CHECK (call_id IS NULL OR char_length(call_id) BETWEEN 1 AND 255),
  agent_release_id TEXT NOT NULL CHECK (char_length(agent_release_id) BETWEEN 1 AND 255),
  channel_agent_session_id TEXT NOT NULL CHECK (
    char_length(channel_agent_session_id) BETWEEN 1 AND 255
  ),
  execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
  last_received_cursor BIGINT NOT NULL DEFAULT 0 CHECK (last_received_cursor >= 0),
  last_applied_cursor BIGINT NOT NULL DEFAULT 0 CHECK (
    last_applied_cursor >= 0 AND last_applied_cursor <= last_received_cursor
  ),
  terminal_cursor BIGINT CHECK (
    terminal_cursor IS NULL OR terminal_cursor = last_received_cursor AND terminal_cursor > 0
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'completed', 'reconcile_required')
  ),
  reconcile_reason TEXT CHECK (
    reconcile_reason IS NULL OR reconcile_reason IN (
      'coverage_gap', 'session_disappeared', 'invalid_event'
    )
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, interaction_id, execution_generation),
  UNIQUE (tenant_id, channel_agent_session_id, execution_generation),
  CHECK (
    (status = 'active' AND reconcile_reason IS NULL AND (
      terminal_cursor IS NULL OR terminal_cursor > last_applied_cursor
    )) OR
    (status = 'completed' AND reconcile_reason IS NULL
      AND terminal_cursor IS NOT NULL
      AND terminal_cursor = last_received_cursor
      AND terminal_cursor = last_applied_cursor) OR
    (status = 'reconcile_required' AND reconcile_reason IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS converact_active_call_event_inbox (
  tenant_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL CHECK (char_length(interaction_id) BETWEEN 1 AND 255),
  execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
  event_cursor BIGINT NOT NULL CHECK (event_cursor > 0),
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  event_payload TEXT NOT NULL CHECK (
    octet_length(event_payload) BETWEEN 1 AND 131072
    AND jsonb_typeof(event_payload::JSONB) = 'object'
  ),
  terminal BOOLEAN NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  applied_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, interaction_id, execution_generation, event_cursor),
  FOREIGN KEY (tenant_id, interaction_id, execution_generation)
    REFERENCES converact_active_call_event_sessions (
      tenant_id, interaction_id, execution_generation
    ) ON DELETE RESTRICT,
  CHECK (applied_at IS NULL OR applied_at >= received_at)
);

CREATE OR REPLACE FUNCTION converact_active_call_event_append(
  p_tenant_id TEXT,
  p_contract_schema_version SMALLINT,
  p_interaction_id TEXT,
  p_campaign_id TEXT,
  p_campaign_contact_id TEXT,
  p_call_attempt_id TEXT,
  p_call_id TEXT,
  p_agent_release_id TEXT,
  p_channel_agent_session_id TEXT,
  p_execution_generation BIGINT,
  p_expected_previous_cursor BIGINT,
  p_event_cursor BIGINT,
  p_payload_digest TEXT,
  p_event_payload TEXT,
  p_terminal BOOLEAN
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_session public.converact_active_call_event_sessions%ROWTYPE;
  current_event public.converact_active_call_event_inbox%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM opc_current_tenant()
    OR p_contract_schema_version <= 0
    OR p_execution_generation <= 0
    OR p_expected_previous_cursor < 0
    OR p_event_cursor <= 0
    OR p_expected_previous_cursor <> p_event_cursor - 1
    OR p_payload_digest IS NULL
    OR p_payload_digest !~ '^[0-9a-f]{64}$'
    OR p_event_payload IS NULL
    OR p_terminal IS NULL
    OR octet_length(p_event_payload) NOT BETWEEN 1 AND 131072
    OR jsonb_typeof(p_event_payload::JSONB) <> 'object'
  THEN
    RAISE EXCEPTION 'invalid Active Call event append' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.converact_active_call_event_sessions (
    tenant_id, contract_schema_version, interaction_id, campaign_id, campaign_contact_id,
    call_attempt_id, call_id, agent_release_id, channel_agent_session_id,
    execution_generation
  ) VALUES (
    p_tenant_id, p_contract_schema_version, p_interaction_id, p_campaign_id,
    p_campaign_contact_id, p_call_attempt_id, p_call_id, p_agent_release_id,
    p_channel_agent_session_id, p_execution_generation
  )
  ON CONFLICT (tenant_id, interaction_id, execution_generation) DO NOTHING;

  SELECT * INTO STRICT current_session
  FROM public.converact_active_call_event_sessions
  WHERE tenant_id = p_tenant_id
    AND interaction_id = p_interaction_id
    AND execution_generation = p_execution_generation
  FOR UPDATE;

  IF current_session.contract_schema_version IS DISTINCT FROM p_contract_schema_version
    OR current_session.campaign_id IS DISTINCT FROM p_campaign_id
    OR current_session.campaign_contact_id IS DISTINCT FROM p_campaign_contact_id
    OR current_session.call_attempt_id IS DISTINCT FROM p_call_attempt_id
    OR current_session.call_id IS DISTINCT FROM p_call_id
    OR current_session.agent_release_id IS DISTINCT FROM p_agent_release_id
    OR current_session.channel_agent_session_id IS DISTINCT FROM p_channel_agent_session_id
  THEN
    RAISE EXCEPTION 'Active Call event authority conflict' USING ERRCODE = '40001';
  END IF;
  IF current_session.status = 'reconcile_required' THEN
    RAISE EXCEPTION 'Active Call event stream requires reconciliation' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO current_event
  FROM public.converact_active_call_event_inbox
  WHERE tenant_id = p_tenant_id
    AND interaction_id = p_interaction_id
    AND execution_generation = p_execution_generation
    AND event_cursor = p_event_cursor;

  IF FOUND THEN
    IF current_event.payload_digest <> p_payload_digest
      OR current_event.terminal <> p_terminal
    THEN
      RAISE EXCEPTION 'event replay conflicts with durable payload' USING ERRCODE = '40001';
    END IF;
    IF current_event.applied_at IS NOT NULL THEN
      RETURN 'replayed_applied';
    END IF;
    RETURN 'replayed_pending';
  END IF;

  IF current_session.status <> 'active'
    OR current_session.terminal_cursor IS NOT NULL
    OR current_session.last_received_cursor <> p_expected_previous_cursor
  THEN
    RAISE EXCEPTION 'event cursor is not contiguous' USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.converact_active_call_event_inbox (
    tenant_id, interaction_id, execution_generation, event_cursor,
    payload_digest, event_payload, terminal
  ) VALUES (
    p_tenant_id, p_interaction_id, p_execution_generation, p_event_cursor,
    p_payload_digest, p_event_payload, p_terminal
  );

  UPDATE public.converact_active_call_event_sessions
  SET last_received_cursor = p_event_cursor,
      terminal_cursor = CASE WHEN p_terminal THEN p_event_cursor ELSE NULL END,
      updated_at = transaction_timestamp()
  WHERE tenant_id = p_tenant_id
    AND interaction_id = p_interaction_id
    AND execution_generation = p_execution_generation;

  RETURN 'appended';
END
$$;

CREATE OR REPLACE FUNCTION converact_active_call_event_mark_applied(
  p_tenant_id TEXT,
  p_contract_schema_version SMALLINT,
  p_interaction_id TEXT,
  p_campaign_id TEXT,
  p_campaign_contact_id TEXT,
  p_call_attempt_id TEXT,
  p_call_id TEXT,
  p_agent_release_id TEXT,
  p_channel_agent_session_id TEXT,
  p_execution_generation BIGINT,
  p_event_cursor BIGINT,
  p_payload_digest TEXT,
  p_terminal BOOLEAN
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_session public.converact_active_call_event_sessions%ROWTYPE;
  current_event public.converact_active_call_event_inbox%ROWTYPE;
  changed BIGINT;
BEGIN
  IF p_tenant_id IS DISTINCT FROM opc_current_tenant()
    OR p_contract_schema_version <= 0
    OR p_execution_generation <= 0
    OR p_event_cursor <= 0
    OR p_payload_digest IS NULL
    OR p_payload_digest !~ '^[0-9a-f]{64}$'
    OR p_terminal IS NULL
  THEN
    RAISE EXCEPTION 'invalid Active Call event acknowledgement' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO STRICT current_session
  FROM public.converact_active_call_event_sessions
  WHERE tenant_id = p_tenant_id
    AND interaction_id = p_interaction_id
    AND execution_generation = p_execution_generation
  FOR UPDATE;

  IF current_session.contract_schema_version IS DISTINCT FROM p_contract_schema_version
    OR current_session.campaign_id IS DISTINCT FROM p_campaign_id
    OR current_session.campaign_contact_id IS DISTINCT FROM p_campaign_contact_id
    OR current_session.call_attempt_id IS DISTINCT FROM p_call_attempt_id
    OR current_session.call_id IS DISTINCT FROM p_call_id
    OR current_session.agent_release_id IS DISTINCT FROM p_agent_release_id
    OR current_session.channel_agent_session_id IS DISTINCT FROM p_channel_agent_session_id
  THEN
    RAISE EXCEPTION 'Active Call event authority conflict' USING ERRCODE = '40001';
  END IF;
  IF current_session.status = 'reconcile_required' THEN
    RAISE EXCEPTION 'Active Call event stream requires reconciliation' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO STRICT current_event
  FROM public.converact_active_call_event_inbox
  WHERE tenant_id = p_tenant_id
    AND interaction_id = p_interaction_id
    AND execution_generation = p_execution_generation
    AND event_cursor = p_event_cursor
  FOR UPDATE;

  IF current_event.payload_digest <> p_payload_digest
    OR current_event.terminal <> p_terminal
  THEN
    RAISE EXCEPTION 'event acknowledgement conflicts with durable payload' USING ERRCODE = '40001';
  END IF;
  IF p_event_cursor <= current_session.last_applied_cursor THEN
    IF current_event.applied_at IS NULL THEN
      RAISE EXCEPTION 'event acknowledgement head is inconsistent' USING ERRCODE = '40001';
    END IF;
    RETURN 'replayed';
  END IF;
  IF current_session.status <> 'active'
    OR current_event.applied_at IS NOT NULL
    OR current_session.last_applied_cursor <> p_event_cursor - 1
    OR (p_terminal AND (
      current_session.terminal_cursor IS DISTINCT FROM p_event_cursor
      OR current_session.last_received_cursor <> p_event_cursor
    ))
  THEN
    RAISE EXCEPTION 'event acknowledgement is not contiguous' USING ERRCODE = '40001';
  END IF;

  UPDATE public.converact_active_call_event_inbox
  SET applied_at = transaction_timestamp()
  WHERE tenant_id = p_tenant_id
    AND interaction_id = p_interaction_id
    AND execution_generation = p_execution_generation
    AND event_cursor = p_event_cursor
    AND applied_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'event acknowledgement lost ownership' USING ERRCODE = '40001';
  END IF;

  UPDATE public.converact_active_call_event_sessions
  SET last_applied_cursor = p_event_cursor,
      status = CASE WHEN p_terminal THEN 'completed' ELSE 'active' END,
      updated_at = transaction_timestamp()
  WHERE tenant_id = p_tenant_id
    AND interaction_id = p_interaction_id
    AND execution_generation = p_execution_generation;

  RETURN 'applied';
END
$$;

CREATE OR REPLACE FUNCTION converact_active_call_event_require_reconcile(
  p_tenant_id TEXT,
  p_contract_schema_version SMALLINT,
  p_interaction_id TEXT,
  p_campaign_id TEXT,
  p_campaign_contact_id TEXT,
  p_call_attempt_id TEXT,
  p_call_id TEXT,
  p_agent_release_id TEXT,
  p_channel_agent_session_id TEXT,
  p_execution_generation BIGINT,
  p_reason TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_session public.converact_active_call_event_sessions%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM opc_current_tenant()
    OR p_contract_schema_version <= 0
    OR p_execution_generation <= 0
    OR p_reason IS NULL
    OR p_reason NOT IN ('coverage_gap', 'session_disappeared', 'invalid_event')
  THEN
    RAISE EXCEPTION 'invalid Active Call reconciliation request' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.converact_active_call_event_sessions (
    tenant_id, contract_schema_version, interaction_id, campaign_id, campaign_contact_id,
    call_attempt_id, call_id, agent_release_id, channel_agent_session_id,
    execution_generation
  ) VALUES (
    p_tenant_id, p_contract_schema_version, p_interaction_id, p_campaign_id,
    p_campaign_contact_id, p_call_attempt_id, p_call_id, p_agent_release_id,
    p_channel_agent_session_id, p_execution_generation
  )
  ON CONFLICT (tenant_id, interaction_id, execution_generation) DO NOTHING;

  SELECT * INTO STRICT current_session
  FROM public.converact_active_call_event_sessions
  WHERE tenant_id = p_tenant_id
    AND interaction_id = p_interaction_id
    AND execution_generation = p_execution_generation
  FOR UPDATE;

  IF current_session.contract_schema_version IS DISTINCT FROM p_contract_schema_version
    OR current_session.campaign_id IS DISTINCT FROM p_campaign_id
    OR current_session.campaign_contact_id IS DISTINCT FROM p_campaign_contact_id
    OR current_session.call_attempt_id IS DISTINCT FROM p_call_attempt_id
    OR current_session.call_id IS DISTINCT FROM p_call_id
    OR current_session.agent_release_id IS DISTINCT FROM p_agent_release_id
    OR current_session.channel_agent_session_id IS DISTINCT FROM p_channel_agent_session_id
  THEN
    RAISE EXCEPTION 'Active Call event authority conflict' USING ERRCODE = '40001';
  END IF;
  IF current_session.status = 'completed' THEN
    RAISE EXCEPTION 'completed Active Call event stream cannot reconcile' USING ERRCODE = '40001';
  END IF;
  IF current_session.status = 'reconcile_required' THEN
    IF current_session.reconcile_reason <> p_reason THEN
      RAISE EXCEPTION 'Active Call reconciliation reason conflict' USING ERRCODE = '40001';
    END IF;
    RETURN 'replayed';
  END IF;

  UPDATE public.converact_active_call_event_sessions
  SET status = 'reconcile_required',
      reconcile_reason = p_reason,
      updated_at = transaction_timestamp()
  WHERE tenant_id = p_tenant_id
    AND interaction_id = p_interaction_id
    AND execution_generation = p_execution_generation;

  RETURN 'marked';
END
$$;

DO $rls$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'converact_active_call_event_sessions',
    'converact_active_call_event_inbox'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (opc_rls_bypass() OR tenant_id = opc_current_tenant()) WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant())',
      table_name
    );
  END LOOP;
END
$rls$;

REVOKE ALL ON FUNCTION converact_active_call_event_append(
  TEXT, SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT,
  BIGINT, BIGINT, TEXT, TEXT, BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_active_call_event_mark_applied(
  TEXT, SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT,
  BIGINT, TEXT, BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_active_call_event_require_reconcile(
  TEXT, SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT
) FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT ON converact_active_call_event_sessions TO opc_runtime;
    GRANT SELECT ON converact_active_call_event_inbox TO opc_runtime;
    GRANT EXECUTE ON FUNCTION converact_active_call_event_append(
      TEXT, SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT,
      BIGINT, BIGINT, TEXT, TEXT, BOOLEAN
    ) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION converact_active_call_event_mark_applied(
      TEXT, SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT,
      BIGINT, TEXT, BOOLEAN
    ) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION converact_active_call_event_require_reconcile(
      TEXT, SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT
    ) TO opc_runtime;
  END IF;
END
$grant$;
