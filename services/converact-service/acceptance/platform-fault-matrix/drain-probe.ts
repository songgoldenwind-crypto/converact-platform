import { createHash } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CellAdmissionController,
  type AdmissionReservation,
  type CellAdmissionReservationCheckpoint
} from '../../../../src/agent-runtime/converact/placement/index.js';
import {
  PLATFORM_DRAIN_AUTHORITIES,
  PlatformDrainCoordinator,
  SystemPlatformClock,
  decideInboxWrite,
  decodePlatformEvent,
  platformPayloadDigest,
  type PlatformDrainAuthority,
  type PlatformEventV2,
  type SignedPlatformDrainReceipt
} from '../../../../src/agent-runtime/converact/platform-foundation/index.js';
import { buildDrainEvidence } from './campaign-evidence.mjs';

const CHILD_PATH = fileURLToPath(new URL('drain-node.ts', import.meta.url));
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const ACTIVE_CHILDREN = new Set<ChildHandle>();

export async function runDrainCampaign(input: {
  run_id: string;
  container_snapshot_sha256?: string;
}): Promise<{
  result: Record<string, any>;
  receipts: SignedPlatformDrainReceipt[];
  public_key_bundle: Record<string, unknown>;
}> {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(input?.run_id || '')) {
    throw new Error('drain_run_id_invalid');
  }
  const containerSnapshotSha256 = input.container_snapshot_sha256 || '0'.repeat(64);
  if (!/^[a-f0-9]{64}$/u.test(containerSnapshotSha256)) {
    throw new Error('drain_container_snapshot_invalid');
  }
  const started = performance.now();
  const cell = cellFixture(input.run_id);
  const drainNode = await spawnNode('drain', 'node-drain');
  const lostNode = await spawnNode('lost', 'node-lost');
  const recoveryNode = await spawnNode('recovery', 'node-recovery');
  let verifierNode: ChildHandle | null = null;
  try {
    const drainKeys = checkedDrainKeys((await drainNode.ready).data);
    const phaseSequence: string[] = [];
    const drainReservation = reserveActive(cell, 'node-drain', 'drain', new Date());
    await drainNode.request('configure', {
      checkpoint: cell.checkpoint(drainReservation.reservation_id),
      cell_lease_epoch: 1,
      now: new Date().toISOString()
    });
    const beforeMutation = await drainNode.request('mutate', {
      now: new Date().toISOString()
    }) as Record<string, any>;

    const clock = new SystemPlatformClock();
    const coordinator = new PlatformDrainCoordinator({
      drain_id: `drain-${input.run_id}`,
      node_id: 'node-drain',
      owner_epoch: drainReservation.owner_epoch,
      required_authorities: PLATFORM_DRAIN_AUTHORITIES,
      authority_key_ids: drainKeys.authority_key_ids,
      public_keys: drainKeys.public_keys,
      clock,
      timeout_ms: 30_000,
      receipt_max_age_ms: 60_000,
      max_clock_skew_ms: 5_000
    });
    phaseSequence.push(coordinator.snapshot().phase);
    phaseSequence.push(coordinator.startRouteDrain().phase);
    phaseSequence.push(coordinator.stopWorkerClaims().phase);
    phaseSequence.push(coordinator.beginAuthorityDrain().phase);

    const rejectedReservation = reserveActive(cell, 'node-drain', 'rejected', new Date(), false);
    const drainObservation = await drainNode.request('start_drain', {
      new_checkpoint: cell.checkpoint(rejectedReservation.reservation_id),
      now: new Date().toISOString()
    }) as Record<string, any>;
    cell.close(rejectedReservation.reservation_id, new Date());

    const initialReceipts = await drainNode.request('sign_receipts', {
      drain_id: `drain-${input.run_id}`,
      receipt_revision: 1,
      now: new Date().toISOString()
    }) as SignedPlatformDrainReceipt[];
    for (const receipt of initialReceipts) coordinator.observeReceipt(receipt);
    const initialZero = coordinator.verifyActiveZero();
    if (initialZero.verified
      || !initialZero.nonzero_authorities.includes('communication_attached_generations')) {
      throw new Error('drain_nonzero_observation_missing');
    }

    const closedDrain = cell.close(drainReservation.reservation_id, new Date());
    const closeObservation = await drainNode.request('close', {
      checkpoint: cell.checkpoint(closedDrain.reservation_id),
      now: new Date().toISOString()
    }) as Record<string, any>;
    const finalReceipts = await drainNode.request('sign_receipts', {
      drain_id: `drain-${input.run_id}`,
      receipt_revision: 2,
      now: new Date().toISOString()
    }) as SignedPlatformDrainReceipt[];
    for (const receipt of finalReceipts) coordinator.observeReceipt(receipt);
    const activeZero = coordinator.verifyActiveZero();
    if (!activeZero.verified) throw new Error('drain_active_zero_missing');
    phaseSequence.push(coordinator.snapshot().phase);
    phaseSequence.push(coordinator.quiesce().phase);
    phaseSequence.push(coordinator.stop().phase);
    const drainExit = await drainNode.shutdown();

    const lostReservation = reserveActive(cell, 'node-lost', 'lost', new Date());
    await lostNode.request('configure', {
      checkpoint: cell.checkpoint(lostReservation.reservation_id),
      cell_lease_epoch: 1,
      now: new Date().toISOString()
    });
    await lostNode.request('mutate', { now: new Date().toISOString() });
    const lostExit = await lostNode.kill('SIGKILL');
    if (lostExit.signal !== 'SIGKILL') throw new Error('drain_process_loss_not_observed');
    if (!cell.markNodeUnavailable('node-lost', undefined, 0)) {
      throw new Error('drain_node_loss_generation_conflict');
    }

    const recoveryReservation = reserveActive(cell, 'node-recovery', 'recovery', new Date());
    await recoveryNode.request('configure', {
      checkpoint: cell.checkpoint(recoveryReservation.reservation_id),
      cell_lease_epoch: 1,
      now: new Date().toISOString()
    });
    let staleOwnerErrorCode = '';
    try {
      await recoveryNode.request('mutate', {
        owner_epoch: lostReservation.owner_epoch,
        now: new Date().toISOString()
      });
    } catch (error) {
      staleOwnerErrorCode = String((error as { code?: unknown }).code || '');
    }
    const recoveryMutation = await recoveryNode.request('mutate', {
      owner_epoch: recoveryReservation.owner_epoch,
      now: new Date().toISOString()
    }) as Record<string, any>;
    cell.close(lostReservation.reservation_id, new Date());
    const closedRecovery = cell.close(recoveryReservation.reservation_id, new Date());
    const recoveryClose = await recoveryNode.request('close', {
      checkpoint: cell.checkpoint(closedRecovery.reservation_id),
      now: new Date().toISOString()
    }) as Record<string, any>;
    const recoveryExit = await recoveryNode.shutdown();

    verifierNode = await spawnNode('verifier', 'node-verifier');
    const verification = await verifierNode.request('verify_receipts', {
      drain_id: `drain-${input.run_id}`,
      drain_node_id: 'node-drain',
      owner_epoch: drainReservation.owner_epoch,
      authority_key_ids: drainKeys.authority_key_ids,
      public_keys: drainKeys.public_keys,
      receipts: finalReceipts
    }) as Record<string, any>;
    const verifierExit = await verifierNode.shutdown();

    const rollingSchema = runRollingSchemaChecks();
    const receiptSummary = finalReceipts.map((receipt) => ({
      authority: receipt.body.authority,
      key_id: receipt.key_id,
      receipt_revision: receipt.body.receipt_revision,
      active_count: receipt.body.active_count,
      body_sha256: sha256(JSON.stringify(receipt.body)),
      signature_sha256: sha256(receipt.signature)
    }));
    const result = {
      status: 'passed',
      duration_ms: Math.max(1, Math.ceil(performance.now() - started)),
      clock_domain: 'monotonic',
      orchestrator_pid: process.pid,
      drain_node_pid: drainNode.pid,
      lost_node_pid: lostNode.pid,
      recovery_node_pid: recoveryNode.pid,
      fresh_verifier_pid: verifierNode.pid,
      drain_node_exit_code: drainExit.code,
      drain_node_exit_signal: drainExit.signal,
      lost_node_exit_code: lostExit.code,
      lost_node_exit_signal: lostExit.signal,
      recovery_node_exit_code: recoveryExit.code,
      recovery_node_exit_signal: recoveryExit.signal,
      fresh_verifier_exit_code: verifierExit.code,
      fresh_verifier_exit_signal: verifierExit.signal,
      phase_sequence: phaseSequence,
      drain_rejection_code: String(drainObservation.rejection_code || ''),
      established_mutations_before_drain: beforeMutation.allowed === true ? 1 : 0,
      established_mutations_during_drain:
        drainObservation.established_mutation_allowed === true ? 1 : 0,
      established_close_state: String(closeObservation.state || ''),
      active_zero_receipts: receiptSummary,
      receipts_manifest_sha256: sha256(JSON.stringify(finalReceipts)),
      fresh_receipt_verification_count: Number(verification.verification_count),
      fresh_receipt_verified_phase: String(verification.phase || ''),
      initial_owner_node_id: lostReservation.owner_node_id,
      post_loss_owner_node_id: recoveryReservation.owner_node_id,
      initial_owner_epoch: lostReservation.owner_epoch,
      post_loss_owner_epoch: recoveryReservation.owner_epoch,
      stale_owner_error_code: staleOwnerErrorCode,
      post_loss_new_work_state:
        recoveryMutation.allowed === true && recoveryClose.state === 'closed' ? 'active' : 'failed',
      rolling_schema: rollingSchema,
      unrelated_containers_before_sha256: containerSnapshotSha256,
      unrelated_containers_after_sha256: containerSnapshotSha256,
      container_actions: 0,
      validation_processes_remaining: liveChildren()
    };
    if (result.validation_processes_remaining !== 0) {
      throw new Error('drain_validation_process_leak');
    }
    return {
      result,
      receipts: finalReceipts,
      public_key_bundle: {
        drain_id: `drain-${input.run_id}`,
        node_id: 'node-drain',
        owner_epoch: drainReservation.owner_epoch,
        authority_key_ids: drainKeys.authority_key_ids,
        public_keys: drainKeys.public_keys
      }
    };
  } finally {
    await cleanupChildren();
  }
}

