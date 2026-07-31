import { canonicalSha256 } from '../canonical-json.js';
import type { LoadRunManifest } from '../profile-compiler.js';
import {
  LoadRunControlError,
  type CapacityCommandBus,
  type CapacityControllerLease,
  type CapacityEvidenceRecord,
  type CapacityLoadRunRepository,
  type CapacityShardAssignment,
  type CapacityShardLeaseRenewal,
  type CapacityWorkerHeartbeat
} from './types.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/;

export class DurableLoadRunOrchestrator {
  readonly #repository: CapacityLoadRunRepository;
  readonly #commandBus: CapacityCommandBus;

  constructor(input: {
    repository: CapacityLoadRunRepository;
    command_bus: CapacityCommandBus;
  }) {
    this.#repository = input.repository;
    this.#commandBus = input.command_bus;
  }

  async createRun(input: {
    manifest: LoadRunManifest;
    manifest_sha256: string;
    created_at: string;
  }): Promise<void> {
    if (!SHA256.test(input.manifest_sha256) ||
        canonicalSha256(input.manifest) !== input.manifest_sha256) {
      throw new LoadRunControlError('manifest_hash_mismatch', 409);
    }
    safeId(input.manifest.run_id, 'run_id');
    timestamp(input.created_at);
    await this.#repository.createRun(input);
  }

  async claimController(input: {
    run_id: string;
    controller_id: string;
    lease_ttl_ms: number;
    now: string;
  }): Promise<CapacityControllerLease> {
    validateLeaseInput(input);
    return await this.#repository.claimController(input);
  }

  async startPhase(input: {
    run_id: string;
    phase_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    now: string;
  }): Promise<void> {
    safeId(input.run_id, 'run_id');
    safeId(input.phase_id, 'phase_id');
    safeId(input.controller_id, 'controller_id');
    epoch(input.controller_lease_epoch);
    timestamp(input.now);
    await this.#repository.startPhase(input);
  }

  async heartbeatWorker(input: CapacityWorkerHeartbeat): Promise<void> {
    safeId(input.run_id, 'run_id');
    safeId(input.worker_id, 'worker_id');
    safeId(input.fleet_id, 'fleet_id');
    safeId(input.release_id, 'release_id');
    if (!['online', 'draining', 'offline'].includes(input.state)) {
      throw new LoadRunControlError('worker_state_invalid', 400);
    }
    nonNegativeInteger(input.safe_capacity, 'safe_capacity');
    nonNegativeInteger(input.reported_load, 'reported_load');
    timestamp(input.observed_at);
    boundedObject(input.metadata);
    await this.#repository.heartbeatWorker(structuredClone(input));
  }

  async assignNextShard(input: {
    run_id: string;
    phase_id: string;
    worker_id: string;
    fleet_id: string;
    lease_ttl_ms: number;
    now: string;
  }): Promise<CapacityShardAssignment | null> {
    validateLeaseInput(input);
    safeId(input.phase_id, 'phase_id');
    safeId(input.worker_id, 'worker_id');
    safeId(input.fleet_id, 'fleet_id');
    return await this.#repository.assignNextShard(input);
  }

  async renewShardLease(input: {
    run_id: string;
    phase_id: string;
    shard_id: string;
    worker_id: string;
    lease_epoch: string;
    lease_ttl_ms: number;
    now: string;
  }): Promise<CapacityShardLeaseRenewal> {
    validateLeaseInput(input);
    safeId(input.phase_id, 'phase_id');
    safeShardId(input.shard_id);
    safeId(input.worker_id, 'worker_id');
    epoch(input.lease_epoch);
    return await this.#repository.renewShardLease(input);
  }

  async completeShard(input: {
    run_id: string;
    phase_id: string;
    shard_id: string;
    worker_id: string;
    lease_epoch: string;
    outcome: 'completed' | 'failed' | 'cancelled' | 'not_run';
    evidence_id: string;
    error_code: string;
    now: string;
  }): Promise<void> {
    safeId(input.run_id, 'run_id');
    safeId(input.phase_id, 'phase_id');
    safeShardId(input.shard_id);
    safeId(input.worker_id, 'worker_id');
    epoch(input.lease_epoch);
    if (!['completed', 'failed', 'cancelled', 'not_run'].includes(input.outcome)) {
      throw new LoadRunControlError('shard_outcome_invalid', 400);
    }
    if (input.outcome === 'completed' && !input.evidence_id) {
      throw new LoadRunControlError('completed_shard_evidence_required', 400);
    }
    if (input.outcome === 'completed' && input.error_code) {
      throw new LoadRunControlError('completed_shard_has_error', 400);
    }
    if (input.outcome !== 'completed' && !input.error_code) {
      throw new LoadRunControlError('shard_failure_code_required', 400);
    }
    if (input.evidence_id) safeId(input.evidence_id, 'evidence_id');
    safeCode(input.error_code);
    timestamp(input.now);
    await this.#repository.completeShard(input);
  }

