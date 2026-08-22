-- Additive, default-inert fencing for the future Rust Audit writer. Existing
-- TypeScript rows retain NULL route provenance and remain readable. No target
-- runtime receives EXECUTE in this migration.

SET LOCAL lock_timeout = '5s';

ALTER TABLE ivekit_audit_events
  ADD COLUMN route_authority_kind TEXT,
  ADD COLUMN route_partition_key TEXT,
  ADD COLUMN route_generation NUMERIC(20, 0),
  ADD COLUMN route_owner_epoch NUMERIC(20, 0),
  ADD COLUMN route_object_scope TEXT,
  ADD COLUMN route_object_starting_generation NUMERIC(20, 0),
  ADD COLUMN append_position NUMERIC(20, 0),
  ADD CONSTRAINT ivekit_audit_route_shape CHECK (
    (
      route_authority_kind IS NULL AND
      route_partition_key IS NULL AND
      route_generation IS NULL AND
      route_owner_epoch IS NULL AND
      route_object_scope IS NULL AND
      route_object_starting_generation IS NULL AND
      append_position IS NULL
    ) OR (
      route_authority_kind = 'audit' AND
      route_partition_key = 'tenant-chain' AND
      route_generation BETWEEN 1 AND 18446744073709551615 AND
      route_owner_epoch BETWEEN 0 AND 18446744073709551615 AND
      route_object_scope = 'new' AND
      route_object_starting_generation IS NULL AND
      append_position BETWEEN 1 AND 18446744073709551615
    )
  ) NOT VALID,
  ADD CONSTRAINT ivekit_audit_route_generation_fkey
    FOREIGN KEY (
      tenant_id, route_authority_kind, route_partition_key,
      route_generation, route_owner_epoch
    ) REFERENCES converact_authority_generations (
      tenant_id, authority_kind, partition_key, generation, owner_epoch
    ) ON DELETE RESTRICT NOT VALID;

-- Durable chain order is database owned. Business occurred_at remains query
-- metadata and can arrive out of order without changing append order.
CREATE TABLE converact_audit_chain_heads (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  head_event_id TEXT CHECK (
    head_event_id IS NULL OR
    octet_length(head_event_id) BETWEEN 1 AND 255
  ),
  head_event_hash TEXT NOT NULL CHECK (
    head_event_hash ~ '^[0-9a-f]{64}$'
  ),
  next_position NUMERIC(20, 0) NOT NULL CHECK (
    next_position BETWEEN 1 AND 18446744073709551616
  ),
  qualified_legacy_count NUMERIC(20, 0) NOT NULL CHECK (
    qualified_legacy_count BETWEEN 0 AND 18446744073709551615
  ),
  qualified_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CHECK (
    next_position > qualified_legacy_count AND
    (
      (head_event_id IS NULL AND
       head_event_hash = repeat('0', 64) AND
       next_position = 1 AND
       qualified_legacy_count = 0) OR
      head_event_id IS NOT NULL
    )
  )
);

ALTER TABLE converact_audit_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_audit_chain_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON converact_audit_chain_heads FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL PRIVILEGES ON TABLE converact_audit_chain_heads FROM PUBLIC;

-- Narrow definer helper: the legacy role learns only whether it remains the
-- accepting, unexpired writer. It receives no generation-table read access.
CREATE FUNCTION converact_audit_legacy_writer_allowed(p_tenant_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  implementation_value TEXT;
  generation_state_value TEXT;
  lease_expires_at_value TIMESTAMPTZ;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.current_tenant', true), '')
  THEN
    RAISE EXCEPTION 'audit tenant fence rejected'
      USING ERRCODE = '42501';
  END IF;
  IF octet_length(p_tenant_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'legacy audit writer tenant is invalid'
      USING ERRCODE = '55000';
  END IF;

  -- This barrier is also acquired by target append and every Rust route
  -- transition. The following row locks then close the old-writer/commit race.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id, 947113));
  -- Once the target chain has been qualified, an old NULL-provenance writer
  -- can never resume. Reverse handoff requires a separately qualified writer
  -- that advances this same head; otherwise a later Rust return would fork.
  IF EXISTS (
    SELECT 1 FROM public.converact_audit_chain_heads AS head
    WHERE head.tenant_id = p_tenant_id
  ) THEN
    RETURN FALSE;
  END IF;
  SELECT generation.implementation, generation.generation_state,
         generation.lease_expires_at
  INTO implementation_value, generation_state_value, lease_expires_at_value
  FROM public.converact_authority_routes AS route
  INNER JOIN public.converact_authority_generations AS generation
    ON generation.tenant_id = route.tenant_id
   AND generation.authority_kind = route.authority_kind
   AND generation.partition_key = route.partition_key
   AND generation.generation = route.current_generation
  WHERE route.tenant_id = p_tenant_id
    AND route.authority_kind = 'audit'
    AND route.partition_key = 'tenant-chain'
  FOR SHARE OF route, generation;

  IF NOT FOUND THEN
    RETURN TRUE;
  END IF;
  RETURN implementation_value = 'typescript' AND
    generation_state_value = 'accepting_new_work' AND
    lease_expires_at_value > transaction_timestamp();
