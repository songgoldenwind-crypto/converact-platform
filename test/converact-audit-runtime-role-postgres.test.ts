import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import { buildConveractFabricStandaloneContext } from '../scripts/converact-standalone-build-context.js';
import { activateConveractAuditRuntimeRole } from '../src/converact-audit-runtime-role.js';
import { applyConveractFabricMigrations } from '../src/converact-migrations.js';
import { initializeConveractFabricRuntimeRole } from '../src/converact-runtime-role.js';

const freshAdminUrl = process.env.CONVERACT_AUDIT_ROLE_FRESH_TEST_DATABASE_URL || '';
const upgradeAdminUrl = process.env.CONVERACT_AUDIT_ROLE_UPGRADE_TEST_DATABASE_URL || '';
const runtimePassword = process.env.CONVERACT_AUDIT_ROLE_TEST_RUNTIME_PASSWORD || '';
const physicalTest = freshAdminUrl && upgradeAdminUrl && runtimePassword ? test : test.skip;

function migrationCorpus(): {
  fullDirectory: string;
  through122Directory: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'converact-audit-role-postgres-'));
  const outputDirectory = join(root, 'context');
  buildConveractFabricStandaloneContext({
    repoRoot: resolve('.'),
    outputDir: outputDirectory,
    sourceCommit: 'a'.repeat(40),
    generatedAt: '2026-08-22T00:00:00.000Z'
  });
  const fullDirectory = join(outputDirectory, 'migrations');
  const through122Directory = join(root, 'through-122');
  mkdirSync(through122Directory);
  for (const file of readdirSync(fullDirectory)) {
    if (!file.endsWith('.sql') || file === '123_converact_audit_runtime_roles.sql') continue;
    copyFileSync(join(fullDirectory, file), join(through122Directory, file));
  }
  return {
    fullDirectory,
    through122Directory,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

physicalTest('Audit role graph is fresh-install, upgrade and adversarially closed', async () => {
  const migrations = migrationCorpus();
  const fresh = new Pool({ connectionString: freshAdminUrl, max: 1 });
  const upgrade = new Pool({ connectionString: upgradeAdminUrl, max: 1 });
  let runtime: Pool | undefined;
  try {
    const freshSystem = await fresh.query<{ system_identifier: string }>(`
      SELECT system_identifier::text AS system_identifier
      FROM pg_control_system()
    `);
    const upgradeSystem = await upgrade.query<{ system_identifier: string }>(`
      SELECT system_identifier::text AS system_identifier
      FROM pg_control_system()
    `);
    assert.notEqual(
      freshSystem.rows[0]?.system_identifier,
      upgradeSystem.rows[0]?.system_identifier,
      'fresh and upgrade evidence require distinct PostgreSQL clusters because roles are cluster-global'
    );

    for (const pg of [fresh, upgrade]) {
      await pg.query(`
        DO $$
        DECLARE
          database_name TEXT;
        BEGIN
          FOR database_name IN
            SELECT datname FROM pg_database
            WHERE datname <> current_database() AND datallowconn
          LOOP
            EXECUTE format(
              'REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC',
              database_name
            );
          END LOOP;
        END
        $$
      `);
    }

    await fresh.query(`
      DO $$
      BEGIN
        IF to_regrole('pg_database_owner') IS NOT NULL THEN
          EXECUTE 'ALTER SCHEMA public OWNER TO pg_database_owner';
        END IF;
      END
      $$
    `);
    await initializeConveractFabricRuntimeRole(fresh, runtimePassword);
    await initializeConveractFabricRuntimeRole(upgrade, runtimePassword);

    await applyConveractFabricMigrations(fresh, {
      directory: migrations.fullDirectory,
      advisoryLockName: 'converact_audit_role_fresh'
    });
    await applyConveractFabricMigrations(fresh, {
      directory: migrations.fullDirectory,
      advisoryLockName: 'converact_audit_role_fresh'
    });

    await applyConveractFabricMigrations(upgrade, {
      directory: migrations.through122Directory,
      advisoryLockName: 'converact_audit_role_upgrade'
    });
    await assertWrapperOwner(upgrade, 'opc_admin');
    await applyConveractFabricMigrations(upgrade, {
      directory: migrations.fullDirectory,
      advisoryLockName: 'converact_audit_role_upgrade'
    });

    await assertRuntimeLogin(fresh, false);
    await assertRuntimeLogin(upgrade, false);
    await assertWrapperOwner(fresh, 'converact_audit_store_owner');
    await assertWrapperOwner(upgrade, 'converact_audit_store_owner');

    const serverVersion = await fresh.query<{ server_version_num: string }>(`
      SELECT current_setting('server_version_num') AS server_version_num
    `);
    if (Number(serverVersion.rows[0]?.server_version_num) >= 150000) {
      await fresh.query(`GRANT SET ON PARAMETER session_replication_role TO PUBLIC`);
      await assertActivationRejected(fresh, /parameter authority outside the graph/i);
      await fresh.query(`REVOKE SET ON PARAMETER session_replication_role FROM PUBLIC`);
    }

    for (const role of ['converact_audit_runtime', 'converact_audit_store_owner']) {
      await fresh.query(`ALTER ROLE ${role} SET app.bypass_rls = 'on'`);
      await assertActivationRejected(fresh, /audit .* role shape is invalid/i);
      await fresh.query(`ALTER ROLE ${role} RESET app.bypass_rls`);
    }
    await fresh.query(`
      DO $$
      BEGIN
        EXECUTE format(
          'ALTER ROLE converact_audit_runtime IN DATABASE %I SET app.bypass_rls = %L',
          current_database(),
          'on'
        );
      END
      $$
    `);
    await assertActivationRejected(fresh, /no persistent database settings/i);
    await fresh.query(`
      DO $$
      BEGIN
        EXECUTE format(
          'ALTER ROLE converact_audit_runtime IN DATABASE %I RESET app.bypass_rls',
          current_database()
        );
      END
      $$
    `);
    await fresh.query(`
      DO $$
      BEGIN
        EXECUTE format(
          'ALTER DATABASE %I SET app.current_tenant = %L',
          current_database(),
          'ambient-tenant'
        );
      END
      $$
    `);
    await assertActivationRejected(fresh, /no persistent database settings/i);
    await fresh.query(`
      DO $$
      BEGIN
        EXECUTE format(
          'ALTER DATABASE %I RESET app.current_tenant',
          current_database()
        );
      END
      $$
    `);

    await fresh.query(`
      CREATE POLICY audit_role_extra_policy
      ON converact_audit_chain_heads FOR SELECT USING (true)
    `);
    await assertActivationRejected(fresh, /audit target RLS graph is invalid/i);
    await fresh.query(`DROP POLICY audit_role_extra_policy ON converact_audit_chain_heads`);

    for (const defaultAcl of [
      {
        grant: 'GRANT EXECUTE ON FUNCTIONS TO PUBLIC',
        revoke: 'REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC'
      },
      {
        grant: 'GRANT SELECT ON TABLES TO PUBLIC',
        revoke: 'REVOKE SELECT ON TABLES FROM PUBLIC'
      },
      {
        grant: 'GRANT USAGE ON SEQUENCES TO PUBLIC',
        revoke: 'REVOKE USAGE ON SEQUENCES FROM PUBLIC'
      },
      {
        grant: 'GRANT CREATE ON SCHEMAS TO PUBLIC',
        revoke: 'REVOKE CREATE ON SCHEMAS FROM PUBLIC'
      }
    ]) {
      await fresh.query(`ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin ${defaultAcl.grant}`);
      await assertActivationRejected(fresh, /default ACL authority outside the graph/i);
      await fresh.query(`ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin ${defaultAcl.revoke}`);
    }
    await fresh.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO PUBLIC
    `);
    await assertActivationRejected(fresh, /default ACL authority outside the graph/i);
    await fresh.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin IN SCHEMA public
      REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC
    `);

    await fresh.query(`
      GRANT EXECUTE ON FUNCTION converact_authority_writer_fence(
        TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
      ) TO converact_audit_runtime
    `);
    await assertActivationRejected(fresh, /audit function bypass privilege detected/i);
    await fresh.query(`
      REVOKE EXECUTE ON FUNCTION converact_authority_writer_fence(
        TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
      ) FROM converact_audit_runtime
    `);

    await fresh.query(`GRANT SELECT ON converact_audit_chain_heads TO converact_audit_runtime`);
    await assertActivationRejected(fresh, /audit runtime table privilege graph is invalid/i);
    await fresh.query(`REVOKE SELECT ON converact_audit_chain_heads FROM converact_audit_runtime`);

    await fresh.query(`GRANT SELECT ON tenants TO converact_audit_runtime`);
    await assertActivationRejected(fresh, /authority outside target relations/i);
    await fresh.query(`REVOKE SELECT ON tenants FROM converact_audit_runtime`);

    await fresh.query(`CREATE ROLE converact_audit_role_probe NOLOGIN`);
    await fresh.query(`GRANT converact_audit_runtime TO converact_audit_role_probe`);
    await assertActivationRejected(fresh, /no memberships in either direction/i);
    await fresh.query(`REVOKE converact_audit_runtime FROM converact_audit_role_probe`);
    await fresh.query(`
      GRANT EXECUTE ON FUNCTION converact_audit_writer_fence(
        TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
      ) TO converact_audit_role_probe
    `);
    await assertActivationRejected(fresh, /audit wrapper privilege graph is invalid/i);
    await fresh.query(`
      REVOKE EXECUTE ON FUNCTION converact_audit_writer_fence(
        TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
      ) FROM converact_audit_role_probe
    `);
    await fresh.query(`
      GRANT EXECUTE ON FUNCTION converact_audit_legacy_writer_guard()
      TO converact_audit_role_probe
    `);
    await assertActivationRejected(fresh, /audit legacy guard graph is invalid/i);
    await fresh.query(`
      REVOKE EXECUTE ON FUNCTION converact_audit_legacy_writer_guard()
      FROM converact_audit_role_probe
    `);

    await fresh.query(`GRANT SELECT ON ivekit_audit_events TO converact_audit_role_probe WITH GRANT OPTION`);
    await fresh.query(`SET ROLE converact_audit_role_probe`);
    await fresh.query(`GRANT SELECT ON ivekit_audit_events TO converact_audit_runtime`);
    await fresh.query(`RESET ROLE`);
    await assertActivationRejected(fresh, /audit target relation ACL graph is invalid/i);
    await fresh.query(`SET ROLE converact_audit_role_probe`);
    await fresh.query(`REVOKE SELECT ON ivekit_audit_events FROM converact_audit_runtime`);
    await fresh.query(`RESET ROLE`);
    await fresh.query(`REVOKE ALL ON ivekit_audit_events FROM converact_audit_role_probe`);

    await fresh.query(`GRANT USAGE ON SCHEMA public TO converact_audit_role_probe WITH GRANT OPTION`);
    await fresh.query(`SET ROLE converact_audit_role_probe`);
    await fresh.query(`GRANT USAGE ON SCHEMA public TO converact_audit_runtime`);
    await fresh.query(`RESET ROLE`);
    await assertActivationRejected(fresh, /audit role schema ACL graph is invalid/i);
    await fresh.query(`SET ROLE converact_audit_role_probe`);
    await fresh.query(`REVOKE USAGE ON SCHEMA public FROM converact_audit_runtime`);
    await fresh.query(`RESET ROLE`);
    await fresh.query(`REVOKE ALL ON SCHEMA public FROM converact_audit_role_probe`);

    const databaseAcl = await fresh.query<{
      grant_probe: string;
      grant_runtime: string;
      revoke_runtime: string;
      revoke_probe: string;
    }>(`
      SELECT
        format(
          'GRANT CONNECT ON DATABASE %I TO converact_audit_role_probe WITH GRANT OPTION',
          current_database()
        ) AS grant_probe,
        format(
          'GRANT CONNECT ON DATABASE %I TO converact_audit_runtime',
          current_database()
        ) AS grant_runtime,
        format(
          'REVOKE CONNECT ON DATABASE %I FROM converact_audit_runtime',
          current_database()
        ) AS revoke_runtime,
        format(
          'REVOKE ALL ON DATABASE %I FROM converact_audit_role_probe',
          current_database()
        ) AS revoke_probe
    `);
    const databaseStatements = databaseAcl.rows[0];
    assert.ok(databaseStatements);
    await fresh.query(databaseStatements.grant_probe);
    await fresh.query(`SET ROLE converact_audit_role_probe`);
    await fresh.query(databaseStatements.grant_runtime);
    await fresh.query(`RESET ROLE`);
    await assertActivationRejected(fresh, /audit role database ACL graph is invalid/i);
    await fresh.query(`SET ROLE converact_audit_role_probe`);
    await fresh.query(databaseStatements.revoke_runtime);
    await fresh.query(`RESET ROLE`);
    await fresh.query(databaseStatements.revoke_probe);

    await fresh.query(`ALTER TABLE ivekit_audit_events OWNER TO converact_audit_role_probe`);
    await assertActivationRejected(fresh, /audit target relation owner is invalid/i);
    await fresh.query(`ALTER TABLE ivekit_audit_events OWNER TO opc_admin`);
    await fresh.query(`GRANT CREATE ON SCHEMA public TO converact_audit_role_probe`);
    await assertActivationRejected(fresh, /audit public schema create authority is invalid/i);
    await fresh.query(`REVOKE CREATE ON SCHEMA public FROM converact_audit_role_probe`);
    await fresh.query(`GRANT CREATE ON SCHEMA public TO converact_audit_role_probe`);
    await fresh.query(`
      ALTER FUNCTION converact_authority_writer_fence(
        TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
      ) OWNER TO converact_audit_role_probe
    `);
    await fresh.query(`REVOKE CREATE ON SCHEMA public FROM converact_audit_role_probe`);
    await assertActivationRejected(fresh, /audit owner authority function graph is invalid/i);
    await fresh.query(`
      ALTER FUNCTION converact_authority_writer_fence(
        TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
      ) OWNER TO opc_admin
    `);
    await fresh.query(`
      REVOKE ALL ON FUNCTION converact_authority_writer_fence(
        TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
      ) FROM PUBLIC
    `);
    await fresh.query(`
      GRANT EXECUTE ON FUNCTION converact_authority_writer_fence(
        TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
      ) TO converact_event_store_owner, converact_audit_store_owner
    `);
    await fresh.query(`DROP ROLE converact_audit_role_probe`);

    for (const role of ['converact_audit_runtime', 'converact_audit_store_owner']) {
      await fresh.query(`REVOKE USAGE ON SCHEMA public FROM ${role}`);
      await assertActivationRejected(fresh, /audit role schema ACL graph is invalid/i);
      await fresh.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    }

    await fresh.query(`
      ALTER TABLE ivekit_audit_events
      DISABLE TRIGGER ivekit_audit_legacy_writer
    `);
    await assertActivationRejected(fresh, /audit legacy guard graph is invalid/i);
    await fresh.query(`
      ALTER TABLE ivekit_audit_events
      ENABLE TRIGGER ivekit_audit_legacy_writer
    `);
    await fresh.query(`DROP TRIGGER ivekit_audit_legacy_writer ON ivekit_audit_events`);
    await fresh.query(`
      CREATE TRIGGER ivekit_audit_legacy_writer
      BEFORE UPDATE ON ivekit_audit_events
      FOR EACH ROW EXECUTE FUNCTION converact_audit_legacy_writer_guard()
    `);
    await assertActivationRejected(fresh, /audit legacy guard graph is invalid/i);
    await fresh.query(`DROP TRIGGER ivekit_audit_legacy_writer ON ivekit_audit_events`);
    await fresh.query(`
      CREATE TRIGGER ivekit_audit_legacy_writer
      BEFORE INSERT ON ivekit_audit_events
      FOR EACH ROW EXECUTE FUNCTION converact_audit_legacy_writer_guard()
    `);

    await fresh.query(`
      CREATE FUNCTION converact_audit_extra_trigger_probe()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp
      AS $$
      BEGIN
        RETURN NEW;
      END
      $$
    `);
    await fresh.query(`
      REVOKE ALL ON FUNCTION converact_audit_extra_trigger_probe() FROM PUBLIC
    `);
    await fresh.query(`
      CREATE TRIGGER converact_audit_extra_trigger_probe
      BEFORE INSERT ON ivekit_audit_events
      FOR EACH ROW EXECUTE FUNCTION converact_audit_extra_trigger_probe()
    `);
    await assertActivationRejected(fresh, /audit target trigger or rule graph is invalid/i);
    await fresh.query(`
      DROP TRIGGER converact_audit_extra_trigger_probe ON ivekit_audit_events
    `);
    await fresh.query(`DROP FUNCTION converact_audit_extra_trigger_probe()`);

    await fresh.query(`
      CREATE RULE converact_audit_extra_rule AS
      ON INSERT TO ivekit_audit_events DO ALSO
      UPDATE converact_audit_chain_heads
      SET next_position = next_position
      WHERE false
    `);
    await assertActivationRejected(fresh, /audit target trigger or rule graph is invalid/i);
    await fresh.query(`DROP RULE converact_audit_extra_rule ON ivekit_audit_events`);

    await fresh.query(`SET session_replication_role = replica`);
    await assertActivationRejected(fresh, /session replication role is invalid/i);
    await fresh.query(`RESET session_replication_role`);

    await fresh.query(`
      DO $$
      BEGIN
        EXECUTE format(
          'GRANT CONNECT ON DATABASE %I TO converact_audit_runtime WITH GRANT OPTION',
          current_database()
        );
      END
      $$
    `);
    await assertActivationRejected(fresh, /audit role database ACL graph is invalid/i);
    await fresh.query(`
      DO $$
      BEGIN
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON DATABASE %I FROM converact_audit_runtime',
          current_database()
        );
      END
      $$
    `);

    await fresh.query(`
      DO $$
      BEGIN
        EXECUTE format(
          'GRANT CONNECT ON DATABASE %I TO PUBLIC',
          current_database()
        );
      END
      $$
    `);
    await assertActivationRejected(fresh, /database authority outside the graph/i);
    await fresh.query(`
      DO $$
      BEGIN
        EXECUTE format(
          'REVOKE CONNECT ON DATABASE %I FROM PUBLIC',
          current_database()
        );
      END
      $$
    `);

    for (const role of ['converact_audit_runtime', 'converact_audit_store_owner']) {
      await fresh.query(`GRANT USAGE ON SCHEMA public TO ${role} WITH GRANT OPTION`);
      await assertActivationRejected(fresh, /audit role schema ACL graph is invalid/i);
      await fresh.query(`REVOKE GRANT OPTION FOR USAGE ON SCHEMA public FROM ${role}`);
    }

    await fresh.query(`
      GRANT EXECUTE ON FUNCTION converact_authority_writer_fence(
        TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
      ) TO converact_audit_store_owner WITH GRANT OPTION
    `);
    await assertActivationRejected(fresh, /audit owner authority function graph is invalid/i);
    await fresh.query(`
      REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION converact_authority_writer_fence(
        TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
      ) FROM converact_audit_store_owner
    `);

    await fresh.query(`CREATE DATABASE converact_audit_public_connect_probe`);
    await assertActivationRejected(fresh, /database authority outside the graph/i);
    await fresh.query(`DROP DATABASE converact_audit_public_connect_probe`);

    const largeObject = await fresh.query<{ oid: number }>(`SELECT lo_create(0) AS oid`);
    const largeObjectOid = Number(largeObject.rows[0]?.oid);
    assert.ok(Number.isSafeInteger(largeObjectOid) && largeObjectOid > 0);
    await fresh.query(`GRANT SELECT ON LARGE OBJECT ${largeObjectOid} TO PUBLIC`);
    await assertActivationRejected(fresh, /large-object authority/i);
    await fresh.query(`REVOKE SELECT ON LARGE OBJECT ${largeObjectOid} FROM PUBLIC`);
    await fresh.query(`SELECT lo_unlink($1)`, [largeObjectOid]);

    await activateConveractAuditRuntimeRole(fresh, runtimePassword);
    await activateConveractAuditRuntimeRole(upgrade, runtimePassword);
    await assertRuntimeLogin(fresh, true);
    await assertRuntimeLogin(upgrade, true);
    await assertExactGraph(fresh);
    await assertExactGraph(upgrade);

    await initializeConveractFabricRuntimeRole(fresh, runtimePassword);
    await assertRuntimeLogin(fresh, true);
    await activateConveractAuditRuntimeRole(fresh, runtimePassword);
    await assertExactGraph(fresh);

    runtime = new Pool({
      connectionString: roleUrl(freshAdminUrl, 'converact_audit_runtime', runtimePassword),
      max: 1
    });
    const runtimeGraph = await runtime.query<{
      event_select: boolean;
      event_insert: boolean;
      head_select: boolean;
      generic_fence: boolean;
      audit_append: boolean;
    }>(`
      SELECT
        has_table_privilege(current_user, 'ivekit_audit_events', 'SELECT') AS event_select,
        has_table_privilege(current_user, 'ivekit_audit_events', 'INSERT') AS event_insert,
        has_table_privilege(current_user, 'converact_audit_chain_heads', 'SELECT') AS head_select,
        has_function_privilege(
          current_user,
          'converact_authority_writer_fence(text,text,text,numeric,numeric,text,text,numeric)',
          'EXECUTE'
        ) AS generic_fence,
        has_function_privilege(
          current_user,
          'converact_audit_event_append(text,text,text,numeric,numeric,text,text,numeric,text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb,timestamp with time zone,timestamp with time zone,boolean,text,text)',
          'EXECUTE'
        ) AS audit_append
    `);
    assert.deepEqual(runtimeGraph.rows, [{
      event_select: true,
      event_insert: false,
      head_select: false,
      generic_fence: false,
      audit_append: true
    }]);
  } finally {
    await runtime?.end();
    await upgrade.end();
    await fresh.end();
    migrations.cleanup();
  }
});

