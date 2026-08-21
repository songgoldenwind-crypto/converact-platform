export interface ConveractFabricRuntimeRoleQueryable {
  query(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

async function requireOpcAdmin(pg: ConveractFabricRuntimeRoleQueryable): Promise<void> {
  const identity = await pg.query('SELECT current_user AS current_user');
  if (String(identity.rows[0]?.current_user || '') !== 'opc_admin') {
    throw new Error('Converact Fabric runtime-role initialization must run as opc_admin');
  }
}

export async function initializeConveractFabricRuntimeRole(
  pg: ConveractFabricRuntimeRoleQueryable,
  password: string
): Promise<void> {
  if (!password) throw new Error('CONVERACT_RUNTIME_DB_PASSWORD is required');

  await requireOpcAdmin(pg);

  await pg.query('BEGIN');
  try {
    await pg.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
          CREATE ROLE opc_runtime
            LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'opc_sip_effect_executor'
        ) THEN
          CREATE ROLE opc_sip_effect_executor
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOREPLICATION NOINHERIT NOBYPASSRLS;
        END IF;
        ALTER ROLE opc_sip_effect_executor
          NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOINHERIT NOBYPASSRLS;
        GRANT opc_sip_effect_executor TO opc_runtime;
        REVOKE ADMIN OPTION FOR opc_sip_effect_executor FROM opc_runtime;
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'converact_event_runtime'
        ) THEN
          CREATE ROLE converact_event_runtime
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOREPLICATION NOINHERIT NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'converact_event_store_owner'
        ) THEN
          CREATE ROLE converact_event_store_owner
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOREPLICATION NOINHERIT NOBYPASSRLS;
        END IF;
        ALTER ROLE converact_event_runtime
          NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOINHERIT NOBYPASSRLS;
        ALTER ROLE converact_event_store_owner
          NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOINHERIT NOBYPASSRLS;
        IF pg_has_role('converact_event_runtime', 'opc_runtime', 'MEMBER') THEN
          REVOKE opc_runtime FROM converact_event_runtime;
        END IF;
        IF pg_has_role(
          'converact_event_runtime', 'opc_sip_effect_executor', 'MEMBER'
        ) THEN
          REVOKE opc_sip_effect_executor FROM converact_event_runtime;
        END IF;
      END
      $$
    `);
    await pg.query(`
      ALTER ROLE opc_runtime
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS
    `);

    const quoted = await pg.query(
      "SELECT format('ALTER ROLE opc_runtime PASSWORD %L', $1::text) AS statement",
      [password]
    );
    const alterPassword = String(quoted.rows[0]?.statement || '');
    if (!alterPassword) throw new Error('PostgreSQL did not quote the opc_runtime password');
    await pg.query(alterPassword);

    await pg.query(`
      DO $$
      BEGIN
        EXECUTE format(
          'REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC',
          current_database()
        );
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO opc_runtime', current_database());
      END
      $$
    `);
    await pg.query('GRANT USAGE ON SCHEMA public TO opc_runtime');
    await pg.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await pg.query('REVOKE CREATE ON SCHEMA public FROM opc_runtime');
    await pg.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opc_runtime');
    await pg.query('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO opc_runtime');
    await pg.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opc_runtime
    `);
    await pg.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin IN SCHEMA public
        GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO opc_runtime
    `);
    await pg.query(`
      GRANT USAGE ON SCHEMA public TO opc_sip_effect_executor;
      DO $$
      DECLARE
        feature_table TEXT;
      BEGIN
        FOREACH feature_table IN ARRAY ARRAY[
          'ivekit_sip_effect_schema_registry',
          'ivekit_sip_effect_writer_registry',
          'ivekit_sip_protocol_effects',
          'ivekit_sip_effect_receipts',
          'ivekit_sip_durable_boundaries',
          'ivekit_sip_durable_boundary_facts'
        ] LOOP
          IF to_regclass('public.' || feature_table) IS NOT NULL THEN
            EXECUTE format(
              'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, opc_runtime, opc_sip_effect_executor',
              feature_table
            );
            EXECUTE format(
              'GRANT SELECT ON TABLE public.%I TO opc_sip_effect_executor',
              feature_table
            );
          END IF;
        END LOOP;
        IF to_regclass('public.ivekit_sip_protocol_effects') IS NOT NULL THEN
          GRANT INSERT ON TABLE public.ivekit_sip_protocol_effects
            TO opc_sip_effect_executor;
          GRANT UPDATE (
            state,
            revision,
            unknown_count,
            last_receipt_id,
            last_receipt_hash,
            last_receipt_repair_delay_ms,
            failure_code,
            repair_due_at,
            repair_owner_id,
            repair_owner_epoch,
            repair_epoch_high_watermark,
            repair_claim_token,
            repair_claim_revision,
            repair_lease_until,
            repair_attempts,
            repair_exhausted_at,
            repair_exhaustion_receipt_hash,
            operator_attention_required,
            repair_compacted_at,
            canonical_wire_bytes,
            payload_retained,
            terminal_tombstone_id,
            terminal_tombstone_hash,
            terminal_at,
            updated_at
          ) ON TABLE public.ivekit_sip_protocol_effects
            TO opc_sip_effect_executor;
        END IF;
        IF to_regclass('public.ivekit_sip_effect_receipts') IS NOT NULL THEN
          GRANT INSERT ON TABLE public.ivekit_sip_effect_receipts
            TO opc_sip_effect_executor;
        END IF;
        IF to_regprocedure(
          'public.ivekit_assert_sip_effect_writer(text,text,integer,text)'
        ) IS NOT NULL THEN
          REVOKE ALL ON FUNCTION public.ivekit_assert_sip_effect_writer(
            TEXT, TEXT, INTEGER, TEXT
          ) FROM PUBLIC, opc_runtime;
          GRANT EXECUTE ON FUNCTION public.ivekit_assert_sip_effect_writer(
            TEXT, TEXT, INTEGER, TEXT
          ) TO opc_sip_effect_executor;
        END IF;
      END
      $$
    `);
    await pg.query(`
      DO $$
      BEGIN
        IF to_regclass('public.schema_migrations') IS NOT NULL THEN
          REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM opc_runtime;
        END IF;
        IF to_regclass('public.converact_platform_outbox') IS NOT NULL THEN
          REVOKE ALL PRIVILEGES ON TABLE public.converact_platform_outbox
            FROM opc_runtime;
          GRANT SELECT, INSERT, UPDATE ON TABLE public.converact_platform_outbox
            TO opc_runtime;
        END IF;
        IF to_regclass('public.converact_platform_inbox') IS NOT NULL THEN
          REVOKE ALL PRIVILEGES ON TABLE public.converact_platform_inbox
            FROM opc_runtime;
          GRANT SELECT, INSERT ON TABLE public.converact_platform_inbox
            TO opc_runtime;
        END IF;
        IF to_regclass('public.converact_platform_effect_receipts') IS NOT NULL THEN
          REVOKE ALL PRIVILEGES ON TABLE public.converact_platform_effect_receipts
            FROM opc_runtime;
          GRANT SELECT, INSERT ON TABLE public.converact_platform_effect_receipts
            TO opc_runtime;
        END IF;
        IF to_regclass('public.converact_platform_outbox_transitions') IS NOT NULL THEN
          REVOKE ALL PRIVILEGES ON TABLE
            public.converact_platform_outbox_transitions,
            public.converact_platform_outbox_claim_operations,
            public.converact_platform_outbox_claim_receipts
            FROM opc_runtime;
        END IF;
        IF to_regclass('public.ivekit_voice_cdr_calls') IS NOT NULL THEN
          REVOKE DELETE, TRUNCATE
            ON TABLE public.ivekit_voice_cdr_calls
            FROM opc_runtime;
        END IF;
        IF to_regclass('public.ivekit_voice_cdr_legs') IS NOT NULL THEN
          REVOKE DELETE, TRUNCATE
            ON TABLE public.ivekit_voice_cdr_legs
            FROM opc_runtime;
        END IF;
        IF to_regclass('public.ivekit_voice_cdr_submissions') IS NOT NULL THEN
          REVOKE UPDATE, DELETE, TRUNCATE
            ON TABLE public.ivekit_voice_cdr_submissions
            FROM opc_runtime;
        END IF;
        IF to_regclass('public.ivekit_voice_cdr_receipts') IS NOT NULL THEN
          REVOKE UPDATE, DELETE, TRUNCATE
            ON TABLE public.ivekit_voice_cdr_receipts
            FROM opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_rustdesk_session_by_external_id(text)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_rustdesk_session_by_external_id(TEXT) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_worker_tenant_ids(text,timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_worker_tenant_ids(TEXT, TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_tinode_inbound_tenant_ids(timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_tinode_inbound_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_ivekit_event_retention_tenant_ids(timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_ivekit_event_retention_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_ivekit_cc_worker_tenant_ids(timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_ivekit_cc_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_secure_file_status_transition_allowed(text,text)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_secure_file_status_transition_allowed(TEXT, TEXT) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_secure_file_worker_tenant_ids(timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_secure_file_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_secure_file_derivative_worker_tenant_ids(timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_secure_file_derivative_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_secure_file_cleanup_worker_tenant_ids(timestamp with time zone,timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_secure_file_cleanup_worker_tenant_ids(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_ivekit_voice_profile_context(text)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_ivekit_voice_profile_context(TEXT) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_ivekit_recording_worker_tenant_ids(timestamp with time zone,integer)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_ivekit_recording_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
        END IF;
        IF to_regprocedure('public.opc_ivekit_applied_migration_versions(text[])') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION public.opc_ivekit_applied_migration_versions(TEXT[]) TO opc_runtime;
        END IF;
      END
      $$
    `);
    await pg.query('COMMIT');
  } catch (error) {
    await pg.query('ROLLBACK');
    throw error;
  }
}

/**
 * Explicitly enables the isolated Rust Platform Event database login.
 *
 * Bootstrap keeps the role `NOLOGIN`; activation is permitted only after the
 * exact migration-owned privilege graph exists. This function does not wire or
 * start a runtime process.
 */
export async function activateConveractEventRuntimeRole(
  pg: ConveractFabricRuntimeRoleQueryable,
  password: string
): Promise<void> {
  if (!password) {
    throw new Error('CONVERACT_EVENT_RUNTIME_DB_PASSWORD is required');
  }
  await requireOpcAdmin(pg);

  await pg.query('BEGIN');
  try {
    await pg.query(`
      DO $$
      DECLARE
        event_role pg_roles%ROWTYPE;
        owner_role pg_roles%ROWTYPE;
        admin_role_oid OID;
        legacy_role_oid OID;
        current_database_oid OID;
        public_schema_oid OID;
        wrapper_signature TEXT;
        wrapper_oid REGPROCEDURE;
        target_table TEXT;
        target_table_oid REGCLASS;
        target_table_oids OID[] := ARRAY[]::OID[];
        wrapper_oids OID[] := ARRAY[]::OID[];
        authority_function_oids OID[];
        allowed_function_oids OID[];
        table_state pg_class%ROWTYPE;
      BEGIN
        SELECT * INTO event_role FROM pg_roles
        WHERE rolname = 'converact_event_runtime';
        SELECT * INTO owner_role FROM pg_roles
        WHERE rolname = 'converact_event_store_owner';
        SELECT oid INTO admin_role_oid FROM pg_roles
        WHERE rolname = 'opc_admin';
        SELECT oid INTO legacy_role_oid FROM pg_roles
        WHERE rolname = 'opc_runtime';
        SELECT oid INTO current_database_oid FROM pg_database
        WHERE datname = current_database();
        SELECT oid INTO public_schema_oid FROM pg_namespace
        WHERE nspname = 'public';
        IF admin_role_oid IS NULL THEN
          RAISE EXCEPTION 'opc_admin role is missing';
        END IF;
        IF event_role.rolname IS NULL OR event_role.rolsuper OR
           event_role.rolcreatedb OR event_role.rolcreaterole OR
           event_role.rolreplication OR event_role.rolinherit OR
           event_role.rolbypassrls
        THEN
          RAISE EXCEPTION 'converact event runtime role shape is invalid';
        END IF;
        IF owner_role.rolname IS NULL OR owner_role.rolcanlogin IS DISTINCT FROM FALSE OR
           owner_role.rolsuper OR owner_role.rolcreatedb OR
           owner_role.rolcreaterole OR owner_role.rolreplication OR
           owner_role.rolinherit OR owner_role.rolbypassrls
        THEN
          RAISE EXCEPTION 'converact event store owner role shape is invalid';
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

        FOREACH wrapper_signature IN ARRAY ARRAY[
          'public.converact_platform_writer_fence(text,text,text,numeric,numeric,text,text,numeric)',
          'public.converact_platform_inbox_append(text,text,text,numeric,numeric,text,text,numeric,text,text,text,bigint,text,timestamp with time zone)',
          'public.converact_platform_effect_append(text,text,text,numeric,numeric,text,text,numeric,text,text,text,text,text,bigint,text,bigint,text,timestamp with time zone)',
          'public.converact_platform_outbox_enqueue(text,text,text,numeric,numeric,text,text,numeric,text,text,text,integer,integer,text,text,text,text,bigint,text,text,text,jsonb,jsonb,text,text,text,jsonb,integer,timestamp with time zone,timestamp with time zone)',
          'public.converact_platform_outbox_claim(text,text,text,numeric,numeric,text,text,numeric,text,text,text,bigint,integer)',
          'public.converact_platform_outbox_transition_apply(text,text,text,numeric,numeric,text,text,numeric,text,text,text,bigint,text,text,bigint,text,text)'
        ] LOOP
          wrapper_oid := to_regprocedure(wrapper_signature);
          IF wrapper_oid IS NULL OR NOT EXISTS (
            SELECT 1 FROM pg_proc AS procedure
            JOIN pg_roles AS owner ON owner.oid = procedure.proowner
            WHERE procedure.oid = wrapper_oid
              AND owner.rolname = 'converact_event_store_owner'
              AND procedure.prosecdef
              AND procedure.proconfig = ARRAY[
                'search_path=pg_catalog, public, pg_temp'
              ]::TEXT[]
          ) OR NOT EXISTS (
            SELECT 1
            FROM pg_proc AS procedure,
              LATERAL aclexplode(
                coalesce(
                  procedure.proacl,
                  acldefault('f', procedure.proowner)
                )
              ) AS privilege
            WHERE procedure.oid = wrapper_oid
              AND privilege.grantee = event_role.oid
              AND privilege.privilege_type = 'EXECUTE'
              AND NOT privilege.is_grantable
          ) OR EXISTS (
            SELECT 1
            FROM pg_proc AS procedure,
              LATERAL aclexplode(
                coalesce(
                  procedure.proacl,
                  acldefault('f', procedure.proowner)
                )
              ) AS privilege
            WHERE procedure.oid = wrapper_oid
              AND NOT (
                privilege.grantee = owner_role.oid AND
                privilege.privilege_type = 'EXECUTE'
              )
              AND NOT (
                privilege.grantee = event_role.oid AND
                privilege.privilege_type = 'EXECUTE' AND
                NOT privilege.is_grantable
              )
          ) THEN
            RAISE EXCEPTION 'converact event wrapper privilege graph is invalid';
          END IF;
          wrapper_oids := array_append(wrapper_oids, wrapper_oid::OID);
        END LOOP;

        authority_function_oids := ARRAY[
          to_regprocedure(
            'public.converact_authority_writer_fence(text,text,text,numeric,numeric,text,text,numeric)'
          )::OID,
          to_regprocedure(
            'public.converact_authority_claim_generation_work(text,text,text,numeric,numeric,text,text,numeric,text,text)'
          )::OID,
          to_regprocedure(
            'public.converact_authority_release_generation_work(text,text,text,numeric,numeric,text,text,text)'
          )::OID
        ];
        IF array_position(authority_function_oids, NULL) IS NOT NULL OR (
          SELECT count(DISTINCT procedure.oid)
          FROM pg_proc AS procedure,
            LATERAL aclexplode(
              coalesce(
                procedure.proacl,
                acldefault('f', procedure.proowner)
              )
            ) AS privilege
          WHERE procedure.oid = ANY(authority_function_oids)
            AND privilege.grantee = owner_role.oid
            AND privilege.privilege_type = 'EXECUTE'
            AND NOT privilege.is_grantable
        ) <> cardinality(authority_function_oids) THEN
          RAISE EXCEPTION 'converact event owner authority function graph is invalid';
        END IF;
        allowed_function_oids := wrapper_oids || authority_function_oids;

        FOREACH target_table IN ARRAY ARRAY[
          'public.converact_platform_outbox',
          'public.converact_platform_inbox',
          'public.converact_platform_effect_receipts',
          'public.converact_platform_outbox_transitions',
          'public.converact_platform_outbox_claim_operations',
          'public.converact_platform_outbox_claim_receipts'
        ] LOOP
          target_table_oid := to_regclass(target_table);
          IF target_table_oid IS NULL THEN
            RAISE EXCEPTION 'converact event target table is missing';
          END IF;
          target_table_oids := array_append(target_table_oids, target_table_oid::OID);
          SELECT * INTO table_state FROM pg_class
          WHERE oid = target_table_oid;

          IF NOT table_state.relrowsecurity OR
             NOT table_state.relforcerowsecurity OR (
            SELECT count(*) FROM pg_policy AS policy
            WHERE policy.polrelid = target_table_oid
          ) <> 1 OR NOT EXISTS (
            SELECT 1 FROM pg_policy AS policy
            WHERE policy.polrelid = target_table_oid
              AND policy.polname = 'tenant_isolation'
              AND policy.polcmd = '*'
              AND policy.polpermissive
              AND policy.polroles = ARRAY[0::OID]
              AND regexp_replace(
                pg_get_expr(policy.polqual, policy.polrelid), '\\s+', '', 'g'
              ) IN (
                '(opc_rls_bypass()OR(tenant_id=opc_current_tenant()))',
                'opc_rls_bypass()OR(tenant_id=opc_current_tenant())'
              )
              AND regexp_replace(
                pg_get_expr(policy.polwithcheck, policy.polrelid), '\\s+', '', 'g'
              ) IN (
                '(opc_rls_bypass()OR(tenant_id=opc_current_tenant()))',
                'opc_rls_bypass()OR(tenant_id=opc_current_tenant())'
              )
          ) OR NOT EXISTS (
            SELECT 1
            FROM pg_class AS object,
              LATERAL aclexplode(
                coalesce(object.relacl, acldefault('r', object.relowner))
              ) AS privilege
            WHERE object.oid = target_table_oid
              AND privilege.grantee = event_role.oid
              AND privilege.privilege_type = 'SELECT'
              AND NOT privilege.is_grantable
          ) OR has_table_privilege(
            'converact_event_runtime', target_table,
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          ) THEN
            RAISE EXCEPTION 'converact event table privilege graph is invalid';
          END IF;

          IF target_table = 'public.converact_platform_outbox' THEN
            IF (
              SELECT count(*)
              FROM pg_class AS object,
                LATERAL aclexplode(
                  coalesce(object.relacl, acldefault('r', object.relowner))
                ) AS privilege
              WHERE object.oid = target_table_oid
                AND privilege.grantee = owner_role.oid
                AND privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
                AND NOT privilege.is_grantable
            ) <> 3 OR has_table_privilege(
              'converact_event_store_owner', target_table,
              'DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ) THEN
              RAISE EXCEPTION 'converact event owner table privilege graph is invalid';
            END IF;
          ELSIF (
            SELECT count(*)
            FROM pg_class AS object,
              LATERAL aclexplode(
                coalesce(object.relacl, acldefault('r', object.relowner))
              ) AS privilege
            WHERE object.oid = target_table_oid
              AND privilege.grantee = owner_role.oid
              AND privilege.privilege_type IN ('SELECT', 'INSERT')
              AND NOT privilege.is_grantable
          ) <> 2 OR has_table_privilege(
            'converact_event_store_owner', target_table,
            'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          ) THEN
            RAISE EXCEPTION 'converact event owner table privilege graph is invalid';
          END IF;
        END LOOP;

        IF EXISTS (
          SELECT 1
          FROM pg_class AS object,
            LATERAL aclexplode(object.relacl) AS privilege
          WHERE object.oid = ANY(target_table_oids)
            AND NOT (
              privilege.grantee = object.relowner AND
              privilege.grantor = object.relowner
            )
            AND NOT (
              privilege.grantee = event_role.oid AND
              privilege.grantor = object.relowner AND
              privilege.privilege_type = 'SELECT' AND
              NOT privilege.is_grantable
            )
            AND NOT (
              privilege.grantee = owner_role.oid AND
              privilege.grantor = object.relowner AND
              NOT privilege.is_grantable AND
              CASE
                WHEN object.relname = 'converact_platform_outbox'
                THEN privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
                ELSE privilege.privilege_type IN ('SELECT', 'INSERT')
              END
            )
            AND NOT (
              legacy_role_oid IS NOT NULL AND
              privilege.grantee = legacy_role_oid AND
              privilege.grantor = object.relowner AND
              NOT privilege.is_grantable AND
              CASE
                WHEN object.relname = 'converact_platform_outbox'
                THEN privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
                WHEN object.relname IN (
                  'converact_platform_inbox',
                  'converact_platform_effect_receipts'
                )
                THEN privilege.privilege_type IN ('SELECT', 'INSERT')
                ELSE FALSE
              END
            )
        ) OR EXISTS (
          SELECT 1 FROM pg_attribute AS attribute
          WHERE attribute.attrelid = ANY(target_table_oids)
            AND cardinality(attribute.attacl) > 0
        ) THEN
          RAISE EXCEPTION 'converact event target relation ACL graph is invalid';
        END IF;

        -- Closed-world backstop for every current-database and shared catalog
        -- object, including large objects and extension-defined object kinds.
        -- A runtime role used by another database is deliberately rejected.
        IF EXISTS (
          SELECT 1 FROM pg_shdepend AS dependency
          WHERE dependency.refclassid = 'pg_authid'::REGCLASS
            AND dependency.refobjid = event_role.oid
            AND NOT (
              dependency.dbid = current_database_oid AND
              dependency.deptype = 'a' AND
              dependency.objsubid = 0 AND (
                dependency.classid = 'pg_class'::REGCLASS AND
                dependency.objid = ANY(target_table_oids) OR
                dependency.classid = 'pg_proc'::REGCLASS AND
                dependency.objid = ANY(wrapper_oids) OR
                dependency.classid = 'pg_namespace'::REGCLASS AND
                dependency.objid = public_schema_oid
              )
            )
            AND NOT (
              dependency.dbid = 0 AND
              dependency.classid = 'pg_database'::REGCLASS AND
              dependency.objid = current_database_oid AND
              dependency.objsubid = 0 AND
              dependency.deptype = 'a'
            )
        ) THEN
          RAISE EXCEPTION 'converact event runtime has authority outside the exact graph';
        END IF;

        IF EXISTS (
          SELECT 1 FROM pg_shdepend AS dependency
          WHERE dependency.refclassid = 'pg_authid'::REGCLASS
            AND dependency.refobjid = owner_role.oid
            AND NOT (
              dependency.dbid = current_database_oid AND
              dependency.objsubid = 0 AND (
                dependency.deptype = 'a' AND
                dependency.classid = 'pg_class'::REGCLASS AND
                dependency.objid = ANY(target_table_oids) OR
                dependency.deptype = 'a' AND
                dependency.classid = 'pg_proc'::REGCLASS AND
                dependency.objid = ANY(authority_function_oids) OR
                dependency.deptype = 'o' AND
                dependency.classid = 'pg_proc'::REGCLASS AND
                dependency.objid = ANY(wrapper_oids) OR
                dependency.deptype = 'a' AND
                dependency.classid = 'pg_namespace'::REGCLASS AND
                dependency.objid = public_schema_oid
              )
            )
        ) THEN
          RAISE EXCEPTION 'converact event owner has authority outside the exact graph';
        END IF;

        -- ACL rows name only direct grantees. Effective privilege checks also
        -- close ambient PUBLIC grants, which pg_shdepend cannot attribute to
        -- either dedicated role.
        IF has_database_privilege(
          event_role.oid, current_database_oid, 'CREATE,TEMPORARY'
        ) OR EXISTS (
          SELECT 1 FROM pg_database AS database
          WHERE database.oid <> current_database_oid
            AND database.datallowconn
            AND has_database_privilege(
              event_role.oid, database.oid, 'CONNECT'
            )
        ) OR has_database_privilege(
          owner_role.oid, current_database_oid, 'CONNECT,CREATE,TEMPORARY'
        ) THEN
          RAISE EXCEPTION 'converact event roles have effective authority outside the exact graph (database)';
        END IF;

        IF has_schema_privilege(
          event_role.oid, public_schema_oid, 'CREATE'
        ) OR has_schema_privilege(
          owner_role.oid, public_schema_oid, 'CREATE'
        ) OR EXISTS (
          SELECT 1 FROM pg_namespace AS namespace
          WHERE namespace.oid <> public_schema_oid
            AND namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
            AND (
              has_schema_privilege(
                event_role.oid, namespace.oid, 'USAGE,CREATE'
              ) OR has_schema_privilege(
                owner_role.oid, namespace.oid, 'USAGE,CREATE'
              )
            )
        ) THEN
          RAISE EXCEPTION 'converact event roles have effective authority outside the exact graph (schema)';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM pg_class AS object
          JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
          WHERE namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
            AND object.oid <> ALL(target_table_oids)
            AND object.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND (
              has_table_privilege(
                event_role.oid, object.oid,
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
              ) OR has_table_privilege(
                owner_role.oid, object.oid,
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
              ) OR has_any_column_privilege(
                event_role.oid, object.oid,
                'SELECT,INSERT,UPDATE,REFERENCES'
              ) OR has_any_column_privilege(
                owner_role.oid, object.oid,
                'SELECT,INSERT,UPDATE,REFERENCES'
              )
            )
        ) THEN
          RAISE EXCEPTION 'converact event roles have effective authority outside the exact graph (relation)';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM pg_class AS object
          JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
          WHERE namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
            AND object.relkind = 'S'
            AND (
              has_sequence_privilege(
                event_role.oid, object.oid, 'USAGE,SELECT,UPDATE'
              ) OR has_sequence_privilege(
                owner_role.oid, object.oid, 'USAGE,SELECT,UPDATE'
              )
            )
        ) THEN
          RAISE EXCEPTION 'converact event roles have effective authority outside the exact graph (sequence)';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM pg_largeobject_metadata AS object,
            LATERAL aclexplode(
              coalesce(object.lomacl, acldefault('L', object.lomowner))
            ) AS privilege
          WHERE privilege.grantee IN (0, event_role.oid, owner_role.oid)
            AND privilege.privilege_type IN ('SELECT', 'UPDATE')
        ) THEN
          RAISE EXCEPTION 'converact event roles have effective authority outside the exact graph (large object)';
        END IF;

        IF (
          SELECT count(*)
          FROM pg_default_acl AS defaults,
            LATERAL aclexplode(defaults.defaclacl) AS privilege
          WHERE defaults.defaclrole = admin_role_oid
            AND defaults.defaclnamespace = 0
            AND defaults.defaclobjtype = 'f'
            AND privilege.grantee = admin_role_oid
            AND privilege.grantor = admin_role_oid
            AND privilege.privilege_type = 'EXECUTE'
            AND NOT privilege.is_grantable
        ) <> 1 OR EXISTS (
          SELECT 1
          FROM pg_default_acl AS defaults,
            LATERAL aclexplode(defaults.defaclacl) AS privilege
          WHERE defaults.defaclrole = admin_role_oid
            AND defaults.defaclobjtype IN ('r', 'S', 'f', 'n')
            AND (
              defaults.defaclobjtype IN ('r', 'S') AND
              defaults.defaclnamespace IN (0, public_schema_oid) AND
              privilege.grantee = 0 OR
              defaults.defaclobjtype = 'n' AND
              defaults.defaclnamespace = 0 AND
              privilege.grantee = 0 OR
              defaults.defaclobjtype = 'f' AND
              defaults.defaclnamespace = 0 AND NOT (
                privilege.grantee = admin_role_oid AND
                privilege.grantor = admin_role_oid AND
                privilege.privilege_type = 'EXECUTE' AND
                NOT privilege.is_grantable
              )
            )
        ) THEN
          RAISE EXCEPTION 'converact event roles have effective authority outside the exact graph (default ACL)';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM pg_class AS object,
            LATERAL aclexplode(object.relacl) AS privilege
          WHERE privilege.grantee = event_role.oid
            AND (
              object.oid <> ALL(target_table_oids) OR
              privilege.privilege_type <> 'SELECT' OR
              privilege.is_grantable
            )
        ) OR EXISTS (
          SELECT 1
          FROM pg_attribute AS attribute,
            LATERAL aclexplode(attribute.attacl) AS privilege
          WHERE privilege.grantee = event_role.oid
        ) OR EXISTS (
          SELECT 1
          FROM pg_proc AS procedure,
            LATERAL aclexplode(procedure.proacl) AS privilege
          WHERE privilege.grantee = event_role.oid
            AND procedure.oid <> ALL(wrapper_oids)
        ) OR EXISTS (
          SELECT 1 FROM pg_proc AS procedure
          WHERE procedure.prosecdef
            AND has_function_privilege(
              event_role.oid, procedure.oid, 'EXECUTE'
            )
            AND procedure.oid <> ALL(wrapper_oids)
        ) OR EXISTS (
          SELECT 1 FROM pg_class AS object
          WHERE object.relowner = event_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_proc AS procedure
          WHERE procedure.proowner = event_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_namespace AS namespace
          WHERE namespace.nspowner = event_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_type AS type
          WHERE type.typowner = event_role.oid
        ) OR EXISTS (
          SELECT 1
          FROM pg_namespace AS namespace,
            LATERAL aclexplode(namespace.nspacl) AS privilege
          WHERE privilege.grantee = event_role.oid
            AND NOT (
              namespace.nspname = 'public' AND
              privilege.privilege_type = 'USAGE' AND
              NOT privilege.is_grantable
            )
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_namespace AS namespace,
            LATERAL aclexplode(namespace.nspacl) AS privilege
          WHERE namespace.nspname = 'public'
            AND privilege.grantee = event_role.oid
            AND privilege.privilege_type = 'USAGE'
            AND NOT privilege.is_grantable
        ) OR EXISTS (
          SELECT 1
          FROM pg_database AS database,
            LATERAL aclexplode(database.datacl) AS privilege
          WHERE privilege.grantee = event_role.oid
            AND NOT (
              database.datname = current_database() AND
              privilege.privilege_type = 'CONNECT' AND
              NOT privilege.is_grantable
            )
        ) OR EXISTS (
          SELECT 1 FROM pg_database AS database
          WHERE database.datdba = event_role.oid
        ) OR EXISTS (
          SELECT 1
          FROM pg_tablespace AS tablespace,
            LATERAL aclexplode(tablespace.spcacl) AS privilege
          WHERE privilege.grantee = event_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_tablespace AS tablespace
          WHERE tablespace.spcowner = event_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_default_acl AS defaults
          WHERE defaults.defaclrole = event_role.oid
        ) OR EXISTS (
          SELECT 1
          FROM pg_default_acl AS defaults,
            LATERAL aclexplode(defaults.defaclacl) AS privilege
          WHERE privilege.grantee = event_role.oid
        ) THEN
          RAISE EXCEPTION 'converact event runtime has authority outside the exact graph';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM pg_class AS object,
            LATERAL aclexplode(object.relacl) AS privilege
          WHERE privilege.grantee = owner_role.oid
            AND (
              object.oid <> ALL(target_table_oids) OR
              privilege.is_grantable OR
              CASE
                WHEN object.relname = 'converact_platform_outbox'
                THEN privilege.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE')
                ELSE privilege.privilege_type NOT IN ('SELECT', 'INSERT')
              END
            )
        ) OR EXISTS (
          SELECT 1
          FROM pg_attribute AS attribute,
            LATERAL aclexplode(attribute.attacl) AS privilege
          WHERE privilege.grantee = owner_role.oid
        ) OR EXISTS (
          SELECT 1
          FROM pg_proc AS procedure,
            LATERAL aclexplode(procedure.proacl) AS privilege
          WHERE privilege.grantee = owner_role.oid
            AND procedure.oid <> ALL(allowed_function_oids)
        ) OR EXISTS (
          SELECT 1 FROM pg_proc AS procedure
          WHERE procedure.prosecdef
            AND has_function_privilege(
              owner_role.oid, procedure.oid, 'EXECUTE'
            )
            AND procedure.oid <> ALL(allowed_function_oids)
        ) OR EXISTS (
          SELECT 1 FROM pg_class AS object
          WHERE object.relowner = owner_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_proc AS procedure
          WHERE procedure.proowner = owner_role.oid
            AND procedure.oid <> ALL(wrapper_oids)
        ) OR EXISTS (
          SELECT 1 FROM pg_namespace AS namespace
          WHERE namespace.nspowner = owner_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_type AS type
          WHERE type.typowner = owner_role.oid
        ) OR EXISTS (
          SELECT 1
          FROM pg_namespace AS namespace,
            LATERAL aclexplode(namespace.nspacl) AS privilege
          WHERE privilege.grantee = owner_role.oid
            AND NOT (
              namespace.nspname = 'public' AND
              privilege.privilege_type = 'USAGE' AND
              NOT privilege.is_grantable
            )
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_namespace AS namespace,
            LATERAL aclexplode(namespace.nspacl) AS privilege
          WHERE namespace.nspname = 'public'
            AND privilege.grantee = owner_role.oid
            AND privilege.privilege_type = 'USAGE'
            AND NOT privilege.is_grantable
        ) OR EXISTS (
          SELECT 1
          FROM pg_database AS database,
            LATERAL aclexplode(database.datacl) AS privilege
          WHERE privilege.grantee = owner_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_database AS database
          WHERE database.datdba = owner_role.oid
        ) OR EXISTS (
          SELECT 1
          FROM pg_tablespace AS tablespace,
            LATERAL aclexplode(tablespace.spcacl) AS privilege
          WHERE privilege.grantee = owner_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_tablespace AS tablespace
          WHERE tablespace.spcowner = owner_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_default_acl AS defaults
          WHERE defaults.defaclrole = owner_role.oid
        ) OR EXISTS (
          SELECT 1
          FROM pg_default_acl AS defaults,
            LATERAL aclexplode(defaults.defaclacl) AS privilege
          WHERE privilege.grantee = owner_role.oid
        ) THEN
          RAISE EXCEPTION 'converact event owner has authority outside the exact graph';
        END IF;

        IF has_schema_privilege(
          'converact_event_runtime', 'public', 'CREATE'
        ) OR has_schema_privilege(
          'converact_event_store_owner', 'public', 'CREATE'
        ) OR has_function_privilege(
          'converact_event_runtime',
          'public.converact_authority_writer_fence(text,text,text,numeric,numeric,text,text,numeric)',
          'EXECUTE'
        ) OR has_function_privilege(
          'converact_event_runtime',
          'public.converact_authority_claim_generation_work(text,text,text,numeric,numeric,text,text,numeric,text,text)',
          'EXECUTE'
        ) OR has_function_privilege(
          'converact_event_runtime',
          'public.converact_authority_release_generation_work(text,text,text,numeric,numeric,text,text,text)',
          'EXECUTE'
        ) THEN
          RAISE EXCEPTION 'converact event runtime bypass privilege detected';
        END IF;
      END
      $$
    `);
    const quoted = await pg.query(
      "SELECT format('ALTER ROLE converact_event_runtime PASSWORD %L', $1::text) AS statement",
      [password]
    );
    const alterPassword = String(quoted.rows[0]?.statement || '');
    if (!alterPassword) {
      throw new Error('PostgreSQL did not quote the converact_event_runtime password');
    }
    await pg.query(alterPassword);
    await pg.query(`
      ALTER ROLE converact_event_runtime
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOINHERIT NOBYPASSRLS
    `);
    await pg.query(`
      DO $$
      BEGIN
        EXECUTE format(
          'GRANT CONNECT ON DATABASE %I TO converact_event_runtime',
          current_database()
        );
      END
      $$
    `);
    await pg.query('GRANT USAGE ON SCHEMA public TO converact_event_runtime');
    await pg.query('REVOKE CREATE ON SCHEMA public FROM converact_event_runtime');
    await pg.query('COMMIT');
  } catch (error) {
    await pg.query('ROLLBACK');
    throw error;
  }
}
