import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import { withPgTenant } from '../src/db-pg-tenant.js';
import {
  DialogRecoveryCapsuleCodec,
  type DialogRecoveryCapsulePayload
} from '../src/agent-runtime/ivekit/voice/dialog-recovery-capsule.js';
import {
  parseVoiceDualLegCdr
} from '../src/agent-runtime/ivekit/voice/cdr-convergence.js';
import {
  DialogOwnerTakeoverError,
  type DialogPeerIdentity
} from '../src/agent-runtime/ivekit/voice/dialog-owner-takeover.js';
import {
  dialogShadowPairHash,
  type DialogShadowRecord
} from '../src/agent-runtime/ivekit/voice/dialog-shadow.js';
import type {
  DialogTerminalShadowRepairClaim
} from '../src/agent-runtime/ivekit/voice/dialog-terminal-shadow-repair.js';
import {
  PostgresDialogOwnerTakeoverStore
} from '../src/agent-runtime/ivekit/voice/postgres/dialog-owner-takeover-store.js';
import {
  PostgresVoiceCdrConvergenceStore
} from '../src/agent-runtime/ivekit/voice/postgres/cdr-convergence-store.js';

const adminUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_DATABASE_URL || '';
const runtimeUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_DATABASE_URL || '';
const postgresTest = adminUrl && runtimeUrl ? test : test.skip;
const TENANT_A = 'ivekit_terminal_repair_a';
const TENANT_B = 'ivekit_terminal_repair_b';
const CELL_ID = 'cell-terminal-repair';
const CALL_SESSION_REF = 'call-terminal-repair';
const CDR_CALL_ID = 'interaction-terminal-repair';
const PROFILE_ID = 'profile-terminal-repair';
const REGION_ID = 'region-terminal-repair';
const DURABILITY_ID = 'durability-terminal-repair';
const RECEIPT_ID = 'receipt-terminal-repair';
const SOURCE_PAIR_HASH = 'c'.repeat(64);
const CDR_PAYLOAD_HASH = terminalCdrEnvelope().payload_hash;

