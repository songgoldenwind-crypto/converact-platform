ALTER TABLE ivekit_cell_admission_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cell_admission_reservations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ivekit_cell_admission_reservations;
CREATE POLICY tenant_isolation ON ivekit_cell_admission_reservations
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ivekit_cell_admission_reservations TO opc_runtime;
  END IF;
END
$$;
