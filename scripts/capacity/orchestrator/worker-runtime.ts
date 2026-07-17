import { canonicalJson, canonicalSha256 } from '../canonical-json.js';
import {
  LoadRunControlError,
  type CapacityEvidenceRecord,
  type CapacityShardExecutionCheckpoint,
  type CapacityShardExecutionCheckpointRepository,
  type CapacityShardExecutionResult,
  type CapacityStartShardCommand
} from './types.js';
import type { CapacityShardExecutor } from './worker.js';

export interface CapacityShardDriver {
  execute(
    command: CapacityStartShardCommand,
    options: { signal: AbortSignal }
  ): Promise<CapacityShardExecutionResult>;
}

export interface CapacityShardResultFinalizer {
  finalize(
    command: CapacityStartShardCommand,
    result: CapacityShardExecutionResult,
    options: { signal: AbortSignal }
  ): Promise<void>;
}

export interface CapacityEvidenceObjectStore {
  put(input: {
    key: string;
    body: Uint8Array;
    sha256: string;
    content_type: 'application/json';
    signal: AbortSignal;
  }): Promise<{ object_uri: string }>;
}

export interface CapacityShardResultControl {
  registerEvidence(input: {
    evidence_id: string;
    run_id: string;
    phase_id: string;
    shard_id: string;
    kind: string;
    metadata: Record<string, unknown>;
    now: string;
  }): Promise<CapacityEvidenceRecord>;
  startEvidenceUpload(input: {
    evidence_id: string;
    now: string;
  }): Promise<CapacityEvidenceRecord>;
  completeEvidenceUpload(input: {
    evidence_id: string;
    object_uri: string;
    sha256: string;
    byte_size: number;
    captured_at: string;
    now: string;
  }): Promise<CapacityEvidenceRecord>;
  verifyEvidence(input: {
    evidence_id: string;
    outcome: 'verified';
    error_code: '';
    now: string;
  }): Promise<CapacityEvidenceRecord>;
  completeShard(input: {
    run_id: string;
    phase_id: string;
    shard_id: string;
    worker_id: string;
    lease_epoch: string;
    outcome: CapacityShardExecutionResult['outcome'];
    evidence_id: string;
    error_code: string;
    now: string;
  }): Promise<void>;
}

export class CheckpointedCapacityShardExecutor implements CapacityShardExecutor {
  readonly #driver: CapacityShardDriver;
  readonly #checkpointRepository: CapacityShardExecutionCheckpointRepository;
  readonly #finalizer: CapacityShardResultFinalizer;
  readonly #now: () => string;

  constructor(input: {
    driver: CapacityShardDriver;
    checkpoint_repository: CapacityShardExecutionCheckpointRepository;
    finalizer: CapacityShardResultFinalizer;
    now?: () => string;
  }) {
    this.#driver = input.driver;
    this.#checkpointRepository = input.checkpoint_repository;
    this.#finalizer = input.finalizer;
    this.#now = input.now || (() => new Date().toISOString());
  }

  async start(
    command: CapacityStartShardCommand,
    options: { signal: AbortSignal }
  ): Promise<void> {
    const result = validateCapacityShardExecutionResult(
      await this.#driver.execute(structuredClone(command), options)
    );
    const resultSha256 = canonicalSha256(result);
    const checkpoint = await this.#checkpointRepository.saveShardExecutionResult({
      run_id: command.run_id,
      phase_id: command.phase_id,
      shard_id: command.shard_id,
      worker_id: command.worker_id,
      lease_epoch: command.lease_epoch,
      result,
      result_sha256: resultSha256,
      now: validTimestamp(this.#now())
    });
    await this.#finalizeCheckpoint(command, checkpoint, options);
  }

  async resume(
    command: CapacityStartShardCommand,
    checkpoint: CapacityShardExecutionCheckpoint,
    options: { signal: AbortSignal }
  ): Promise<void> {
    await this.#finalizeCheckpoint(command, checkpoint, options);
  }

  async #finalizeCheckpoint(
    command: CapacityStartShardCommand,
    checkpoint: CapacityShardExecutionCheckpoint,
    options: { signal: AbortSignal }
  ): Promise<void> {
    if (checkpoint.state !== 'result_ready' || !checkpoint.result ||
        canonicalSha256(checkpoint.result) !== checkpoint.result_sha256) {
      throw new LoadRunControlError('execution_checkpoint_invalid', 500);
    }
    await this.#finalizer.finalize(
      structuredClone(command),
      validateCapacityShardExecutionResult(checkpoint.result),
      options
    );
  }
}

