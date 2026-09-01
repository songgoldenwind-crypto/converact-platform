-- Additive immutable runtime artifacts for published Agent Releases.
-- This migration does not switch a writer or deploy an Active Call process.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_agent_release_runtime_artifacts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_release_id TEXT NOT NULL,
  compiler_revision TEXT NOT NULL CHECK (
    char_length(compiler_revision) BETWEEN 1 AND 128
    AND compiler_revision ~ '^[0-9A-Za-z][0-9A-Za-z._:-]*$'
  ),
  artifact_hash TEXT NOT NULL CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
  playbook_content TEXT NOT NULL CHECK (
    octet_length(playbook_content) BETWEEN 1 AND 65536
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, agent_release_id, compiler_revision),
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION converact_agent_release_frozen_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Agent Release is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.definition_id IS DISTINCT FROM OLD.definition_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.language IS DISTINCT FROM OLD.language
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.components IS DISTINCT FROM OLD.components
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Agent Release content is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = OLD.state AND NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'published' AND OLD.retired_at IS NULL
    AND NEW.state = 'retired' AND NEW.retired_at IS NOT NULL
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Agent Release transition is invalid' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS converact_agent_releases_frozen ON converact_agent_releases;
CREATE TRIGGER converact_agent_releases_frozen
  BEFORE UPDATE OR DELETE ON converact_agent_releases
  FOR EACH ROW EXECUTE FUNCTION converact_agent_release_frozen_guard();

CREATE OR REPLACE FUNCTION converact_agent_release_artifact_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Agent Release runtime artifact is immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS converact_agent_release_artifacts_immutable
  ON converact_agent_release_runtime_artifacts;
CREATE TRIGGER converact_agent_release_artifacts_immutable
  BEFORE UPDATE OR DELETE ON converact_agent_release_runtime_artifacts
  FOR EACH ROW EXECUTE FUNCTION converact_agent_release_artifact_immutable_guard();

ALTER TABLE converact_agent_release_runtime_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_agent_release_runtime_artifacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_agent_release_runtime_artifacts;
CREATE POLICY tenant_isolation ON converact_agent_release_runtime_artifacts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION converact_agent_release_frozen_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_agent_release_artifact_immutable_guard() FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT ON converact_agent_release_runtime_artifacts TO opc_runtime;
  END IF;
END
$grant$;
