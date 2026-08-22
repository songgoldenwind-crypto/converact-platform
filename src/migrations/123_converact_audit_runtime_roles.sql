-- Isolate the default-disabled Rust Audit adapter behind one login and one
-- non-login function owner. This migration grants no LOGIN capability and
-- does not change the active Audit Authority route.

SET LOCAL lock_timeout = '5s';

DO $audit_role_guard$
DECLARE
  runtime_role pg_roles%ROWTYPE;
  owner_role pg_roles%ROWTYPE;
  wrapper_signature TEXT;
  wrapper_oid REGPROCEDURE;
  legacy_guard_oid REGPROCEDURE;
  immutable_guard_oid REGPROCEDURE;
  parameter_acl_exposed BOOLEAN := FALSE;
BEGIN
  IF current_user <> 'opc_admin' THEN
    RAISE EXCEPTION 'audit role migration must run as opc_admin'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO runtime_role FROM pg_roles
  WHERE rolname = 'converact_audit_runtime';
  SELECT * INTO owner_role FROM pg_roles
  WHERE rolname = 'converact_audit_store_owner';

  IF runtime_role.rolname IS NULL OR runtime_role.rolcanlogin OR
     runtime_role.rolsuper OR runtime_role.rolcreatedb OR
     runtime_role.rolcreaterole OR runtime_role.rolreplication OR
     runtime_role.rolinherit OR runtime_role.rolbypassrls OR
     coalesce(cardinality(runtime_role.rolconfig), 0) <> 0
  THEN
    RAISE EXCEPTION 'audit runtime bootstrap role is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF owner_role.rolname IS NULL OR owner_role.rolcanlogin OR
     owner_role.rolsuper OR owner_role.rolcreatedb OR
     owner_role.rolcreaterole OR owner_role.rolreplication OR
     owner_role.rolinherit OR owner_role.rolbypassrls OR
     coalesce(cardinality(owner_role.rolconfig), 0) <> 0
  THEN
    RAISE EXCEPTION 'audit store owner bootstrap role is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE member IN (runtime_role.oid, owner_role.oid)
       OR roleid IN (runtime_role.oid, owner_role.oid)
  ) THEN
    RAISE EXCEPTION 'audit roles must have no memberships in either direction'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_db_role_setting
    WHERE setrole IN (runtime_role.oid, owner_role.oid)
       OR (
         setrole = 0 AND setdatabase IN (
           0,
           (SELECT oid FROM pg_database WHERE datname = current_database())
         )
       )
  ) THEN
    RAISE EXCEPTION 'audit roles must have no persistent database settings'
      USING ERRCODE = '55000';
  END IF;
  IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' OR
     (
       SELECT setting.reset_val
       FROM pg_settings AS setting
       WHERE setting.name = 'session_replication_role'
     ) IS DISTINCT FROM 'origin'
  THEN
    RAISE EXCEPTION 'audit session replication role is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF current_setting('server_version_num')::INTEGER >= 150000 THEN
    EXECUTE $parameter_acl$
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_parameter_acl AS parameter,
          LATERAL pg_catalog.aclexplode(parameter.paracl) AS privilege
        WHERE privilege.grantee IN (0, $1, $2)
          AND privilege.privilege_type IN ('SET', 'ALTER SYSTEM')
      )
    $parameter_acl$
    INTO parameter_acl_exposed
    USING runtime_role.oid, owner_role.oid;
    IF parameter_acl_exposed THEN
      RAISE EXCEPTION 'audit roles have parameter authority outside the graph'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF to_regclass('public.ivekit_audit_events') IS NULL OR
     to_regclass('public.converact_audit_chain_heads') IS NULL OR
     EXISTS (
       SELECT 1 FROM pg_class AS relation
       JOIN pg_roles AS owner ON owner.oid = relation.relowner
       WHERE relation.oid IN (
         'public.ivekit_audit_events'::REGCLASS,
         'public.converact_audit_chain_heads'::REGCLASS
       ) AND owner.rolname <> 'opc_admin'
     )
  THEN
    RAISE EXCEPTION 'audit target relation owner is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_namespace AS namespace,
      pg_database AS database
    WHERE namespace.nspname = 'public'
      AND database.datname = current_database()
      AND database.datdba = to_regrole('opc_admin')::OID
      AND namespace.nspowner IN (
        to_regrole('opc_admin')::OID,
        to_regrole('pg_database_owner')::OID
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_namespace AS namespace,
      LATERAL aclexplode(
        coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
      ) AS privilege
    WHERE namespace.nspname = 'public'
      AND privilege.privilege_type = 'CREATE'
      AND privilege.grantee <> namespace.nspowner
  ) THEN
    RAISE EXCEPTION 'public schema create authority is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relowner IN (runtime_role.oid, owner_role.oid)
  ) OR EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proowner IN (runtime_role.oid, owner_role.oid)
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace
    WHERE nspowner IN (runtime_role.oid, owner_role.oid)
  ) OR EXISTS (
    SELECT 1 FROM pg_type
    WHERE typowner IN (runtime_role.oid, owner_role.oid)
  ) THEN
    RAISE EXCEPTION 'audit roles must not own pre-existing objects'
      USING ERRCODE = '55000';
  END IF;

  FOREACH wrapper_signature IN ARRAY ARRAY[
    'public.converact_audit_writer_fence(text,text,text,numeric,numeric,text,text,numeric)',
    'public.converact_audit_chain_head(text,text,text,numeric,numeric,text,text,numeric)',
    'public.converact_audit_event_append(text,text,text,numeric,numeric,text,text,numeric,text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb,timestamp with time zone,timestamp with time zone,boolean,text,text)'
  ] LOOP
    wrapper_oid := to_regprocedure(wrapper_signature);
    IF wrapper_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_proc AS procedure
      JOIN pg_roles AS owner ON owner.oid = procedure.proowner
      WHERE procedure.oid = wrapper_oid
        AND owner.rolname = 'opc_admin'
        AND procedure.prosecdef
        AND procedure.proconfig = ARRAY[
          'search_path=pg_catalog, public, pg_temp'
        ]::TEXT[]
    ) THEN
      RAISE EXCEPTION 'audit wrapper precondition is invalid'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  wrapper_oid := to_regprocedure(
    'public.converact_authority_writer_fence(text,text,text,numeric,numeric,text,text,numeric)'
  );
  IF wrapper_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc AS procedure
    JOIN pg_roles AS owner ON owner.oid = procedure.proowner
    WHERE procedure.oid = wrapper_oid
      AND owner.rolname = 'opc_admin'
      AND procedure.prosecdef
      AND procedure.proconfig = ARRAY[
        'search_path=pg_catalog, public, pg_temp'
      ]::TEXT[]
  ) THEN
    RAISE EXCEPTION 'audit authority fence precondition is invalid'
      USING ERRCODE = '55000';
  END IF;

  legacy_guard_oid := to_regprocedure(
    'public.converact_audit_legacy_writer_guard()'
  );
  IF legacy_guard_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc AS procedure
    JOIN pg_roles AS owner ON owner.oid = procedure.proowner
    WHERE procedure.oid = legacy_guard_oid
      AND owner.rolname = 'opc_admin'
      AND NOT procedure.prosecdef
      AND procedure.proconfig = ARRAY[
        'search_path=pg_catalog, public, pg_temp'
      ]::TEXT[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc AS procedure,
      LATERAL aclexplode(
        coalesce(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS privilege
    WHERE procedure.oid = legacy_guard_oid
      AND privilege.grantee <> procedure.proowner
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger AS trigger
    WHERE trigger.tgrelid = 'public.ivekit_audit_events'::REGCLASS
      AND trigger.tgname = 'ivekit_audit_legacy_writer'
      AND trigger.tgfoid = legacy_guard_oid
      AND trigger.tgenabled = 'O'
      AND NOT trigger.tgisinternal
      AND trigger.tgtype = 7
      AND trigger.tgqual IS NULL
      AND trigger.tgnargs = 0
  ) THEN
    RAISE EXCEPTION 'audit legacy guard precondition is invalid'
      USING ERRCODE = '55000';
  END IF;

  immutable_guard_oid := to_regprocedure(
    'public.opc_ivekit_audit_immutable_guard()'
  );
  IF immutable_guard_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc AS procedure
    JOIN pg_roles AS owner ON owner.oid = procedure.proowner
    WHERE procedure.oid = immutable_guard_oid
      AND owner.rolname = 'opc_admin'
      AND NOT procedure.prosecdef
      AND procedure.proconfig IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc AS procedure,
      LATERAL aclexplode(
        coalesce(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS privilege
    WHERE procedure.oid = immutable_guard_oid
      AND privilege.grantee <> procedure.proowner
  ) OR (
    SELECT count(*) FROM pg_trigger AS trigger
    WHERE trigger.tgrelid = 'public.ivekit_audit_events'::REGCLASS
      AND NOT trigger.tgisinternal
  ) <> 2 OR NOT EXISTS (
    SELECT 1 FROM pg_trigger AS trigger
    WHERE trigger.tgrelid = 'public.ivekit_audit_events'::REGCLASS
      AND trigger.tgname = 'ivekit_audit_events_immutable'
      AND trigger.tgfoid = immutable_guard_oid
      AND trigger.tgenabled = 'O'
      AND NOT trigger.tgisinternal
      AND trigger.tgtype = 27
      AND trigger.tgqual IS NULL
      AND trigger.tgnargs = 0
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger AS trigger
    WHERE trigger.tgrelid = 'public.converact_audit_chain_heads'::REGCLASS
      AND NOT trigger.tgisinternal
  ) OR EXISTS (
    SELECT 1 FROM pg_rewrite AS rule
    WHERE rule.ev_class IN (
      'public.ivekit_audit_events'::REGCLASS,
      'public.converact_audit_chain_heads'::REGCLASS
    )
  ) THEN
    RAISE EXCEPTION 'audit target trigger or rule precondition is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$audit_role_guard$;

-- The target append wrappers become SECURITY DEFINER functions owned by the
-- isolated no-login role below. The invoker trigger must recognize that exact
-- owner while continuing to reject direct, inherited and SET ROLE legacy
-- callers whose session identity is privileged through opc_runtime.
CREATE OR REPLACE FUNCTION converact_audit_legacy_writer_guard()
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
           WHERE relation.oid = 'public.ivekit_audit_events'::REGCLASS)
        ) AND
        current_user <> 'converact_audit_store_owner' AND (
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

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM converact_audit_runtime, converact_audit_store_owner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM converact_audit_runtime, converact_audit_store_owner;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
  FROM converact_audit_runtime, converact_audit_store_owner;
REVOKE ALL PRIVILEGES ON SCHEMA public
  FROM converact_audit_runtime, converact_audit_store_owner;

GRANT USAGE ON SCHEMA public
  TO converact_audit_runtime, converact_audit_store_owner;
GRANT CREATE ON SCHEMA public TO converact_audit_store_owner;

GRANT SELECT, INSERT ON ivekit_audit_events
  TO converact_audit_store_owner;
GRANT SELECT, INSERT, UPDATE ON converact_audit_chain_heads
  TO converact_audit_store_owner;
GRANT EXECUTE ON FUNCTION converact_authority_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) TO converact_audit_store_owner;

ALTER FUNCTION converact_audit_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) OWNER TO converact_audit_store_owner;
ALTER FUNCTION converact_audit_chain_head(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) OWNER TO converact_audit_store_owner;
ALTER FUNCTION converact_audit_event_append(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TEXT
) OWNER TO converact_audit_store_owner;

