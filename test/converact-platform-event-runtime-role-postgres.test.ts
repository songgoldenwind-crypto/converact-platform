import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import { buildConveractFabricStandaloneContext } from '../scripts/converact-standalone-build-context.js';
import { applyConveractFabricMigrations } from '../src/converact-migrations.js';
import {
  activateConveractEventRuntimeRole,
  initializeConveractFabricRuntimeRole
} from '../src/converact-runtime-role.js';

const freshAdminUrl = process.env.CONVERACT_FABRIC_STANDALONE_TEST_DATABASE_URL || '';
const upgradeAdminUrl = process.env.CONVERACT_FABRIC_UPGRADE_TEST_DATABASE_URL || '';
const runtimePassword = process.env.CONVERACT_FABRIC_STANDALONE_TEST_RUNTIME_PASSWORD || '';
const physicalTest = freshAdminUrl && upgradeAdminUrl && runtimePassword ? test : test.skip;

function migrationCorpus(): {
  fullDirectory: string;
  through119Directory: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'converact-event-role-postgres-'));
  const outputDirectory = join(root, 'context');
  buildConveractFabricStandaloneContext({
    repoRoot: resolve('.'),
    outputDir: outputDirectory,
    sourceCommit: 'e'.repeat(40),
    generatedAt: '2026-08-21T00:00:00.000Z'
  });

  const fullDirectory = join(outputDirectory, 'migrations');
  const through119Directory = join(root, 'through-119');
  mkdirSync(through119Directory);
  for (const file of readdirSync(fullDirectory)) {
    if (
      !file.endsWith('.sql') ||
      file === '120_converact_platform_event_runtime_roles.sql' ||
      file === '121_converact_audit_runtime_fencing.sql' ||
      file === '122_converact_audit_runtime_indexes.sql'
    ) {
      continue;
    }
    copyFileSync(join(fullDirectory, file), join(through119Directory, file));
  }

  return {
    fullDirectory,
    through119Directory,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

async function assertRoleMigrationApplied(pg: Pool): Promise<void> {
  const migration = await pg.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM schema_migrations
    WHERE version = '120_converact_platform_event_runtime_roles'
  `);
  assert.equal(migration.rows[0]?.count, '1');

  const wrappers = await pg.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM pg_proc AS procedure
    JOIN pg_roles AS owner ON owner.oid = procedure.proowner
    WHERE procedure.oid IN (
      to_regprocedure('converact_platform_writer_fence(text,text,text,numeric,numeric,text,text,numeric)'),
      to_regprocedure('converact_platform_inbox_append(text,text,text,numeric,numeric,text,text,numeric,text,text,text,bigint,text,timestamp with time zone)'),
      to_regprocedure('converact_platform_effect_append(text,text,text,numeric,numeric,text,text,numeric,text,text,text,text,text,bigint,text,bigint,text,timestamp with time zone)'),
      to_regprocedure('converact_platform_outbox_enqueue(text,text,text,numeric,numeric,text,text,numeric,text,text,text,integer,integer,text,text,text,text,bigint,text,text,text,jsonb,jsonb,text,text,text,jsonb,integer,timestamp with time zone,timestamp with time zone)'),
      to_regprocedure('converact_platform_outbox_claim(text,text,text,numeric,numeric,text,text,numeric,text,text,text,bigint,integer)'),
      to_regprocedure('converact_platform_outbox_transition_apply(text,text,text,numeric,numeric,text,text,numeric,text,text,text,bigint,text,text,bigint,text,text)')
    )
      AND owner.rolname = 'converact_event_store_owner'
      AND procedure.prosecdef
      AND procedure.proconfig = ARRAY[
        'search_path=pg_catalog, public, pg_temp'
      ]::text[]
  `);
  assert.equal(wrappers.rows[0]?.count, '6');
}

async function assertEventRuntimeCannotLogin(pg: Pool): Promise<void> {
  const role = await pg.query<{ rolcanlogin: boolean }>(`
    SELECT rolcanlogin FROM pg_roles WHERE rolname = 'converact_event_runtime'
  `);
  assert.deepEqual(role.rows, [{ rolcanlogin: false }]);
}

