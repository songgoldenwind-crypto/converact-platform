import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MemoryPg, type PgQueryable } from '../src/db-pg.js';
import {
  DialogOwnerTakeoverError,
  type DialogOwnerTakeoverClaimWrite
} from '../src/agent-runtime/ivekit/voice/dialog-owner-takeover.js';
import {
  PostgresDialogOwnerTakeoverStore
} from '../src/agent-runtime/ivekit/voice/postgres/dialog-owner-takeover-store.js';

const MIGRATION = 'src/migrations/102_ivekit_voice_dialog_takeovers.sql';

test('takeover migration persists current authority and append-only claim history with FORCE RLS', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_voice_dialog_ownership/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_voice_dialog_takeovers/);
  assert.match(sql, /owner_epoch_high_watermark/);
  assert.match(sql, /pending_takeover_id/);
  assert.match(sql, /pending_token_sha256/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_voice_dialog_node_leases/);
  assert.match(sql, /token_key_id TEXT NOT NULL/);
  assert.match(sql, /state IN \('prepared', 'shadow_prepared', 'consumed', 'expired'\)/);
  assert.match(sql, /UNIQUE \(tenant_id, cell_id, call_session_ref, idempotency_key\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/g);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON ivekit_voice_dialog_ownership/);
  assert.doesNotMatch(sql, /takeover_token(?!_sha256)/);
});

test('Postgres claim allocates pending epoch without replacing the active owner', async () => {
  const pg = new ScriptedPg([
    step('seed', []),
    step('lock', [authorityRow()]),
    step('assert-candidate-lease', [{ node_id: 'rustpbx-b' }]),
    step('replay', []),
    step('assert-previous-offline', [expiredOwnerLease()]),
    step('insert-attempt', [takeoverRow()]),
    step('publish-pending', [authorityRow({
      owner_epoch_high_watermark: '8',
      pending_takeover_id: 'takeover-a',
      pending_owner_node_id: 'rustpbx-b',
      pending_owner_fault_domain: 'zone-b-rack-1',
      pending_owner_epoch: '8',
      pending_token_sha256: 'd'.repeat(64),
      pending_expires_at: new Date('2026-07-26T01:00:05.000Z'),
      revision: '2'
    })])
  ]);
  const store = new PostgresDialogOwnerTakeoverStore(pg);

  const result = await store.claim(claimWrite());

  assert.equal(result.replayed, false);
  assert.equal(result.owner_epoch, 8);
  assert.equal(result.authority.owner_node_id, 'rustpbx-a');
  assert.equal(result.authority.owner_epoch, 7);
  assert.equal(result.authority.pending_owner_node_id, 'rustpbx-b');
  assert.equal(result.authority.pending_owner_epoch, 8);
  pg.assertDone();
});

test('Postgres consume atomically activates a shadow-prepared owner', async () => {
  const pending = authorityRow({
    owner_epoch_high_watermark: '8',
    pending_takeover_id: 'takeover-a',
    pending_owner_node_id: 'rustpbx-b',
    pending_owner_fault_domain: 'zone-b-rack-1',
    pending_owner_epoch: '8',
    pending_token_sha256: 'd'.repeat(64),
    pending_expires_at: new Date('2026-07-26T01:00:05.000Z'),
    revision: '2'
  });
  const pg = new ScriptedPg([
    step('lock', [pending]),
    step('attempt-by-id', [takeoverRow({
      state: 'shadow_prepared',
      prepared_pair_hash: 'e'.repeat(64)
    })]),
    step('consume-attempt', [takeoverRow({ state: 'consumed' })]),
    step('activate-owner', [authorityRow({
      owner_node_id: 'rustpbx-b',
      owner_fault_domain: 'zone-b-rack-1',
      owner_epoch: '8',
      owner_epoch_high_watermark: '8',
      revision: '3'
    })])
  ]);
  const store = new PostgresDialogOwnerTakeoverStore(pg);

  const result = await store.consume({
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a',
    takeover_id: 'takeover-a',
    owner_node_id: 'rustpbx-b',
    owner_epoch: 8,
    token_sha256: 'd'.repeat(64),
    prepared_pair_hash: 'e'.repeat(64),
    consumed_at: new Date('2026-07-26T01:00:01.000Z')
  });

  assert.equal(result.owner_node_id, 'rustpbx-b');
  assert.equal(result.owner_epoch, 8);
  assert.equal(result.pending_takeover_id, null);
  pg.assertDone();
});

