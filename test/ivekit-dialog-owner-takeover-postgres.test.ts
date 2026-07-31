import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MemoryPg, type PgQueryable } from '../src/db-pg.js';
import {
  DialogRecoveryCapsuleCodec,
  type DialogRecoveryCapsulePayload
} from '../src/agent-runtime/ivekit/voice/dialog-recovery-capsule.js';
import {
  DialogOwnerTakeoverError,
  type DialogOwnerTakeoverClaimWrite
} from '../src/agent-runtime/ivekit/voice/dialog-owner-takeover.js';
import {
  dialogShadowPairHash,
  type DialogShadowRecord
} from '../src/agent-runtime/ivekit/voice/dialog-shadow.js';
import {
  PostgresDialogOwnerTakeoverStore
} from '../src/agent-runtime/ivekit/voice/postgres/dialog-owner-takeover-store.js';

const MIGRATION = 'src/migrations/102_ivekit_voice_dialog_takeovers.sql';
const CDR_MIGRATION = 'src/migrations/103_ivekit_voice_cdr_convergence.sql';

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

test('terminal shadow observation clears the durable pending-shadow repair fence', () => {
  const source = readFileSync(
    'src/agent-runtime/ivekit/voice/postgres/dialog-owner-takeover-store.ts',
    'utf8'
  );

  assert.match(
    source,
    /terminal_shadow_pending = CASE\s+WHEN \$5 = TRUE THEN FALSE ELSE terminal_shadow_pending END/
  );
});

test('CDR migration provides a durable, RLS-isolated terminal repair queue', () => {
  const sql = readFileSync(CDR_MIGRATION, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_voice_dialog_terminal_repairs/);
  assert.match(sql, /idx_ivekit_dialog_terminal_repair_claimed/);
  assert.match(sql, /terminal_cdr_call_id TEXT NOT NULL/);
  assert.match(sql, /terminal_cdr_receipt_id TEXT NOT NULL/);
  assert.match(sql, /terminal_cdr_region_id TEXT NOT NULL/);
  assert.match(sql, /terminal_cdr_durability_contract_id TEXT NOT NULL/);
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, terminal_cdr_receipt_id\)/
  );
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION opc_ivekit_terminal_shadow_repair_tenant_ids/
  );
  assert.match(
    sql,
    /ALTER TABLE ivekit_voice_dialog_terminal_repairs FORCE ROW LEVEL SECURITY/
  );
  assert.match(
    sql,
    /REVOKE ALL\s+ON FUNCTION opc_ivekit_terminal_shadow_repair_tenant_ids\(TEXT, INTEGER\)\s+FROM PUBLIC/
  );
});

test('terminal repair completion binds the source fault domain in both durable updates', () => {
  const source = readFileSync(
    'src/agent-runtime/ivekit/voice/postgres/dialog-owner-takeover-store.ts',
    'utf8'
  );

  assert.match(
    source,
    /source_owner_node_id = \$5\s+AND source_owner_fault_domain = \$15\s+AND source_owner_epoch = \$6/
  );
  assert.match(
    source,
    /owner_node_id = \$5\s+AND owner_fault_domain = \$15\s+AND owner_epoch = \$6/
  );
  assert.match(
    source,
    /JOIN ivekit_voice_cdr_receipts[\s\S]*terminal_cdr_receipt_id/
  );
  assert.match(
    source,
    /receipt\.region_id = ownership\.terminal_cdr_region_id/
  );
  assert.match(
    source,
    /receipt\.region_id = \$18/
  );
});