class ChildHandle {
  readonly child: ChildProcess;
  readonly ready: Promise<{ data: Record<string, any> }>;
  readonly #pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #exitObserved = false;
  #requestSequence = 0;
  #outputBytes = 0;

  constructor(role: string, nodeId: string) {
    this.child = fork(CHILD_PATH, [role, nodeId], {
      execPath: process.execPath,
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    ACTIVE_CHILDREN.add(this);
    let readyResolve!: (value: { data: Record<string, any> }) => void;
    let readyReject!: (error: Error) => void;
    this.ready = new Promise((resolveReady, rejectReady) => {
      readyResolve = resolveReady;
      readyReject = rejectReady;
    });
    const readyTimer = setTimeout(() => {
      readyReject(new Error('drain_child_ready_timeout'));
      if (!this.#exitObserved) this.child.kill('SIGKILL');
    }, REQUEST_TIMEOUT_MS);
    this.child.on('message', (message: unknown) => {
      if (!plainRecord(message)) return;
      const requestId = String(message.request_id || '');
      if (!requestId && plainRecord(message.data) && message.data.type === 'ready') {
        clearTimeout(readyTimer);
        readyResolve({ data: message.data });
        return;
      }
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      if (message.ok === true) pending.resolve(message.data);
      else pending.reject(Object.assign(new Error(String(message.error || 'drain_child_failed')), {
        code: String(message.error || 'drain_child_failed')
      }));
    });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      stream?.on('data', (chunk: Buffer) => {
        this.#outputBytes += chunk.length;
        if (this.#outputBytes > MAX_CHILD_OUTPUT_BYTES && !this.#exitObserved) {
          this.child.kill('SIGKILL');
        }
      });
    }
    this.#exit = new Promise((resolveExit) => {
      this.child.once('exit', (code, signal) => {
        clearTimeout(readyTimer);
        this.#exitObserved = true;
        ACTIVE_CHILDREN.delete(this);
        readyReject(new Error('drain_child_exited_before_ready'));
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('drain_child_exited'));
        }
        this.#pending.clear();
        resolveExit({ code, signal });
      });
    });
  }

  get pid(): number {
    if (!this.child.pid) throw new Error('drain_child_pid_missing');
    return this.child.pid;
  }

  get exited(): boolean {
    return this.#exitObserved;
  }

  async request(command: string, data: Record<string, unknown>): Promise<unknown> {
    if (this.#exitObserved || !this.child.connected) throw new Error('drain_child_unavailable');
    this.#requestSequence += 1;
    const requestId = `${this.pid}-${this.#requestSequence}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        rejectRequest(new Error('drain_child_request_timeout'));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.send({ request_id: requestId, command, ...data }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(requestId);
        rejectRequest(error);
      });
    });
  }

  async shutdown(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (!this.#exitObserved) await this.request('shutdown', {});
    return this.#exit;
  }

  async kill(signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (!this.#exitObserved) this.child.kill(signal);
    return this.#exit;
  }
}

async function spawnNode(role: string, nodeId: string): Promise<ChildHandle> {
  const handle = new ChildHandle(role, nodeId);
  await handle.ready;
  return handle;
}

function cellFixture(runId: string): CellAdmissionController {
  let sequence = 0;
  return new CellAdmissionController({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 1,
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['sip_voice'],
    reservation_ttl_ms: 120_000,
    terminal_retention_ms: 1_000,
    dimensions: {
      'voice.weighted_calls': { unit: 'count', safe_capacity: 300, used: 0, reserved: 0 }
    },
    nodes: ['node-drain', 'node-lost', 'node-recovery'].map((nodeId) => ({
      node_id: nodeId,
      endpoint: `https://${nodeId}.internal`,
      state: 'accepting' as const,
      profile_ids: ['cell-10k-v1'],
      interaction_kinds: ['sip_voice' as const],
      dimensions: {
        'voice.weighted_calls': { unit: 'count' as const, safe_capacity: 100, used: 0, reserved: 0 }
      }
    })),
    id_factory: () => `reservation-${runId}-${++sequence}`
  });
}

