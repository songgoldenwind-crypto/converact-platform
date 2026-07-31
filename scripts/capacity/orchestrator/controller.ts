import { canonicalSha256 } from '../canonical-json.js';
import type { LoadRunManifest } from '../profile-compiler.js';
import {
  LoadRunControlError,
  type CapacityControllerLease,
  type CapacityRunOutcome,
  type CapacityRunState
} from './types.js';

export interface CapacityRunPhaseProgress {
  phase_id: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  total_shards: number;
  completed_shards: number;
  failed_shards: number;
  cancelled_shards: number;
  not_run_shards: number;
  active_shards: number;
}

export interface CapacityRunControlState {
  state: CapacityRunState;
  current_phase_id: string;
  manifest_sha256: string;
  evidence_manifest_sha256: string;
  outcome: string;
}

export interface CapacityRunControllerControl {
  createRun(input: {
    manifest: LoadRunManifest;
    manifest_sha256: string;
    created_at: string;
  }): Promise<void>;
  readRunControlState(input: {
    run_id: string;
  }): Promise<CapacityRunControlState>;
  claimController(input: {
    run_id: string;
    controller_id: string;
    lease_ttl_ms: number;
    now: string;
  }): Promise<CapacityControllerLease>;
  readPhaseProgress(input: {
    run_id: string;
    phase_id: string;
  }): Promise<CapacityRunPhaseProgress>;
  startPhase(input: {
    run_id: string;
    phase_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    now: string;
  }): Promise<void>;
  completePhase(input: {
    run_id: string;
    phase_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    outcome: 'completed' | 'failed';
    now: string;
  }): Promise<void>;
  skipPendingPhases(input: {
    run_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    now: string;
  }): Promise<void>;
  beginRunFinalization(input: {
    run_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    now: string;
  }): Promise<void>;
  finalizeRun(input: {
    run_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    outcome: CapacityRunOutcome;
    evidence_manifest_sha256: string;
    failure_code: string;
    now: string;
  }): Promise<void>;
}

export interface CapacityRunControllerResult {
  run_id: string;
  state: CapacityRunState;
  outcome: string;
}

