-- Freeze the customer media source and transcript metadata for crash-safe Active Call recovery.
SET LOCAL lock_timeout = '5s';

ALTER TABLE converact_active_call_event_sessions
  ADD COLUMN IF NOT EXISTS customer_track_id TEXT,
  ADD COLUMN IF NOT EXISTS call_started_at_ms BIGINT,
  ADD COLUMN IF NOT EXISTS language TEXT,
  ADD COLUMN IF NOT EXISTS retention_policy_ref TEXT;

ALTER TABLE converact_active_call_event_sessions
  DROP CONSTRAINT IF EXISTS converact_active_call_event_media_binding_complete;
ALTER TABLE converact_active_call_event_sessions
  ADD CONSTRAINT converact_active_call_event_media_binding_complete CHECK (
    num_nonnulls(
      customer_track_id, call_started_at_ms, language, retention_policy_ref
    ) IN (0, 4)
    AND (customer_track_id IS NULL OR char_length(customer_track_id) BETWEEN 1 AND 255)
    AND (call_started_at_ms IS NULL OR call_started_at_ms BETWEEN 1 AND 9007199254740991)
    AND (language IS NULL OR char_length(language) BETWEEN 2 AND 35)
    AND (retention_policy_ref IS NULL OR char_length(retention_policy_ref) BETWEEN 1 AND 255)
  ) NOT VALID;
ALTER TABLE converact_active_call_event_sessions
  VALIDATE CONSTRAINT converact_active_call_event_media_binding_complete;

CREATE OR REPLACE FUNCTION converact_active_call_event_bind_media(
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
  p_customer_track_id TEXT,
  p_call_started_at_ms BIGINT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_session public.converact_active_call_event_sessions%ROWTYPE;
  release_language TEXT;
  retention_until_ms BIGINT;
  resolved_retention_policy_ref TEXT;
BEGIN
  IF p_tenant_id IS DISTINCT FROM opc_current_tenant()
    OR p_contract_schema_version <= 0
    OR p_execution_generation <= 0
    OR p_customer_track_id IS NULL
    OR char_length(p_customer_track_id) NOT BETWEEN 1 AND 255
    OR p_call_started_at_ms NOT BETWEEN 1 AND 9007199254740991
  THEN
    RAISE EXCEPTION 'invalid Active Call media binding' USING ERRCODE = '22023';
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
    OR current_session.status = 'reconcile_required'
  THEN
    RAISE EXCEPTION 'Active Call media binding authority conflict' USING ERRCODE = '40001';
  END IF;

  SELECT release.language,
         floor(extract(epoch FROM attempt.retention_until) * 1000)::BIGINT
  INTO STRICT release_language, retention_until_ms
  FROM public.converact_outbound_call_attempts AS attempt
  JOIN public.converact_agent_releases AS release
    ON release.tenant_id = attempt.tenant_id
   AND release.id = attempt.agent_release_id
  WHERE attempt.tenant_id = p_tenant_id
    AND attempt.id = p_call_attempt_id
    AND attempt.campaign_id = p_campaign_id
    AND attempt.campaign_contact_id = p_campaign_contact_id
    AND attempt.interaction_id = p_interaction_id
    AND attempt.call_id IS NOT DISTINCT FROM p_call_id
    AND attempt.agent_release_id = p_agent_release_id
    AND attempt.channel_agent_session_id = p_channel_agent_session_id
    AND attempt.execution_generation = p_execution_generation;

  resolved_retention_policy_ref := 'until-ms-' || retention_until_ms::TEXT;

  IF current_session.customer_track_id IS NULL THEN
    UPDATE public.converact_active_call_event_sessions
    SET customer_track_id = p_customer_track_id,
        call_started_at_ms = p_call_started_at_ms,
        language = release_language,
        retention_policy_ref = resolved_retention_policy_ref,
        updated_at = transaction_timestamp()
    WHERE tenant_id = p_tenant_id
      AND interaction_id = p_interaction_id
      AND execution_generation = p_execution_generation;
    RETURN 'bound';
  END IF;

  IF current_session.customer_track_id IS NOT DISTINCT FROM p_customer_track_id
    AND current_session.call_started_at_ms IS NOT DISTINCT FROM p_call_started_at_ms
    AND current_session.language IS NOT DISTINCT FROM release_language
    AND current_session.retention_policy_ref IS NOT DISTINCT FROM resolved_retention_policy_ref
  THEN
    RETURN 'replayed';
  END IF;

  RAISE EXCEPTION 'Active Call media binding conflicts with durable state'
    USING ERRCODE = '40001';
END
$$;

REVOKE ALL ON FUNCTION converact_active_call_event_bind_media(
  TEXT, SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BIGINT
) FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT EXECUTE ON FUNCTION converact_active_call_event_bind_media(
      TEXT, SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BIGINT
    ) TO opc_runtime;
  END IF;
END
$grant$;
