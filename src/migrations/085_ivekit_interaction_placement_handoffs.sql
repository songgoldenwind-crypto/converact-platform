ALTER TABLE ivekit_interaction_placements
  ADD COLUMN IF NOT EXISTS placement_generation BIGINT NOT NULL DEFAULT 1
    CHECK (placement_generation >= 1);

CREATE TABLE IF NOT EXISTS ivekit_interaction_placement_handoffs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL,
  interaction_kind TEXT NOT NULL
    CHECK (interaction_kind IN (
      'tinode_im', 'sip_voice', 'livekit_av', 'livekit_screen', 'rustdesk_remote'
    )),
  placement_generation BIGINT NOT NULL CHECK (placement_generation >= 2),
  from_region_id TEXT NOT NULL,
  from_zone_id TEXT NOT NULL,
  from_cell_id TEXT NOT NULL,
  from_owner_node_id TEXT NOT NULL,
  from_owner_epoch NUMERIC(20,0) NOT NULL
    CHECK (from_owner_epoch >= 0 AND from_owner_epoch <= 18446744073709551615),
  from_reservation_id TEXT NOT NULL,
  from_admission_endpoint TEXT NOT NULL,
  from_provider_endpoint TEXT NOT NULL,
  from_required_capacity JSONB NOT NULL
    CHECK (jsonb_typeof(from_required_capacity) = 'object'),
  to_owner_node_id TEXT NOT NULL,
  to_owner_epoch NUMERIC(20,0) NOT NULL
    CHECK (to_owner_epoch >= 0 AND to_owner_epoch <= 18446744073709551615),
  to_reservation_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('prepared', 'source_close_pending', 'completed', 'failed')),
  sync_state TEXT NOT NULL
    CHECK (sync_state IN ('waiting', 'pending', 'processing', 'retry_wait', 'failed', 'succeeded')),
  reason TEXT NOT NULL DEFAULT '',
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
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, interaction_kind, interaction_id, placement_generation),
  UNIQUE (tenant_id, to_reservation_id),
  CHECK (
    (state = 'prepared' AND sync_state = 'waiting')
    OR (state = 'source_close_pending' AND sync_state IN (
      'pending', 'processing', 'retry_wait', 'failed'
    ))
    OR (state = 'completed' AND sync_state = 'succeeded')
    OR (state = 'failed' AND sync_state = 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_ivekit_interaction_placement_handoffs_due
  ON ivekit_interaction_placement_handoffs(
    tenant_id, sync_state, next_attempt_at, lease_until, updated_at, id
  )
  WHERE state = 'source_close_pending'
    AND sync_state IN ('pending', 'processing', 'retry_wait');

CREATE INDEX IF NOT EXISTS idx_ivekit_interaction_placement_handoffs_owner
  ON ivekit_interaction_placement_handoffs(
    tenant_id, interaction_kind, interaction_id, from_owner_epoch, to_owner_epoch
  );

ALTER TABLE ivekit_interaction_placement_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_interaction_placement_handoffs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_interaction_placement_handoffs;
CREATE POLICY tenant_isolation ON ivekit_interaction_placement_handoffs FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

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
  SELECT due.tenant_id
  FROM (
    SELECT placement.tenant_id, COALESCE(
      placement.next_attempt_at,
      placement.updated_at
    ) AS due_at
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
    UNION ALL
    SELECT handoff.tenant_id, COALESCE(
      handoff.next_attempt_at,
      handoff.updated_at
    ) AS due_at
    FROM public.ivekit_interaction_placement_handoffs handoff
    WHERE handoff.state = 'source_close_pending'
      AND (
        handoff.sync_state = 'pending'
        OR (
          handoff.sync_state = 'retry_wait'
          AND (
            handoff.next_attempt_at IS NULL
            OR handoff.next_attempt_at <= p_now
          )
        )
        OR (
          handoff.sync_state = 'processing'
          AND handoff.lease_until <= p_now
        )
      )
      AND handoff.attempt_count < handoff.max_attempts
  ) due
  GROUP BY due.tenant_id
  ORDER BY min(due.due_at)
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

REVOKE ALL ON FUNCTION opc_ivekit_placement_tenant_ids(
  TIMESTAMPTZ, INTEGER
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ivekit_interaction_placement_handoffs TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_ivekit_placement_tenant_ids(
      TIMESTAMPTZ, INTEGER
    ) TO opc_runtime;
  END IF;
END
$$;
