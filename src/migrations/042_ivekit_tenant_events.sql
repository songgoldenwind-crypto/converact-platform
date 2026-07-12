CREATE TABLE IF NOT EXISTS ivekit_tenant_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'tenant'
    CHECK (visibility_scope IN ('tenant', 'chat_session', 'media_call', 'remote_session')),
  visibility_ref_id TEXT NOT NULL DEFAULT '',
  audience_user_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (visibility_scope = 'tenant' AND visibility_ref_id = '') OR
    (visibility_scope <> 'tenant' AND visibility_ref_id <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_ivekit_tenant_events_replay
  ON ivekit_tenant_events(tenant_id, id);

CREATE INDEX IF NOT EXISTS idx_ivekit_tenant_events_expiry
  ON ivekit_tenant_events(expires_at);

ALTER TABLE ivekit_tenant_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_tenant_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_tenant_events;
CREATE POLICY tenant_isolation ON ivekit_tenant_events FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE OR REPLACE FUNCTION opc_ivekit_event_retention_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT event.tenant_id
  FROM public.ivekit_tenant_events event
  WHERE event.expires_at <= p_now
  GROUP BY event.tenant_id
  ORDER BY min(event.expires_at), event.tenant_id
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

REVOKE ALL ON FUNCTION opc_ivekit_event_retention_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_ivekit_event_retention_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
  END IF;
END
$$;
