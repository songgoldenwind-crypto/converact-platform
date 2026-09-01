-- Additive immutable Tool manifests bound to published Agent Releases.
-- This migration does not switch a writer or enable any Tool Provider.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_agent_release_tool_manifests (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_release_id TEXT NOT NULL,
  tool_set_hash TEXT NOT NULL CHECK (tool_set_hash ~ '^[0-9a-f]{64}$'),
  tool_manifest JSONB NOT NULL CHECK (
    jsonb_typeof(tool_manifest) = 'array'
    AND jsonb_array_length(tool_manifest) BETWEEN 1 AND 64
    AND octet_length(tool_manifest::TEXT) <= 65536
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, agent_release_id),
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION converact_agent_release_tool_manifest_bind_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  release_tool_set_hash TEXT;
BEGIN
  SELECT release.components->>'tool_schema_hash'
  INTO release_tool_set_hash
  FROM public.converact_agent_releases AS release
  WHERE release.tenant_id = NEW.tenant_id
    AND release.id = NEW.agent_release_id;
  IF release_tool_set_hash IS NULL OR release_tool_set_hash <> NEW.tool_set_hash THEN
    RAISE EXCEPTION 'Agent Release Tool manifest binding is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS converact_agent_release_tool_manifest_bind
  ON converact_agent_release_tool_manifests;
CREATE TRIGGER converact_agent_release_tool_manifest_bind
  BEFORE INSERT ON converact_agent_release_tool_manifests
  FOR EACH ROW EXECUTE FUNCTION converact_agent_release_tool_manifest_bind_guard();

CREATE OR REPLACE FUNCTION converact_agent_release_tool_manifest_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Agent Release Tool manifest is immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS converact_agent_release_tool_manifest_immutable
  ON converact_agent_release_tool_manifests;
CREATE TRIGGER converact_agent_release_tool_manifest_immutable
  BEFORE UPDATE OR DELETE ON converact_agent_release_tool_manifests
  FOR EACH ROW EXECUTE FUNCTION converact_agent_release_tool_manifest_immutable_guard();

ALTER TABLE converact_agent_release_tool_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_agent_release_tool_manifests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_agent_release_tool_manifests;
CREATE POLICY tenant_isolation ON converact_agent_release_tool_manifests FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION converact_agent_release_tool_manifest_bind_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_agent_release_tool_manifest_immutable_guard() FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT ON converact_agent_release_tool_manifests TO opc_runtime;
  END IF;
END
$grant$;