test('Postgres claim resumes the same pending attempt after response loss', async () => {
  const pending = authorityRow({
    owner_epoch_high_watermark: '8',
    pending_takeover_id: 'takeover-a',
    pending_owner_node_id: 'rustpbx-b',
    pending_owner_fault_domain: 'zone-b-rack-1',
    pending_owner_epoch: '8',
    pending_token_sha256: 'd'.repeat(64),
    pending_expires_at: new Date('2026-07-26T01:00:05.000Z'),
    revision: '2'
  });
  const pg = new ScriptedPg([
    step('seed', []),
    step('lock', [pending]),
    step('assert-candidate-lease', [{ node_id: 'rustpbx-b' }]),
    step('replay', [takeoverRow()])
  ]);
  const store = new PostgresDialogOwnerTakeoverStore(pg);

  const result = await store.claim(claimWrite());

  assert.equal(result.replayed, true);
  assert.equal(result.takeover_id, 'takeover-a');
  assert.equal(result.owner_epoch, 8);
  assert.equal(result.token_key_id, 'recovery-2026-07');
  pg.assertDone();
});

test('Postgres consume retry returns the already active authority', async () => {
  const active = authorityRow({
    owner_node_id: 'rustpbx-b',
    owner_fault_domain: 'zone-b-rack-1',
    owner_epoch: '8',
    owner_epoch_high_watermark: '8',
    shadow_pair_hash: 'e'.repeat(64),
    revision: '3'
  });
  const pg = new ScriptedPg([
    step('lock', [active]),
    step('attempt-by-id', [takeoverRow({
      state: 'consumed',
      prepared_pair_hash: 'e'.repeat(64)
    })])
  ]);
  const store = new PostgresDialogOwnerTakeoverStore(pg);

  const result = await store.consume(consumeWrite());

  assert.equal(result.owner_node_id, 'rustpbx-b');
  assert.equal(result.owner_epoch, 8);
  assert.equal(result.pending_takeover_id, null);
  pg.assertDone();
});

test('Postgres claim requires an active candidate lease', async () => {
  const pg = new ScriptedPg([
    step('seed', []),
    step('lock', [authorityRow()]),
    step('assert-candidate-lease', [])
  ]);
  const store = new PostgresDialogOwnerTakeoverStore(pg);

  await assert.rejects(
    store.claim(claimWrite()),
    (error) => code(error) === 'dialog_owner_takeover_candidate_inactive'
  );
  pg.assertDone();
});

test('Postgres claim refuses takeover while the previous owner lease is active', async () => {
  const pg = new ScriptedPg([
    step('seed', []),
    step('lock', [authorityRow()]),
    step('assert-candidate-lease', [{ node_id: 'rustpbx-b' }]),
    step('replay', []),
    step('assert-previous-offline', [{
      ...expiredOwnerLease(),
      lease_expires_at: new Date('2026-07-26T01:00:00.001Z')
    }])
  ]);
  const store = new PostgresDialogOwnerTakeoverStore(pg);

  await assert.rejects(
    store.claim(claimWrite()),
    (error) => code(error) === 'dialog_owner_takeover_previous_owner_active'
  );
  pg.assertDone();
});

test('Postgres heartbeat binds a node lease to its SPIFFE identity', async () => {
  const identity = {
    spiffe_id:
      'spiffe://ivekit.internal/cells/cell-a/fault-domains/zone-b-rack-1/nodes/rustpbx-b',
    cell_id: 'cell-a',
    node_id: 'rustpbx-b',
    fault_domain: 'zone-b-rack-1'
  };
  const pg = new ScriptedPg([
    step('heartbeat-node', [{
      ...identity,
      heartbeat_at: new Date('2026-07-26T01:00:00.000Z'),
      lease_expires_at: new Date('2026-07-26T01:00:03.000Z'),
      revision: '2'
    }])
  ]);
  const store = new PostgresDialogOwnerTakeoverStore(pg);

  const lease = await store.heartbeatNode({
    identity,
    heartbeat_at: new Date('2026-07-26T01:00:00.000Z'),
    lease_ttl_ms: 3_000
  });

  assert.equal(lease.spiffe_id, identity.spiffe_id);
  assert.equal(lease.lease_expires_at, '2026-07-26T01:00:03.000Z');
  assert.equal(lease.revision, 2);
  pg.assertDone();
});

