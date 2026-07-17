ALTER TABLE ivekit_cell_leases
  ADD COLUMN IF NOT EXISTS topology_sha256 TEXT;

UPDATE ivekit_cell_leases
SET topology_sha256 = repeat('0', 64)
WHERE topology_sha256 IS NULL;

ALTER TABLE ivekit_cell_leases
  ALTER COLUMN topology_sha256 SET DEFAULT repeat('0', 64),
  ALTER COLUMN topology_sha256 SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ivekit_cell_leases_topology_sha256_check'
      AND conrelid = 'ivekit_cell_leases'::regclass
  ) THEN
    ALTER TABLE ivekit_cell_leases
      ADD CONSTRAINT ivekit_cell_leases_topology_sha256_check
      CHECK (topology_sha256 ~ '^[0-9a-f]{64}$');
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_ivekit_cell_leases_topology
  ON ivekit_cell_leases(topology_sha256, state, lease_expires_at);
