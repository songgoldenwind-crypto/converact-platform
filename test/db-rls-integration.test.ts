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

test('setup real postgres + migrations (incl. 009 RLS)', async () => {
  if (!HAS_REAL_PG) return;
  resetPostgresForTests(null);
  pg = (await initPostgres())!;
  assert.ok(pg, 'initPostgres returned null — is DATABASE_URL set?');
});

maybe('cross-tenant read isolation: tenant A cannot see tenant B rows', async () => {
  const a = 'tenant_rls_a';
  const b = 'tenant_rls_b';
  await withPgBypass(pg, async (c) => {
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
  await withPgBypass(pg, async (c) => {
    await c.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1,$2,'free') ON CONFLICT DO NOTHING`, [t, 'FC']);
    await c.query(`DELETE FROM compliance_dnc_list WHERE tenant_id = $1`, [t]);
    await c.query(`INSERT INTO compliance_dnc_list (id, tenant_id, phone_number, reason) VALUES ($1,$2,$3,$4)`, [pgId('dnc'), t, '+819000000003', 'fc']);
  });

  // Raw query WITHOUT setting app.current_tenant and WITHOUT bypass: RLS must
  // hide the row. NOTE: this only holds if the role is not the owner (see file
  // header). Use withPgBypass to confirm the row actually exists, then assert
  // the non-bypassed read sees nothing.
  const bypassSeen = await withPgBypass(pg, (c) =>
    c.query(`SELECT count(*)::int AS n FROM compliance_dnc_list WHERE tenant_id = $1`, [t]));
  assert.equal(bypassSeen.rows[0].n, 1, 'seed row must exist (bypass)');

  const rawSeen = await withPgTransactionRaw(pg, (c) =>
    c.query(`SELECT count(*)::int AS n FROM compliance_dnc_list WHERE tenant_id = $1`, [t]));
  assert.equal(rawSeen.rows[0].n, 0, 'row visible without tenant context or bypass — RLS fail-closed broken');
});

maybe('WITH CHECK blocks cross-tenant write', async () => {
  const a = 'tenant_rls_wc_a';
  const b = 'tenant_rls_wc_b';
  await withPgBypass(pg, async (c) => {
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

maybe('bypass does not leak outside withPgBypass transaction', async () => {
  await withPgBypass(pg, async (c) => {
    const v = await c.query(`SELECT current_setting('app.bypass_rls', true) AS v`);
    assert.equal(v.rows[0].v, 'on', 'bypass should be on inside withPgBypass txn');
  });
  // A subsequent tenant-scoped txn must NOT carry bypass.
  const anyT = 'tenant_rls_noleak';
  await withPgBypass(pg, async (c) => {
    await c.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1,$2,'free') ON CONFLICT DO NOTHING`, [anyT, 'NL']);
  });
  await withPgTenant(pg, anyT, async (c) => {
    const v = await c.query(`SELECT current_setting('app.bypass_rls', true) AS v`);
    assert.equal(v.rows[0].v, '', 'bypass leaked into a tenant txn — GUC is not transaction-scoped');
    const t = await c.query(`SELECT current_setting('app.current_tenant', true) AS v`);
    assert.equal(t.rows[0].v, anyT, 'current_tenant not set inside withPgTenant txn');
  });
});

test('teardown real postgres', async () => {
  if (!HAS_REAL_PG) return;
  await closePostgres();
});