export class CapacityRunController {
  readonly #control: CapacityRunControllerControl;
  readonly #controllerId: string;
  readonly #leaseTtlMs: number;
  readonly #pollIntervalMs: number;
  readonly #now: () => string;
  readonly #delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(input: {
    control: CapacityRunControllerControl;
    controller_id: string;
    lease_ttl_ms: number;
    poll_interval_ms: number;
    now?: () => string;
    delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  }) {
    this.#control = input.control;
    this.#controllerId = safeId(input.controller_id, 'controller_id');
    this.#leaseTtlMs = boundedInteger(input.lease_ttl_ms, 1_000, 300_000, 'lease_ttl_ms');
    this.#pollIntervalMs = boundedInteger(
      input.poll_interval_ms,
      100,
      Math.floor(input.lease_ttl_ms / 3),
      'poll_interval_ms'
    );
    this.#now = input.now || (() => new Date().toISOString());
    this.#delay = input.delay || abortableDelay;
  }

  async run(
    input: {
      manifest: LoadRunManifest;
      manifest_sha256: string;
    },
    signal?: AbortSignal
  ): Promise<CapacityRunControllerResult> {
    if (canonicalSha256(input.manifest) !== input.manifest_sha256) {
      throw new LoadRunControlError('manifest_hash_mismatch', 409);
    }
    await this.#ensureRun(input);
    while (!signal?.aborted) {
      const state = await this.#control.readRunControlState({
        run_id: input.manifest.run_id
      });
      if (state.manifest_sha256 !== input.manifest_sha256) {
        throw new LoadRunControlError('existing_run_manifest_mismatch', 409);
      }
      if (state.state === 'finalizing') {
        return result(input.manifest.run_id, state.state, 'awaiting_evidence_validation');
      }
      if (isTerminal(state.state)) {
        return result(
          input.manifest.run_id,
          state.state,
          state.outcome || state.state
        );
      }
      const now = validTimestamp(this.#now());
      if (Date.parse(input.manifest.start_not_before) > Date.parse(now)) {
        await this.#delay(this.#pollIntervalMs, signal);
        continue;
      }
      let lease: CapacityControllerLease;
      try {
        lease = await this.#control.claimController({
          run_id: input.manifest.run_id,
          controller_id: this.#controllerId,
          lease_ttl_ms: this.#leaseTtlMs,
          now
        });
      } catch (error) {
        if (!(error instanceof LoadRunControlError) ||
            error.code !== 'controller_lease_unavailable') throw error;
        await this.#delay(this.#pollIntervalMs, signal);
        continue;
      }
      const advanced = await this.#advance(input.manifest, lease, now);
      if (advanced) return advanced;
      await this.#delay(this.#pollIntervalMs, signal);
    }
    throw new LoadRunControlError('capacity_controller_aborted', 409, true);
  }

  async #ensureRun(input: {
    manifest: LoadRunManifest;
    manifest_sha256: string;
  }): Promise<void> {
    try {
      await this.#control.createRun({
        manifest: input.manifest,
        manifest_sha256: input.manifest_sha256,
        created_at: validTimestamp(this.#now())
      });
    } catch (error) {
      if (!(error instanceof LoadRunControlError) ||
          error.code !== 'run_already_exists') throw error;
      const existing = await this.#control.readRunControlState({
        run_id: input.manifest.run_id
      });
      if (existing.manifest_sha256 !== input.manifest_sha256) {
        throw new LoadRunControlError('existing_run_manifest_mismatch', 409);
      }
    }
  }

  async #advance(
    manifest: LoadRunManifest,
    lease: CapacityControllerLease,
    now: string
  ): Promise<CapacityRunControllerResult | null> {
    for (const phase of manifest.phases) {
      let progress = await this.#control.readPhaseProgress({
        run_id: manifest.run_id,
        phase_id: phase.id
      });
      if (progress.state === 'completed') continue;
      if (progress.state === 'failed' || progress.state === 'skipped') {
        return await this.#failRun(manifest.run_id, lease, now);
      }
      if (progress.state === 'pending') {
        await this.#control.startPhase({
          run_id: manifest.run_id,
          phase_id: phase.id,
          controller_id: this.#controllerId,
          controller_lease_epoch: lease.lease_epoch,
          now
        });
        progress = await this.#control.readPhaseProgress({
          run_id: manifest.run_id,
          phase_id: phase.id
        });
      }
      if (progress.state !== 'running' || progress.active_shards > 0) return null;
      if (terminalShardCount(progress) !== progress.total_shards) return null;
      const outcome = progress.failed_shards > 0 ||
        progress.cancelled_shards > 0 || progress.not_run_shards > 0
        ? 'failed'
        : 'completed';
      await this.#control.completePhase({
        run_id: manifest.run_id,
        phase_id: phase.id,
        controller_id: this.#controllerId,
        controller_lease_epoch: lease.lease_epoch,
        outcome,
        now
      });
      if (outcome === 'failed') {
        return await this.#failRun(manifest.run_id, lease, now);
      }
    }
    await this.#control.beginRunFinalization({
      run_id: manifest.run_id,
      controller_id: this.#controllerId,
      controller_lease_epoch: lease.lease_epoch,
      now
    });
    return result(manifest.run_id, 'finalizing', 'awaiting_evidence_validation');
  }

  async #failRun(
    runId: string,
    lease: CapacityControllerLease,
    now: string
  ): Promise<CapacityRunControllerResult> {
    await this.#control.skipPendingPhases({
      run_id: runId,
      controller_id: this.#controllerId,
      controller_lease_epoch: lease.lease_epoch,
      now
    });
    await this.#control.finalizeRun({
      run_id: runId,
      controller_id: this.#controllerId,
      controller_lease_epoch: lease.lease_epoch,
      outcome: 'failed',
      evidence_manifest_sha256: '',
      failure_code: 'capacity_phase_failed',
      now
    });
    return result(runId, 'failed', 'failed');
  }
}

function terminalShardCount(progress: CapacityRunPhaseProgress): number {
  return progress.completed_shards + progress.failed_shards +
    progress.cancelled_shards + progress.not_run_shards;
}

function result(
  runId: string,
  state: CapacityRunState,
  outcome: string
): CapacityRunControllerResult {
  return { run_id: runId, state, outcome };
}

function isTerminal(state: CapacityRunState): boolean {
  return ['completed', 'failed', 'cancelled', 'not_run'].includes(state);
}

function safeId(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(value)) {
    throw new LoadRunControlError(`${field}_invalid`, 400);
  }
  return value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new LoadRunControlError(`${field}_invalid`, 400);
  }
  return value;
}

function validTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new LoadRunControlError('timestamp_invalid', 500);
  }
  return new Date(value).toISOString();
}

function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
