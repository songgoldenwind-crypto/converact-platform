import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CellAdmissionController,
  CellAdmissionLedgerError,
  PostgresCellAdmissionLedger
} from '../src/agent-runtime/ivekit/placement/index.js';

test('Cell admission ledger migration persists fenced reservation state', () => {
  const sql = readFileSync(
    'src/migrations/083_ivekit_cell_admission_reservations.sql',
    'utf8'
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_cell_admission_reservations/i);
  assert.match(sql, /PRIMARY KEY \(region_id, zone_id, cell_id, reservation_id\)/i);
  assert.match(sql, /UNIQUE \(region_id, zone_id, cell_id, idempotency_key\)/i);
  assert.match(sql, /owner_epoch NUMERIC\(20,0\)/i);
  assert.match(sql, /cell_lease_epoch BIGINT NOT NULL/i);
  assert.match(sql, /state IN \('reserved', 'active', 'expired', 'closed'\)/i);
  assert.match(sql, /payload_hash ~ '\^\[a-f0-9\]\{64\}\$'/i);
  assert.match(sql, /idx_ivekit_cell_admission_reservations_due/i);
});

test('Cell admission ledger runtime migration preserves tenant RLS and exposes bounded Cell maintenance', () => {
  const sql = readFileSync(
    'src/migrations/104_ivekit_cell_admission_ledger_runtime.sql',
    'utf8'
  );

  assert.match(sql, /USING \(opc_rls_bypass\(\) OR tenant_id = opc_current_tenant\(\)\)/i);
  assert.match(sql, /WITH CHECK \(opc_rls_bypass\(\) OR tenant_id = opc_current_tenant\(\)\)/i);
  assert.match(sql, /opc_ivekit_cell_admission_recovery_rows/i);
  assert.match(sql, /opc_ivekit_expire_cell_admission_reservations/i);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path = pg_catalog, public/i);
  assert.match(sql, /p_terminal_retention_ms NOT BETWEEN 1000 AND 86400000/i);
  assert.match(sql, /p_limit NOT BETWEEN 1 AND 250000/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]+FROM PUBLIC/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION[\s\S]+TO opc_runtime/i);
});

test('Cell admission restores active and reserved capacity plus the current owner sequence', () => {
  const controller = fixture([
    checkpoint({
      reservation_id: 'reservation-active',
      state: 'active',
      owner_epoch: '12884901893',
      idempotency_key: 'idem-active',
      interaction_id: 'call-active'
    }),
    checkpoint({
      reservation_id: 'reservation-reserved',
      state: 'reserved',
      owner_epoch: '12884901894',
      idempotency_key: 'idem-reserved',
      interaction_id: 'call-reserved'
    })
  ]);

  const snapshot = controller.snapshot();
  assert.equal(snapshot.dimensions['voice.weighted_calls'].used, 1);
  assert.equal(snapshot.dimensions['voice.weighted_calls'].reserved, 1);
  assert.equal(snapshot.nodes[0]?.dimensions['voice.weighted_calls'].used, 1);
  assert.equal(snapshot.nodes[0]?.dimensions['voice.weighted_calls'].reserved, 1);

  const next = controller.reserve({
    request_id: 'request-next',
    idempotency_key: 'idem-next',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-next',
    interaction_id: 'call-next',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: { 'voice.weighted_calls': 1 }
  }, new Date('2026-07-16T08:00:02.000Z'));

  assert.equal(next.owner_epoch, '12884901895');
  assert.equal(controller.checkpoint(next.reservation_id).interaction_id, 'call-next');
});

test('Cell admission restore rejects future lease epochs and duplicate idempotency', () => {
  assert.throws(
    () => fixture([
      checkpoint({ owner_epoch: '17179869185' })
    ]),
    /future Cell lease epoch/i
  );
  assert.throws(
    () => fixture([
      checkpoint({ reservation_id: 'reservation-a' }),
      checkpoint({ reservation_id: 'reservation-b' })
    ]),
    /duplicate recovered admission idempotency/i
  );
});

