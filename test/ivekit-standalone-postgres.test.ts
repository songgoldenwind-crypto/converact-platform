import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import { runMigrations } from '../src/db-pg.js';

const adminUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_DATABASE_URL || '';
const runtimeUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_DATABASE_URL || '';
const maybe = adminUrl && runtimeUrl ? test : test.skip;

maybe('standalone PostgreSQL fresh migration is minimal, checksummed, idempotent, and RLS enforced', async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
  const directory = resolve('services/ivekit-service/migrations');
  try {
    await runMigrations(admin, { directory, advisoryLockName: 'ivekit_test_migrations' });

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
      'rustdesk_gateway_sessions'
    ]) assert.equal(tables.rows.some((row) => row.tablename === required), true, required);

    const checksums = await admin.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM schema_migrations ORDER BY version`
    );
    assert.equal(checksums.rows.length > 20, true);
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

    await admin.query(`INSERT INTO tenants (id, name) VALUES ('ivekit_rls_a', 'A'), ('ivekit_rls_b', 'B') ON CONFLICT DO NOTHING`);
    await admin.query(`
      INSERT INTO collaboration_sessions (id, tenant_id, business_ref_type, business_ref_id, title)
      VALUES ('ivekit_rls_session_b', 'ivekit_rls_b', 'order', 'B-1', 'private B')
      ON CONFLICT DO NOTHING
    `);

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

    await runMigrations(admin, { directory, advisoryLockName: 'ivekit_test_migrations' });
    const preserved = await admin.query(
      `SELECT id FROM collaboration_sessions WHERE id = 'ivekit_rls_session_b'`
    );
    assert.equal(preserved.rowCount, 1);
  } finally {
    await runtime.end();
    await admin.end();
  }
});
