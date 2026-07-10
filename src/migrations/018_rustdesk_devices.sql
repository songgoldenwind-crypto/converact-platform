CREATE TABLE IF NOT EXISTS rustdesk_devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_ref_type TEXT NOT NULL,
  business_ref_id TEXT NOT NULL,
  rustdesk_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deactivated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rustdesk_devices_tenant_rustdesk
  ON rustdesk_devices(tenant_id, rustdesk_id)
  WHERE deactivated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rustdesk_devices_business_ref
  ON rustdesk_devices(tenant_id, business_ref_type, business_ref_id, created_at DESC)
  WHERE deactivated_at IS NULL;