REVOKE CREATE ON SCHEMA public FROM converact_audit_store_owner;

REVOKE ALL PRIVILEGES ON ivekit_audit_events, converact_audit_chain_heads
  FROM converact_audit_runtime;
GRANT SELECT ON ivekit_audit_events TO converact_audit_runtime;

REVOKE ALL ON FUNCTION converact_audit_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) FROM PUBLIC, opc_runtime, converact_audit_runtime;
REVOKE ALL ON FUNCTION converact_audit_chain_head(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) FROM PUBLIC, opc_runtime, converact_audit_runtime;
REVOKE ALL ON FUNCTION converact_audit_event_append(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TEXT
) FROM PUBLIC, opc_runtime, converact_audit_runtime;

GRANT EXECUTE ON FUNCTION converact_audit_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) TO converact_audit_runtime;
GRANT EXECUTE ON FUNCTION converact_audit_chain_head(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) TO converact_audit_runtime;
GRANT EXECUTE ON FUNCTION converact_audit_event_append(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TEXT
) TO converact_audit_runtime;

REVOKE EXECUTE ON FUNCTION converact_authority_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) FROM converact_audit_runtime;

-- Preserve the active TypeScript writer's existing read/append surface while
-- removing broad grants that generic bootstrap may have replayed.
REVOKE ALL PRIVILEGES ON ivekit_audit_events FROM opc_runtime;
GRANT SELECT, INSERT ON ivekit_audit_events TO opc_runtime;
REVOKE ALL PRIVILEGES ON converact_audit_chain_heads FROM opc_runtime;
REVOKE ALL ON FUNCTION converact_audit_legacy_writer_allowed(TEXT)
  FROM PUBLIC, opc_runtime;