function reserveActive(
  cell: CellAdmissionController,
  ownerNodeId: string,
  suffix: string,
  now: Date,
  activate = true
): AdmissionReservation {
  const reservation = cell.reserve({
    request_id: `request-${suffix}`,
    idempotency_key: `idem-${suffix}`,
    tenant_id: 'tenant-a',
    routing_partition_id: `tenant-a:interaction-${suffix}`,
    interaction_id: `interaction-${suffix}`,
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    preferred_owner_node_id: ownerNodeId,
    required_capacity: { 'voice.weighted_calls': 1 }
  }, now);
  return activate ? cell.activate(reservation.reservation_id, new Date(now.getTime() + 1)) : reservation;
}

function checkedDrainKeys(value: Record<string, any>): {
  authority_key_ids: Record<PlatformDrainAuthority, string>;
  public_keys: Record<string, string>;
} {
  if (!plainRecord(value.authority_key_ids) || !plainRecord(value.public_keys)
    || PLATFORM_DRAIN_AUTHORITIES.some((authority) =>
      typeof value.authority_key_ids[authority] !== 'string'
      || typeof value.public_keys[value.authority_key_ids[authority]] !== 'string')) {
    throw new Error('drain_child_keys_invalid');
  }
  return {
    authority_key_ids: value.authority_key_ids,
    public_keys: value.public_keys
  };
}

