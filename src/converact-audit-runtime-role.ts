import type { ConveractFabricRuntimeRoleQueryable } from './converact-runtime-role.js';

async function requireOpcAdmin(pg: ConveractFabricRuntimeRoleQueryable): Promise<void> {
  const identity = await pg.query('SELECT current_user AS current_user');
  if (String(identity.rows[0]?.current_user || '') !== 'opc_admin') {
    throw new Error('Converact Audit runtime-role activation must run as opc_admin');
  }
}

/**
 * Enables the isolated Rust Audit database login only after the exact
 * migration-owned graph has been validated. This does not wire a pool, start a
 * process or change the active Audit Authority route.
 */
export async function activateConveractAuditRuntimeRole(
  pg: ConveractFabricRuntimeRoleQueryable,
  password: string
): Promise<void> {
  if (!password) throw new Error('CONVERACT_AUDIT_RUNTIME_DB_PASSWORD is required');
  await requireOpcAdmin(pg);

  await pg.query('BEGIN');
  try {
    await pg.query(`
      DO $audit_activation_graph$
      DECLARE
        runtime_role pg_roles%ROWTYPE;
        owner_role pg_roles%ROWTYPE;
        admin_oid OID;
        legacy_oid OID;
        database_oid OID;
        database_owner_oid OID;
        predefined_database_owner_oid OID;
        schema_oid OID;
        event_oid OID;
        head_oid OID;
        guard_oid OID;
        immutable_guard_oid OID;
        wrapper_signature TEXT;
        wrapper_oid REGPROCEDURE;
        wrapper_oids OID[] := ARRAY[]::OID[];
        authority_fence_oid OID;
        allowed_owner_function_oids OID[];
        relation_oid OID;
        table_state pg_class%ROWTYPE;
        normalized_using TEXT;
        normalized_check TEXT;
        parameter_acl_exposed BOOLEAN := FALSE;
      BEGIN
        SELECT * INTO runtime_role FROM pg_roles
        WHERE rolname = 'converact_audit_runtime';
        SELECT * INTO owner_role FROM pg_roles
        WHERE rolname = 'converact_audit_store_owner';
        SELECT oid INTO admin_oid FROM pg_roles WHERE rolname = 'opc_admin';
        SELECT oid INTO legacy_oid FROM pg_roles WHERE rolname = 'opc_runtime';
        SELECT oid INTO database_oid FROM pg_database
        WHERE datname = current_database();
        SELECT datdba INTO database_owner_oid FROM pg_database
        WHERE datname = current_database();
        predefined_database_owner_oid := to_regrole('pg_database_owner')::OID;
        SELECT oid INTO schema_oid FROM pg_namespace WHERE nspname = 'public';
        event_oid := to_regclass('public.ivekit_audit_events')::OID;
        head_oid := to_regclass('public.converact_audit_chain_heads')::OID;
        guard_oid := to_regprocedure(
          'public.converact_audit_legacy_writer_guard()'
        )::OID;
        immutable_guard_oid := to_regprocedure(
          'public.opc_ivekit_audit_immutable_guard()'
        )::OID;

        IF admin_oid IS NULL OR legacy_oid IS NULL OR database_oid IS NULL OR
           schema_oid IS NULL OR event_oid IS NULL OR head_oid IS NULL OR
           guard_oid IS NULL OR immutable_guard_oid IS NULL
        THEN
          RAISE EXCEPTION 'audit activation principals or relations are missing';
        END IF;
        IF runtime_role.rolname IS NULL OR runtime_role.rolsuper OR
           runtime_role.rolcreatedb OR runtime_role.rolcreaterole OR
           runtime_role.rolreplication OR runtime_role.rolinherit OR
           runtime_role.rolbypassrls OR
           coalesce(cardinality(runtime_role.rolconfig), 0) <> 0
        THEN
          RAISE EXCEPTION 'audit runtime role shape is invalid';
        END IF;
        IF owner_role.rolname IS NULL OR owner_role.rolcanlogin OR
           owner_role.rolsuper OR owner_role.rolcreatedb OR
           owner_role.rolcreaterole OR owner_role.rolreplication OR
           owner_role.rolinherit OR owner_role.rolbypassrls
           OR coalesce(cardinality(owner_role.rolconfig), 0) <> 0
        THEN
          RAISE EXCEPTION 'audit store owner role shape is invalid';
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_auth_members
          WHERE member IN (runtime_role.oid, owner_role.oid)
             OR roleid IN (runtime_role.oid, owner_role.oid)
        ) THEN
          RAISE EXCEPTION 'audit roles must have no memberships in either direction';
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_db_role_setting
          WHERE setrole IN (runtime_role.oid, owner_role.oid)
             OR (setrole = 0 AND setdatabase IN (0, database_oid))
        ) THEN
          RAISE EXCEPTION 'audit roles must have no persistent database settings';
        END IF;
        IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' OR
           (
             SELECT setting.reset_val
             FROM pg_settings AS setting
             WHERE setting.name = 'session_replication_role'
           ) IS DISTINCT FROM 'origin'
        THEN
          RAISE EXCEPTION 'audit session replication role is invalid';
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
            RAISE EXCEPTION 'audit roles have parameter authority outside the graph';
          END IF;
        END IF;

        IF NOT EXISTS (
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
          RAISE EXCEPTION 'audit legacy guard graph is invalid';
        END IF;

        IF NOT EXISTS (
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
          RAISE EXCEPTION 'audit target trigger or rule graph is invalid';
        END IF;

        FOREACH wrapper_signature IN ARRAY ARRAY[
          'public.converact_audit_writer_fence(text,text,text,numeric,numeric,text,text,numeric)',
          'public.converact_audit_chain_head(text,text,text,numeric,numeric,text,text,numeric)',
          'public.converact_audit_event_append(text,text,text,numeric,numeric,text,text,numeric,text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb,timestamp with time zone,timestamp with time zone,boolean,text,text)'
        ] LOOP
          wrapper_oid := to_regprocedure(wrapper_signature);
          wrapper_oids := array_append(wrapper_oids, wrapper_oid::OID);
          IF wrapper_oid IS NULL OR NOT EXISTS (
            SELECT 1 FROM pg_proc AS procedure
            WHERE procedure.oid = wrapper_oid
              AND procedure.proowner = owner_role.oid
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
              AND privilege.grantee = runtime_role.oid
              AND privilege.grantor = owner_role.oid
              AND privilege.privilege_type = 'EXECUTE'
              AND NOT privilege.is_grantable
          ) OR EXISTS (
            SELECT 1
            FROM pg_proc AS procedure,
              LATERAL aclexplode(
                coalesce(procedure.proacl, acldefault('f', procedure.proowner))
              ) AS privilege
            WHERE procedure.oid = wrapper_oid
              AND NOT (
                privilege.grantee = owner_role.oid AND
                privilege.privilege_type = 'EXECUTE'
              )
              AND NOT (
                privilege.grantee = runtime_role.oid AND
                privilege.grantor = owner_role.oid AND
                privilege.privilege_type = 'EXECUTE' AND
                NOT privilege.is_grantable
              )
          ) THEN
            RAISE EXCEPTION 'audit wrapper privilege graph is invalid';
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
            AND privilege.grantee = owner_role.oid
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
            AND privilege.grantee = owner_role.oid
            AND (
              privilege.grantor <> procedure.proowner OR
              privilege.privilege_type <> 'EXECUTE' OR
              privilege.is_grantable
            )
        ) THEN
          RAISE EXCEPTION 'audit owner authority function graph is invalid';
        END IF;
        allowed_owner_function_oids := wrapper_oids || ARRAY[authority_fence_oid];

        FOREACH relation_oid IN ARRAY ARRAY[event_oid, head_oid] LOOP
          SELECT * INTO table_state FROM pg_class WHERE oid = relation_oid;
          IF table_state.relowner <> admin_oid THEN
            RAISE EXCEPTION 'audit target relation owner is invalid';
          END IF;
          IF NOT table_state.relrowsecurity OR NOT table_state.relforcerowsecurity OR
             (
               SELECT count(*) FROM pg_policy AS policy
               WHERE policy.polrelid = relation_oid
             ) <> 1
          THEN
            RAISE EXCEPTION 'audit target RLS graph is invalid';
          END IF;
          SELECT
            regexp_replace(
              pg_get_expr(policy.polqual, policy.polrelid), '\\s', '', 'g'
            ),
            regexp_replace(
              pg_get_expr(policy.polwithcheck, policy.polrelid), '\\s', '', 'g'
            )
          INTO normalized_using, normalized_check
          FROM pg_policy AS policy
          WHERE policy.polrelid = relation_oid
            AND policy.polname = 'tenant_isolation'
            AND policy.polcmd = '*'
            AND policy.polpermissive
            AND policy.polroles = ARRAY[0]::OID[];
          IF normalized_using IS DISTINCT FROM
               '(opc_rls_bypass()OR(tenant_id=opc_current_tenant()))' OR
             normalized_check IS DISTINCT FROM
               '(opc_rls_bypass()OR(tenant_id=opc_current_tenant()))'
          THEN
            RAISE EXCEPTION 'audit tenant policy is invalid';
          END IF;
        END LOOP;

        IF NOT has_table_privilege(runtime_role.oid, event_oid, 'SELECT') OR
           has_table_privilege(
             runtime_role.oid, event_oid,
             'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           ) OR has_table_privilege(
             runtime_role.oid, head_oid,
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           )
        THEN
          RAISE EXCEPTION 'audit runtime table privilege graph is invalid';
        END IF;
        IF NOT has_table_privilege(
             owner_role.oid, event_oid, 'SELECT,INSERT'
           ) OR has_table_privilege(
             owner_role.oid, event_oid,
             'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           ) OR NOT has_table_privilege(
             owner_role.oid, head_oid, 'SELECT,INSERT,UPDATE'
           ) OR has_table_privilege(
             owner_role.oid, head_oid, 'DELETE,TRUNCATE,REFERENCES,TRIGGER'
           )
        THEN
          RAISE EXCEPTION 'audit owner table privilege graph is invalid';
        END IF;
        IF NOT has_table_privilege(legacy_oid, event_oid, 'SELECT,INSERT') OR
           has_table_privilege(
             legacy_oid, event_oid,
             'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           ) OR has_table_privilege(
             legacy_oid, head_oid,
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           )
        THEN
          RAISE EXCEPTION 'legacy audit table privilege graph is invalid';
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
              privilege.grantee = runtime_role.oid AND
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
              privilege.grantee = owner_role.oid AND
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
          RAISE EXCEPTION 'audit target relation ACL graph is invalid';
        END IF;

        IF has_function_privilege(
          runtime_role.oid,
          'public.converact_authority_writer_fence(text,text,text,numeric,numeric,text,text,numeric)',
          'EXECUTE'
        ) OR has_function_privilege(
          runtime_role.oid,
          'public.converact_audit_legacy_writer_allowed(text)',
          'EXECUTE'
        ) OR NOT has_function_privilege(
          legacy_oid,
          'public.converact_audit_legacy_writer_allowed(text)',
          'EXECUTE'
        )
        THEN
          RAISE EXCEPTION 'audit function bypass privilege detected';
        END IF;

        IF EXISTS (
          SELECT 1 FROM pg_proc AS procedure
          WHERE procedure.prosecdef
            AND has_function_privilege(
              runtime_role.oid, procedure.oid, 'EXECUTE'
            )
            AND procedure.oid <> ALL(wrapper_oids)
        ) OR EXISTS (
          SELECT 1 FROM pg_proc AS procedure
          WHERE procedure.prosecdef
            AND has_function_privilege(owner_role.oid, procedure.oid, 'EXECUTE')
            AND procedure.oid <> ALL(allowed_owner_function_oids)
        ) THEN
          RAISE EXCEPTION 'audit roles can execute an unreviewed definer';
        END IF;

        IF EXISTS (
          SELECT 1 FROM pg_class AS object
          JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
          WHERE namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
            AND object.oid NOT IN (event_oid, head_oid)
            AND object.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND (
              has_table_privilege(
                runtime_role.oid, object.oid,
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
              ) OR has_table_privilege(
                owner_role.oid, object.oid,
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
              ) OR has_any_column_privilege(
                runtime_role.oid, object.oid,
                'SELECT,INSERT,UPDATE,REFERENCES'
              ) OR has_any_column_privilege(
                owner_role.oid, object.oid,
                'SELECT,INSERT,UPDATE,REFERENCES'
              )
            )
        ) THEN
          RAISE EXCEPTION 'audit roles have authority outside target relations';
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_class AS object
          JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
          WHERE namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
            AND object.relkind = 'S'
            AND (
              has_sequence_privilege(
                runtime_role.oid, object.oid, 'USAGE,SELECT,UPDATE'
              ) OR has_sequence_privilege(
                owner_role.oid, object.oid, 'USAGE,SELECT,UPDATE'
              )
            )
        ) THEN
          RAISE EXCEPTION 'audit roles have sequence authority';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM pg_largeobject_metadata AS object,
            LATERAL aclexplode(
              coalesce(object.lomacl, acldefault('L', object.lomowner))
            ) AS privilege
          WHERE privilege.grantee IN (0, runtime_role.oid, owner_role.oid)
            AND privilege.privilege_type IN ('SELECT', 'UPDATE')
        ) THEN
          RAISE EXCEPTION 'audit roles have large-object authority';
        END IF;

        IF (
          SELECT count(*)
          FROM pg_default_acl AS defaults,
            LATERAL aclexplode(defaults.defaclacl) AS privilege
          WHERE defaults.defaclrole = admin_oid
            AND defaults.defaclnamespace = 0
            AND defaults.defaclobjtype = 'f'
            AND privilege.grantee = admin_oid
            AND privilege.grantor = admin_oid
            AND privilege.privilege_type = 'EXECUTE'
            AND NOT privilege.is_grantable
        ) <> 1 OR EXISTS (
          SELECT 1
          FROM pg_default_acl AS defaults,
            LATERAL aclexplode(defaults.defaclacl) AS privilege
          WHERE defaults.defaclrole = admin_oid
            AND defaults.defaclobjtype IN ('r', 'S', 'f', 'n')
            AND (
              defaults.defaclobjtype IN ('r', 'S') AND
              defaults.defaclnamespace IN (0, schema_oid) AND
              privilege.grantee = 0 OR
              defaults.defaclobjtype = 'n' AND
              defaults.defaclnamespace = 0 AND
              privilege.grantee = 0 OR
              defaults.defaclobjtype = 'f' AND
              defaults.defaclnamespace IN (0, schema_oid) AND (
                defaults.defaclnamespace <> 0 OR NOT (
                  privilege.grantee = admin_oid AND
                  privilege.grantor = admin_oid AND
                  privilege.privilege_type = 'EXECUTE' AND
                  NOT privilege.is_grantable
                )
              )
            )
        ) THEN
          RAISE EXCEPTION 'audit roles have default ACL authority outside the graph';
        END IF;

        IF has_database_privilege(
          runtime_role.oid, database_oid, 'CREATE,TEMPORARY'
        ) OR EXISTS (
          SELECT 1 FROM pg_database AS database
          WHERE database.oid <> database_oid
            AND database.datallowconn
            AND has_database_privilege(
              runtime_role.oid, database.oid, 'CONNECT'
            )
        ) OR has_database_privilege(
          owner_role.oid, database_oid, 'CONNECT,CREATE,TEMPORARY'
        ) THEN
          RAISE EXCEPTION 'audit roles have database authority outside the graph';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM pg_database AS database,
            LATERAL aclexplode(database.datacl) AS privilege
          WHERE privilege.grantee = runtime_role.oid
            AND NOT (
              database.oid = database_oid AND
              privilege.grantor = database.datdba AND
              privilege.privilege_type = 'CONNECT' AND
              NOT privilege.is_grantable
            )
        ) OR EXISTS (
          SELECT 1
          FROM pg_database AS database,
            LATERAL aclexplode(database.datacl) AS privilege
          WHERE privilege.grantee = owner_role.oid
        ) THEN
          RAISE EXCEPTION 'audit role database ACL graph is invalid';
        END IF;
        IF has_schema_privilege(runtime_role.oid, schema_oid, 'CREATE') OR
           NOT has_schema_privilege(runtime_role.oid, schema_oid, 'USAGE') OR
           has_schema_privilege(owner_role.oid, schema_oid, 'CREATE') OR
           NOT has_schema_privilege(owner_role.oid, schema_oid, 'USAGE') OR
           EXISTS (
             SELECT 1 FROM pg_namespace AS namespace
             WHERE namespace.oid <> schema_oid
               AND namespace.nspname <> 'information_schema'
               AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
               AND (
                 has_schema_privilege(
                   runtime_role.oid, namespace.oid, 'USAGE,CREATE'
                 ) OR has_schema_privilege(
                   owner_role.oid, namespace.oid, 'USAGE,CREATE'
                 )
               )
           )
        THEN
          RAISE EXCEPTION 'audit roles have schema authority outside the graph';
        END IF;
        IF database_owner_oid <> admin_oid OR NOT EXISTS (
          SELECT 1 FROM pg_namespace AS namespace
          WHERE namespace.oid = schema_oid
            AND namespace.nspowner IN (admin_oid, predefined_database_owner_oid)
        ) OR EXISTS (
          SELECT 1
          FROM pg_namespace AS namespace,
            LATERAL aclexplode(
              coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
          ) AS privilege
          WHERE namespace.oid = schema_oid
            AND privilege.privilege_type = 'CREATE'
            AND privilege.grantee <> namespace.nspowner
        ) THEN
          RAISE EXCEPTION 'audit public schema create authority is invalid';
        END IF;
        IF (
          SELECT count(*)
          FROM pg_namespace AS namespace,
            LATERAL aclexplode(namespace.nspacl) AS privilege
          WHERE namespace.oid = schema_oid
            AND privilege.grantee = runtime_role.oid
            AND privilege.grantor = namespace.nspowner
            AND privilege.privilege_type = 'USAGE'
            AND NOT privilege.is_grantable
        ) <> 1 OR (
          SELECT count(*)
          FROM pg_namespace AS namespace,
            LATERAL aclexplode(namespace.nspacl) AS privilege
          WHERE namespace.oid = schema_oid
            AND privilege.grantee = owner_role.oid
            AND privilege.grantor = namespace.nspowner
            AND privilege.privilege_type = 'USAGE'
            AND NOT privilege.is_grantable
        ) <> 1 OR EXISTS (
          SELECT 1
          FROM pg_namespace AS namespace,
            LATERAL aclexplode(namespace.nspacl) AS privilege
          WHERE privilege.grantee IN (runtime_role.oid, owner_role.oid)
            AND NOT (
              namespace.oid = schema_oid AND
              privilege.grantor = namespace.nspowner AND
              privilege.privilege_type = 'USAGE' AND
              NOT privilege.is_grantable
            )
        ) THEN
          RAISE EXCEPTION 'audit role schema ACL graph is invalid';
        END IF;

        IF EXISTS (
          SELECT 1 FROM pg_shdepend AS dependency
          WHERE dependency.refclassid = 'pg_authid'::REGCLASS
            AND dependency.refobjid = runtime_role.oid
            AND NOT (
              dependency.dbid = database_oid AND
              dependency.deptype = 'a' AND
              dependency.objsubid = 0 AND (
                dependency.classid = 'pg_class'::REGCLASS AND
                dependency.objid = event_oid OR
                dependency.classid = 'pg_proc'::REGCLASS AND
                dependency.objid = ANY(wrapper_oids) OR
                dependency.classid = 'pg_namespace'::REGCLASS AND
                dependency.objid = schema_oid
              ) OR dependency.dbid = 0 AND
                 dependency.classid = 'pg_database'::REGCLASS AND
                 dependency.objid = database_oid AND
                 dependency.objsubid = 0 AND dependency.deptype = 'a'
            )
        ) THEN
          RAISE EXCEPTION 'audit runtime has catalog authority outside the graph';
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_shdepend AS dependency
          WHERE dependency.refclassid = 'pg_authid'::REGCLASS
            AND dependency.refobjid = owner_role.oid
            AND NOT (
              dependency.dbid = database_oid AND
              dependency.objsubid = 0 AND (
                dependency.deptype = 'a' AND
                dependency.classid = 'pg_class'::REGCLASS AND
                dependency.objid IN (event_oid, head_oid) OR
                dependency.deptype = 'a' AND
                dependency.classid = 'pg_proc'::REGCLASS AND
                dependency.objid = ANY(allowed_owner_function_oids) OR
                dependency.deptype = 'o' AND
                dependency.classid = 'pg_proc'::REGCLASS AND
                dependency.objid = ANY(wrapper_oids) OR
                dependency.deptype = 'a' AND
                dependency.classid = 'pg_namespace'::REGCLASS AND
                dependency.objid = schema_oid
              )
            )
        ) THEN
          RAISE EXCEPTION 'audit owner has catalog authority outside the graph';
        END IF;

        IF EXISTS (
          SELECT 1 FROM pg_class WHERE relowner = runtime_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_proc WHERE proowner = runtime_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_namespace WHERE nspowner = runtime_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_type WHERE typowner = runtime_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_class WHERE relowner = owner_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_proc
          WHERE proowner = owner_role.oid AND oid <> ALL(wrapper_oids)
        ) OR EXISTS (
          SELECT 1 FROM pg_namespace WHERE nspowner = owner_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_type WHERE typowner = owner_role.oid
        ) OR EXISTS (
          SELECT 1 FROM pg_default_acl
          WHERE defaclrole IN (runtime_role.oid, owner_role.oid)
        ) OR EXISTS (
          SELECT 1 FROM pg_default_acl AS defaults,
            LATERAL aclexplode(defaults.defaclacl) AS privilege
          WHERE privilege.grantee IN (runtime_role.oid, owner_role.oid)
        ) OR EXISTS (
          SELECT 1 FROM pg_tablespace AS tablespace
          WHERE tablespace.spcowner IN (runtime_role.oid, owner_role.oid)
        ) OR EXISTS (
          SELECT 1 FROM pg_tablespace AS tablespace,
            LATERAL aclexplode(tablespace.spcacl) AS privilege
          WHERE privilege.grantee IN (runtime_role.oid, owner_role.oid)
        ) THEN
          RAISE EXCEPTION 'audit roles own authority outside the exact graph';
        END IF;
      END
      $audit_activation_graph$
    `);

    const quoted = await pg.query(
      "SELECT format('ALTER ROLE converact_audit_runtime PASSWORD %L', $1::text) AS statement",
      [password]
    );
    const alterPassword = String(quoted.rows[0]?.statement || '');
    if (!alterPassword) {
      throw new Error('PostgreSQL did not quote the converact_audit_runtime password');
    }
    await pg.query(alterPassword);
    await pg.query(`
      ALTER ROLE converact_audit_runtime
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOINHERIT NOBYPASSRLS
    `);
    await pg.query(`
      DO $$
      BEGIN
        EXECUTE format(
          'GRANT CONNECT ON DATABASE %I TO converact_audit_runtime',
          current_database()
        );
      END
      $$
    `);
    await pg.query('GRANT USAGE ON SCHEMA public TO converact_audit_runtime');
    await pg.query('REVOKE CREATE ON SCHEMA public FROM converact_audit_runtime');
    await pg.query('COMMIT');
  } catch (error) {
    await pg.query('ROLLBACK');
    throw error;
  }
}