physicalTest(
  'Platform Event role migration is fresh-install and through-119 upgrade compatible',
  async () => {
    const migrations = migrationCorpus();
    const fresh = new Pool({ connectionString: freshAdminUrl, max: 1 });
    const upgrade = new Pool({ connectionString: upgradeAdminUrl, max: 1 });
    try {
      await initializeConveractFabricRuntimeRole(fresh, runtimePassword);
      await initializeConveractFabricRuntimeRole(upgrade, runtimePassword);
      await applyConveractFabricMigrations(fresh, {
        directory: migrations.fullDirectory,
        advisoryLockName: 'converact_event_role_fresh_migrations'
      });
      await applyConveractFabricMigrations(fresh, {
        directory: migrations.fullDirectory,
        advisoryLockName: 'converact_event_role_fresh_migrations'
      });
      await assertRoleMigrationApplied(fresh);

      await fresh.query(`
        CREATE POLICY event_role_test_allow_all
        ON converact_platform_outbox
        FOR SELECT USING (true)
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-extra-policy'),
        /converact event table privilege graph is invalid/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`
        DROP POLICY event_role_test_allow_all ON converact_platform_outbox
      `);

      await fresh.query(`
        ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin
        GRANT EXECUTE ON FUNCTIONS TO PUBLIC
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-public-function-default'),
        /converact event roles have effective authority outside the exact graph/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`
        ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin
        REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC
      `);

      await fresh.query(`
        ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin
        GRANT SELECT ON TABLES TO PUBLIC
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-public-table-default'),
        /converact event roles have effective authority outside the exact graph/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`
        ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin
        REVOKE SELECT ON TABLES FROM PUBLIC
      `);

      await fresh.query(`
        ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin
        GRANT USAGE ON SEQUENCES TO PUBLIC
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-public-sequence-default'),
        /converact event roles have effective authority outside the exact graph/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`
        ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin
        REVOKE USAGE ON SEQUENCES FROM PUBLIC
      `);

      await fresh.query(`
        ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin
        GRANT CREATE ON SCHEMAS TO PUBLIC
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-public-schema-default'),
        /converact event roles have effective authority outside the exact graph/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`
        ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin
        REVOKE CREATE ON SCHEMAS FROM PUBLIC
      `);

      await fresh.query(`
        CREATE FUNCTION converact_event_public_definer_probe()
        RETURNS TEXT
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp
        AS 'SELECT current_user'
      `);
      await fresh.query(`
        GRANT EXECUTE ON FUNCTION converact_event_public_definer_probe() TO PUBLIC
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-public-definer'),
        /converact event runtime has authority outside the exact graph/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`DROP FUNCTION converact_event_public_definer_probe()`);

      await fresh.query(`CREATE DATABASE converact_event_public_connect_probe`);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-public-database'),
        /converact event roles have effective authority outside the exact graph/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`DROP DATABASE converact_event_public_connect_probe`);

      await fresh.query(`
        GRANT EXECUTE ON FUNCTION converact_platform_writer_fence(
          TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
        ) TO opc_runtime
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-third-party-wrapper'),
        /converact event wrapper privilege graph is invalid/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`
        REVOKE EXECUTE ON FUNCTION converact_platform_writer_fence(
          TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
        ) FROM opc_runtime
      `);

      await fresh.query(`
        GRANT EXECUTE ON FUNCTION converact_platform_writer_fence(
          TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
        ) TO converact_event_runtime WITH GRANT OPTION
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-wrapper-grant-option'),
        /converact event wrapper privilege graph is invalid/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`
        REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION converact_platform_writer_fence(
          TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
        ) FROM converact_event_runtime
      `);

      await fresh.query(`
        REVOKE UPDATE ON converact_platform_outbox FROM converact_event_store_owner
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-missing-grant'),
        /converact event owner table privilege graph is invalid/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`
        GRANT UPDATE ON converact_platform_outbox TO converact_event_store_owner
      `);

      await fresh.query(`
        REVOKE EXECUTE ON FUNCTION converact_authority_writer_fence(
          TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
        ) FROM converact_event_store_owner
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-missing-owner-function'),
        /converact event owner authority function graph is invalid/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`
        GRANT EXECUTE ON FUNCTION converact_authority_writer_fence(
          TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
        ) TO converact_event_store_owner
      `);

      await fresh.query(`GRANT SELECT ON tenants TO converact_event_runtime`);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-extra-runtime-table'),
        /converact event runtime has authority outside the exact graph/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`REVOKE SELECT ON tenants FROM converact_event_runtime`);

      await fresh.query(`GRANT SELECT ON tenants TO PUBLIC`);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-public-table'),
        /converact event roles have effective authority outside the exact graph/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`REVOKE SELECT ON tenants FROM PUBLIC`);

      await fresh.query(`GRANT SELECT (name) ON tenants TO PUBLIC`);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-public-column'),
        /converact event roles have effective authority outside the exact graph/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`REVOKE SELECT (name) ON tenants FROM PUBLIC`);

      await fresh.query(`CREATE SEQUENCE converact_event_public_sequence_probe`);
      await fresh.query(`GRANT USAGE ON SEQUENCE converact_event_public_sequence_probe TO PUBLIC`);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-public-sequence'),
        /converact event roles have effective authority outside the exact graph/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`DROP SEQUENCE converact_event_public_sequence_probe`);

      await fresh.query(`
        GRANT UPDATE (status) ON converact_platform_outbox TO converact_event_runtime
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-column-update'),
        /converact event target relation ACL graph is invalid/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`
        REVOKE UPDATE (status) ON converact_platform_outbox FROM converact_event_runtime
      `);

      await fresh.query(`CREATE ROLE converact_event_acl_rogue NOLOGIN`);
      await fresh.query(`
        GRANT INSERT ON converact_platform_outbox TO converact_event_acl_rogue
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-rogue-writer'),
        /converact event target relation ACL graph is invalid/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`
        REVOKE INSERT ON converact_platform_outbox FROM converact_event_acl_rogue
      `);
      await fresh.query(`DROP ROLE converact_event_acl_rogue`);

      await fresh.query(`GRANT UPDATE (status) ON converact_platform_outbox TO PUBLIC`);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-public-column-write'),
        /converact event target relation ACL graph is invalid/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`REVOKE UPDATE (status) ON converact_platform_outbox FROM PUBLIC`);

      const largeObject = await fresh.query<{ oid: number }>(`
        SELECT lo_create(0) AS oid
      `);
      const largeObjectOid = Number(largeObject.rows[0]?.oid);
      assert.ok(Number.isSafeInteger(largeObjectOid) && largeObjectOid > 0);
      await fresh.query(`
        GRANT SELECT ON LARGE OBJECT ${largeObjectOid} TO converact_event_runtime
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-large-object'),
        /converact event runtime has authority outside the exact graph/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`
        REVOKE SELECT ON LARGE OBJECT ${largeObjectOid} FROM converact_event_runtime
      `);
      await fresh.query(`
        GRANT SELECT ON LARGE OBJECT ${largeObjectOid} TO PUBLIC
      `);
      await assert.rejects(
        () => activateConveractEventRuntimeRole(fresh, 'must-not-activate-with-public-large-object'),
        /converact event roles have effective authority outside the exact graph/i
      );
      await assertEventRuntimeCannotLogin(fresh);
      await fresh.query(`
        REVOKE SELECT ON LARGE OBJECT ${largeObjectOid} FROM PUBLIC
      `);
      await fresh.query(`SELECT lo_unlink($1)`, [largeObjectOid]);

      await activateConveractEventRuntimeRole(
        fresh,
        'converact-event-role-final-success-password'
      );
      const activated = await fresh.query<{ rolcanlogin: boolean }>(`
        SELECT rolcanlogin FROM pg_roles
        WHERE rolname = 'converact_event_runtime'
      `);
      assert.deepEqual(activated.rows, [{ rolcanlogin: true }]);
      await fresh.query(`ALTER ROLE converact_event_runtime NOLOGIN`);
      await fresh.query(`
        DO $$
        BEGIN
          EXECUTE format(
            'REVOKE CONNECT ON DATABASE %I FROM converact_event_runtime',
            current_database()
          );
        END
        $$
      `);

      await applyConveractFabricMigrations(upgrade, {
        directory: migrations.through119Directory,
        advisoryLockName: 'converact_event_role_upgrade_migrations'
      });
      await upgrade.query(`
        INSERT INTO tenants (id, name)
        VALUES ('converact_event_role_upgrade', 'Event role upgrade sentinel')
      `);
      await initializeConveractFabricRuntimeRole(upgrade, runtimePassword);
      await applyConveractFabricMigrations(upgrade, {
        directory: migrations.fullDirectory,
        advisoryLockName: 'converact_event_role_upgrade_migrations'
      });
      await assertRoleMigrationApplied(upgrade);
      const sentinel = await upgrade.query<{ name: string }>(`
        SELECT name FROM tenants WHERE id = 'converact_event_role_upgrade'
      `);
      assert.deepEqual(sentinel.rows, [{ name: 'Event role upgrade sentinel' }]);
    } finally {
      migrations.cleanup();
      await fresh.end();
      await upgrade.end();
    }
  }
);