test('Postgres terminal repair reserves a higher epoch bound to the Region CDR', async () => {
  const pending = authorityRow({
    terminal: true,
    terminal_shadow_pending: true,
    terminal_cdr_sequence: '77',
    terminal_cdr_payload_hash: 'd'.repeat(64),
    terminal_cdr_call_id: 'call-a',
    terminal_cdr_receipt_id: 'receipt-a',
    terminal_cdr_region_id: 'region-a',
    terminal_cdr_durability_contract_id: 'contract-a'
  });
  const pg = new ScriptedPg([
    step('terminal-repair:assert-worker-lease', [{ worker_id: 'rustpbx-b' }]),
    step('terminal-repair:lock-authority', [pending]),
    step('terminal-repair:find-claim', []),
    step('terminal-repair:reserve-epoch', [{
      ...pending,
      owner_epoch_high_watermark: '8',
      revision: '2'
    }]),
    step('terminal-repair:insert-claim', [terminalRepairRow()])
  ]);
  const store = new PostgresDialogOwnerTakeoverStore(pg);

  const repair = await store.claimTerminalShadowRepair({
    repair_id: 'repair-a',
    tenant_id: 'tenant-a',
    identity: repairIdentity(),
    claimed_at: new Date('2026-07-27T01:00:00.000Z'),
    lease_ttl_ms: 5_000
  });

  assert.equal(repair?.repair_owner_epoch, 8);
  assert.equal(repair?.terminal_cdr_sequence, 77);
  assert.equal(repair?.terminal_cdr_payload_hash, 'd'.repeat(64));
  pg.assertDone();
});

