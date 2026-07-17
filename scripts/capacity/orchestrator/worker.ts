import {
  LoadRunControlError,
  type CapacityShardExecutionCheckpoint,
  type CapacityStartShardCommand
} from './types.js';
import { canonicalSha256 } from '../canonical-json.js';

export interface CapacityShardLeaseCoordinator {
  renew(input: {
    run_id: string;
    phase_id: string;
    shard_id: string;
    worker_id: string;
    lease_epoch: string;
    lease_ttl_ms: number;
    now: string;
  }): Promise<{
    execution_claimed: boolean;
    execution_checkpoint?: CapacityShardExecutionCheckpoint;
  }>;
}

export interface CapacityShardExecutor {
  start(
    command: CapacityStartShardCommand,
    options: { signal: AbortSignal }
  ): Promise<void>;
  resume?(
    command: CapacityStartShardCommand,
    checkpoint: CapacityShardExecutionCheckpoint,
    options: { signal: AbortSignal }
  ): Promise<void>;
}

export class FencedCapacityCommandHandler {
  readonly #workerId: string;
  readonly #fleetId: string;
  readonly #leaseTtlMs: number;
  readonly #renewalIntervalMs: number;
  readonly #now: () => string;
  readonly #coordinator: CapacityShardLeaseCoordinator;
  readonly #executor: CapacityShardExecutor;

  constructor(input: {
    worker_id: string;
    fleet_id: string;
    lease_ttl_ms: number;
    renewal_interval_ms?: number;
    now?: () => string;
    coordinator: CapacityShardLeaseCoordinator;
    executor: CapacityShardExecutor;
  }) {
    this.#workerId = safeToken(input.worker_id, 'worker_id');
    this.#fleetId = safeToken(input.fleet_id, 'fleet_id');
    if (!Number.isInteger(input.lease_ttl_ms) ||
        input.lease_ttl_ms < 1_000 || input.lease_ttl_ms > 300_000) {
      throw new LoadRunControlError('lease_ttl_ms_invalid', 400);
    }
    this.#leaseTtlMs = input.lease_ttl_ms;
    const renewalIntervalMs = input.renewal_interval_ms ??
      Math.max(100, Math.floor(input.lease_ttl_ms / 3));
    if (!Number.isInteger(renewalIntervalMs) ||
        renewalIntervalMs < 100 || renewalIntervalMs > input.lease_ttl_ms / 2) {
      throw new LoadRunControlError('renewal_interval_ms_invalid', 400);
    }
    this.#renewalIntervalMs = renewalIntervalMs;
    this.#now = input.now || (() => new Date().toISOString());
    this.#coordinator = input.coordinator;
    this.#executor = input.executor;
  }

  async handle(raw: unknown): Promise<void> {
    const command = validateStartShardCommand(raw);
    if (command.worker_id !== this.#workerId || command.fleet_id !== this.#fleetId) {
      throw new LoadRunControlError('command_target_mismatch', 409);
    }
    const now = validTimestamp(this.#now());
    if (Date.parse(command.lease_expires_at) <= Date.parse(now)) {
      throw new LoadRunControlError('command_lease_expired', 409);
    }
    const initialRenewal = await this.#coordinator.renew({
      run_id: command.run_id,
      phase_id: command.phase_id,
      shard_id: command.shard_id,
      worker_id: command.worker_id,
      lease_epoch: command.lease_epoch,
      lease_ttl_ms: this.#leaseTtlMs,
      now
    });
    const resumeCheckpoint = initialRenewal.execution_claimed
      ? null
      : resumableCheckpoint(initialRenewal.execution_checkpoint);
    if (!initialRenewal.execution_claimed && !resumeCheckpoint) return;
    const controller = new AbortController();
    let renewalError: unknown = null;
    const renewal = this.#maintainLease(command, controller.signal)
      .catch((error) => {
        renewalError = error;
        controller.abort(error);
      });
    const execution = resumeCheckpoint
      ? this.#executor.resume!(
        structuredClone(command),
        structuredClone(resumeCheckpoint),
        { signal: controller.signal }
      )
      : this.#executor.start(
        structuredClone(command),
        { signal: controller.signal }
      );
    try {
      await Promise.race([
        execution,
        renewal.then(() => {
          if (renewalError) throw renewalError;
          return new Promise<void>(() => undefined);
        })
      ]);
    } finally {
      controller.abort();
      await renewal;
    }
    if (renewalError) throw renewalError;
  }

  async #maintainLease(
    command: CapacityStartShardCommand,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      await abortableDelay(this.#renewalIntervalMs, signal);
      if (signal.aborted) return;
      await this.#coordinator.renew({
        run_id: command.run_id,
        phase_id: command.phase_id,
        shard_id: command.shard_id,
        worker_id: command.worker_id,
        lease_epoch: command.lease_epoch,
        lease_ttl_ms: this.#leaseTtlMs,
        now: validTimestamp(this.#now())
      });
    }
  }
}

