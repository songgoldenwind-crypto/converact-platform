import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CellLeaseError,
  PostgresCellLeaseRepository,
  startCellLeaseMaintainer
} from '../src/agent-runtime/ivekit/placement/index.js';

test('Cell lease migration stores one fenced owner per Region/Zone/Cell', () => {
  const sql = readFileSync('src/migrations/078_ivekit_cell_leases.sql', 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_cell_leases/i);
  assert.match(sql, /PRIMARY KEY \(region_id, zone_id, cell_id\)/i);
  assert.match(sql, /lease_epoch BIGINT NOT NULL/i);
  assert.match(sql, /lease_epoch <= 4294967295/i);
  assert.match(sql, /state IN \('active', 'released'\)/i);
  assert.match(sql, /lease_expires_at TIMESTAMPTZ NOT NULL/i);
});

test('Cell topology migration binds every lease to a SHA-256 configuration', () => {
  const sql = readFileSync(
    'src/migrations/084_ivekit_cell_lease_topology.sql',
    'utf8'
  );
  assert.match(sql, /ADD COLUMN IF NOT EXISTS topology_sha256 TEXT/i);
  assert.match(sql, /SET topology_sha256 = repeat\('0', 64\)/i);
  assert.match(sql, /ALTER COLUMN topology_sha256 SET NOT NULL/i);
  assert.match(sql, /topology_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/i);
});

test('Postgres Cell lease claim increments epoch only for takeover or expired ownership', async () => {
  const pg = new QueryStub([{
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_instance_id: 'admission-a',
    lease_epoch: '8',
    topology_sha256: 'a'.repeat(64),
    lease_expires_at: '2026-07-16T09:00:30.000Z'
  }]);
  const repository = new PostgresCellLeaseRepository(pg as any);
  const lease = await repository.claim({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_instance_id: 'admission-a',
    topology_sha256: 'a'.repeat(64),
    lease_ttl_ms: 30_000,
    now: '2026-07-16T09:00:00.000Z'
  });
  assert.equal(lease.lease_epoch, 8);
  assert.equal(lease.topology_sha256, 'a'.repeat(64));
  assert.match(pg.calls[0]?.text || '', /ON CONFLICT \(region_id, zone_id, cell_id\)/i);
  assert.match(pg.calls[0]?.text || '', /lease_epoch \+ 1/i);
  assert.match(
    pg.calls[0]?.text || '',
    /ivekit_cell_leases\.topology_sha256\s*=\s*EXCLUDED\.topology_sha256/i
  );
  assert.match(pg.calls[0]?.text || '', /lease_expires_at <= \$7::timestamptz/i);
  assert.equal(pg.calls[0]?.params[4], 'a'.repeat(64));
});

test('Postgres Cell lease renewal and release reject stale epochs or topology', async () => {
  const renewPg = new QueryStub([]);
  const repository = new PostgresCellLeaseRepository(renewPg as any);
  await assert.rejects(
    () => repository.renew({
      region_id: 'region-a',
      zone_id: 'zone-a',
      cell_id: 'cell-a',
      owner_instance_id: 'admission-old',
      lease_epoch: 7,
      topology_sha256: 'b'.repeat(64),
      lease_ttl_ms: 30_000,
      now: '2026-07-16T09:00:10.000Z'
    }),
    (error: unknown) => error instanceof CellLeaseError &&
      error.code === 'stale_cell_lease'
  );
  assert.match(renewPg.calls[0]?.text || '', /lease_epoch = \$5::bigint/i);
  assert.match(renewPg.calls[0]?.text || '', /topology_sha256 = \$6/i);
  assert.match(renewPg.calls[0]?.text || '', /lease_expires_at > \$8::timestamptz/i);

  const releasePg = new QueryStub([]);
  const releaseRepository = new PostgresCellLeaseRepository(releasePg as any);
  await assert.rejects(
    () => releaseRepository.release({
      region_id: 'region-a',
      zone_id: 'zone-a',
      cell_id: 'cell-a',
      owner_instance_id: 'admission-old',
      lease_epoch: 7,
      topology_sha256: 'b'.repeat(64),
      now: '2026-07-16T09:00:10.000Z'
    }),
    (error: unknown) => error instanceof CellLeaseError &&
      error.code === 'stale_cell_lease'
  );
});