  async completePhase(input: {
    run_id: string;
    phase_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    outcome: 'completed' | 'failed';
    now: string;
  }): Promise<void> {
    safeId(input.run_id, 'run_id');
    safeId(input.phase_id, 'phase_id');
    safeId(input.controller_id, 'controller_id');
    epoch(input.controller_lease_epoch);
    if (!['completed', 'failed'].includes(input.outcome)) {
      throw new LoadRunControlError('phase_outcome_invalid', 400);
    }
    timestamp(input.now);
    await this.#repository.completePhase(input);
  }

  async finalizeRun(input: {
    run_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    outcome: 'passed' | 'failed' | 'cancelled' | 'not_run' | 'invalid_generator_capacity';
    evidence_manifest_sha256: string;
    failure_code: string;
    now: string;
  }): Promise<void> {
    safeId(input.run_id, 'run_id');
    safeId(input.controller_id, 'controller_id');
    epoch(input.controller_lease_epoch);
    if (!['passed', 'failed', 'cancelled', 'not_run', 'invalid_generator_capacity']
      .includes(input.outcome)) {
      throw new LoadRunControlError('run_outcome_invalid', 400);
    }
    if ((input.outcome === 'passed' &&
        !SHA256.test(input.evidence_manifest_sha256)) ||
        (input.outcome !== 'passed' && input.evidence_manifest_sha256 !== '' &&
         !SHA256.test(input.evidence_manifest_sha256))) {
      throw new LoadRunControlError('evidence_manifest_sha256_invalid', 400);
    }
    if (input.outcome === 'passed' && input.failure_code) {
      throw new LoadRunControlError('passed_run_has_failure_code', 400);
    }
    if (input.outcome !== 'passed' && !input.failure_code) {
      throw new LoadRunControlError('run_failure_code_required', 400);
    }
    safeCode(input.failure_code);
    timestamp(input.now);
    await this.#repository.finalizeRun(input);
  }

  async registerEvidence(input: {
    evidence_id: string;
    run_id: string;
    phase_id: string;
    shard_id: string;
    kind: string;
    metadata: Record<string, unknown>;
    now: string;
  }): Promise<CapacityEvidenceRecord> {
    safeId(input.evidence_id, 'evidence_id');
    safeId(input.run_id, 'run_id');
    if (input.phase_id) safeId(input.phase_id, 'phase_id');
    if (input.shard_id) safeShardId(input.shard_id);
    if (input.shard_id && !input.phase_id) {
      throw new LoadRunControlError('shard_evidence_phase_required', 400);
    }
    safeId(input.kind, 'kind');
    boundedObject(input.metadata);
    timestamp(input.now);
    return await this.#repository.registerEvidence(structuredClone(input));
  }

  async startEvidenceUpload(input: {
    evidence_id: string;
    now: string;
  }): Promise<CapacityEvidenceRecord> {
    safeId(input.evidence_id, 'evidence_id');
    timestamp(input.now);
    return await this.#repository.startEvidenceUpload(input);
  }

  async completeEvidenceUpload(input: {
    evidence_id: string;
    object_uri: string;
    sha256: string;
    byte_size: number;
    captured_at: string;
    now: string;
  }): Promise<CapacityEvidenceRecord> {
    safeId(input.evidence_id, 'evidence_id');
    safeObjectUri(input.object_uri);
    if (!SHA256.test(input.sha256)) throw new LoadRunControlError('evidence_sha256_invalid', 400);
    boundedInteger(input.byte_size, 1, Number.MAX_SAFE_INTEGER, 'byte_size');
    timestamp(input.captured_at);
    timestamp(input.now);
    return await this.#repository.completeEvidenceUpload(input);
  }