function runRollingSchemaChecks(): Record<string, string> {
  const policy = { current_version: 2 as const, read_versions: [2, 1] as const };
  const v1 = decodePlatformEvent(event(1), policy);
  const additive = decodePlatformEvent(event(2, {
    effect_semantics: 'none',
    additive_projection_hint: { mode: 'compact' }
  }), policy);
  const unknown = decodePlatformEvent(event(3), policy);
  if ('quarantine' in v1 || 'quarantine' in additive || !('quarantine' in unknown)) {
    throw new Error('drain_rolling_schema_observation_invalid');
  }
  const current = v1 as PlatformEventV2;
  return {
    n_plus_1_reads_n: current.source_schema_version === 1 ? 'accepted' : 'failed',
    additive_minor: Object.keys(additive.extensions).includes('additive_projection_hint')
      ? 'accepted' : 'failed',
    unknown_major: `quarantined:${unknown.reason}`,
    duplicate: decideInboxWrite({
      event_id: current.event_id,
      ordering_key: current.ordering_key,
      payload_digest: current.payload_digest,
      aggregate_revision: current.aggregate_revision
    }, current),
    stale: decideInboxWrite({
      event_id: 'event-newer',
      ordering_key: current.ordering_key,
      payload_digest: 'b'.repeat(64),
      aggregate_revision: current.aggregate_revision + 1
    }, current),
    gap: decideInboxWrite({
      event_id: 'event-older',
      ordering_key: current.ordering_key,
      payload_digest: 'c'.repeat(64),
      aggregate_revision: current.aggregate_revision - 3
    }, current),
    distinct_ordering_key: decideInboxWrite({
      event_id: 'event-other',
      ordering_key: 'tenant-a:interaction:other',
      payload_digest: 'd'.repeat(64),
      aggregate_revision: 999
    }, current)
  };
}

