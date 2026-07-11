-- Runtime connections must not be able to turn a custom GUC into a global
-- tenant bypass. Cross-tenant bootstrap and worker discovery use narrowly
-- scoped SECURITY DEFINER functions instead.

CREATE OR REPLACE FUNCTION opc_rls_bypass() RETURNS boolean AS $$
  SELECT current_user = 'opc_admin';
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION opc_auth_user_by_email(p_email TEXT)
RETURNS TABLE (
  user_id TEXT,
  email TEXT,
  password_hash TEXT,
  role TEXT,
  name TEXT,
  tenant_id TEXT,
  tenant_name TEXT,
  plan_code TEXT,
  tenant_status TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.email, u.password_hash, u.role, u.name,
         t.id, t.name, t.plan_code, t.status
  FROM public.users u
  JOIN public.tenants t ON t.id = u.tenant_id
  WHERE lower(u.email) = lower(p_email) AND u.is_active = TRUE
  ORDER BY u.created_at ASC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION opc_register_tenant_owner(
  p_tenant_id TEXT,
  p_tenant_name TEXT,
  p_user_id TEXT,
  p_email TEXT,
  p_password_hash TEXT,
  p_name TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(lower(p_email)));
  IF EXISTS (SELECT 1 FROM public.users WHERE lower(email) = lower(p_email)) THEN
    RAISE EXCEPTION 'email already registered' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.tenants (id, name, plan_code)
  VALUES (p_tenant_id, p_tenant_name, 'free');
  INSERT INTO public.users (id, tenant_id, email, password_hash, role, name)
  VALUES (p_user_id, p_tenant_id, p_email, p_password_hash, 'owner', nullif(p_name, ''));
END;
$$;

CREATE OR REPLACE FUNCTION opc_rustdesk_session_by_external_id(p_external_id TEXT)
RETURNS SETOF public.rustdesk_gateway_sessions
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public.rustdesk_gateway_sessions WHERE external_id = p_external_id;
$$;

CREATE OR REPLACE FUNCTION opc_worker_tenant_ids(
  p_queue TEXT,
  p_now TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bounded_limit INTEGER := least(greatest(p_limit, 1), 1000);
BEGIN
  IF p_queue = 'tinode' THEN
    RETURN QUERY
      SELECT m.tenant_id
      FROM public.collaboration_messages m
      WHERE m.provider = 'tinode'
        AND (
          m.provider_delivery_status = 'pending'
          OR (m.provider_delivery_status = 'retry_wait'
              AND (m.provider_next_attempt_at IS NULL OR m.provider_next_attempt_at <= p_now))
          OR (m.provider_delivery_status = 'publishing' AND m.provider_delivery_lease_until <= p_now)
        )
      GROUP BY m.tenant_id
      ORDER BY min(coalesce(m.provider_next_attempt_at, m.created_at))
      LIMIT bounded_limit;
  ELSIF p_queue = 'attachment' THEN
    RETURN QUERY
      SELECT j.tenant_id
      FROM public.collaboration_attachment_processing_jobs j
      WHERE (j.status = 'pending'
             OR (j.status = 'retry_wait' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= p_now))
             OR (j.status = 'processing' AND j.lease_until <= p_now))
        AND j.attempt_count < j.max_attempts
      GROUP BY j.tenant_id
      ORDER BY min(coalesce(j.next_attempt_at, j.created_at))
      LIMIT bounded_limit;
  ELSIF p_queue = 'quality' THEN
    RETURN QUERY
      SELECT j.tenant_id
      FROM public.collaboration_quality_review_jobs j
      WHERE (j.status = 'pending'
             OR (j.status = 'retry_wait' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= p_now))
             OR (j.status = 'processing' AND j.lease_until <= p_now))
        AND j.attempt_count < j.max_attempts
      GROUP BY j.tenant_id
      ORDER BY min(coalesce(j.next_attempt_at, j.created_at))
      LIMIT bounded_limit;
  ELSE
    RAISE EXCEPTION 'unsupported worker queue: %', p_queue USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION opc_auth_user_by_email(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_register_tenant_owner(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_rustdesk_session_by_external_id(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_worker_tenant_ids(TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_auth_user_by_email(TEXT) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_register_tenant_owner(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_rustdesk_session_by_external_id(TEXT) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_worker_tenant_ids(TEXT, TIMESTAMPTZ, INTEGER) TO opc_runtime';
  END IF;
END
$$;