postgresTest('terminal shadow repair is cross-process safe, CDR-bound and RLS-isolated', async (t) => {
  const admin = new Pool({ connectionString: adminUrl });
  const runtime = new Pool({ connectionString: runtimeUrl });
  t.after(async () => {
    await cleanup(admin);
    await runtime.end();
    await admin.end();
  });

  await cleanup(admin);
  await admin.query(
    'INSERT INTO tenants (id, name) VALUES ($1, $2), ($3, $4)',
    [TENANT_A, 'Terminal repair A', TENANT_B, 'Terminal repair B']
  );
  await admin.query(
    `INSERT INTO ivekit_voice_deployment_profiles
       (id, tenant_id, name, adapter, status)
     VALUES ($1, $2, 'Terminal repair profile', 'rustpbx', 'enabled')`,
    [PROFILE_ID, TENANT_A]
  );
  await admin.query(
    `INSERT INTO ivekit_voice_calls
       (id, tenant_id, business_ref_type, business_ref_id,
        provider_profile_id, provider_call_id, direction, state,
        from_address_kind, from_address_ciphertext, from_address_hmac,
        from_address_redacted, to_address_kind, to_address_ciphertext,
        to_address_hmac, to_address_redacted, idempotency_key)
     VALUES
       ($1, $2, 'test', 'terminal-repair', $3, $4, 'outbound', 'completed',
        'e164', 'cipher-from', $5, '+86******01',
        'e164', 'cipher-to', $6, '+86******02', 'terminal-repair-call')`,
    [
      CDR_CALL_ID,
      TENANT_A,
      PROFILE_ID,
      CALL_SESSION_REF,
      'a'.repeat(64),
      'b'.repeat(64)
    ]
  );
  await admin.query(
    `INSERT INTO ivekit_voice_cdr_durability_contracts
       (id, region_id, store_kind, fault_domains, quorum_size, status,
        config_hash, verified_at)
     VALUES
       ($1, $2, 'postgresql_sync_quorum', ARRAY['zone-a', 'zone-b'], 2,
        'active', $3, $4::timestamptz)`,
    [
      DURABILITY_ID,
      REGION_ID,
      'e'.repeat(64),
      '2026-07-27T01:00:00.000Z'
    ]
  );
  await admin.query(
    `INSERT INTO ivekit_voice_dialog_ownership
      (tenant_id, cell_id, call_session_ref, profile,
       owner_node_id, owner_fault_domain, owner_epoch,
       owner_epoch_high_watermark, shadow_pair_hash, terminal, revision,
       created_at, updated_at)
     VALUES
      ($1, $2, $3, 'VOICE-HA-T1', 'rustpbx-a', 'zone-a-rack-1', 7, 7,
       $4, FALSE, 1, $5::timestamptz, $5::timestamptz)`,
    [
      TENANT_A,
      CELL_ID,
      CALL_SESSION_REF,
      SOURCE_PAIR_HASH,
      '2026-07-27T01:00:00.000Z'
    ]
  );
  const cdrEnvelope = terminalCdrEnvelope();
  const cdrReceipt = await new PostgresVoiceCdrConvergenceStore(runtime, {
    region_id: REGION_ID,
    id: () => RECEIPT_ID,
    now: () => new Date('2026-07-27T01:00:01.000Z')
  }).converge({
    tenant_id: TENANT_A,
    profile_id: PROFILE_ID,
    authoritative_availability_profile: 'VOICE-HA-T1',
    envelope: cdrEnvelope
  });
  assert.equal(cdrReceipt.receipt_id, RECEIPT_ID);
  assert.equal(cdrReceipt.acknowledged_payload_hash, CDR_PAYLOAD_HASH);

  const publicPrivilege = await admin.query<{ allowed: boolean }>(
    `SELECT has_function_privilege(
       'public',
       'opc_ivekit_terminal_shadow_repair_tenant_ids(text,integer)',
       'EXECUTE'
     ) AS allowed`
  );
  assert.equal(publicPrivilege.rows[0]?.allowed, false);

  const store = new PostgresDialogOwnerTakeoverStore(runtime);
  const claimedAt = new Date();
  const identityB = identity('rustpbx-b', 'zone-b-rack-1');
  const identityC = identity('rustpbx-c', 'zone-c-rack-1');
  await Promise.all([
    store.heartbeatTerminalShadowRepairWorker({
      identity: identityB,
      heartbeat_at: claimedAt,
      lease_ttl_ms: 60_000
    }),
    store.heartbeatTerminalShadowRepairWorker({
      identity: identityC,
      heartbeat_at: claimedAt,
      lease_ttl_ms: 60_000
    })
  ]);
  const repairLeaseCounts = await admin.query<{
    repair_workers: string;
    dialog_owners: string;
  }>(
    `SELECT
       (SELECT count(*)::text
        FROM ivekit_voice_terminal_repair_worker_leases
        WHERE cell_id = $1) AS repair_workers,
       (SELECT count(*)::text
        FROM ivekit_voice_dialog_node_leases
        WHERE cell_id = $1) AS dialog_owners`,
    [CELL_ID]
  );
  assert.deepEqual(repairLeaseCounts.rows[0], {
    repair_workers: '2',
    dialog_owners: '0'
  });

  assert.deepEqual(
    await store.pendingTenantIds({ cell_id: CELL_ID, limit: 32 }),
    [TENANT_A]
  );
  const competingClaims = await Promise.all([
    store.claimTerminalShadowRepair({
      repair_id: 'terminal-repair-b',
      tenant_id: TENANT_A,
      identity: identityB,
      claimed_at: claimedAt,
      lease_ttl_ms: 10_000
    }),
    store.claimTerminalShadowRepair({
      repair_id: 'terminal-repair-c',
      tenant_id: TENANT_A,
      identity: identityC,
      claimed_at: claimedAt,
      lease_ttl_ms: 10_000
    })
  ]);
  const claims = competingClaims.filter(
    (value): value is DialogTerminalShadowRepairClaim => value !== null
  );
  assert.equal(claims.length, 1);
  assert.equal(competingClaims.filter((value) => value === null).length, 1);
  const claim = claims[0]!;
  assert.equal(claim.source_pair_hash, SOURCE_PAIR_HASH);
  assert.equal(claim.source_owner_fault_domain, 'zone-a-rack-1');
  assert.equal(claim.terminal_cdr_sequence, 77);
  assert.equal(claim.terminal_cdr_payload_hash, CDR_PAYLOAD_HASH);
  assert.equal(claim.terminal_cdr_call_id, CDR_CALL_ID);
  assert.equal(claim.terminal_cdr_receipt_id, RECEIPT_ID);
  assert.equal(claim.terminal_cdr_region_id, REGION_ID);
  assert.equal(claim.terminal_cdr_durability_contract_id, DURABILITY_ID);
  assert.equal(claim.repair_owner_epoch, 8);

  const tenantARepairs = await withPgTenant(runtime, TENANT_A, (pg) => pg.query(
    'SELECT id FROM ivekit_voice_dialog_terminal_repairs ORDER BY id'
  ));
  const tenantBRepairs = await withPgTenant(runtime, TENANT_B, (pg) => pg.query(
    'SELECT id FROM ivekit_voice_dialog_terminal_repairs ORDER BY id'
  ));
  assert.equal(tenantARepairs.rowCount, 1);
  assert.equal(tenantBRepairs.rowCount, 0);

  const records = terminalPair(claim);
  const pairHash = dialogShadowPairHash(records);
  await admin.query(
    `UPDATE ivekit_voice_dialog_ownership
     SET owner_fault_domain = 'zone-tampered'
     WHERE tenant_id = $1 AND cell_id = $2 AND call_session_ref = $3`,
    [TENANT_A, CELL_ID, CALL_SESSION_REF]
  );
  await assert.rejects(
    store.completeTerminalShadowRepair({
      claim,
      records,
      pair_hash: pairHash,
      completed_at: new Date()
    }),
    (error) => error instanceof DialogOwnerTakeoverError &&
      error.code === 'dialog_owner_takeover_store_unavailable'
  );
  const stillClaimed = await admin.query<{ state: string }>(
    'SELECT state FROM ivekit_voice_dialog_terminal_repairs WHERE id = $1',
    [claim.repair_id]
  );
  assert.equal(stillClaimed.rows[0]?.state, 'claimed');

  await admin.query(
    `UPDATE ivekit_voice_dialog_ownership
     SET owner_fault_domain = 'zone-a-rack-1'
     WHERE tenant_id = $1 AND cell_id = $2 AND call_session_ref = $3`,
    [TENANT_A, CELL_ID, CALL_SESSION_REF]
  );
  const authority = await store.completeTerminalShadowRepair({
    claim,
    records,
    pair_hash: pairHash,
    completed_at: new Date()
  });
  assert.equal(authority.terminal, true);
  assert.equal(authority.terminal_shadow_pending, false);
  assert.equal(authority.owner_node_id, claim.repair_owner_node_id);
  assert.equal(authority.owner_fault_domain, claim.repair_owner_fault_domain);
  assert.equal(authority.owner_epoch, claim.repair_owner_epoch);
  assert.equal(authority.shadow_pair_hash, pairHash);

  const committed = await withPgTenant(runtime, TENANT_A, (pg) => pg.query<{
    state: string;
    terminal_pair_hash: string;
  }>(
    `SELECT state, terminal_pair_hash
     FROM ivekit_voice_dialog_terminal_repairs
     WHERE id = $1`,
    [claim.repair_id]
  ));
  assert.deepEqual(committed.rows[0], {
    state: 'committed',
    terminal_pair_hash: pairHash
  });
  assert.deepEqual(
    await store.pendingTenantIds({ cell_id: CELL_ID, limit: 32 }),
    []
  );
});

