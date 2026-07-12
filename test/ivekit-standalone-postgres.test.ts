import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import { buildIveKitStandaloneContext } from '../scripts/ivekit-standalone-build-context.js';
import { runMigrations } from '../src/db-pg.js';
import { applyIveKitMigrations } from '../src/ivekit-migrations.js';
import { initializeIveKitRuntimeRole } from '../src/ivekit-runtime-role.js';
import { IveKitTenantEventStore } from '../src/agent-runtime/ivekit/tenant-event-store.js';
import { RustDeskDeviceCommandStore } from '../src/agent-runtime/collaboration/rustdesk-device-command-store.js';
import { withPgTenant } from '../src/db-pg-tenant.js';

const freshAdminUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_DATABASE_URL || '';
const freshRuntimeUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_DATABASE_URL || '';
const upgradeAdminUrl = process.env.OPC_IVEKIT_UPGRADE_TEST_DATABASE_URL || '';
const upgradeRuntimeUrl = process.env.OPC_IVEKIT_UPGRADE_TEST_RUNTIME_DATABASE_URL || '';
const runtimePassword = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_PASSWORD || '';
const freshTest = freshAdminUrl && freshRuntimeUrl && runtimePassword ? test : test.skip;
const upgradeTest = upgradeAdminUrl && upgradeRuntimeUrl && runtimePassword ? test : test.skip;

