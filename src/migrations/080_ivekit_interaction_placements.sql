CREATE TABLE IF NOT EXISTS ivekit_interaction_placements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL,
  interaction_kind TEXT NOT NULL
    CHECK (interaction_kind IN (
      'tinode_im', 'sip_voice', 'livekit_av', 'livekit_screen', 'rustdesk_remote'
    )),
  routing_partition_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  owner_component TEXT NOT NULL
    CHECK (owner_component IN ('rustpbx', 'livekit', 'tinode', 'rustdesk')),
  region_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  owner_node_id TEXT NOT NULL,
  owner_epoch NUMERIC(20,0) NOT NULL
    CHECK (owner_epoch >= 0 AND owner_epoch <= 18446744073709551615),
  cell_lease_epoch BIGINT NOT NULL
    CHECK (cell_lease_epoch >= 1 AND cell_lease_epoch <= 4294967295),
  reservation_id TEXT NOT NULL,
  reservation_expires_at TIMESTAMPTZ NOT NULL,
  admission_endpoint TEXT NOT NULL,
  provider_endpoint TEXT NOT NULL,
  snapshot_version BIGINT NOT NULL CHECK (snapshot_version >= 1),
  required_capacity JSONB NOT NULL
    CHECK (jsonb_typeof(required_capacity) = 'object'),
  placement_token_sha256 TEXT NOT NULL
    CHECK (placement_token_sha256 ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL
    CHECK (state IN ('reserved', 'active', 'draining', 'recovering', 'closed', 'expired')),
  desired_state TEXT NOT NULL
    CHECK (desired_state IN ('reserved', 'active', 'closed')),
  sync_state TEXT NOT NULL
    CHECK (sync_state IN ('succeeded', 'pending', 'processing', 'retry_wait', 'failed')),
  lifecycle_reason TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 20 CHECK (max_attempts BETWEEN 1 AND 100),
  next_attempt_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  worker_id TEXT NOT NULL DEFAULT '',
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, interaction_kind, interaction_id),
  UNIQUE (tenant_id, reservation_id),
  CHECK (state <> 'closed' OR desired_state = 'closed')
);

CREATE INDEX IF NOT EXISTS idx_ivekit_interaction_placements_owner
  ON ivekit_interaction_placements(
    tenant_id, cell_id, owner_node_id, owner_epoch, state
  );

CREATE INDEX IF NOT EXISTS idx_ivekit_interaction_placements_due
  ON ivekit_interaction_placements(
    tenant_id, sync_state, next_attempt_at, lease_until, updated_at, id
  )
  WHERE sync_state IN ('pending', 'processing', 'retry_wait');

ALTER TABLE ivekit_interaction_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_interaction_placements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_interaction_placements;
CREATE POLICY tenant_isolation ON ivekit_interaction_placements FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE OR REPLACE FUNCTION opc_ivekit_claim_interaction_placements(
  p_tenant_id TEXT,
  p_interaction_kind TEXT,
  p_interaction_id TEXT,
  p_worker_id TEXT,
  p_now TIMESTAMPTZ,
  p_lease_until TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS SETOF public.ivekit_interaction_placements
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
    WITH candidate AS (
      SELECT placement.id
      FROM public.ivekit_interaction_placements placement
      WHERE placement.tenant_id = p_tenant_id
        AND (p_interaction_kind = '' OR placement.interaction_kind = p_interaction_kind)
        AND (p_interaction_id = '' OR placement.interaction_id = p_interaction_id)
        AND placement.desired_state IN ('active', 'closed')
        AND (
          placement.sync_state = 'pending'
          OR (
            placement.sync_state = 'retry_wait'
            AND (
              placement.next_attempt_at IS NULL
              OR placement.next_attempt_at <= p_now
            )
          )
          OR (
            placement.sync_state = 'processing'
            AND placement.lease_until <= p_now
          )
        )
        AND placement.attempt_count < placement.max_attempts
      ORDER BY COALESCE(placement.next_attempt_at, placement.updated_at), placement.id
      FOR UPDATE SKIP LOCKED
      LIMIT least(greatest(p_limit, 1), 100)
    )
    UPDATE public.ivekit_interaction_placements placement
    SET sync_state = 'processing',
        worker_id = p_worker_id,
        lease_until = p_lease_until,
        attempt_count = placement.attempt_count + 1,
        revision = placement.revision + 1,
        updated_at = p_now
    FROM candidate
    WHERE placement.tenant_id = p_tenant_id
      AND placement.id = candidate.id
    RETURNING placement.*;
END;
$$;

CREATE OR REPLACE FUNCTION opc_ivekit_placement_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT placement.tenant_id
  FROM public.ivekit_interaction_placements placement
  WHERE placement.desired_state IN ('active', 'closed')
    AND (
      placement.sync_state = 'pending'
      OR (
        placement.sync_state = 'retry_wait'
        AND (
          placement.next_attempt_at IS NULL
          OR placement.next_attempt_at <= p_now
        )
      )
      OR (
        placement.sync_state = 'processing'
        AND placement.lease_until <= p_now
      )
    )
    AND placement.attempt_count < placement.max_attempts
  GROUP BY placement.tenant_id
  ORDER BY min(COALESCE(placement.next_attempt_at, placement.updated_at))
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

REVOKE ALL ON FUNCTION opc_ivekit_claim_interaction_placements(
  TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_ivekit_placement_tenant_ids(
  TIMESTAMPTZ, INTEGER
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ivekit_interaction_placements TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_ivekit_claim_interaction_placements(
      TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER
    ) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_ivekit_placement_tenant_ids(
      TIMESTAMPTZ, INTEGER
    ) TO opc_runtime;
  END IF;
END
$$;