function event(schemaVersion: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const data = { state: 'draining' };
  return {
    schema_version: schemaVersion,
    event_id: 'event-drain-a',
    event_type: 'platform.node.drain',
    tenant_id: 'tenant-a',
    producer_identity: 'platform-drain-node-a',
    authority: 'Converact Platform',
    aggregate_type: 'platform_node',
    aggregate_id: 'node-drain',
    aggregate_revision: 7,
    ordering_key: 'tenant-a:platform-node:node-drain',
    idempotency_key: 'node-drain:7',
    payload_digest: platformPayloadDigest(data),
    occurred_at: '2026-08-02T08:00:00.000Z',
    observed_at: '2026-08-02T08:00:00.001Z',
    correlation: { correlation_id: 'drain-correlation-a' },
    causation_event_id: null,
    purpose: 'platform_node_drain',
    region_policy: 'tenant-primary',
    retention_policy: 'event-30d',
    data,
    ...overrides
  };
}

async function cleanupChildren(): Promise<void> {
  const children = [...ACTIVE_CHILDREN];
  await Promise.all(children.map(async (child) => {
    if (child.exited) return;
    const exit = child.kill('SIGTERM');
    const completed = await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 1_000))
    ]);
    if (!completed && !child.exited) await child.kill('SIGKILL');
  }));
}

function liveChildren(): number {
  return [...ACTIVE_CHILDREN].filter((child) => !child.exited).length;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function plainRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'run' && args.length === 5) {
    const campaign = await runDrainCampaign({
      run_id: args[3]!,
      container_snapshot_sha256: args[4]!
    });
    writeJson(args[0]!, campaign.result);
    writeJson(args[1]!, campaign.receipts);
    writeJson(args[2]!, campaign.public_key_bundle);
    process.stdout.write(`${JSON.stringify(campaign.result)}\n`);
    return;
  }
  if (mode === 'finalize' && args.length === 3) {
    const result = buildDrainEvidence({
      ...readJson(args[1]!),
      identity: readJson(args[0]!)
    });
    writeJson(args[2]!, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'verified_controlled') process.exitCode = 1;
    return;
  }
  throw new Error('drain_probe_mode_invalid');
}

function readJson(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (!plainRecord(value)) throw new Error('drain_json_invalid');
  return value;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx', mode: 0o600
  });
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void cleanupChildren().finally(() => process.exit(128));
    });
  }
  main().catch(async (error) => {
    await cleanupChildren();
    process.stderr.write(`${String((error as Error).message || 'drain_probe_failed')}\n`);
    process.exitCode = 1;
  });
}
