CREATE TABLE IF NOT EXISTS ivekit_voice_extension_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  extension_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (char_length(request_hash) = 64),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > issued_at),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, extension_id)
    REFERENCES ivekit_voice_extensions(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ivekit_voice_extension_sessions_expiry
  ON ivekit_voice_extension_sessions(tenant_id, expires_at, id);

ALTER TABLE ivekit_voice_extension_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_extension_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_extension_sessions;
CREATE POLICY tenant_isolation ON ivekit_voice_extension_sessions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE OR REPLACE FUNCTION opc_ivekit_webphone_session_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(tenant_id TEXT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT session.tenant_id
  FROM public.ivekit_voice_extension_sessions AS session
  WHERE session.expires_at <= p_now
  GROUP BY session.tenant_id
  ORDER BY MIN(session.expires_at), session.tenant_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 1000))
$$;

REVOKE ALL ON FUNCTION opc_ivekit_webphone_session_tenant_ids(TIMESTAMPTZ, INTEGER)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, DELETE ON ivekit_voice_extension_sessions TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_ivekit_webphone_session_tenant_ids(TIMESTAMPTZ, INTEGER)
      TO opc_runtime;
  END IF;
END
$$;
