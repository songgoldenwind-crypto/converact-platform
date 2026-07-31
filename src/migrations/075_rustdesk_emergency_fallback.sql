ALTER TABLE rustdesk_device_commands
  ADD COLUMN IF NOT EXISTS emergency_fallback_authorized BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE rustdesk_device_commands
  ADD COLUMN IF NOT EXISTS emergency_fallback_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE rustdesk_device_commands
  ADD COLUMN IF NOT EXISTS emergency_fallback_authorized_by TEXT NOT NULL DEFAULT '';

ALTER TABLE rustdesk_device_commands
  ADD COLUMN IF NOT EXISTS emergency_fallback_authorized_at TIMESTAMPTZ;

COMMENT ON COLUMN rustdesk_device_commands.emergency_fallback_authorized IS
  'Explicit owner/admin approval for a collateral RustDesk service restart after targeted disconnect failed.';