async function cleanup(admin: Pool): Promise<void> {
  const tenants = [TENANT_A, TENANT_B];
  await admin.query(
    'DELETE FROM ivekit_voice_terminal_repair_worker_leases WHERE cell_id = $1',
    [CELL_ID]
  );
  await admin.query(
    'DELETE FROM ivekit_voice_dialog_terminal_repairs WHERE tenant_id = ANY($1::text[])',
    [tenants]
  );
  await admin.query(
    'DELETE FROM ivekit_voice_dialog_ownership WHERE tenant_id = ANY($1::text[])',
    [tenants]
  );
  await admin.query(
    'DELETE FROM ivekit_voice_cdr_receipts WHERE tenant_id = ANY($1::text[])',
    [tenants]
  );
  await admin.query(
    'DELETE FROM ivekit_voice_cdr_submissions WHERE tenant_id = ANY($1::text[])',
    [tenants]
  );
  await admin.query(
    'DELETE FROM ivekit_voice_cdr_legs WHERE tenant_id = ANY($1::text[])',
    [tenants]
  );
  await admin.query(
    'DELETE FROM ivekit_voice_cdr_calls WHERE tenant_id = ANY($1::text[])',
    [tenants]
  );
  await admin.query(
    'DELETE FROM tenants WHERE id = ANY($1::text[])',
    [tenants]
  );
}

function terminalCdrEnvelope() {
  return parseVoiceDualLegCdr({
    schema_version: '1.0.0',
    state: 'pending_unacknowledged',
    interaction_id: CDR_CALL_ID,
    provider_call_id: CALL_SESSION_REF,
    cell_id: CELL_ID,
    owner_node_id: 'rustpbx-a',
    expected_region_id: REGION_ID,
    availability_profile: 'VOICE-HA-T1',
    owner_epoch: '7',
    sequence: '77',
    call: {
      winning_branch_hash: null,
      early_media: true,
      transfer_chain_hashes: [],
      media_timeout: false,
      started_at: '2026-07-27T00:59:50.000Z',
      answered_at: '2026-07-27T00:59:55.000Z',
      ended_at: '2026-07-27T01:00:00.000Z'
    },
    legs: [
      {
        role: 'caller',
        dialog_id_hash: '1'.repeat(64),
        direction: 'inbound',
        sip_final_code: 200,
        hangup_cause: 'normal_clearing',
        answered_at: '2026-07-27T00:59:55.000Z',
        ended_at: '2026-07-27T01:00:00.000Z',
        media_result: 'relayed',
        reservation_ref: 'reservation-terminal-caller',
        owner_epoch: '7',
        route_snapshot_revision: '11'
      },
      {
        role: 'callee',
        dialog_id_hash: '2'.repeat(64),
        direction: 'outbound',
        sip_final_code: 200,
        hangup_cause: 'normal_clearing',
        answered_at: '2026-07-27T00:59:55.000Z',
        ended_at: '2026-07-27T01:00:00.000Z',
        media_result: 'relayed',
        reservation_ref: 'reservation-terminal-callee',
        owner_epoch: '7',
        route_snapshot_revision: '11'
      }
    ]
  });
}

