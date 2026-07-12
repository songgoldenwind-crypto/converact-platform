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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_rustdesk_session_by_external_id(TEXT) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_worker_tenant_ids(TEXT, TIMESTAMPTZ, INTEGER) TO opc_runtime';
  END IF;
END
$$;
