-- IVR runtime tables: ensure FORCE RLS (idempotent backfill after 007/009).
-- Tables may predate 009 on some envs, or need explicit re-apply after schema drift.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'tenant_id'
      AND table_name IN (
        'ivr_sessions',
        'ivr_session_steps',
        'ivr_time_groups',
        'ivr_region_groups',
        'ivr_group_call_groups',
        'ivr_flow_history'
      )
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
         WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant())',
      r.table_name
    );
  END LOOP;
END $$;

ALTER TABLE ivr_sessions ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
