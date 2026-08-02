import { createHash, generateKeyPairSync } from 'node:crypto';

import {
  ComponentNodeAdmissionController,
  type CellAdmissionReservationCheckpoint
} from '../../../../src/agent-runtime/converact/placement/index.js';
import {
  PLATFORM_DRAIN_AUTHORITIES,
  PlatformDrainCoordinator,
  SystemPlatformClock,
  signPlatformDrainReceipt,
  type PlatformDrainAuthority,
  type SignedPlatformDrainReceipt
} from '../../../../src/agent-runtime/converact/platform-foundation/index.js';

const role = process.argv[2];
const nodeId = process.argv[3];
if (!process.send || !['drain', 'lost', 'recovery', 'verifier'].includes(role || '')
  || !/^[a-z][a-z0-9-]{2,63}$/u.test(nodeId || '')) {
  throw new Error('drain_node_arguments_invalid');
}

const controller = role === 'verifier' ? null : new ComponentNodeAdmissionController({
  component: 'rustpbx',
  region_id: 'region-a',
  zone_id: 'zone-a',
  cell_id: 'cell-a',
  node_id: nodeId!,
  profile_ids: ['cell-10k-v1'],
  interaction_kinds: ['sip_voice'],
  dimensions: {
    'voice.weighted_calls': {
      unit: 'count', safe_capacity: 100, used: 0, reserved: 0
    }
  }
});
const signingKeys = new Map<PlatformDrainAuthority, ReturnType<typeof generateKeyPairSync>>();
const authorityKeyIds = {} as Record<PlatformDrainAuthority, string>;
const publicKeys: Record<string, string> = {};
if (role === 'drain') {
  for (const authority of PLATFORM_DRAIN_AUTHORITIES) {
    const pair = generateKeyPairSync('ed25519');
    const keyId = `drain-${authority}-key-v1`;
    signingKeys.set(authority, pair);
    authorityKeyIds[authority] = keyId;
    publicKeys[keyId] = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }
}
let checkpoint: CellAdmissionReservationCheckpoint | null = null;

process.on('message', (message: unknown) => {
  void handleRequest(message).catch((error) => {
    const requestId = plainRecord(message) ? String(message.request_id || '') : '';
    respond(requestId, false, null, errorCode(error));
  });
});

respond('', true, {
  type: 'ready',
  role,
  node_id: nodeId,
  process_pid: process.pid,
  authority_key_ids: role === 'drain' ? authorityKeyIds : undefined,
  public_keys: role === 'drain' ? publicKeys : undefined
});