test('Postgres Cell admission ledger fences writes through the active Cell lease', async () => {
  const pg = new QueryStub([checkpoint()]);
  const ledger = new PostgresCellAdmissionLedger(pg as any);
  const stored = await ledger.persist({
    checkpoint: checkpoint(),
    leader: leader(),
    now: '2026-07-16T08:00:00.000Z'
  });

  assert.equal(stored.reservation_id, 'reservation-a');
  assert.equal(pg.calls[0]?.text, 'BEGIN');
  assert.match(pg.calls[1]?.text || '', /set_config\('app\.current_tenant'/i);
  assert.deepEqual(pg.calls[1]?.params, ['tenant-a']);
  assert.match(pg.calls[2]?.text || '', /ivekit_cell_leases/i);
  assert.match(pg.calls[2]?.text || '', /owner_instance_id = \$\d+/i);
  assert.match(pg.calls[2]?.text || '', /lease_epoch = \$\d+::bigint/i);
  assert.match(pg.calls[2]?.text || '', /lease_expires_at > \$\d+::timestamptz/i);
  assert.match(pg.calls[2]?.text || '', /ON CONFLICT \(region_id, zone_id, cell_id, reservation_id\)/i);
  assert.equal(pg.calls[3]?.text, 'COMMIT');
});

test('Postgres Cell admission ledger fences a same-node active owner takeover', async () => {
  const pg = new QueryStub([
    checkpoint({
      state: 'active',
      owner_epoch: '12884901890',
      updated_at: '2026-07-16T08:00:01.000Z'
    })
  ]);
  const ledger = new PostgresCellAdmissionLedger(pg as any);
  await ledger.persist({
    checkpoint: checkpoint({
      state: 'active',
      owner_epoch: '12884901890',
      updated_at: '2026-07-16T08:00:01.000Z'
    }),
    leader: leader(),
    now: '2026-07-16T08:00:01.000Z'
  });

  const sql = pg.calls[2]?.text || '';
  assert.match(sql, /SET owner_epoch = EXCLUDED\.owner_epoch/i);
  assert.match(sql, /cell_lease_epoch = EXCLUDED\.cell_lease_epoch/i);
  assert.match(
    sql,
    /ivekit_cell_admission_reservations\.owner_node_id = EXCLUDED\.owner_node_id/i
  );
  assert.match(
    sql,
    /ivekit_cell_admission_reservations\.state = 'active'[\s\S]+EXCLUDED\.state = 'active'/i
  );
  assert.match(
    sql,
    /ivekit_cell_admission_reservations\.owner_epoch < EXCLUDED\.owner_epoch/i
  );
  assert.match(sql, /EXCLUDED\.cell_lease_epoch = \$5::bigint/i);
});

test('Postgres Cell admission ledger lets the active Cell leader persist monotonic terminal state after recovery', async () => {
  const pg = new QueryStub([
    checkpoint({
      state: 'closed',
      owner_epoch: '8589934593',
      updated_at: '2026-07-16T08:00:01.000Z'
    })
  ]);
  const ledger = new PostgresCellAdmissionLedger(pg as any);

  await ledger.persist({
    checkpoint: checkpoint({
      state: 'closed',
      owner_epoch: '8589934593',
      updated_at: '2026-07-16T08:00:01.000Z'
    }),
    leader: leader(),
    now: '2026-07-16T08:00:01.000Z'
  });

  const sql = pg.calls[2]?.text || '';
  assert.match(
    sql,
    /EXCLUDED\.state = 'closed'[\s\S]+EXCLUDED\.state = 'expired'/i
  );
  assert.match(
    sql,
    /ivekit_cell_admission_reservations\.state IN \('reserved', 'expired'\)[\s\S]+EXCLUDED\.state = 'expired'/i
  );
});

test('Postgres Cell admission ledger rejects a stale leader and loads bounded recovery rows', async () => {
  const stalePg = new QueryStub([]);
  const stale = new PostgresCellAdmissionLedger(stalePg as any);
  await assert.rejects(
    () => stale.persist({
      checkpoint: checkpoint(),
      leader: leader(),
      now: '2026-07-16T08:00:00.000Z'
    }),
    (error: unknown) => error instanceof CellAdmissionLedgerError &&
      error.code === 'stale_cell_lease'
  );
  assert.equal(stalePg.calls.at(-1)?.text, 'ROLLBACK');

  const pg = new QueryStub([
    checkpoint(),
    checkpoint({
      reservation_id: 'reservation-b',
      idempotency_key: 'idem-b',
      interaction_id: 'call-b'
    })
  ]);
  const ledger = new PostgresCellAdmissionLedger(pg as any);
  const rows = await ledger.load({
    leader: leader(),
    terminal_retention_ms: 300_000,
    now: '2026-07-16T08:00:00.000Z'
  });

  assert.equal(rows.length, 2);
  const recoverySql = (pg.calls[0]?.text || '').replace(/\s+/g, ' ');
  assert.match(
    recoverySql,
    /opc_ivekit_cell_admission_recovery_rows\(\s*\$1, \$2, \$3, \$4, \$5::bigint, \$6::timestamptz, \$7::bigint, \$8::integer\s*\)/i
  );
  assert.deepEqual(pg.calls[0]?.params, [
    'region-a',
    'zone-a',
    'cell-a',
    'admission-a',
    3,
    '2026-07-16T08:00:00.000Z',
    300_000,
    250_000
  ]);
});

test('Postgres Cell admission expiry sweep is lease fenced', async () => {
  const pg = new QueryStub([{ expired_count: '3' }]);
  const ledger = new PostgresCellAdmissionLedger(pg as any);
  const expired = await ledger.expireDue({
    leader: leader(),
    now: '2026-07-16T08:00:11.000Z'
  });

  assert.equal(expired, 3);
  const expirySql = (pg.calls[0]?.text || '').replace(/\s+/g, ' ');
  assert.match(
    expirySql,
    /opc_ivekit_expire_cell_admission_reservations\(\s*\$1, \$2, \$3, \$4, \$5::bigint, \$6::timestamptz\s*\)/i
  );
  assert.deepEqual(pg.calls[0]?.params, [
    'region-a',
    'zone-a',
    'cell-a',
    'admission-a',
    3,
    '2026-07-16T08:00:11.000Z'
  ]);
});

function fixture(
  recovered: ReturnType<typeof checkpoint>[] = []
): CellAdmissionController {
  return new CellAdmissionController({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['sip_voice'],
    reservation_ttl_ms: 10_000,
    dimensions: {
      'voice.weighted_calls': {
        unit: 'calls',
        safe_capacity: 10,
        used: 0,
        reserved: 0
      }
    },
    nodes: [{
      node_id: 'rustpbx-a',
      endpoint: 'https://rustpbx-a.internal',
      state: 'accepting',
      profile_ids: ['cell-10k-v1'],
      interaction_kinds: ['sip_voice'],
      dimensions: {
        'voice.weighted_calls': {
          unit: 'calls',
          safe_capacity: 10,
          used: 0,
          reserved: 0
        }
      }
    }],
    recovered_reservations: recovered,
    id_factory: () => 'reservation-next'
  });
}

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    reservation_id: 'reservation-a',
    state: 'reserved' as const,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: 'rustpbx-a',
    owner_epoch: '12884901889',
    endpoint: 'https://rustpbx-a.internal',
    expires_at: '2026-07-16T08:00:10.000Z',
    required_capacity: { 'voice.weighted_calls': 1 },
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-a',
    interaction_id: 'call-a',
    interaction_kind: 'sip_voice' as const,
    profile_id: 'cell-10k-v1',
    idempotency_key: 'idem-a',
    payload_hash: 'a'.repeat(64),
    created_at: '2026-07-16T08:00:00.000Z',
    updated_at: '2026-07-16T08:00:00.000Z',
    ...overrides
  };
}

function leader() {
  return {
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_instance_id: 'admission-a',
    cell_lease_epoch: 3
  };
}

class QueryStub {
  calls: Array<{ text: string; params: unknown[] }> = [];

  constructor(private readonly rows: Array<Record<string, unknown>>) {}

  async query(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    if (/^(?:BEGIN|COMMIT|ROLLBACK)$|set_config\(/i.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [...this.rows], rowCount: this.rows.length };
  }
}