async function assertActivationRejected(pg: Pool, pattern: RegExp): Promise<void> {
  await assert.rejects(() => activateConveractAuditRuntimeRole(pg, runtimePassword), pattern);
  await assertRuntimeLogin(pg, false);
}

async function assertRuntimeLogin(pg: Pool, expected: boolean): Promise<void> {
  const result = await pg.query<{ rolcanlogin: boolean }>(`
    SELECT rolcanlogin FROM pg_roles WHERE rolname = 'converact_audit_runtime'
  `);
  assert.deepEqual(result.rows, [{ rolcanlogin: expected }]);
}

async function assertWrapperOwner(pg: Pool, expectedOwner: string): Promise<void> {
  const result = await pg.query<{ owner: string; count: string }>(`
    SELECT owner.rolname AS owner, count(*)::text AS count
    FROM pg_proc AS procedure
    JOIN pg_roles AS owner ON owner.oid = procedure.proowner
    WHERE procedure.oid IN (
      to_regprocedure('converact_audit_writer_fence(text,text,text,numeric,numeric,text,text,numeric)'),
      to_regprocedure('converact_audit_chain_head(text,text,text,numeric,numeric,text,text,numeric)'),
      to_regprocedure('converact_audit_event_append(text,text,text,numeric,numeric,text,text,numeric,text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb,timestamp with time zone,timestamp with time zone,boolean,text,text)')
    )
    GROUP BY owner.rolname
  `);
  assert.deepEqual(result.rows, [{ owner: expectedOwner, count: '3' }]);
}