GRANT EXECUTE ON FUNCTION converact_audit_legacy_writer_allowed(TEXT)
  TO opc_runtime;

DO $audit_role_graph$
DECLARE
  admin_oid OID;
  legacy_oid OID;
  runtime_oid OID;
  owner_oid OID;
  database_owner_oid OID;
  predefined_database_owner_oid OID;
  guard_oid OID;
  immutable_guard_oid OID;
  authority_fence_oid OID;
  wrapper_oid OID;
  wrapper_oids OID[] := ARRAY[]::OID[];
  event_oid OID := 'public.ivekit_audit_events'::REGCLASS::OID;
  head_oid OID := 'public.converact_audit_chain_heads'::REGCLASS::OID;
BEGIN
  SELECT oid INTO admin_oid FROM pg_roles WHERE rolname = 'opc_admin';
  SELECT oid INTO legacy_oid FROM pg_roles WHERE rolname = 'opc_runtime';
  SELECT oid INTO runtime_oid FROM pg_roles
  WHERE rolname = 'converact_audit_runtime';
  SELECT oid INTO owner_oid FROM pg_roles
  WHERE rolname = 'converact_audit_store_owner';
  SELECT datdba INTO database_owner_oid FROM pg_database
  WHERE datname = current_database();
  predefined_database_owner_oid := to_regrole('pg_database_owner')::OID;
  guard_oid := to_regprocedure(
    'public.converact_audit_legacy_writer_guard()'
  )::OID;
  immutable_guard_oid := to_regprocedure(
    'public.opc_ivekit_audit_immutable_guard()'
  )::OID;

  IF guard_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc AS procedure
    WHERE procedure.oid = guard_oid
      AND procedure.proowner = admin_oid
      AND NOT procedure.prosecdef
      AND procedure.proconfig = ARRAY[
        'search_path=pg_catalog, public, pg_temp'
      ]::TEXT[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc AS procedure,
      LATERAL aclexplode(
        coalesce(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS privilege
    WHERE procedure.oid = guard_oid
      AND privilege.grantee <> admin_oid
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger AS trigger
    WHERE trigger.tgrelid = event_oid
      AND trigger.tgname = 'ivekit_audit_legacy_writer'
      AND trigger.tgfoid = guard_oid
      AND trigger.tgenabled = 'O'
      AND NOT trigger.tgisinternal
      AND trigger.tgtype = 7
      AND trigger.tgqual IS NULL
      AND trigger.tgnargs = 0
  ) THEN
    RAISE EXCEPTION 'audit legacy guard graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF immutable_guard_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc AS procedure
    WHERE procedure.oid = immutable_guard_oid
      AND procedure.proowner = admin_oid
      AND NOT procedure.prosecdef
      AND procedure.proconfig IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc AS procedure,
      LATERAL aclexplode(
        coalesce(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS privilege
    WHERE procedure.oid = immutable_guard_oid
      AND privilege.grantee <> admin_oid
  ) OR (
    SELECT count(*) FROM pg_trigger AS trigger
    WHERE trigger.tgrelid = event_oid
      AND NOT trigger.tgisinternal
  ) <> 2 OR NOT EXISTS (
    SELECT 1 FROM pg_trigger AS trigger
    WHERE trigger.tgrelid = event_oid
      AND trigger.tgname = 'ivekit_audit_events_immutable'
      AND trigger.tgfoid = immutable_guard_oid
      AND trigger.tgenabled = 'O'
      AND NOT trigger.tgisinternal
      AND trigger.tgtype = 27
      AND trigger.tgqual IS NULL
      AND trigger.tgnargs = 0
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger AS trigger
    WHERE trigger.tgrelid = head_oid
      AND NOT trigger.tgisinternal
  ) OR EXISTS (
    SELECT 1 FROM pg_rewrite AS rule
    WHERE rule.ev_class IN (event_oid, head_oid)
  ) THEN
    RAISE EXCEPTION 'audit target trigger or rule graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  FOREACH wrapper_oid IN ARRAY ARRAY[
    to_regprocedure(
      'public.converact_audit_writer_fence(text,text,text,numeric,numeric,text,text,numeric)'
    )::OID,
    to_regprocedure(
      'public.converact_audit_chain_head(text,text,text,numeric,numeric,text,text,numeric)'
    )::OID,
    to_regprocedure(
      'public.converact_audit_event_append(text,text,text,numeric,numeric,text,text,numeric,text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb,timestamp with time zone,timestamp with time zone,boolean,text,text)'
    )::OID
  ] LOOP
    wrapper_oids := array_append(wrapper_oids, wrapper_oid);
    IF wrapper_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_proc AS procedure
      WHERE procedure.oid = wrapper_oid
        AND procedure.proowner = owner_oid
        AND procedure.prosecdef
        AND procedure.proconfig = ARRAY[
          'search_path=pg_catalog, public, pg_temp'
        ]::TEXT[]
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_proc AS procedure,
        LATERAL aclexplode(
          coalesce(procedure.proacl, acldefault('f', procedure.proowner))
        ) AS privilege
      WHERE procedure.oid = wrapper_oid
        AND privilege.grantee = runtime_oid
        AND privilege.grantor = owner_oid
        AND privilege.privilege_type = 'EXECUTE'
        AND NOT privilege.is_grantable
    ) OR
       EXISTS (
         SELECT 1
         FROM pg_proc AS procedure,
           LATERAL aclexplode(
             coalesce(procedure.proacl, acldefault('f', procedure.proowner))
         ) AS privilege
         WHERE procedure.oid = wrapper_oid
           AND NOT (
             privilege.grantee = owner_oid AND
             privilege.privilege_type = 'EXECUTE'
           )
           AND NOT (
             privilege.grantee = runtime_oid AND
             privilege.grantor = owner_oid AND
             privilege.privilege_type = 'EXECUTE' AND
             NOT privilege.is_grantable
           )
       )
    THEN
      RAISE EXCEPTION 'audit wrapper privilege graph is invalid'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  authority_fence_oid := to_regprocedure(
    'public.converact_authority_writer_fence(text,text,text,numeric,numeric,text,text,numeric)'
  )::OID;
  IF authority_fence_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc AS procedure
    WHERE procedure.oid = authority_fence_oid
      AND procedure.proowner = admin_oid
      AND procedure.prosecdef
      AND procedure.proconfig = ARRAY[
        'search_path=pg_catalog, public, pg_temp'
      ]::TEXT[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_proc AS procedure,
      LATERAL aclexplode(
        coalesce(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS privilege
    WHERE procedure.oid = authority_fence_oid
      AND privilege.grantee = owner_oid
      AND privilege.grantor = procedure.proowner
      AND privilege.privilege_type = 'EXECUTE'
      AND NOT privilege.is_grantable
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc AS procedure,
      LATERAL aclexplode(
        coalesce(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS privilege
    WHERE procedure.oid = authority_fence_oid
      AND privilege.grantee = owner_oid
      AND (
        privilege.grantor <> procedure.proowner OR
        privilege.privilege_type <> 'EXECUTE' OR
        privilege.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'audit owner authority function graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF has_table_privilege(
    runtime_oid, event_oid,
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR has_table_privilege(
    runtime_oid, head_oid,
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT has_table_privilege(runtime_oid, event_oid, 'SELECT') OR
     has_function_privilege(
       runtime_oid,
       'public.converact_authority_writer_fence(text,text,text,numeric,numeric,text,text,numeric)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'audit runtime privilege graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class AS relation
    WHERE relation.oid IN (event_oid, head_oid)
      AND relation.relowner <> admin_oid
  ) THEN
    RAISE EXCEPTION 'audit target relation owner is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF database_owner_oid <> admin_oid OR NOT EXISTS (
    SELECT 1 FROM pg_namespace AS namespace
    WHERE namespace.oid = 'public'::REGNAMESPACE
      AND namespace.nspowner IN (admin_oid, predefined_database_owner_oid)
  ) OR EXISTS (
    SELECT 1
    FROM pg_namespace AS namespace,
      LATERAL aclexplode(
        coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
      ) AS privilege
    WHERE namespace.oid = 'public'::REGNAMESPACE
      AND privilege.privilege_type = 'CREATE'
      AND privilege.grantee <> namespace.nspowner
  ) THEN
    RAISE EXCEPTION 'public schema create authority is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF NOT has_table_privilege(owner_oid, event_oid, 'SELECT,INSERT') OR
     has_table_privilege(
       owner_oid, event_oid,
       'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) OR NOT has_table_privilege(
       owner_oid, head_oid, 'SELECT,INSERT,UPDATE'
     ) OR has_table_privilege(
       owner_oid, head_oid, 'DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) OR NOT has_function_privilege(
       owner_oid,
       'public.converact_authority_writer_fence(text,text,text,numeric,numeric,text,text,numeric)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'audit owner privilege graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF NOT has_table_privilege(legacy_oid, event_oid, 'SELECT,INSERT') OR
     has_table_privilege(
       legacy_oid, event_oid,
       'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) OR has_table_privilege(
       legacy_oid, head_oid,
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) OR NOT has_function_privilege(
       legacy_oid,
       'public.converact_audit_legacy_writer_allowed(text)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'legacy audit privilege graph is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class AS relation,
      LATERAL aclexplode(relation.relacl) AS privilege
    WHERE relation.oid IN (event_oid, head_oid)
      AND NOT (
        privilege.grantee = relation.relowner AND
        privilege.grantor = relation.relowner
      )
      AND NOT (
        relation.oid = event_oid AND
        privilege.grantee = runtime_oid AND
        privilege.grantor = relation.relowner AND
        privilege.privilege_type = 'SELECT' AND
        NOT privilege.is_grantable
      )
      AND NOT (
        relation.oid = event_oid AND
        privilege.grantee = legacy_oid AND
        privilege.grantor = relation.relowner AND
        privilege.privilege_type IN ('SELECT', 'INSERT') AND
        NOT privilege.is_grantable
      )
      AND NOT (
        privilege.grantee = owner_oid AND
        privilege.grantor = relation.relowner AND
        NOT privilege.is_grantable AND
        CASE
          WHEN relation.oid = event_oid
          THEN privilege.privilege_type IN ('SELECT', 'INSERT')
          ELSE privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
        END
      )
  ) OR EXISTS (
    SELECT 1 FROM pg_attribute AS attribute
    WHERE attribute.attrelid IN (event_oid, head_oid)
      AND cardinality(attribute.attacl) > 0
  ) THEN
    RAISE EXCEPTION 'audit column privilege graph is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$audit_role_graph$;

COMMENT ON FUNCTION converact_audit_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) IS 'Audit read/replay writer fence owned by the isolated non-login Audit store role.';
