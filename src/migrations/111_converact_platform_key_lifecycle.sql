CREATE TABLE IF NOT EXISTS converact_platform_key_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_ring_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_version BIGINT NOT NULL CHECK (key_version > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('signing', 'encryption', 'mtls', 'provider_credential')),
  state TEXT NOT NULL CHECK (state IN (
    'generated', 'staged', 'active', 'retiring', 'revoked', 'expired', 'destroyed'
  )),
  material_ref TEXT NOT NULL CHECK (material_ref ~ '^(kms|pki)://'),
  revision BIGINT NOT NULL CHECK (revision > 0),
  writer_id TEXT NOT NULL,
  writer_epoch BIGINT NOT NULL CHECK (writer_epoch >= 0),
  not_before TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > not_before),
  state_changed_at TIMESTAMPTZ NOT NULL,
  overlap_until TIMESTAMPTZ,
  last_command_id TEXT,
  last_command_digest TEXT CHECK (last_command_digest IS NULL OR char_length(last_command_digest) = 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, key_ring_id, key_id, revision),
  UNIQUE (tenant_id, key_ring_id, key_version, revision),
  CHECK ((last_command_id IS NULL) = (last_command_digest IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_converact_platform_key_ring_head
  ON converact_platform_key_versions (tenant_id, key_ring_id, key_version DESC, revision DESC);

CREATE TABLE IF NOT EXISTS converact_platform_key_lifecycle_receipts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  key_ring_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_version BIGINT NOT NULL CHECK (key_version > 0),
  command_id TEXT NOT NULL,
  command_digest TEXT NOT NULL CHECK (char_length(command_digest) = 64),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  writer_id TEXT NOT NULL,
  writer_epoch BIGINT NOT NULL CHECK (writer_epoch >= 0),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, key_ring_id, command_id)
);

CREATE TABLE IF NOT EXISTS converact_platform_certificate_bindings (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL,
  service_identity TEXT NOT NULL,
  san_service_id TEXT NOT NULL,
  audience JSONB NOT NULL CHECK (jsonb_typeof(audience) = 'array'),
  key_ring_id TEXT NOT NULL,
  key_version BIGINT NOT NULL CHECK (key_version > 0),
  certificate_ref TEXT NOT NULL CHECK (certificate_ref ~ '^pki://'),
  ca_ref TEXT NOT NULL CHECK (ca_ref ~ '^pki://'),
  not_before TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > not_before),
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  revision BIGINT NOT NULL CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, binding_id, revision)
);

CREATE OR REPLACE FUNCTION opc_converact_platform_key_history_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'platform key history is immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS converact_platform_key_versions_append_only
  ON converact_platform_key_versions;
CREATE TRIGGER converact_platform_key_versions_append_only
  BEFORE UPDATE OR DELETE ON converact_platform_key_versions
  FOR EACH ROW EXECUTE FUNCTION opc_converact_platform_key_history_guard();

DROP TRIGGER IF EXISTS converact_platform_key_lifecycle_receipts_append_only
  ON converact_platform_key_lifecycle_receipts;
CREATE TRIGGER converact_platform_key_lifecycle_receipts_append_only
  BEFORE UPDATE OR DELETE ON converact_platform_key_lifecycle_receipts
  FOR EACH ROW EXECUTE FUNCTION opc_converact_platform_key_history_guard();

DROP TRIGGER IF EXISTS converact_platform_certificate_bindings_append_only
  ON converact_platform_certificate_bindings;
CREATE TRIGGER converact_platform_certificate_bindings_append_only
  BEFORE UPDATE OR DELETE ON converact_platform_certificate_bindings
  FOR EACH ROW EXECUTE FUNCTION opc_converact_platform_key_history_guard();

ALTER TABLE converact_platform_key_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_key_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_platform_key_versions;
CREATE POLICY tenant_isolation ON converact_platform_key_versions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_platform_key_lifecycle_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_key_lifecycle_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_platform_key_lifecycle_receipts;
CREATE POLICY tenant_isolation ON converact_platform_key_lifecycle_receipts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_platform_certificate_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_certificate_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_platform_certificate_bindings;
CREATE POLICY tenant_isolation ON converact_platform_certificate_bindings FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION opc_converact_platform_key_history_guard() FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT ON converact_platform_key_versions TO opc_runtime;
    GRANT SELECT, INSERT ON converact_platform_key_lifecycle_receipts TO opc_runtime;
    GRANT SELECT, INSERT ON converact_platform_certificate_bindings TO opc_runtime;
  END IF;
END
$grant$;
