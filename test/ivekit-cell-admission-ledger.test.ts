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
  assert.match(pg.calls[0]?.text || '', /ivekit_cell_leases/i);
  assert.match(pg.calls[0]?.text || '', /owner_instance_id = \$\d+/i);
  assert.match(pg.calls[0]?.text || '', /lease_epoch = \$\d+::bigint/i);
  assert.match(pg.calls[0]?.text || '', /lease_expires_at > \$\d+::timestamptz/i);
  assert.match(pg.calls[0]?.text || '', /ON CONFLICT \(region_id, zone_id, cell_id, reservation_id\)/i);
});

test('Postgres Cell admission ledger rejects a stale leader and loads bounded recovery rows', async () => {
  const stale = new PostgresCellAdmissionLedger(new QueryStub([]) as any);
  await assert.rejects(
    () => stale.persist({
      checkpoint: checkpoint(),
      leader: leader(),
      now: '2026-07-16T08:00:00.000Z'
    }),
    (error: unknown) => error instanceof CellAdmissionLedgerError &&
      error.code === 'stale_cell_lease'
  );

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
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    terminal_retention_ms: 300_000,
    now: '2026-07-16T08:00:00.000Z'
  });

  assert.equal(rows.length, 2);
  assert.match(pg.calls[0]?.text || '', /state IN \('reserved', 'active'\)/i);
  assert.match(pg.calls[0]?.text || '', /updated_at >=/i);
  assert.match(pg.calls[0]?.text || '', /LIMIT \$\d+/i);
});

test('Postgres Cell admission expiry sweep is lease fenced', async () => {
  const pg = new QueryStub([{ expired_count: '3' }]);
  const ledger = new PostgresCellAdmissionLedger(pg as any);
  const expired = await ledger.expireDue({
    leader: leader(),
    now: '2026-07-16T08:00:11.000Z'
  });

  assert.equal(expired, 3);
  assert.match(pg.calls[0]?.text || '', /SET state = 'expired'/i);
  assert.match(pg.calls[0]?.text || '', /state = 'reserved'/i);
  assert.match(pg.calls[0]?.text || '', /ivekit_cell_leases/i);
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
    return { rows: [...this.rows], rowCount: this.rows.length };
  }
}
