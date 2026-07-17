ALTER TABLE ivekit_tenant_events
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT NOT NULL DEFAULT '';

ALTER TABLE ivekit_tenant_events
  DROP CONSTRAINT IF EXISTS ivekit_tenant_events_idempotency_key_length;

ALTER TABLE ivekit_tenant_events
  ADD CONSTRAINT ivekit_tenant_events_idempotency_key_length
  CHECK (char_length(idempotency_key) <= 255);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ivekit_tenant_events_idempotency
  ON ivekit_tenant_events(tenant_id, idempotency_key)
  WHERE idempotency_key <> '';
