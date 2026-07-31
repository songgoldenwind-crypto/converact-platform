CREATE TABLE IF NOT EXISTS ivekit_cell_leases (
  region_id TEXT NOT NULL CHECK (char_length(region_id) BETWEEN 1 AND 255),
  zone_id TEXT NOT NULL CHECK (char_length(zone_id) BETWEEN 1 AND 255),
  cell_id TEXT NOT NULL CHECK (char_length(cell_id) BETWEEN 1 AND 255),
  owner_instance_id TEXT NOT NULL CHECK (char_length(owner_instance_id) BETWEEN 1 AND 255),
  lease_epoch BIGINT NOT NULL CHECK (
    lease_epoch >= 1 AND lease_epoch <= 4294967295
  ),
  state TEXT NOT NULL CHECK (state IN ('active', 'released')),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (region_id, zone_id, cell_id)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_cell_leases_owner
  ON ivekit_cell_leases(owner_instance_id, state, lease_expires_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON ivekit_cell_leases TO opc_runtime;
  END IF;
END
$$;