END
$$;

-- A rolling TypeScript writer may append only while the tenant's fixed audit
-- chain route is absent or its current accepting generation is TypeScript.
-- The invoker-rights trigger sees SET ROLE; membership checks also cover a
-- login that inherits or can SET ROLE to opc_runtime.
CREATE FUNCTION converact_audit_legacy_writer_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.route_authority_kind IS NULL AND
     NEW.route_partition_key IS NULL AND
     NEW.route_generation IS NULL AND
     NEW.route_owner_epoch IS NULL AND
     NEW.route_object_scope IS NULL AND
     NEW.route_object_starting_generation IS NULL AND
     NEW.append_position IS NULL
  THEN
    IF NOT public.converact_audit_legacy_writer_allowed(NEW.tenant_id) THEN
      RAISE EXCEPTION 'legacy audit writer is fenced'
        USING ERRCODE = '55000';
    END IF;
  ELSIF to_regrole('opc_runtime') IS NOT NULL AND
        current_user <> pg_get_userbyid(
          (SELECT relation.relowner FROM pg_class AS relation
           WHERE relation.oid = 'public.ivekit_audit_events'::regclass)
        ) AND (
          pg_has_role(current_user, to_regrole('opc_runtime'), 'USAGE') OR
          pg_has_role(session_user, to_regrole('opc_runtime'), 'USAGE')
        )
  THEN
      RAISE EXCEPTION 'legacy audit writer cannot set target provenance'
        USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ivekit_audit_legacy_writer
BEFORE INSERT ON ivekit_audit_events
FOR EACH ROW EXECUTE FUNCTION converact_audit_legacy_writer_guard();

-- Domain-specific wrapper: a future Audit runtime never receives the generic
-- AuthorityRoute mutation or writer-fence capability directly.
CREATE FUNCTION converact_audit_writer_fence(
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.current_tenant', true), '')
  THEN
    RAISE EXCEPTION 'audit tenant fence rejected'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id, 947113));
  RETURN public.converact_authority_writer_fence(
    p_tenant_id, p_authority_kind, p_partition_key,
    p_route_generation, p_route_owner_epoch, p_route_lease_token,
    p_object_scope, p_object_starting_generation
  );
END
$$;

-- Locks and returns the database-owned chain head. A brand-new tenant can
-- initialize the zero head. Any existing unqualified history fails closed;
-- a later offline gate must prove that chain and seed its exact anchor.
CREATE FUNCTION converact_audit_chain_head(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_route_generation NUMERIC(20, 0),
  p_route_owner_epoch NUMERIC(20, 0),
  p_route_lease_token TEXT,
  p_object_scope TEXT,
  p_object_starting_generation NUMERIC(20, 0)
)
RETURNS TABLE(previous_hash TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_head_hash TEXT;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.current_tenant', true), '')
  THEN
    RAISE EXCEPTION 'audit tenant fence rejected'
      USING ERRCODE = '42501';
  END IF;
  IF p_authority_kind <> 'audit' OR
     p_partition_key <> 'tenant-chain' OR
     p_object_scope <> 'new' OR
     p_object_starting_generation IS NOT NULL
  THEN
    RAISE EXCEPTION 'audit chain head input is invalid'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id, 947113));
  PERFORM public.converact_authority_writer_fence(
    p_tenant_id, p_authority_kind, p_partition_key,
    p_route_generation, p_route_owner_epoch, p_route_lease_token,
    p_object_scope, p_object_starting_generation
  );
  SELECT head.head_event_hash
  INTO current_head_hash
  FROM public.converact_audit_chain_heads AS head
  WHERE head.tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.ivekit_audit_events AS event
      WHERE event.tenant_id = p_tenant_id
      LIMIT 1
    ) THEN
      RAISE EXCEPTION 'audit chain requires qualification'
        USING ERRCODE = '55000';
    END IF;
    current_head_hash := repeat('0', 64);
    INSERT INTO public.converact_audit_chain_heads (
      tenant_id, head_event_id, head_event_hash,
      next_position, qualified_legacy_count
    ) VALUES (
      p_tenant_id, NULL, current_head_hash, 1, 0
    );
  END IF;

  RETURN QUERY SELECT current_head_hash;