test('Cell lease maintainer drains immediately after renewal loss', async () => {
  let renewals = 0;
  let released = 0;
  let lost = 0;
  const maintainer = await startCellLeaseMaintainer({
    repository: {
      async claim(input) {
        return {
          region_id: input.region_id,
          zone_id: input.zone_id,
          cell_id: input.cell_id,
          owner_instance_id: input.owner_instance_id,
          lease_epoch: 9,
          topology_sha256: input.topology_sha256,
          lease_expires_at: '2026-07-16T09:00:30.000Z'
        };
      },
      async renew(input) {
        renewals += 1;
        throw new CellLeaseError('stale_cell_lease', 409);
      },
      async release() {
        released += 1;
      }
    },
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_instance_id: 'admission-a',
    lease_ttl_ms: 3_000,
    renewal_interval_ms: 100,
    now: () => '2026-07-16T09:00:00.000Z',
    on_lost: async () => {
      lost += 1;
    },
    topology_sha256: 'c'.repeat(64)
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(maintainer.lease.lease_epoch, 9);
  assert.equal(renewals, 1);
  assert.equal(lost, 1);
  await maintainer.stop();
  assert.equal(released, 0);
});

test('Cell lease maintainer waits as standby until a retryable lease becomes available', async () => {
  let claims = 0;
  let waiting = 0;
  let released = 0;
  const maintainer = await startCellLeaseMaintainer({
    repository: {
      async claim(input) {
        claims += 1;
        if (claims < 3) {
          throw new CellLeaseError('cell_lease_unavailable', 409, true);
        }
        return {
          region_id: input.region_id,
          zone_id: input.zone_id,
          cell_id: input.cell_id,
          owner_instance_id: input.owner_instance_id,
          lease_epoch: 10,
          topology_sha256: input.topology_sha256,
          lease_expires_at: '2026-07-16T09:00:30.000Z'
        };
      },
      async renew() {
        throw new Error('renew must not run during this test');
      },
      async release() {
        released += 1;
      }
    },
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_instance_id: 'admission-standby',
    lease_ttl_ms: 3_000,
    renewal_interval_ms: 1_000,
    claim_retry_interval_ms: 10,
    topology_sha256: 'd'.repeat(64),
    on_waiting() {
      waiting += 1;
    },
    on_lost() {}
  });

  assert.equal(maintainer.lease.lease_epoch, 10);
  assert.equal(claims, 3);
  assert.equal(waiting, 2);
  await maintainer.stop();
  assert.equal(released, 1);
});

test('Cell lease standby wait is abortable and never retries non-retryable failures', async () => {
  const abortController = new AbortController();
  let claims = 0;
  const waiting = startCellLeaseMaintainer({
    repository: {
      async claim() {
        claims += 1;
        throw new CellLeaseError('cell_lease_unavailable', 409, true);
      },
      async renew() {
        throw new Error('unreachable');
      },
      async release() {}
    },
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_instance_id: 'admission-standby',
    lease_ttl_ms: 3_000,
    renewal_interval_ms: 1_000,
    claim_retry_interval_ms: 100,
    topology_sha256: 'e'.repeat(64),
    signal: abortController.signal,
    on_waiting() {
      abortController.abort();
    },
    on_lost() {}
  });
  await assert.rejects(
    () => waiting,
    (error: unknown) => error instanceof CellLeaseError &&
      error.code === 'cell_lease_acquire_aborted'
  );
  assert.equal(claims, 1);

  await assert.rejects(
    () => startCellLeaseMaintainer({
      repository: {
        async claim() {
          throw new CellLeaseError('cell_lease_identifier_invalid', 400);
        },
        async renew() {
          throw new Error('unreachable');
        },
        async release() {}
      },
      region_id: 'region-a',
      zone_id: 'zone-a',
      cell_id: 'cell-a',
      owner_instance_id: 'admission-bad',
      lease_ttl_ms: 3_000,
      renewal_interval_ms: 1_000,
      claim_retry_interval_ms: 10,
      topology_sha256: 'f'.repeat(64),
      on_lost() {}
    }),
    (error: unknown) => error instanceof CellLeaseError &&
      error.code === 'cell_lease_identifier_invalid'
  );
});

class QueryStub {
  calls: Array<{ text: string; params: unknown[] }> = [];

  constructor(private readonly rows: Array<Record<string, unknown>>) {}

  async query(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    return { rows: [...this.rows], rowCount: this.rows.length };
  }
}
