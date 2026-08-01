CREATE TABLE IF NOT EXISTS converact_platform_billing_writers (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  billing_key TEXT NOT NULL CHECK (char_length(billing_key) BETWEEN 1 AND 1024),
  writer_id TEXT NOT NULL CHECK (char_length(writer_id) BETWEEN 1 AND 256),
  writer_epoch BIGINT NOT NULL CHECK (writer_epoch >= 0),
  elected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, billing_key, writer_epoch),
  UNIQUE (tenant_id, billing_key, writer_id, writer_epoch)
);

CREATE INDEX IF NOT EXISTS idx_converact_platform_billing_writer_head
  ON converact_platform_billing_writers (tenant_id, billing_key, writer_epoch DESC);

CREATE TABLE IF NOT EXISTS converact_platform_usage_entries (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL,
  billing_key TEXT NOT NULL CHECK (char_length(billing_key) BETWEEN 1 AND 1024),
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('usage', 'reversal', 'credit')),
  unit TEXT NOT NULL CHECK (char_length(unit) BETWEEN 1 AND 256),
  quantity NUMERIC(30, 6) NOT NULL CHECK (quantity > 0),
  receipt_id TEXT NOT NULL,
  receipt_digest TEXT NOT NULL CHECK (char_length(receipt_digest) = 64),
  writer_id TEXT NOT NULL,
  writer_epoch BIGINT NOT NULL CHECK (writer_epoch >= 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  reverses_entry_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, entry_id),
  UNIQUE (tenant_id, billing_key, entry_id),
  UNIQUE (tenant_id, receipt_id),
  UNIQUE (tenant_id, billing_key, receipt_digest),
  FOREIGN KEY (tenant_id, billing_key, writer_id, writer_epoch)
    REFERENCES converact_platform_billing_writers
      (tenant_id, billing_key, writer_id, writer_epoch),
  FOREIGN KEY (tenant_id, billing_key, reverses_entry_id)
    REFERENCES converact_platform_usage_entries (tenant_id, billing_key, entry_id),
  CHECK (
    (entry_kind = 'usage' AND reverses_entry_id IS NULL)
    OR (entry_kind IN ('reversal', 'credit') AND reverses_entry_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_converact_platform_base_usage
  ON converact_platform_usage_entries (tenant_id, billing_key)
  WHERE entry_kind = 'usage';

CREATE INDEX IF NOT EXISTS idx_converact_platform_usage_timeline
  ON converact_platform_usage_entries (tenant_id, occurred_at, entry_id);

CREATE OR REPLACE FUNCTION opc_converact_platform_usage_history_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'platform usage history is immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS converact_platform_billing_writers_append_only
  ON converact_platform_billing_writers;
CREATE TRIGGER converact_platform_billing_writers_append_only
  BEFORE UPDATE OR DELETE ON converact_platform_billing_writers
  FOR EACH ROW EXECUTE FUNCTION opc_converact_platform_usage_history_guard();

DROP TRIGGER IF EXISTS converact_platform_usage_entries_append_only
  ON converact_platform_usage_entries;
CREATE TRIGGER converact_platform_usage_entries_append_only
  BEFORE UPDATE OR DELETE ON converact_platform_usage_entries
  FOR EACH ROW EXECUTE FUNCTION opc_converact_platform_usage_history_guard();

ALTER TABLE converact_platform_billing_writers ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_billing_writers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_platform_billing_writers;
CREATE POLICY tenant_isolation ON converact_platform_billing_writers FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_platform_usage_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_usage_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_platform_usage_entries;
CREATE POLICY tenant_isolation ON converact_platform_usage_entries FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION opc_converact_platform_usage_history_guard() FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT ON converact_platform_billing_writers TO opc_runtime;
    GRANT SELECT, INSERT ON converact_platform_usage_entries TO opc_runtime;
  END IF;
END
$grant$;