function standaloneMigrations(): { directory: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-standalone-postgres-'));
  const outputDir = join(root, 'context');
  buildIveKitStandaloneContext({
    repoRoot: resolve('.'),
    outputDir,
    sourceCommit: 'integration-test',
    generatedAt: '2026-07-12T00:00:00.000Z'
  });
  return {
    directory: join(outputDir, 'migrations'),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

freshTest('standalone PostgreSQL fresh migration is minimal, checksummed, idempotent, and RLS enforced', async () => {
  const admin = new Pool({ connectionString: freshAdminUrl, max: 1 });
  const runtime = new Pool({ connectionString: freshRuntimeUrl, max: 1 });
  const migrations = standaloneMigrations();
  try {
    await initializeIveKitRuntimeRole(admin, runtimePassword);
    await applyIveKitMigrations(admin, {
      directory: migrations.directory,
      advisoryLockName: 'ivekit_test_fresh_migrations'
    });

    const tables = await admin.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );
    for (const forbidden of ['users', 'voice_call_sessions', 'leads', 'campaigns', 'ivr_flows']) {
      assert.equal(tables.rows.some((row) => row.tablename === forbidden), false, forbidden);
    }
    for (const required of [
      'tenants',
      'collaboration_sessions',
      'ivekit_media_calls',
      'ivekit_tenant_events',
      'rustdesk_gateway_sessions'
    ]) assert.equal(tables.rows.some((row) => row.tablename === required), true, required);

    const checksums = await admin.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM schema_migrations ORDER BY version`
    );
    assert.equal(checksums.rows.length, 32);
    assert.equal(checksums.rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum)), true);

    const rlsGaps = await admin.query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col
        ON col.table_schema = n.nspname
       AND col.table_name = c.relname
       AND col.column_name = 'tenant_id'
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
    `);
    assert.deepEqual(rlsGaps.rows, []);

    const privileges = await admin.query<{
      can_create: boolean;
      can_read_ledger: boolean;
      is_superuser: boolean;
      bypasses_rls: boolean;
      can_create_role: boolean;
    }>(`
      SELECT
        has_schema_privilege('opc_runtime', 'public', 'CREATE') AS can_create,
        has_table_privilege('opc_runtime', 'public.schema_migrations', 'SELECT') AS can_read_ledger,
        rolsuper AS is_superuser,
        rolbypassrls AS bypasses_rls,
        rolcreaterole AS can_create_role
      FROM pg_roles
      WHERE rolname = 'opc_runtime'
    `);
    assert.deepEqual(privileges.rows[0], {
      can_create: false,
      can_read_ledger: false,
      is_superuser: false,
      bypasses_rls: false,
      can_create_role: false
    });

    await admin.query(`INSERT INTO tenants (id, name) VALUES ('ivekit_rls_a', 'A'), ('ivekit_rls_b', 'B')`);
    await admin.query(`
      INSERT INTO rustdesk_devices
        (id, tenant_id, business_ref_type, business_ref_id, rustdesk_id, display_name)
      VALUES ('ivekit_recovery_device', 'ivekit_rls_a', 'order', 'A-1', '123456789', 'Recovery device');
      INSERT INTO rustdesk_gateway_sessions
        (external_id, tenant_id, target_id, actor_identity)
      VALUES
        ('ivekit_recovery_executed', 'ivekit_rls_a', 'ivekit_recovery_device', 'tester'),
        ('ivekit_recovery_uncertain', 'ivekit_rls_a', 'ivekit_recovery_device', 'tester');
      INSERT INTO rustdesk_device_commands
        (id, tenant_id, device_id, external_id, requested_by, requested_reason)
      VALUES
        ('ivekit_recovery_command_executed', 'ivekit_rls_a', 'ivekit_recovery_device', 'ivekit_recovery_executed', 'tester', 'gateway_ended'),
        ('ivekit_recovery_command_uncertain', 'ivekit_rls_a', 'ivekit_recovery_device', 'ivekit_recovery_uncertain', 'tester', 'gateway_ended')
    `);
    await withPgTenant(runtime, 'ivekit_rls_a', async (tenantPg) => {
      const commands = new RustDeskDeviceCommandStore(tenantPg);
      const executedClaim = (await commands.claimNext({
        tenant_id: 'ivekit_rls_a',
        device_id: 'ivekit_recovery_device',
        edge_instance_id: 'ivekit-recovery-edge',
        lease_ms: 1_000,
        now: '2026-07-12T00:00:00.000Z'
      }))!;
      assert.equal(executedClaim.command.id, 'ivekit_recovery_command_executed');
      const resumed = await commands.recover({
        tenant_id: 'ivekit_rls_a',
        device_id: 'ivekit_recovery_device',
        command_id: executedClaim.command.id,
        edge_instance_id: 'ivekit-recovery-edge',
        attempt: 1,
        state: 'executed',
        lease_ms: 30_000,
        now: '2026-07-12T00:00:05.000Z'
      });
      assert.equal(resumed.action, 'resume_report');
      assert.equal(resumed.command.attempt_count, 1);
      await commands.complete({
        tenant_id: 'ivekit_rls_a',
        device_id: 'ivekit_recovery_device',
        command_id: executedClaim.command.id,
        claim_token: resumed.claim_token!,
        status: 'succeeded',
        execution_method: 'session_adapter',
        exit_code: 0,
        duration_ms: 10,
        stdout_bytes: 0,
        stderr_bytes: 0,
        now: '2026-07-12T00:00:05.100Z'
      });

      const uncertainClaim = (await commands.claimNext({
        tenant_id: 'ivekit_rls_a',
        device_id: 'ivekit_recovery_device',
        edge_instance_id: 'ivekit-recovery-edge',
        lease_ms: 1_000,
        now: '2026-07-12T00:01:00.000Z'
      }))!;
      assert.equal(uncertainClaim.command.id, 'ivekit_recovery_command_uncertain');
      const uncertain = await commands.recover({
        tenant_id: 'ivekit_rls_a',
        device_id: 'ivekit_recovery_device',
        command_id: uncertainClaim.command.id,
        edge_instance_id: 'ivekit-recovery-edge',
        attempt: 1,
        state: 'executing',
        lease_ms: 30_000,
        now: '2026-07-12T00:01:05.000Z'
      });
      assert.equal(uncertain.action, 'quarantine');
      assert.equal(uncertain.command.status, 'failed');
      assert.equal(uncertain.command.result_metadata.error_code, 'edge_recovery_execution_uncertain');
    });
    await admin.query(`
      INSERT INTO collaboration_sessions (id, tenant_id, business_ref_type, business_ref_id, title)
      VALUES ('ivekit_rls_session_b', 'ivekit_rls_b', 'order', 'B-1', 'private B')
    `);

    const eventStore = new IveKitTenantEventStore(runtime, {
      cursor_secret: 'standalone-postgres-event-secret'
    });
    const eventHead = await eventStore.headCursor('ivekit_rls_a');
    const durableEvent = await eventStore.append({
      tenant_id: 'ivekit_rls_a',
      type: 'tenant.acceptance.updated',
      data: { acceptance_id: 'event-a' }
    });
    const replay = await eventStore.list({
      tenant_id: 'ivekit_rls_a',
      user_id: 'runtime-user-a',
      role: 'operator',
      cursor: eventHead,
      limit: 10
    });
    assert.deepEqual(replay.items.map((event) => event.event_id), [durableEvent.event_id]);
    const foreignReplay = await eventStore.list({
      tenant_id: 'ivekit_rls_b',
      user_id: 'runtime-user-b',
      role: 'admin',
      cursor: await eventStore.headCursor('ivekit_rls_b'),
      limit: 10
    });
    assert.deepEqual(foreignReplay.items, []);

    let retentionNow = new Date('2026-07-12T10:00:00.000Z');
    const retentionStore = new IveKitTenantEventStore(runtime, {
      cursor_secret: 'standalone-postgres-retention-secret',
      retention_ms: 1_000,
      now: () => retentionNow
    });
    await retentionStore.append({
      tenant_id: 'ivekit_rls_a',
      type: 'tenant.expired.acceptance',
      data: { acceptance_id: 'expired-event-a' }
    });
    retentionNow = new Date('2026-07-12T10:00:02.000Z');
    assert.deepEqual(await retentionStore.pruneExpired({
      now: retentionNow,
      tenant_limit: 10,
      batch_size: 100
    }), { tenants: 1, deleted: 1 });

    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant', 'ivekit_rls_a', true)`);
      await client.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const foreign = await client.query(
        `SELECT id FROM collaboration_sessions WHERE tenant_id = 'ivekit_rls_b'`
      );
      assert.equal(foreign.rowCount, 0);
      await assert.rejects(
        () => client.query(`
          INSERT INTO collaboration_sessions
            (id, tenant_id, business_ref_type, business_ref_id)
          VALUES ('ivekit_cross_tenant_write', 'ivekit_rls_b', 'order', 'B-2')
        `),
        /row-level security|policy/i
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    await applyIveKitMigrations(admin, {
      directory: migrations.directory,
      advisoryLockName: 'ivekit_test_fresh_migrations'
    });
    const preserved = await admin.query(
      `SELECT id FROM collaboration_sessions WHERE id = 'ivekit_rls_session_b'`
    );
    assert.equal(preserved.rowCount, 1);
  } finally {
    migrations.cleanup();
    await runtime.end();
    await admin.end();
  }
});

upgradeTest('existing OPC schema upgrades through standalone runner without product or communication data loss', async () => {
  const admin = new Pool({ connectionString: upgradeAdminUrl, max: 1 });
  const runtime = new Pool({ connectionString: upgradeRuntimeUrl, max: 1 });
  const migrations = standaloneMigrations();
  try {
    await runMigrations(admin, {
      directory: resolve('src/migrations'),
      advisoryLockName: 'ivekit_test_opc_root_migrations'
    });
    await admin.query(`INSERT INTO tenants (id, name) VALUES ('ivekit_upgrade_tenant', 'Upgrade tenant')`);
    await admin.query(`
      INSERT INTO campaigns (id, tenant_id, name)
      VALUES ('ivekit_upgrade_campaign', 'ivekit_upgrade_tenant', 'Preserved campaign')
    `);
    await admin.query(`
      INSERT INTO collaboration_sessions (id, tenant_id, business_ref_type, business_ref_id, title)
      VALUES ('ivekit_upgrade_session', 'ivekit_upgrade_tenant', 'order', 'UP-1', 'Preserved session')
    `);
    const productTablesBefore = await admin.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'
    `);

    await initializeIveKitRuntimeRole(admin, runtimePassword);
    await applyIveKitMigrations(admin, {
      directory: migrations.directory,
      advisoryLockName: 'ivekit_test_upgrade_migrations'
    });
    await applyIveKitMigrations(admin, {
      directory: migrations.directory,
      advisoryLockName: 'ivekit_test_upgrade_migrations'
    });

    const productTablesAfter = await admin.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'
    `);
    assert.equal(Number(productTablesAfter.rows[0].count) >= Number(productTablesBefore.rows[0].count), true);
    assert.equal((await admin.query(
      `SELECT id FROM campaigns WHERE id = 'ivekit_upgrade_campaign'`
    )).rowCount, 1);
    assert.equal((await admin.query(
      `SELECT id FROM collaboration_sessions WHERE id = 'ivekit_upgrade_session'`
    )).rowCount, 1);

    const standaloneVersions = await admin.query<{ version: string; count: string }>(`
      SELECT version, count(*)::text AS count
      FROM schema_migrations
      WHERE version IN ('000_ivekit_foundation', '090_ivekit_runtime_security')
      GROUP BY version
      ORDER BY version
    `);
    assert.deepEqual(standaloneVersions.rows, [
      { version: '000_ivekit_foundation', count: '1' },
      { version: '090_ivekit_runtime_security', count: '1' }
    ]);

    await assert.rejects(
      () => runtime.query('SELECT version FROM schema_migrations'),
      /permission denied/i
    );
    await assert.rejects(
      () => runtime.query('CREATE TABLE ivekit_runtime_must_not_create (id TEXT)'),
      /permission denied/i
    );
  } finally {
    migrations.cleanup();
    await runtime.end();
    await admin.end();
  }
});
