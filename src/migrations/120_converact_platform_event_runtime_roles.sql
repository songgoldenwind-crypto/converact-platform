-- Freeze the Platform Event database privilege graph before the Rust runtime
-- login can be activated. Role bootstrap creates both principals as NOLOGIN;
-- the separate activation command validates this migration-owned graph before
-- assigning a password and LOGIN capability.

SET LOCAL lock_timeout = '5s';

DO $role_guard$
DECLARE
  event_role pg_roles%ROWTYPE;
  owner_role pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO event_role FROM pg_roles
  WHERE rolname = 'converact_event_runtime';
  SELECT * INTO owner_role FROM pg_roles
  WHERE rolname = 'converact_event_store_owner';

  IF event_role.rolname IS NULL OR event_role.rolcanlogin OR
     event_role.rolsuper OR event_role.rolcreatedb OR
     event_role.rolcreaterole OR event_role.rolreplication OR
     event_role.rolinherit OR event_role.rolbypassrls
  THEN
    RAISE EXCEPTION 'converact event runtime bootstrap role is invalid';
  END IF;
  IF owner_role.rolname IS NULL OR owner_role.rolcanlogin IS DISTINCT FROM FALSE OR
     owner_role.rolsuper OR owner_role.rolcreatedb OR
     owner_role.rolcreaterole OR owner_role.rolreplication OR
     owner_role.rolinherit OR owner_role.rolbypassrls
  THEN
    RAISE EXCEPTION 'converact event store owner role is invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE member IN (
      SELECT oid FROM pg_roles
      WHERE rolname IN ('converact_event_runtime', 'converact_event_store_owner')
    ) OR roleid IN (
      SELECT oid FROM pg_roles
      WHERE rolname IN ('converact_event_runtime', 'converact_event_store_owner')
    )
  ) THEN
    RAISE EXCEPTION 'converact event roles must have no memberships in either direction';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relowner = owner_role.oid
  ) OR EXISTS (
    SELECT 1 FROM pg_proc WHERE proowner = owner_role.oid
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspowner = owner_role.oid
  ) OR EXISTS (
    SELECT 1 FROM pg_type WHERE typowner = owner_role.oid
  ) THEN
    RAISE EXCEPTION 'converact event store owner must not own pre-existing objects';
  END IF;
END
$role_guard$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM converact_event_store_owner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM converact_event_store_owner;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
  FROM converact_event_store_owner;
REVOKE ALL PRIVILEGES ON SCHEMA public
  FROM converact_event_store_owner;

CREATE OR REPLACE FUNCTION converact_platform_writer_fence(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_route_generation NUMERIC(20, 0),
  p_route_owner_epoch NUMERIC(20, 0),
  p_route_lease_token TEXT,
  p_object_scope TEXT,
  p_object_starting_generation NUMERIC(20, 0)
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.converact_authority_writer_fence(
    p_tenant_id, p_authority_kind, p_partition_key,
    p_route_generation, p_route_owner_epoch, p_route_lease_token,
    p_object_scope, p_object_starting_generation
  )
$$;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. A target
-- login could otherwise inherit an unrelated SECURITY DEFINER capability even
-- though its own ACL contains no grant row. Close that ambient escalation
-- surface before the exact wrapper grants are installed.
DO $revoke_public_security_definers$
DECLARE
  procedure RECORD;
BEGIN
  FOR procedure IN
    SELECT candidate.oid::REGPROCEDURE AS identity
    FROM pg_proc AS candidate
    JOIN pg_namespace AS namespace ON namespace.oid = candidate.pronamespace
    WHERE namespace.nspname = 'public'
      AND candidate.prosecdef
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC',
      procedure.identity
    );
  END LOOP;
END
$revoke_public_security_definers$;

-- Keep later opc_admin migrations from silently restoring ambient EXECUTE on
-- newly created functions after the event login has already been activated.
ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO converact_event_store_owner;
GRANT CREATE ON SCHEMA public TO converact_event_store_owner;

GRANT SELECT, INSERT, UPDATE ON converact_platform_outbox
  TO converact_event_store_owner;
GRANT SELECT, INSERT ON converact_platform_inbox,
  converact_platform_effect_receipts,
  converact_platform_outbox_transitions,
  converact_platform_outbox_claim_operations,
  converact_platform_outbox_claim_receipts
  TO converact_event_store_owner;