END
$$;

CREATE FUNCTION converact_audit_event_append(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_route_generation NUMERIC(20, 0),
  p_route_owner_epoch NUMERIC(20, 0),
  p_route_lease_token TEXT,
  p_object_scope TEXT,
  p_object_starting_generation NUMERIC(20, 0),
  p_id TEXT,
  p_actor_id TEXT,
  p_actor_role TEXT,
  p_action TEXT,
  p_resource_type TEXT,
  p_resource_id TEXT,
  p_business_ref_type TEXT,
  p_business_ref_id TEXT,
  p_request_id TEXT,
  p_idempotency_key TEXT,
  p_result TEXT,
  p_policy_decision TEXT,
  p_source_ip_hmac TEXT,
  p_metadata JSONB,
  p_occurred_at TIMESTAMPTZ,
  p_retention_until TIMESTAMPTZ,
  p_legal_hold BOOLEAN,
  p_previous_hash TEXT,
  p_event_hash TEXT
)
RETURNS TABLE(inserted_event_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_head_hash TEXT;
  current_position NUMERIC(20, 0);
  inserted_id TEXT;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.current_tenant', true), '')
  THEN
    RAISE EXCEPTION 'audit tenant fence rejected'
      USING ERRCODE = '42501';
  END IF;
  IF p_authority_kind <> 'audit' OR
     p_partition_key <> 'tenant-chain' OR
     p_object_scope <> 'new' OR
     p_object_starting_generation IS NOT NULL OR
     p_metadata IS NULL OR
     jsonb_typeof(p_metadata) <> 'object'
  THEN
    RAISE EXCEPTION 'audit append input is invalid'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id, 947113));
  PERFORM public.converact_authority_writer_fence(
    p_tenant_id, p_authority_kind, p_partition_key,
    p_route_generation, p_route_owner_epoch, p_route_lease_token,
    p_object_scope, p_object_starting_generation
  );

  SELECT head.head_event_hash, head.next_position
  INTO current_head_hash, current_position
  FROM public.converact_audit_chain_heads AS head
  WHERE head.tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit chain requires qualification'
      USING ERRCODE = '55000';
  END IF;
  IF current_position > 18446744073709551615 THEN
    RAISE EXCEPTION 'audit append position is exhausted'
      USING ERRCODE = '55000';
  END IF;
  IF current_head_hash IS DISTINCT FROM p_previous_hash THEN
    RAISE EXCEPTION 'audit chain tail is stale'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.ivekit_audit_events (
    id, tenant_id, actor_id, actor_role, action, resource_type, resource_id,
    business_ref_type, business_ref_id, request_id, idempotency_key, result,
    policy_decision, source_ip_hmac, metadata, occurred_at, retention_until,
    legal_hold, previous_hash, event_hash,
    route_authority_kind, route_partition_key, route_generation,
    route_owner_epoch, route_object_scope, route_object_starting_generation,
    append_position
  ) VALUES (
    p_id, p_tenant_id, p_actor_id, p_actor_role, p_action, p_resource_type,
    p_resource_id, p_business_ref_type, p_business_ref_id, p_request_id,
    p_idempotency_key, p_result, p_policy_decision, p_source_ip_hmac,
    p_metadata, p_occurred_at, p_retention_until, p_legal_hold,
    p_previous_hash, p_event_hash,
    p_authority_kind, p_partition_key, p_route_generation,
    p_route_owner_epoch, p_object_scope, p_object_starting_generation,
    current_position
  )
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING id INTO inserted_id;

  IF inserted_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.converact_audit_chain_heads
  SET head_event_id = p_id,
      head_event_hash = p_event_hash,
      next_position = current_position + 1,
      updated_at = transaction_timestamp()
  WHERE tenant_id = p_tenant_id
    AND head_event_hash = current_head_hash
    AND next_position = current_position;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit chain tail is stale'
      USING ERRCODE = '40001';
  END IF;

  inserted_event_id := inserted_id;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION converact_audit_legacy_writer_allowed(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_audit_legacy_writer_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_audit_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_audit_chain_head(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_audit_event_append(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TEXT
) FROM PUBLIC;

DO $legacy_capability_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    REVOKE ALL PRIVILEGES ON TABLE converact_audit_chain_heads
      FROM opc_runtime;
    GRANT EXECUTE ON FUNCTION converact_audit_legacy_writer_allowed(TEXT)
      TO opc_runtime;
    REVOKE EXECUTE ON FUNCTION converact_audit_legacy_writer_guard()
      FROM opc_runtime;
    REVOKE EXECUTE ON FUNCTION converact_audit_writer_fence(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
    ) FROM opc_runtime;
    REVOKE EXECUTE ON FUNCTION converact_audit_chain_head(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
    ) FROM opc_runtime;
    REVOKE EXECUTE ON FUNCTION converact_audit_event_append(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
      TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
      TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TEXT
    ) FROM opc_runtime;
  END IF;
END
$legacy_capability_guard$;

-- Fail closed if a hostile same-signature object/default ACL or a replayed
-- broad legacy grant changed the exact default-inert capability graph.
DO $audit_privilege_graph$
DECLARE
  admin_oid OID;
  runtime_oid OID;
  helper_oid OID;
  procedure_oid OID;
  expected_definer BOOLEAN;
  head_oid OID;
BEGIN
  SELECT oid INTO admin_oid FROM pg_roles WHERE rolname = 'opc_admin';
  SELECT oid INTO runtime_oid FROM pg_roles WHERE rolname = 'opc_runtime';
  helper_oid := to_regprocedure(
    'public.converact_audit_legacy_writer_allowed(text)'
  )::OID;
  head_oid := 'public.converact_audit_chain_heads'::regclass::OID;
  IF admin_oid IS NULL OR current_user <> 'opc_admin' OR
     runtime_oid IS NULL OR helper_oid IS NULL
  THEN
    RAISE EXCEPTION 'audit privilege principals are invalid'
      USING ERRCODE = '55000';
  END IF;

  FOR procedure_oid, expected_definer IN
    SELECT * FROM (VALUES
      (helper_oid, TRUE),
      (to_regprocedure('public.converact_audit_legacy_writer_guard()')::OID, FALSE),
      (to_regprocedure(
        'public.converact_audit_writer_fence(text,text,text,numeric,numeric,text,text,numeric)'
      )::OID, TRUE),
      (to_regprocedure(
        'public.converact_audit_chain_head(text,text,text,numeric,numeric,text,text,numeric)'
      )::OID, TRUE),
      (to_regprocedure(
        'public.converact_audit_event_append(text,text,text,numeric,numeric,text,text,numeric,text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb,timestamp with time zone,timestamp with time zone,boolean,text,text)'
      )::OID, TRUE)
    ) AS expected(oid, security_definer)
  LOOP
    IF procedure_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_proc AS procedure
      WHERE procedure.oid = procedure_oid
        AND procedure.proowner = admin_oid
        AND procedure.prosecdef = expected_definer
        AND procedure.proconfig = ARRAY[
          'search_path=pg_catalog, public, pg_temp'
        ]::TEXT[]
    ) OR EXISTS (
      SELECT 1
      FROM pg_proc AS procedure,
        LATERAL aclexplode(
          coalesce(procedure.proacl, acldefault('f', procedure.proowner))
        ) AS privilege
      WHERE procedure.oid = procedure_oid
        AND NOT (
          privilege.grantee = admin_oid AND
          privilege.privilege_type = 'EXECUTE'
        )
        AND NOT (
          procedure_oid = helper_oid AND
          privilege.grantee = runtime_oid AND
          privilege.privilege_type = 'EXECUTE' AND
          NOT privilege.is_grantable
        )
    ) THEN
      RAISE EXCEPTION 'audit function privilege graph is invalid'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class AS relation
    WHERE relation.oid = head_oid
      AND relation.relowner = admin_oid
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_class AS relation,
      LATERAL aclexplode(
        coalesce(relation.relacl, acldefault('r', relation.relowner))
      ) AS privilege
    WHERE relation.oid = head_oid
      AND privilege.grantee <> admin_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_attribute AS attribute
    WHERE attribute.attrelid = head_oid
      AND cardinality(attribute.attacl) > 0
  ) THEN
    RAISE EXCEPTION 'audit head privilege graph is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$audit_privilege_graph$;

COMMENT ON TABLE converact_audit_chain_heads IS
  'Per-tenant database-owned Audit chain head and monotonic append position; independent of event retention.';
COMMENT ON FUNCTION converact_audit_legacy_writer_allowed(TEXT) IS
  'Only rolling legacy capability: serializes with route transitions and accepts an unexpired TypeScript generation.';
COMMENT ON FUNCTION converact_audit_chain_head(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) IS 'Default-inert exact-head oracle; existing unqualified legacy history fails closed.';

COMMENT ON FUNCTION converact_audit_event_append(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TEXT
) IS 'Default-inert Audit append kernel: fixed tenant chain, monotonic database position and atomic head advancement.';
