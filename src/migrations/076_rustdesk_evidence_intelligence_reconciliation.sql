CREATE OR REPLACE FUNCTION opc_rustdesk_evidence_intelligence_candidates(
  p_limit INTEGER DEFAULT 25
)
RETURNS TABLE(tenant_id TEXT, secure_file_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT file.tenant_id, file.id
  FROM public.collaboration_secure_files AS file
  WHERE file.status = 'ready'
    AND file.threat_status = 'clean'
    AND file.metadata ->> 'source' = 'rustdesk_companion_evidence'
    AND NOT (file.metadata ? 'rustdesk_intelligence_reconciliation')
    AND NOT EXISTS (
      SELECT 1
      FROM public.collaboration_message_attachments AS attachment
      WHERE attachment.tenant_id = file.tenant_id
        AND attachment.secure_file_id = file.id
    )
  ORDER BY file.updated_at, file.id
  LIMIT GREATEST(1, LEAST(p_limit, 100))
$$;

REVOKE ALL ON FUNCTION opc_rustdesk_evidence_intelligence_candidates(INTEGER) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_rustdesk_evidence_intelligence_candidates(INTEGER) TO opc_runtime';
  END IF;
END
$$;