function resumableCheckpoint(
  checkpoint: CapacityShardExecutionCheckpoint | undefined
): CapacityShardExecutionCheckpoint | null {
  if (!checkpoint || checkpoint.state !== 'result_ready') return null;
  if (!checkpoint.result || !/^[a-f0-9]{64}$/.test(checkpoint.result_sha256) ||
      canonicalSha256(checkpoint.result) !== checkpoint.result_sha256) {
    throw new LoadRunControlError('execution_checkpoint_invalid', 500);
  }
  return checkpoint;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function validateStartShardCommand(raw: unknown): CapacityStartShardCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LoadRunControlError('command_payload_invalid', 400);
  }
  if (JSON.stringify(raw).length > 65_536) {
    throw new LoadRunControlError('command_payload_invalid', 413);
  }
  const value = raw as Record<string, unknown>;
  const exactKeys = [
    'schema_version', 'command_id', 'command_type', 'run_id', 'phase_id',
    'shard_id', 'worker_id', 'fleet_id', 'lease_epoch', 'lease_expires_at',
    'issued_at', 'assignment'
  ];
  if (Object.keys(value).sort().join('|') !== exactKeys.sort().join('|') ||
      value.schema_version !== '1.0.0' || value.command_type !== 'start_shard') {
    throw new LoadRunControlError('command_payload_invalid', 400);
  }
  for (const field of [
    'command_id', 'run_id', 'phase_id', 'worker_id', 'fleet_id'
  ]) safeToken(value[field], field);
  safeShardId(value.shard_id);
  decimalEpoch(value.lease_epoch);
  const leaseExpiresAt = validTimestamp(value.lease_expires_at);
  const issuedAt = validTimestamp(value.issued_at);
  if (Date.parse(issuedAt) >= Date.parse(leaseExpiresAt)) {
    throw new LoadRunControlError('command_payload_invalid', 400);
  }

  const assignment = value.assignment;
  if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
    throw new LoadRunControlError('command_assignment_invalid', 400);
  }
  const details = assignment as Record<string, unknown>;
  const assignmentKeys = [
    'workload_domain', 'workload_id', 'workload_kind', 'ordinal_start',
    'ordinal_end_exclusive', 'expected_count', 'required_protocols', 'seed'
  ];
  if (Object.keys(details).sort().join('|') !== assignmentKeys.sort().join('|') ||
      !['interaction', 'connection'].includes(String(details.workload_domain))) {
    throw new LoadRunControlError('command_assignment_invalid', 400);
  }
  for (const field of ['workload_id', 'workload_kind', 'seed']) {
    safeToken(details[field], field);
  }
  const start = integer(details.ordinal_start, 'ordinal_start');
  const end = integer(details.ordinal_end_exclusive, 'ordinal_end_exclusive');
  const expected = integer(details.expected_count, 'expected_count');
  if (start < 0 || end <= start || expected !== end - start ||
      expected > 1_000_000_000) {
    throw new LoadRunControlError('command_assignment_invalid', 400);
  }
  if (!Array.isArray(details.required_protocols) ||
      details.required_protocols.length === 0 ||
      details.required_protocols.length > 32 ||
      new Set(details.required_protocols).size !== details.required_protocols.length ||
      details.required_protocols.some((protocol) =>
        typeof protocol !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(protocol))) {
    throw new LoadRunControlError('command_assignment_invalid', 400);
  }
  return structuredClone(value) as unknown as CapacityStartShardCommand;
}

function safeToken(value: unknown, field: string): string {
  const text = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(text)) {
    throw new LoadRunControlError(`${field}_invalid`, 400);
  }
  return text;
}

function safeShardId(value: unknown): string {
  const text = String(value || '');
  if (!text || text.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._@:/-]+$/.test(text)) {
    throw new LoadRunControlError('shard_id_invalid', 400);
  }
  return text;
}

function decimalEpoch(value: unknown): string {
  const text = String(value || '');
  if (!/^[1-9][0-9]{0,18}$/.test(text)) {
    throw new LoadRunControlError('lease_epoch_invalid', 400);
  }
  return text;
}

function validTimestamp(value: unknown): string {
  const text = String(value || '');
  if (!Number.isFinite(Date.parse(text))) {
    throw new LoadRunControlError('timestamp_invalid', 400);
  }
  return new Date(text).toISOString();
}

function integer(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new LoadRunControlError(`${field}_invalid`, 400);
  }
  return parsed;
}
