CREATE TABLE IF NOT EXISTS ivekit_cell_admission_reservations (
  region_id TEXT NOT NULL CHECK (char_length(region_id) BETWEEN 1 AND 255),
  zone_id TEXT NOT NULL CHECK (char_length(zone_id) BETWEEN 1 AND 255),
  cell_id TEXT NOT NULL CHECK (char_length(cell_id) BETWEEN 1 AND 255),
  reservation_id TEXT NOT NULL CHECK (char_length(reservation_id) BETWEEN 1 AND 255),
  tenant_id TEXT NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 255),
  routing_partition_id TEXT NOT NULL
    CHECK (char_length(routing_partition_id) BETWEEN 1 AND 255),
  interaction_id TEXT NOT NULL CHECK (char_length(interaction_id) BETWEEN 1 AND 255),
  interaction_kind TEXT NOT NULL
    CHECK (interaction_kind IN (
      'tinode_im', 'sip_voice', 'livekit_av', 'livekit_screen', 'rustdesk_remote'
    )),
  profile_id TEXT NOT NULL CHECK (char_length(profile_id) BETWEEN 1 AND 72),
  owner_node_id TEXT NOT NULL CHECK (char_length(owner_node_id) BETWEEN 1 AND 255),
  owner_epoch NUMERIC(20,0) NOT NULL
    CHECK (owner_epoch >= 0 AND owner_epoch <= 18446744073709551615),
  cell_lease_epoch BIGINT NOT NULL
    CHECK (cell_lease_epoch >= 1 AND cell_lease_epoch <= 4294967295),
  endpoint TEXT NOT NULL CHECK (char_length(endpoint) BETWEEN 1 AND 2048),
  required_capacity JSONB NOT NULL
    CHECK (jsonb_typeof(required_capacity) = 'object'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL
    CHECK (state IN ('reserved', 'active', 'expired', 'closed')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (region_id, zone_id, cell_id, reservation_id),
  UNIQUE (region_id, zone_id, cell_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_cell_admission_reservations_due
  ON ivekit_cell_admission_reservations(
    region_id, zone_id, cell_id, state, expires_at, updated_at
  );

CREATE INDEX IF NOT EXISTS idx_ivekit_cell_admission_reservations_owner
  ON ivekit_cell_admission_reservations(
    region_id, zone_id, cell_id, owner_node_id, owner_epoch, state
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ivekit_cell_admission_reservations TO opc_runtime;
  END IF;
END
$$;
