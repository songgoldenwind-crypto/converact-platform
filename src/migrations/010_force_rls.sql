-- Backfill: force RLS on all tenant-scoped tables.
-- Reason: migration 009 originally ENABLEd RLS but did not FORCE it, so the
-- table owner (the role in DATABASE_URL) bypassed every policy. 010 makes the
-- owner subject to the same policies on databases where the original 009
-- already ran without FORCE. Idempotent — safe on fresh databases too.
-- See audit 审核文档.md 校准3 / 代码动作3.

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
  LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.table_name);
  END LOOP;

  ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
END $$;