function identity(nodeId: string, faultDomain: string): DialogPeerIdentity {
  return {
    spiffe_id:
      `spiffe://ivekit.internal/cells/${CELL_ID}/fault-domains/${faultDomain}/nodes/${nodeId}`,
    cell_id: CELL_ID,
    node_id: nodeId,
    fault_domain: faultDomain
  };
}

function terminalPair(
  claim: DialogTerminalShadowRepairClaim
): [DialogShadowRecord, DialogShadowRecord] {
  return [
    terminalRecord(claim, 'caller'),
    terminalRecord(claim, 'callee')
  ];
}

function terminalRecord(
  claim: DialogTerminalShadowRepairClaim,
  leg: 'caller' | 'callee'
): DialogShadowRecord {
  const payload = recoveryPayload(leg);
  return {
    schema_version: 2,
    tenant_id: TENANT_A,
    cell_id: CELL_ID,
    dialog_id: payload.dialog_id,
    call_id_hash: (leg === 'caller' ? 'a' : 'b').repeat(64),
    owner_node_id: claim.repair_owner_node_id,
    owner_fault_domain: claim.repair_owner_fault_domain,
    owner_epoch: claim.repair_owner_epoch,
    sequence: 1,
    state: 'terminated',
    local_tag: payload.local_tag,
    remote_tag: payload.remote_tag,
    route_set: payload.route_set,
    local_cseq: payload.local_cseq,
    remote_cseq: payload.remote_cseq,
    branch_hash: 'f'.repeat(64),
    final_response_hash: 'e'.repeat(64),
    auth_context_ref: 'auth-terminal-repair',
    logical_offer_hash: 'a'.repeat(64),
    logical_answer_hash: 'b'.repeat(64),
    media_reservation_id: payload.media_reservation_id,
    provider_session_ref: CALL_SESSION_REF,
    cdr_sequence: claim.terminal_cdr_sequence,
    recorded_at: '2026-07-27T01:00:01.000Z',
    terminal: true,
    takeover_id: claim.repair_id,
    terminal_cdr_payload_hash: claim.terminal_cdr_payload_hash,
    recovery_capsule: codec().seal(payload, {
      tenant_id: TENANT_A,
      cell_id: CELL_ID,
      dialog_id: payload.dialog_id,
      owner_epoch: claim.repair_owner_epoch,
      sequence: 1
    })
  };
}

function recoveryPayload(
  leg: 'caller' | 'callee'
): DialogRecoveryCapsulePayload {
  const caller = leg === 'caller';
  return {
    schema_version: 1,
    call_session_ref: CALL_SESSION_REF,
    interaction_id: 'interaction-terminal-repair',
    dialog_id: caller ? 'dialog-terminal-caller' : 'dialog-terminal-callee',
    peer_dialog_id: caller ? 'dialog-terminal-callee' : 'dialog-terminal-caller',
    leg,
    dialog_role: caller ? 'uas' : 'uac',
    raw_call_id: `${leg}-terminal-call@example.invalid`,
    local_tag: `${leg}-terminal-local`,
    remote_tag: `${leg}-terminal-remote`,
    from_uri: 'sip:caller@example.invalid',
    to_uri: 'sip:callee@example.invalid',
    local_contact_uri: 'sip:rustpbx@example.internal:5060',
    remote_uri: 'sip:peer@example.invalid',
    remote_contact_uri: 'sip:peer@198.51.100.20:5060',
    route_set: ['sip:edge.example.internal:5061;transport=tls;lr'],
    local_cseq: caller ? 22 : 31,
    remote_cseq: caller ? 18 : 29,
    supports_100rel: true,
    media_reservation_id: `reservation-terminal/${leg}`,
    started_at: '2026-07-27T01:00:00.000Z',
    answered_at: '2026-07-27T01:00:00.500Z',
    cdr_sequence: 77,
    route_snapshot_revision: 42
  };
}

function codec(): DialogRecoveryCapsuleCodec {
  return new DialogRecoveryCapsuleCodec({
    current: { key_id: 'terminal-repair-key', key: Buffer.alloc(32, 0x41) },
    random_bytes: (size) => Buffer.alloc(size, 0x42)
  });
}