async function assertExactGraph(pg: Pool): Promise<void> {
  const result = await pg.query<{
    event_select: boolean;
    event_insert: boolean;
    head_select: boolean;
    generic_fence: boolean;
    audit_append: boolean;
    owner_login: boolean;
  }>(`
    SELECT
      has_table_privilege('converact_audit_runtime', 'ivekit_audit_events', 'SELECT') AS event_select,
      has_table_privilege('converact_audit_runtime', 'ivekit_audit_events', 'INSERT') AS event_insert,
      has_table_privilege('converact_audit_runtime', 'converact_audit_chain_heads', 'SELECT') AS head_select,
      has_function_privilege(
        'converact_audit_runtime',
        'converact_authority_writer_fence(text,text,text,numeric,numeric,text,text,numeric)',
        'EXECUTE'
      ) AS generic_fence,
      has_function_privilege(
        'converact_audit_runtime',
        'converact_audit_event_append(text,text,text,numeric,numeric,text,text,numeric,text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb,timestamp with time zone,timestamp with time zone,boolean,text,text)',
        'EXECUTE'
      ) AS audit_append,
      (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'converact_audit_store_owner') AS owner_login
  `);
  assert.deepEqual(result.rows, [{
    event_select: true,
    event_insert: false,
    head_select: false,
    generic_fence: false,
    audit_append: true,
    owner_login: false
  }]);
}

function roleUrl(databaseUrl: string, role: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}
