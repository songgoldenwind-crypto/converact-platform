ALTER TABLE rustdesk_devices
  ADD COLUMN IF NOT EXISTS runtime_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (runtime_status IN ('unknown', 'online', 'offline'));

ALTER TABLE rustdesk_devices
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

ALTER TABLE rustdesk_devices
  ADD COLUMN IF NOT EXISTS last_seen_actor TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_rustdesk_devices_runtime_status
  ON rustdesk_devices(tenant_id, runtime_status, last_seen_at DESC)
  WHERE deactivated_at IS NULL;
