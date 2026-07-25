-- Keep the migration ledger private while allowing the runtime readiness probe
-- to verify a bounded set of application-owned migration versions.

CREATE OR REPLACE FUNCTION public.opc_ivekit_applied_migration_versions(
  p_versions TEXT[]
)
RETURNS TABLE (version TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT ledger.version
  FROM public.schema_migrations AS ledger
  WHERE cardinality(p_versions) BETWEEN 1 AND 256
    AND ledger.version = ANY(p_versions);
$$;

REVOKE ALL ON FUNCTION public.opc_ivekit_applied_migration_versions(TEXT[]) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.opc_ivekit_applied_migration_versions(TEXT[]) TO opc_runtime;
  END IF;
END
$$;