  async verifyEvidence(input: {
    evidence_id: string;
    outcome: 'verified' | 'rejected' | 'not_run';
    error_code: string;
    now: string;
  }): Promise<CapacityEvidenceRecord> {
    safeId(input.evidence_id, 'evidence_id');
    if (!['verified', 'rejected', 'not_run'].includes(input.outcome)) {
      throw new LoadRunControlError('evidence_outcome_invalid', 400);
    }
    if (input.outcome === 'verified' && input.error_code) {
      throw new LoadRunControlError('verified_evidence_has_error', 400);
    }
    if (input.outcome !== 'verified' && !input.error_code) {
      throw new LoadRunControlError('evidence_error_code_required', 400);
    }
    safeCode(input.error_code);
    timestamp(input.now);
    return await this.#repository.verifyEvidence(input);
  }

  async dispatchCommands(input: {
    dispatcher_id: string;
    lease_ttl_ms: number;
    limit: number;
    now: string;
  }): Promise<{
    claimed: number;
    published: number;
    released: number;
    unconfirmed: number;
  }> {
    safeId(input.dispatcher_id, 'dispatcher_id');
    leaseTtl(input.lease_ttl_ms);
    const limit = boundedInteger(input.limit, 1, 1000, 'limit');
    timestamp(input.now);
    const commands = await this.#repository.claimCommands({ ...input, limit });
    let published = 0;
    let released = 0;
    let unconfirmed = 0;
    for (const command of commands) {
      try {
        await this.#commandBus.publish({
          subject: command.subject,
          payload: structuredClone(command.payload)
        });
      } catch (error) {
        await this.#repository.releaseCommand({
          command_id: command.command_id,
          dispatcher_id: command.dispatcher_id,
          dispatch_epoch: command.dispatch_epoch,
          error_code: errorCode(error),
          now: input.now
        });
        released += 1;
        continue;
      }
      try {
        await this.#repository.markCommandPublished({
          command_id: command.command_id,
          dispatcher_id: command.dispatcher_id,
          dispatch_epoch: command.dispatch_epoch,
          now: input.now
        });
        published += 1;
      } catch {
        unconfirmed += 1;
      }
    }
    return { claimed: commands.length, published, released, unconfirmed };
  }
}

export function assertCapacityManifestHash(manifest: LoadRunManifest, sha256: string): void {
  if (!SHA256.test(sha256) || canonicalSha256(manifest) !== sha256) {
    throw new LoadRunControlError('manifest_hash_mismatch', 409);
  }
}

function validateLeaseInput(input: {
  run_id: string;
  lease_ttl_ms: number;
  now: string;
}): void {
  safeId(input.run_id, 'run_id');
  leaseTtl(input.lease_ttl_ms);
  timestamp(input.now);
}

function safeId(value: string, field: string): string {
  if (!SAFE_ID.test(value)) throw new LoadRunControlError(`${field}_invalid`, 400);
  return value;
}

function safeShardId(value: string): string {
  if (!value || value.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._@:/-]+$/.test(value)) {
    throw new LoadRunControlError('shard_id_invalid', 400);
  }
  return value;
}

function timestamp(value: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new LoadRunControlError('timestamp_invalid', 400);
  }
  return new Date(value).toISOString();
}

function epoch(value: string): string {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new LoadRunControlError('lease_epoch_invalid', 400);
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 9_223_372_036_854_775_807n) {
    throw new LoadRunControlError('lease_epoch_invalid', 400);
  }
  return value;
}

function leaseTtl(value: number): number {
  return boundedInteger(value, 1_000, 300_000, 'lease_ttl_ms');
}

function nonNegativeInteger(value: number, field: string): number {
  return boundedInteger(value, 0, 1_000_000_000, field);
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new LoadRunControlError(`${field}_invalid`, 400);
  }
  return value;
}

function boundedObject(value: Record<string, unknown>): void {
  const serialized = JSON.stringify(value);
  if (serialized.length > 32_768) throw new LoadRunControlError('metadata_too_large', 413);
}

function safeObjectUri(value: string): string {
  if (!value || value.length > 2048 || /[\r\n\0]/.test(value)) {
    throw new LoadRunControlError('object_uri_invalid', 400);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LoadRunControlError('object_uri_invalid', 400);
  }
  if (!['s3:', 'gs:', 'https:'].includes(url.protocol) ||
      !url.hostname || url.username || url.password) {
    throw new LoadRunControlError('object_uri_invalid', 400);
  }
  return value;
}

function safeCode(value: string): string {
  if (value.length > 255 || (value && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value))) {
    throw new LoadRunControlError('error_code_invalid', 400);
  }
  return value;
}

function errorCode(error: unknown): string {
  const candidate = String((error as { code?: unknown })?.code || '');
  if (candidate && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(candidate)) return candidate;
  return 'command_publish_failed';
}
