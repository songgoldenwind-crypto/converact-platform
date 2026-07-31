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
        'rustdesk_devices',
        'rustdesk_gateway_sessions',
        'rustdesk_gateway_events'
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
