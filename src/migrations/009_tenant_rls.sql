-- CCaaS MT-2: PostgreSQL row-level security for tenant isolation.
-- Application sets per-transaction context via:
--   SELECT set_config('app.current_tenant', '<tenant_id>', true);
--   SELECT set_config('app.bypass_rls', 'on', true);  -- auth bootstrap only
--
-- Why FORCE ROW LEVEL SECURITY: by default the table OWNER bypasses RLS
-- policies. The role in DATABASE_URL typically owns these tables (it ran the
-- migrations), so without FORCE the isolation this file defines is silently
-- NOT enforced in production. FORCE makes the owner subject to the same
-- policies as everyone else; the opc_rls_bypass() GUC remains the only escape
-- hatch, reserved for auth bootstrap. See audit 审核文档.md 校准3 / 代码动作3.

CREATE OR REPLACE FUNCTION opc_rls_bypass() RETURNS boolean AS $$
  SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on';
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION opc_current_tenant() RETURNS text AS $$
  SELECT nullif(current_setting('app.current_tenant', true), '');
$$ LANGUAGE sql STABLE;

-- tenants: match on primary key, not tenant_id column
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON tenants;
CREATE POLICY tenant_self ON tenants
  FOR ALL
  USING (opc_rls_bypass() OR id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR id = opc_current_tenant());

-- All other public tables with tenant_id
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenant_id'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name <> 'tenants'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', r.table_name);

    IF r.table_name = 'audio_library' THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I FOR ALL
           USING (
             opc_rls_bypass()
             OR scope = ''public''
             OR tenant_id = opc_current_tenant()
           )
           WITH CHECK (
             opc_rls_bypass()
             OR tenant_id = opc_current_tenant()
           )',
        r.table_name
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I FOR ALL
           USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
           WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant())',
        r.table_name
      );
    END IF;
  END LOOP;
END $$;