test('Postgres claim rejects stale active owner before reserving another epoch', async () => {
  const pg = new ScriptedPg([
    step('seed', []),
    step('lock', [authorityRow({
      owner_node_id: 'rustpbx-c',
      owner_epoch: '9',
      owner_epoch_high_watermark: '9'
    })]),
    step('assert-candidate-lease', [{ node_id: 'rustpbx-b' }]),
    step('replay', [])
  ]);
  const store = new PostgresDialogOwnerTakeoverStore(pg);

  await assert.rejects(
    store.claim(claimWrite()),
    (error) => code(error) === 'dialog_owner_takeover_stale_owner'
  );
  pg.assertDone();
});

function claimWrite(): DialogOwnerTakeoverClaimWrite {
  return {
    takeover_id: 'takeover-a',
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a',
    previous_owner_node_id: 'rustpbx-a',
    previous_owner_fault_domain: 'zone-a-rack-1',
    expected_owner_epoch: 7,
    owner_node_id: 'rustpbx-b',
    owner_fault_domain: 'zone-b-rack-1',
    owner_spiffe_id:
      'spiffe://ivekit.internal/cells/cell-a/fault-domains/zone-b-rack-1/nodes/rustpbx-b',
    shadow_pair_hash: 'c'.repeat(64),
    token_key_id: 'recovery-2026-07',
    token_sha256: 'd'.repeat(64),
    token_expires_at: '2026-07-26T01:00:05.000Z',
    idempotency_key: 'takeover-request-a',
    request_hash: 'e'.repeat(64),
    reason: 'owner_heartbeat_expired',
    claimed_at: new Date('2026-07-26T01:00:00.000Z')
  };
}

function consumeWrite() {
  return {
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a',
    takeover_id: 'takeover-a',
    owner_node_id: 'rustpbx-b',
    owner_epoch: 8,
    token_sha256: 'd'.repeat(64),
    prepared_pair_hash: 'e'.repeat(64),
    consumed_at: new Date('2026-07-26T01:00:01.000Z')
  };
}

function authorityRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a',
    profile: 'VOICE-HA-T1',
    owner_node_id: 'rustpbx-a',
    owner_fault_domain: 'zone-a-rack-1',
    owner_epoch: '7',
    owner_epoch_high_watermark: '7',
    shadow_pair_hash: 'c'.repeat(64),
    terminal: false,
    pending_takeover_id: null,
    pending_owner_node_id: null,
    pending_owner_fault_domain: null,
    pending_owner_epoch: null,
    pending_token_sha256: null,
    pending_expires_at: null,
    revision: '1',
    ...overrides
  };
}

function takeoverRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'takeover-a',
    owner_epoch: '8',
    expires_at: new Date('2026-07-26T01:00:05.000Z'),
    request_hash: 'e'.repeat(64),
    token_key_id: 'recovery-2026-07',
    prepared_pair_hash: null,
    state: 'prepared',
    ...overrides
  };
}

function expiredOwnerLease() {
  return {
    node_id: 'rustpbx-a',
    fault_domain: 'zone-a-rack-1',
    lease_expires_at: new Date('2026-07-26T00:59:59.999Z')
  };
}

interface ScriptStep {
  marker: string;
  rows: Record<string, unknown>[];
}

function step(marker: string, rows: Record<string, unknown>[]): ScriptStep {
  return { marker, rows };
}

class ScriptedPg extends MemoryPg implements PgQueryable {
  readonly #steps: ScriptStep[];

  constructor(steps: ScriptStep[]) {
    super();
    this.#steps = [...steps];
  }

  override async query(text: string, params: unknown[] = []): Promise<any> {
    const next = this.#steps.shift();
    assert.ok(next, `unexpected query: ${text}`);
    assert.match(text, new RegExp(`ivekit-dialog-owner-takeover:${next.marker}`));
    assert.equal(
      params.some((value) => String(value).includes('takeover-token')),
      false
    );
    return {
      rows: structuredClone(next.rows),
      rowCount: next.rows.length,
      command: '',
      oid: 0,
      fields: []
    };
  }

  assertDone(): void {
    assert.deepEqual(this.#steps, []);
  }
}

function code(error: unknown): string {
  return error instanceof DialogOwnerTakeoverError ? error.code : '';
}