GRANT EXECUTE ON FUNCTION converact_authority_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) TO converact_event_store_owner;
GRANT EXECUTE ON FUNCTION converact_authority_claim_generation_work(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT
) TO converact_event_store_owner;
GRANT EXECUTE ON FUNCTION converact_authority_release_generation_work(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TEXT
) TO converact_event_store_owner;

ALTER FUNCTION converact_platform_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) OWNER TO converact_event_store_owner;
ALTER FUNCTION converact_platform_inbox_append(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
) OWNER TO converact_event_store_owner;
ALTER FUNCTION converact_platform_effect_append(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
) OWNER TO converact_event_store_owner;
ALTER FUNCTION converact_platform_outbox_enqueue(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT, BIGINT,
  TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT, JSONB, INTEGER,
  TIMESTAMPTZ, TIMESTAMPTZ
) OWNER TO converact_event_store_owner;
ALTER FUNCTION converact_platform_outbox_claim(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, BIGINT, INTEGER
) OWNER TO converact_event_store_owner;
ALTER FUNCTION converact_platform_outbox_transition_apply(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, BIGINT, TEXT, TEXT
) OWNER TO converact_event_store_owner;

REVOKE CREATE ON SCHEMA public FROM converact_event_store_owner;

REVOKE ALL ON FUNCTION converact_platform_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_platform_inbox_append(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_platform_effect_append(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_platform_outbox_enqueue(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT, BIGINT,
  TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT, JSONB, INTEGER,
  TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_platform_outbox_claim(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, BIGINT, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_platform_outbox_transition_apply(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, BIGINT, TEXT, TEXT
) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION converact_authority_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) FROM converact_event_runtime;
REVOKE EXECUTE ON FUNCTION converact_authority_claim_generation_work(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT
) FROM converact_event_runtime;
REVOKE EXECUTE ON FUNCTION converact_authority_release_generation_work(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TEXT
) FROM converact_event_runtime;

-- Re-running the legacy bootstrap grants broad table privileges before the
-- rolling migration window. Narrow the legacy principal here so a fresh
-- install reaches the same one-writer graph without requiring a second
-- bootstrap pass. The claim/transition truth tables are target-owned only.
DO $legacy_rolling_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    REVOKE ALL ON converact_platform_outbox, converact_platform_inbox,
      converact_platform_effect_receipts,
      converact_platform_outbox_transitions,
      converact_platform_outbox_claim_operations,
      converact_platform_outbox_claim_receipts
      FROM opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON converact_platform_outbox TO opc_runtime;
    GRANT SELECT, INSERT ON converact_platform_inbox,
      converact_platform_effect_receipts TO opc_runtime;
  END IF;
END
$legacy_rolling_grants$;

REVOKE ALL ON converact_platform_outbox, converact_platform_inbox,
  converact_platform_effect_receipts,
  converact_platform_outbox_transitions,
  converact_platform_outbox_claim_operations,
  converact_platform_outbox_claim_receipts
  FROM converact_event_runtime;
GRANT SELECT ON converact_platform_outbox, converact_platform_inbox,
  converact_platform_effect_receipts,
  converact_platform_outbox_transitions,
  converact_platform_outbox_claim_operations,
  converact_platform_outbox_claim_receipts
  TO converact_event_runtime;
GRANT USAGE ON SCHEMA public TO converact_event_runtime;
REVOKE CREATE ON SCHEMA public FROM converact_event_runtime;

GRANT EXECUTE ON FUNCTION converact_platform_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) TO converact_event_runtime;
GRANT EXECUTE ON FUNCTION converact_platform_inbox_append(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
) TO converact_event_runtime;
GRANT EXECUTE ON FUNCTION converact_platform_effect_append(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
) TO converact_event_runtime;
GRANT EXECUTE ON FUNCTION converact_platform_outbox_enqueue(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT, BIGINT,
  TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT, JSONB, INTEGER,
  TIMESTAMPTZ, TIMESTAMPTZ
) TO converact_event_runtime;
GRANT EXECUTE ON FUNCTION converact_platform_outbox_claim(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, BIGINT, INTEGER
) TO converact_event_runtime;
GRANT EXECUTE ON FUNCTION converact_platform_outbox_transition_apply(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, BIGINT, TEXT, TEXT
) TO converact_event_runtime;

COMMENT ON FUNCTION converact_platform_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) IS 'Platform Event read/replay fence; target runtime receives no underlying Authority mutation capability.';