async function handleRequest(value: unknown): Promise<void> {
  if (!plainRecord(value) || typeof value.request_id !== 'string'
    || typeof value.command !== 'string') throw new Error('drain_node_request_invalid');
  const requestId = value.request_id;
  if (value.command === 'configure') {
    requireController();
    const now = checkedDate(value.now);
    const leaseEpoch = checkedLeaseEpoch(value.cell_lease_epoch);
    checkpoint = structuredClone(value.checkpoint as CellAdmissionReservationCheckpoint);
    controller!.applyLease(heartbeat(leaseEpoch, 'draining', false, true, now), now);
    controller!.applyRecoveryReservation(checkpoint, addMs(now, 1), leaseEpoch);
    controller!.applyLease(heartbeat(leaseEpoch, 'accepting', true, false, addMs(now, 2)), addMs(now, 2));
    respond(requestId, true, controller!.snapshot(addMs(now, 3)));
    return;
  }
  if (value.command === 'mutate') {
    requireCheckpoint();
    const now = checkedDate(value.now);
    const ownerEpoch = typeof value.owner_epoch === 'string'
      ? value.owner_epoch
      : checkpoint!.owner_epoch;
    const result = controller!.authorize({
      reservation_id: checkpoint!.reservation_id,
      interaction_id: checkpoint!.interaction_id,
      owner_epoch: ownerEpoch,
      operation: 'mutate'
    }, now);
    respond(requestId, true, result);
    return;
  }
  if (value.command === 'start_drain') {
    requireCheckpoint();
    const now = checkedDate(value.now);
    controller!.startDrain(now);
    let rejectionCode = '';
    try {
      controller!.applyReservation(
        value.new_checkpoint as CellAdmissionReservationCheckpoint,
        addMs(now, 1)
      );
    } catch (error) {
      rejectionCode = errorCode(error);
    }
    const mutation = controller!.authorize({
      reservation_id: checkpoint!.reservation_id,
      interaction_id: checkpoint!.interaction_id,
      owner_epoch: checkpoint!.owner_epoch,
      operation: 'mutate'
    }, addMs(now, 2));
    respond(requestId, true, {
      rejection_code: rejectionCode,
      established_mutation_allowed: mutation.allowed,
      snapshot: controller!.snapshot(addMs(now, 3))
    });
    return;
  }
  if (value.command === 'close') {
    requireCheckpoint();
    const now = checkedDate(value.now);
    checkpoint = structuredClone(value.checkpoint as CellAdmissionReservationCheckpoint);
    const closed = controller!.applyReservation(checkpoint, now);
    respond(requestId, true, {
      state: closed.state,
      snapshot: controller!.snapshot(addMs(now, 1))
    });
    return;
  }
  if (value.command === 'sign_receipts') {
    if (role !== 'drain' || signingKeys.size !== PLATFORM_DRAIN_AUTHORITIES.length) {
      throw new Error('drain_node_signing_role_invalid');
    }
    requireCheckpoint();
    const now = checkedDate(value.now);
    const snapshot = controller!.snapshot(now);
    const activeIds = snapshot.reservations.active > 0 ? [checkpoint!.interaction_id] : [];
    const revision = Number(value.receipt_revision);
    const receipts = PLATFORM_DRAIN_AUTHORITIES.map((authority) => {
      const ids = authority === 'communication_attached_generations' ? activeIds : [];
      return signPlatformDrainReceipt({
        key_id: authorityKeyIds[authority],
        private_key: signingKeys.get(authority)!.privateKey,
        body: {
          schema_version: '1.0.0',
          drain_id: String(value.drain_id),
          node_id: nodeId!,
          owner_epoch: checkpoint!.owner_epoch,
          authority,
          receipt_revision: revision,
          active_count: String(ids.length),
          active_id_digest: sha256(JSON.stringify(ids.sort())),
          observed_at: now.toISOString(),
          expires_at: addMs(now, 60_000).toISOString()
        }
      });
    });
    respond(requestId, true, receipts);
    return;
  }
  if (value.command === 'verify_receipts') {
    if (role !== 'verifier') throw new Error('drain_node_verifier_role_invalid');
    const clock = new SystemPlatformClock();
    const receipts = value.receipts as SignedPlatformDrainReceipt[];
    const coordinator = new PlatformDrainCoordinator({
      drain_id: String(value.drain_id),
      node_id: String(value.drain_node_id),
      owner_epoch: String(value.owner_epoch),
      required_authorities: PLATFORM_DRAIN_AUTHORITIES,
      authority_key_ids: value.authority_key_ids as Record<PlatformDrainAuthority, string>,
      public_keys: value.public_keys as Record<string, string>,
      clock,
      timeout_ms: 30_000,
      receipt_max_age_ms: 60_000,
      max_clock_skew_ms: 5_000
    });
    coordinator.startRouteDrain();
    coordinator.stopWorkerClaims();
    coordinator.beginAuthorityDrain();
    for (const receipt of receipts) coordinator.observeReceipt(receipt);
    const verified = coordinator.verifyActiveZero();
    respond(requestId, true, {
      process_pid: process.pid,
      verification_count: receipts.length,
      verified,
      phase: coordinator.snapshot().phase
    });
    return;
  }
  if (value.command === 'shutdown') {
    respond(requestId, true, { shutting_down: true });
    setImmediate(() => process.exit(0));
    return;
  }
  throw new Error('drain_node_command_invalid');
}

function heartbeat(
  cellLeaseEpoch: number,
  state: 'accepting' | 'draining',
  recoveryComplete: boolean,
  recoveryReset: boolean,
  now: Date
) {
  return {
    component: 'rustpbx' as const,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: nodeId!,
    cell_lease_epoch: cellLeaseEpoch,
    state,
    recovery_complete: recoveryComplete,
    recovery_reset: recoveryReset,
    observed_at: now.toISOString(),
    expires_at: addMs(now, 120_000).toISOString()
  };
}

function requireController(): void {
  if (!controller) throw new Error('drain_node_controller_unavailable');
}

function requireCheckpoint(): void {
  requireController();
  if (!checkpoint) throw new Error('drain_node_checkpoint_missing');
}

function checkedDate(value: unknown): Date {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) throw new Error('drain_node_time_invalid');
  return new Date(parsed);
}

function checkedLeaseEpoch(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 0xffff_ffff) {
    throw new Error('drain_node_lease_epoch_invalid');
  }
  return Number(value);
}

function addMs(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function errorCode(error: unknown): string {
  return String((error as { code?: unknown })?.code || (error as Error)?.message || 'drain_node_failed');
}

function respond(requestId: string, ok: boolean, data: unknown, error = ''): void {
  process.send!({ request_id: requestId, ok, data, error });
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