test('Postgres terminal repair completion atomically clears only the bound fence', async () => {
  const records = terminalRepairPair();
  const pairHash = dialogShadowPairHash(records);
  const pg = new ScriptedPg([
    step('terminal-repair:complete', [authorityRow({
      owner_node_id: 'rustpbx-b',
      owner_fault_domain: 'zone-b-rack-1',
      owner_epoch: '8',
      owner_epoch_high_watermark: '8',
      shadow_pair_hash: pairHash,
      terminal: true,
      terminal_shadow_pending: false,
      terminal_cdr_sequence: '77',
      terminal_cdr_payload_hash: 'd'.repeat(64),
      terminal_cdr_call_id: 'call-a',
      terminal_cdr_receipt_id: 'receipt-a',
      terminal_cdr_region_id: 'region-a',
      terminal_cdr_durability_contract_id: 'contract-a',
      revision: '3'
    })])
  ]);
  const store = new PostgresDialogOwnerTakeoverStore(pg);

  const authority = await store.completeTerminalShadowRepair({
    claim: {
      repair_id: 'repair-a',
      tenant_id: 'tenant-a',
      cell_id: 'cell-a',
      call_session_ref: 'call-session-a',
      source_owner_node_id: 'rustpbx-a',
      source_owner_fault_domain: 'zone-a-rack-1',
      source_owner_epoch: 7,
      source_pair_hash: 'c'.repeat(64),
      repair_owner_node_id: 'rustpbx-b',
      repair_owner_fault_domain: 'zone-b-rack-1',
      repair_owner_epoch: 8,
      terminal_cdr_sequence: 77,
      terminal_cdr_payload_hash: 'd'.repeat(64),
      terminal_cdr_call_id: 'call-a',
      terminal_cdr_receipt_id: 'receipt-a',
      terminal_cdr_region_id: 'region-a',
      terminal_cdr_durability_contract_id: 'contract-a',
      claimed_at: '2026-07-27T01:00:00.000Z',
      expires_at: '2026-07-27T01:00:05.000Z'
    },
    records,
    pair_hash: pairHash,
    completed_at: new Date('2026-07-27T01:00:01.000Z')
  });

  assert.equal(authority.terminal, true);
  assert.equal(authority.terminal_shadow_pending, false);
  assert.equal(authority.owner_epoch, 8);
  pg.assertDone();
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
    terminal_shadow_pending: false,
    terminal_cdr_sequence: null,
    terminal_cdr_payload_hash: null,
    terminal_cdr_call_id: null,
    terminal_cdr_receipt_id: null,
    terminal_cdr_region_id: null,
    terminal_cdr_durability_contract_id: null,
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

function terminalRepairRow() {
  return {
    id: 'repair-a',
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a',
    source_owner_node_id: 'rustpbx-a',
    source_owner_fault_domain: 'zone-a-rack-1',
    source_owner_epoch: '7',
    source_pair_hash: 'c'.repeat(64),
    repair_owner_node_id: 'rustpbx-b',
    repair_owner_fault_domain: 'zone-b-rack-1',
    repair_owner_epoch: '8',
    terminal_cdr_sequence: '77',
    terminal_cdr_payload_hash: 'd'.repeat(64),
    terminal_cdr_call_id: 'call-a',
    terminal_cdr_receipt_id: 'receipt-a',
    terminal_cdr_region_id: 'region-a',
    terminal_cdr_durability_contract_id: 'contract-a',
    claimed_at: new Date('2026-07-27T01:00:00.000Z'),
    expires_at: new Date('2026-07-27T01:00:05.000Z')
  };
}

function repairIdentity() {
  return {
    spiffe_id:
      'spiffe://ivekit.internal/cells/cell-a/fault-domains/zone-b-rack-1/nodes/rustpbx-b',
    cell_id: 'cell-a',
    node_id: 'rustpbx-b',
    fault_domain: 'zone-b-rack-1'
  };
}

function terminalRepairPair(): [DialogShadowRecord, DialogShadowRecord] {
  return [repairRecord('caller'), repairRecord('callee')];
}

function repairRecord(leg: 'caller' | 'callee'): DialogShadowRecord {
  const payload = repairPayload(leg);
  const codec = repairCodec();
  return {
    schema_version: 2,
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    dialog_id: payload.dialog_id,
    call_id_hash: (leg === 'caller' ? 'a' : 'b').repeat(64),
    owner_node_id: 'rustpbx-b',
    owner_fault_domain: 'zone-b-rack-1',
    owner_epoch: 8,
    sequence: 1,
    state: 'terminated',
    local_tag: payload.local_tag,
    remote_tag: payload.remote_tag,
    route_set: payload.route_set,
    local_cseq: payload.local_cseq,
    remote_cseq: payload.remote_cseq,
    branch_hash: 'c'.repeat(64),
    final_response_hash: 'e'.repeat(64),
    auth_context_ref: 'auth-context-a',
    logical_offer_hash: 'a'.repeat(64),
    logical_answer_hash: 'b'.repeat(64),
    media_reservation_id: payload.media_reservation_id,
    provider_session_ref: payload.call_session_ref,
    cdr_sequence: 77,
    recorded_at: '2026-07-27T01:00:01.000Z',
    terminal: true,
    takeover_id: 'repair-a',
    terminal_cdr_payload_hash: 'd'.repeat(64),
    recovery_capsule: codec.seal(payload, {
      tenant_id: 'tenant-a',
      cell_id: 'cell-a',
      dialog_id: payload.dialog_id,
      owner_epoch: 8,
      sequence: 1
    })
  };
}

function repairPayload(
  leg: 'caller' | 'callee'
): DialogRecoveryCapsulePayload {
  const caller = leg === 'caller';
  return {
    schema_version: 1,
    call_session_ref: 'call-session-a',
    interaction_id: 'interaction-a',
    dialog_id: caller ? 'dialog-caller' : 'dialog-callee',
    peer_dialog_id: caller ? 'dialog-callee' : 'dialog-caller',
    leg,
    dialog_role: caller ? 'uas' : 'uac',
    raw_call_id: `${leg}-call-id@example.invalid`,
    local_tag: `${leg}-local`,
    remote_tag: `${leg}-remote`,
    from_uri: 'sip:caller@example.invalid',
    to_uri: 'sip:callee@example.invalid',
    local_contact_uri: 'sip:rustpbx-b@example.internal:5060',
    remote_uri: 'sip:peer@example.invalid',
    remote_contact_uri: 'sip:peer@198.51.100.20:5060',
    route_set: ['sip:edge-a.internal:5061;transport=tls;lr'],
    local_cseq: caller ? 22 : 31,
    remote_cseq: caller ? 18 : 29,
    supports_100rel: true,
    media_reservation_id: `reservation/${leg}`,
    cdr_sequence: 77
  };
}

function repairCodec() {
  return new DialogRecoveryCapsuleCodec({
    current: { key_id: 'repair-key', key: Buffer.alloc(32, 0x31) },
    random_bytes: (size) => Buffer.alloc(size, 0x32)
  });
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
    const marker = next.marker.startsWith('terminal-repair:')
      ? `ivekit-dialog-${next.marker}`
      : `ivekit-dialog-owner-takeover:${next.marker}`;
    assert.match(text, new RegExp(marker));
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
