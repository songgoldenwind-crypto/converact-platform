-- Standalone iveKit runtime security hardening.
-- This is the communication-only subset of the OPC least-privilege migration.

CREATE OR REPLACE FUNCTION opc_rls_bypass() RETURNS boolean AS $$
  SELECT current_user = 'opc_admin';
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION opc_rustdesk_session_by_external_id(p_external_id TEXT)
RETURNS SETOF public.rustdesk_gateway_sessions
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public.rustdesk_gateway_sessions WHERE external_id = p_external_id;
$$;

REVOKE ALL ON FUNCTION opc_rustdesk_session_by_external_id(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_worker_tenant_ids(TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_tinode_mutation_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_tinode_inbound_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_ivekit_cc_worker_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_secure_file_status_transition_allowed(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_secure_file_worker_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_secure_file_derivative_worker_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_secure_file_cleanup_worker_tenant_ids(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_rustdesk_evidence_intelligence_candidates(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_tinode_delivery_worker_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_notification_worker_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_notification_worker_tenant_ids(
  TIMESTAMPTZ, INTEGER, SMALLINT[]
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_notification_receipt_tenant_ids(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_notification_health_tenant_ids(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_ivekit_retention_tenant_ids(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_ivekit_event_retention_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_ivekit_delete_expired_audit_events(
  TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_ivekit_claim_interaction_placements(
  TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_ivekit_placement_tenant_ids(
  TIMESTAMPTZ, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_ivekit_recording_worker_tenant_ids(
  TIMESTAMPTZ, INTEGER
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_rustdesk_session_by_external_id(TEXT) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_worker_tenant_ids(TEXT, TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_tinode_mutation_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_tinode_inbound_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_ivekit_cc_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_secure_file_status_transition_allowed(TEXT, TEXT) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_secure_file_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_secure_file_derivative_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_secure_file_cleanup_worker_tenant_ids(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_rustdesk_evidence_intelligence_candidates(INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_tinode_delivery_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_notification_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_notification_worker_tenant_ids(TIMESTAMPTZ, INTEGER, SMALLINT[]) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_notification_receipt_tenant_ids(INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_notification_health_tenant_ids(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_ivekit_retention_tenant_ids(INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_ivekit_event_retention_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_ivekit_delete_expired_audit_events(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_ivekit_claim_interaction_placements(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_ivekit_placement_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_ivekit_recording_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
  END IF;
END
$$;