export class DurableCapacityShardResultFinalizer
implements CapacityShardResultFinalizer {
  readonly #control: CapacityShardResultControl;
  readonly #objectStore: CapacityEvidenceObjectStore;
  readonly #evidencePrefix: string;
  readonly #now: () => string;

  constructor(input: {
    control: CapacityShardResultControl;
    object_store: CapacityEvidenceObjectStore;
    evidence_prefix: string;
    now?: () => string;
  }) {
    this.#control = input.control;
    this.#objectStore = input.object_store;
    this.#evidencePrefix = evidencePrefix(input.evidence_prefix);
    this.#now = input.now || (() => new Date().toISOString());
  }

  async finalize(
    command: CapacityStartShardCommand,
    rawResult: CapacityShardExecutionResult,
    options: { signal: AbortSignal }
  ): Promise<void> {
    abortIfNeeded(options.signal);
    const result = validateCapacityShardExecutionResult(rawResult);
    const resultSha256 = canonicalSha256(result);
    const document = capacityShardEvidenceDocument(command, result);
    const body = Buffer.from(canonicalJson(document));
    const sha256 = canonicalSha256(document);
    const evidenceId = capacityEvidenceId(command);
    const key = [
      this.#evidencePrefix,
      command.run_id,
      command.phase_id,
      `${evidenceId}.json`
    ].join('/');
    const now = validTimestamp(this.#now());
    let record = await this.#control.registerEvidence({
      evidence_id: evidenceId,
      run_id: command.run_id,
      phase_id: command.phase_id,
      shard_id: command.shard_id,
      kind: result.evidence_kind,
      metadata: {
        command_id: command.command_id,
        fleet_id: command.fleet_id,
        worker_id: command.worker_id,
        lease_epoch: command.lease_epoch,
        result_sha256: resultSha256,
        evidence_sha256: sha256
      },
      now
    });
    assertEvidenceRecord(record, command, result, sha256, body.byteLength);
    if (record.state === 'pending' || record.state === 'uploading') {
      record = await this.#control.startEvidenceUpload({
        evidence_id: evidenceId,
        now
      });
      assertEvidenceRecord(record, command, result, sha256, body.byteLength);
    }
    if (record.state === 'uploading') {
      abortIfNeeded(options.signal);
      const uploaded = await this.#objectStore.put({
        key,
        body,
        sha256,
        content_type: 'application/json',
        signal: options.signal
      });
      record = await this.#control.completeEvidenceUpload({
        evidence_id: evidenceId,
        object_uri: uploaded.object_uri,
        sha256,
        byte_size: body.byteLength,
        captured_at: now,
        now
      });
      assertEvidenceRecord(record, command, result, sha256, body.byteLength);
    }
    if (record.state === 'uploaded') {
      record = await this.#control.verifyEvidence({
        evidence_id: evidenceId,
        outcome: 'verified',
        error_code: '',
        now
      });
      assertEvidenceRecord(record, command, result, sha256, body.byteLength);
    }
    if (record.state !== 'verified') {
      throw new LoadRunControlError('capacity_evidence_not_verified', 409, true);
    }
    abortIfNeeded(options.signal);
    await this.#control.completeShard({
      run_id: command.run_id,
      phase_id: command.phase_id,
      shard_id: command.shard_id,
      worker_id: command.worker_id,
      lease_epoch: command.lease_epoch,
      outcome: result.outcome,
      evidence_id: evidenceId,
      error_code: result.error_code,
      now: validTimestamp(this.#now())
    });
  }
}

export function capacityShardEvidenceDocument(
  command: CapacityStartShardCommand,
  result: CapacityShardExecutionResult
): Record<string, unknown> {
  return {
    schema_version: '1.0.0',
    command: {
      command_id: command.command_id,
      run_id: command.run_id,
      phase_id: command.phase_id,
      shard_id: command.shard_id,
      worker_id: command.worker_id,
      fleet_id: command.fleet_id,
      lease_epoch: command.lease_epoch,
      issued_at: command.issued_at,
      lease_expires_at: command.lease_expires_at,
      assignment: structuredClone(command.assignment)
    },
    result: structuredClone(result)
  };
}

export function validateCapacityShardExecutionResult(
  raw: CapacityShardExecutionResult
): CapacityShardExecutionResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      raw.schema_version !== '1.0.0' ||
      !['completed', 'failed', 'cancelled', 'not_run'].includes(raw.outcome) ||
      typeof raw.error_code !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/.test(raw.evidence_kind) ||
      !raw.evidence || typeof raw.evidence !== 'object' ||
      Array.isArray(raw.evidence)) {
    throw new LoadRunControlError('execution_result_invalid', 400);
  }
  if (raw.outcome === 'completed' ? raw.error_code !== '' : !safeErrorCode(raw.error_code)) {
    throw new LoadRunControlError('execution_result_invalid', 400);
  }
  const cloned = structuredClone(raw);
  if (Buffer.byteLength(canonicalJson(cloned)) > 16 * 1024 * 1024) {
    throw new LoadRunControlError('execution_result_too_large', 413);
  }
  return cloned;
}

function capacityEvidenceId(command: CapacityStartShardCommand): string {
  return `capacity-${canonicalSha256({
    run_id: command.run_id,
    phase_id: command.phase_id,
    shard_id: command.shard_id,
    worker_id: command.worker_id,
    lease_epoch: command.lease_epoch
  })}`;
}

function assertEvidenceRecord(
  record: CapacityEvidenceRecord,
  command: CapacityStartShardCommand,
  result: CapacityShardExecutionResult,
  evidenceSha256: string,
  byteSize: number
): void {
  if (record.run_id !== command.run_id ||
      record.phase_id !== command.phase_id ||
      record.shard_id !== command.shard_id ||
      record.kind !== result.evidence_kind ||
      record.metadata.command_id !== command.command_id ||
      record.metadata.worker_id !== command.worker_id ||
      record.metadata.fleet_id !== command.fleet_id ||
      record.metadata.lease_epoch !== command.lease_epoch ||
      record.metadata.result_sha256 !== canonicalSha256(result) ||
      record.metadata.evidence_sha256 !== evidenceSha256) {
    throw new LoadRunControlError('capacity_evidence_identity_mismatch', 409);
  }
  if (record.state === 'uploaded' || record.state === 'verified') {
    if (!record.object_uri || record.sha256 !== evidenceSha256 ||
        record.byte_size !== byteSize) {
      throw new LoadRunControlError('capacity_evidence_object_mismatch', 409);
    }
  }
}

function evidencePrefix(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.length > 512 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized) ||
      normalized.split('/').some((part) => part === '' || part === '..')) {
    throw new LoadRunControlError('evidence_prefix_invalid', 400);
  }
  return normalized;
}

function safeErrorCode(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(value);
}

function validTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new LoadRunControlError('timestamp_invalid', 500);
  }
  return new Date(value).toISOString();
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new LoadRunControlError('capacity_worker_aborted', 409, true);
  }
}
