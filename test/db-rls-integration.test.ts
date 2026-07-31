/**
 * RLS enforcement integration gate (audit A-11 / 校准3).
 *
 * These tests verify Postgres-side row-level security actually enforces
 * tenant isolation — something the in-memory MemoryPg substitute CANNOT do
 * (MemoryPg does not evaluate RLS policies, and withPgTenant/withPgBypass
 * short-circuit to fn(pg) for MemoryPg).
 *
 * THEY REQUIRE A REAL POSTGRES: run with `DATABASE_URL=postgres://...` set and
 * `OPC_USE_MEMORY_PG` unset. Without DATABASE_URL every test skips — that is
 * the intended safe default for test:fast.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RESOLVED RISK — owner bypass (discovered while writing this file, 校准3)
 * ─────────────────────────────────────────────────────────────────────────
 * `src/migrations/009_tenant_rls.sql` originally issued `ENABLE ROW LEVEL
 * SECURITY` but NOT `FORCE`, so the table owner (the role in DATABASE_URL)
 * bypassed every policy and RLS was silently unenforced. RESOLVED: 009 now adds
 * FORCE and `010_force_rls.sql` backfills it on already-deployed databases.
 *
 * These tests MUST still be run under a NON-SUPERUSER role (e.g. opc_app), not
 * the postgres superuser — superusers bypass RLS regardless of FORCE. When you
 * run with `DATABASE_URL=postgres://opc_app@host/db`, the cross-tenant tests
 * below assert real isolation; a failure showing the other tenant's rows or a
 * permitted cross-tenant write is a TRUE security failure, not a test bug.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import {
  initPostgres,
  resetPostgresForTests,
  closePostgres,
  withPgTransaction,
  type PgQueryable,
  pgId
} from '../src/db-pg.js';
import { withPgTenant, withPgBypass } from '../src/db-pg-tenant.js';

// Local helper: run fn in a plain transaction with NO GUC set, to observe RLS
// fail-closed behavior. Kept local so this file stays explicit about "no
// tenant context set" — distinct from withPgTenant/withPgBypass.
function withPgTransactionRaw<T>(pg: PgQueryable, fn: (c: PgQueryable) => Promise<T>): Promise<T> {
  return withPgTransaction(pg, fn);
}

const HAS_REAL_PG = !process.env.OPC_USE_MEMORY_PG && !!process.env.DATABASE_URL;
const maybe = HAS_REAL_PG ? test : test.skip;

let pg: PgQueryable;
let adminPg: Pool;

function withAdmin<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
  return withPgTransaction(adminPg, fn);
}

test('setup real postgres + migrations (incl. 009 RLS)', async () => {
  if (!HAS_REAL_PG) return;
  resetPostgresForTests(null);
  pg = (await initPostgres())!;
  assert.ok(pg, 'initPostgres returned null — is DATABASE_URL set?');
  assert.ok(process.env.DATABASE_MIGRATION_URL, 'DATABASE_MIGRATION_URL is required for RLS fixtures');
  adminPg = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL, max: 1 });
  await adminPg.query('SELECT 1');
});

maybe('cross-tenant read isolation: tenant A cannot see tenant B rows', async () => {
  const a = 'tenant_rls_a';
  const b = 'tenant_rls_b';
  await withAdmin(async (c) => {
    await c.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1,$2,'free') ON CONFLICT DO NOTHING`, [a, 'A']);
    await c.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1,$2,'free') ON CONFLICT DO NOTHING`, [b, 'B']);
    await c.query(`DELETE FROM compliance_dnc_list WHERE tenant_id IN ($1,$2)`, [a, b]);
    await c.query(`INSERT INTO compliance_dnc_list (id, tenant_id, phone_number, reason) VALUES ($1,$2,$3,$4)`, [pgId('dnc'), a, '+819000000001', 'a']);
    await c.query(`INSERT INTO compliance_dnc_list (id, tenant_id, phone_number, reason) VALUES ($1,$2,$3,$4)`, [pgId('dnc'), b, '+819000000002', 'b']);
  });

  const aRows = await withPgTenant(pg, a, (c) =>
    c.query<{ phone_number: string }>(`SELECT phone_number FROM compliance_dnc_list`));
  const bRows = await withPgTenant(pg, b, (c) =>
    c.query<{ phone_number: string }>(`SELECT phone_number FROM compliance_dnc_list`));

  assert.ok(aRows.rows.every((r) => r.phone_number !== '+819000000002'), 'tenant A saw tenant B row — RLS not enforced (owner bypass? see FORCE RLS note)');
  assert.ok(bRows.rows.every((r) => r.phone_number !== '+819000000001'), 'tenant B saw tenant A row — RLS not enforced (owner bypass? see FORCE RLS note)');
});

maybe('fail-closed: no current_tenant context → tenant rows invisible', async () => {
  const t = 'tenant_rls_failclosed';
  await withAdmin(async (c) => {
    await c.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1,$2,'free') ON CONFLICT DO NOTHING`, [t, 'FC']);
    await c.query(`DELETE FROM compliance_dnc_list WHERE tenant_id = $1`, [t]);
    await c.query(`INSERT INTO compliance_dnc_list (id, tenant_id, phone_number, reason) VALUES ($1,$2,$3,$4)`, [pgId('dnc'), t, '+819000000003', 'fc']);
  });

  // Raw query WITHOUT setting app.current_tenant and WITHOUT bypass: RLS must
  // hide the row. NOTE: this only holds if the role is not the owner (see file
  // header). Use the fixture admin to confirm the row actually exists, then assert
  // the non-bypassed read sees nothing.
  const bypassSeen = await withAdmin((c) =>
    c.query(`SELECT count(*)::int AS n FROM compliance_dnc_list WHERE tenant_id = $1`, [t]));
  assert.equal(bypassSeen.rows[0].n, 1, 'seed row must exist (bypass)');

  const rawSeen = await withPgTransactionRaw(pg, (c) =>
    c.query(`SELECT count(*)::int AS n FROM compliance_dnc_list WHERE tenant_id = $1`, [t]));
  assert.equal(rawSeen.rows[0].n, 0, 'row visible without tenant context or bypass — RLS fail-closed broken');
});

maybe('WITH CHECK blocks cross-tenant write', async () => {
  const a = 'tenant_rls_wc_a';
  const b = 'tenant_rls_wc_b';
  await withAdmin(async (c) => {
    await c.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1,$2,'free') ON CONFLICT DO NOTHING`, [a, 'WCA']);
    await c.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1,$2,'free') ON CONFLICT DO NOTHING`, [b, 'WCB']);
    await c.query(`DELETE FROM compliance_dnc_list WHERE tenant_id IN ($1,$2)`, [a, b]);
  });

  // Inside tenant A's context, writing a row whose tenant_id = B must violate
  // the WITH CHECK policy and throw.
  await assert.rejects(
    () => withPgTenant(pg, a, (c) =>
      c.query(`INSERT INTO compliance_dnc_list (id, tenant_id, phone_number, reason) VALUES ($1,$2,$3,$4)`, [pgId('dnc'), b, '+819000000004', 'leak'])),
    /new row violates row-level security|WITH CHECK/i,
    'cross-tenant write was allowed — WITH CHECK not enforced'
  );
});

maybe('runtime role cannot enable generic RLS bypass', async () => {
  const anyT = 'tenant_rls_noleak';
  await withAdmin(async (c) => {
    await c.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1,$2,'free') ON CONFLICT DO NOTHING`, [anyT, 'NL']);
  });
  await assert.rejects(
    () => withPgBypass(pg, async () => undefined),
    /RLS bypass is not permitted/,
    'runtime role must not be able to turn a custom GUC into tenant bypass'
  );
  await withPgTenant(pg, anyT, async (c) => {
    const v = await c.query(`SELECT current_setting('app.bypass_rls', true) AS v`);
    assert.equal(v.rows[0].v, '', 'bypass leaked into a tenant txn — GUC is not transaction-scoped');
    const t = await c.query(`SELECT current_setting('app.current_tenant', true) AS v`);
    assert.equal(t.rows[0].v, anyT, 'current_tenant not set inside withPgTenant txn');
  });
});

maybe('iveKit media call lifecycle tables hide every foreign tenant row', async () => {
  const a = 'tenant_rls_media_a';
  const b = 'tenant_rls_media_b';
  const callId = 'mcall_rls_b';
  await withAdmin(async (c) => {
    await c.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1,$2,'free') ON CONFLICT DO NOTHING`, [a, 'Media A']);
    await c.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1,$2,'free') ON CONFLICT DO NOTHING`, [b, 'Media B']);
    await c.query(`DELETE FROM ivekit_media_calls WHERE tenant_id IN ($1,$2)`, [a, b]);
    await c.query(
      `INSERT INTO ivekit_media_calls
        (id, tenant_id, room_name, media, initiated_by, business_ref_type, business_ref_id)
       VALUES ($1,$2,$3,'video',$4,'service_order','SO-RLS')`,
      [callId, b, 'room-rls-b', 'host-rls-b']
    );
    await c.query(
      `INSERT INTO ivekit_media_call_participants
        (id, tenant_id, call_id, identity, role, status)
       VALUES ('mcp_rls_b',$1,$2,'host-rls-b','host','joined')`,
      [b, callId]
    );
    await c.query(
      `INSERT INTO ivekit_media_call_actions
        (id, tenant_id, call_id, idempotency_key, payload_hash, action, actor_identity,
         from_status, to_status, result_snapshot)
       VALUES ('mca_rls_b',$1,$2,'rls-action-b',$3,'ring','host-rls-b','created','ringing',$4)`,
      [b, callId, 'a'.repeat(64), JSON.stringify({ call: { id: callId }, participants: [] })]
    );
    await c.query(
      `INSERT INTO ivekit_media_moderation_actions
        (id, tenant_id, call_id, room_name, participant_identity, action, actor_identity,
         idempotency_key, payload_hash, track_sid, source, muted, result_snapshot)
       VALUES ('mma_rls_b',$1,$2,'room-rls-b','host-rls-b','mute','host-rls-b',
         'rls-moderation-b',$3,'TR_RLS','microphone',TRUE,$4)`,
      [b, callId, 'b'.repeat(64), JSON.stringify({ action: 'mute', status: 'applied' })]
    );
    await c.query(
      `INSERT INTO ivekit_media_moderation_commands
        (id, tenant_id, call_id, room_name, participant_identity, action, actor_identity,
         idempotency_key, payload_hash, request_payload)
       VALUES ('mmc_rls_b',$1,$2,'room-rls-b','host-rls-b','mute','host-rls-b',
         'rls-moderation-command-b',$3,$4)`,
      [b, callId, 'c'.repeat(64), JSON.stringify({ track_sid: 'TR_RLS', muted: true })]
    );
  });

  await withPgTenant(pg, a, async (c) => {
    for (const table of [
      'ivekit_media_calls',
      'ivekit_media_call_participants',
      'ivekit_media_call_actions',
      'ivekit_media_moderation_actions',
      'ivekit_media_moderation_commands'
    ]) {
      const result = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [b]);
      assert.equal(result.rows[0]?.n, 0, `${table} leaked a foreign tenant row`);
    }
  });
});

test('teardown real postgres', async () => {
  if (!HAS_REAL_PG) return;
  await adminPg.end();
  await closePostgres();
});
