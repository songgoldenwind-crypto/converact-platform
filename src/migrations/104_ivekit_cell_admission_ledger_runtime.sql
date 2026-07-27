ALTER TABLE ivekit_cell_admission_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cell_admission_reservations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ivekit_cell_admission_reservations;
CREATE POLICY tenant_isolation ON ivekit_cell_admission_reservations
  FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE OR REPLACE FUNCTION opc_ivekit_cell_admission_recovery_rows(
  p_region_id TEXT,
  p_zone_id TEXT,
  p_cell_id TEXT,
  p_owner_instance_id TEXT,
  p_cell_lease_epoch BIGINT,
  p_now TIMESTAMPTZ,
  p_terminal_retention_ms BIGINT,
  p_limit INTEGER
)
RETURNS TABLE (
  reservation_id TEXT,
  state TEXT,
  region_id TEXT,
  zone_id TEXT,
  cell_id TEXT,
  owner_node_id TEXT,
  owner_epoch TEXT,
  endpoint TEXT,
  expires_at TIMESTAMPTZ,
  required_capacity JSONB,
  tenant_id TEXT,
  routing_partition_id TEXT,
  interaction_id TEXT,
  interaction_kind TEXT,
  profile_id TEXT,
  idempotency_key TEXT,
  payload_hash TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_region_id !~ '^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$'
     OR p_zone_id !~ '^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$'
     OR p_cell_id !~ '^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$'
     OR p_owner_instance_id !~ '^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$' THEN
    RAISE EXCEPTION 'invalid Cell admission recovery identity'
      USING ERRCODE = '22023';
  END IF;
  IF p_cell_lease_epoch NOT BETWEEN 1 AND 4294967295 THEN
    RAISE EXCEPTION 'invalid Cell admission recovery lease epoch'
      USING ERRCODE = '22023';
  END IF;
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'Cell admission recovery timestamp is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_terminal_retention_ms NOT BETWEEN 1000 AND 86400000 THEN
    RAISE EXCEPTION 'invalid Cell admission terminal retention'
      USING ERRCODE = '22023';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 250000 THEN
    RAISE EXCEPTION 'invalid Cell admission recovery limit'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.ivekit_cell_leases lease
    WHERE lease.region_id = p_region_id
      AND lease.zone_id = p_zone_id
      AND lease.cell_id = p_cell_id
      AND lease.owner_instance_id = p_owner_instance_id
      AND lease.lease_epoch = p_cell_lease_epoch
      AND lease.state = 'active'
      AND lease.lease_expires_at > p_now
  ) THEN
    RAISE EXCEPTION 'stale Cell admission lease'
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY
  SELECT
    reservation.reservation_id,
    reservation.state,
    reservation.region_id,
    reservation.zone_id,
    reservation.cell_id,
    reservation.owner_node_id,
    reservation.owner_epoch::text,
    reservation.endpoint,
    reservation.expires_at,
    reservation.required_capacity,
    reservation.tenant_id,
    reservation.routing_partition_id,
    reservation.interaction_id,
    reservation.interaction_kind,
    reservation.profile_id,
    reservation.idempotency_key,
    reservation.payload_hash,
    reservation.created_at,
    reservation.updated_at
  FROM public.ivekit_cell_admission_reservations reservation
  WHERE reservation.region_id = p_region_id
    AND reservation.zone_id = p_zone_id
    AND reservation.cell_id = p_cell_id
    AND (
      reservation.state IN ('reserved', 'active')
      OR reservation.updated_at >= p_now -
        (p_terminal_retention_ms * interval '1 millisecond')
    )
  ORDER BY reservation.created_at, reservation.reservation_id
  LIMIT p_limit;
END
$$;

CREATE OR REPLACE FUNCTION opc_ivekit_expire_cell_admission_reservations(
  p_region_id TEXT,
  p_zone_id TEXT,
  p_cell_id TEXT,
  p_owner_instance_id TEXT,
  p_cell_lease_epoch BIGINT,
  p_now TIMESTAMPTZ
)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_expired BIGINT;
BEGIN
  IF p_region_id !~ '^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$'
     OR p_zone_id !~ '^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$'
     OR p_cell_id !~ '^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$'
     OR p_owner_instance_id !~ '^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$' THEN
    RAISE EXCEPTION 'invalid Cell admission expiry identity'
      USING ERRCODE = '22023';
  END IF;
  IF p_cell_lease_epoch NOT BETWEEN 1 AND 4294967295 OR p_now IS NULL THEN
    RAISE EXCEPTION 'invalid Cell admission expiry fence'
      USING ERRCODE = '22023';
  END IF;

  WITH active_lease AS (
    SELECT 1
    FROM public.ivekit_cell_leases lease
    WHERE lease.region_id = p_region_id
      AND lease.zone_id = p_zone_id
      AND lease.cell_id = p_cell_id
      AND lease.owner_instance_id = p_owner_instance_id
      AND lease.lease_epoch = p_cell_lease_epoch
      AND lease.state = 'active'
      AND lease.lease_expires_at > p_now
  ),
  expired AS (
    UPDATE public.ivekit_cell_admission_reservations reservation
    SET state = 'expired', updated_at = p_now
    FROM active_lease
    WHERE reservation.region_id = p_region_id
      AND reservation.zone_id = p_zone_id
      AND reservation.cell_id = p_cell_id
      AND reservation.state = 'reserved'
      AND reservation.expires_at <= p_now
    RETURNING 1
  )
  SELECT count(*) INTO v_expired FROM expired;

  RETURN v_expired;
END
$$;

REVOKE ALL ON FUNCTION opc_ivekit_cell_admission_recovery_rows(
  TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMPTZ, BIGINT, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_ivekit_expire_cell_admission_reservations(
  TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMPTZ
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT EXECUTE ON FUNCTION opc_ivekit_cell_admission_recovery_rows(
      TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMPTZ, BIGINT, INTEGER
    ) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_ivekit_expire_cell_admission_reservations(
      TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMPTZ
    ) TO opc_runtime;
  END IF;
END
$$;
