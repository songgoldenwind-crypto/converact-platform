import { safeVoiceProviderPayload } from '../canonical.js';
import { VoiceError } from '../errors.js';
import { observeVoiceReconciliation } from '../metrics.js';
import type { VoiceCallUnitOfWork } from '../ports.js';
import { VoiceProviderRegistry } from '../provider-registry.js';
import { mergeProviderCallState } from '../state-machine.js';
import type { VoiceCall, VoiceCallCommand, VoiceDeploymentProfile } from '../types.js';

export interface VoiceReconciliationWorkerOptions {
  unit_of_work: VoiceCallUnitOfWork;
  provider_registry: VoiceProviderRegistry;
  command_reconciler?: (input: {
    call: VoiceCall;
    command: VoiceCallCommand;
  }) => Promise<VoiceCallCommandReconcileResult | null>;
  worker_id: string;
  batch_size?: number;
  lease_ms?: number;
  reconcile_delay_ms?: number;
  max_reconcile_age_ms?: number;
  now?: () => Date;
}

export interface VoiceCallCommandReconcileResult {
  state: 'pending' | 'succeeded' | 'failed' | 'unknown';
  provider_state?: string;
  provider_call_id?: string;
  provider_dialog_id?: string;
  media_call_id?: string;
}

export interface VoiceReconciliationRunResult {
  claimed: number;
  succeeded: number;
  failed: number;
  pending: number;
  unknown: number;
  stale: number;
}

type ReconcileOutcome = VoiceCallCommandReconcileResult;

export class VoiceReconciliationWorker {
  readonly #unitOfWork: VoiceCallUnitOfWork;
  readonly #registry: VoiceProviderRegistry;
  readonly #commandReconciler?: VoiceReconciliationWorkerOptions['command_reconciler'];
  readonly #workerId: string;
  readonly #batchSize: number;
  readonly #leaseMs: number;
  readonly #reconcileDelayMs: number;
  readonly #maxReconcileAgeMs: number;
  readonly #now: () => Date;
  #active: Promise<VoiceReconciliationRunResult> | null = null;
  #shutdown = false;

  constructor(options: VoiceReconciliationWorkerOptions) {
    this.#unitOfWork = options.unit_of_work;
    this.#registry = options.provider_registry;
    this.#commandReconciler = options.command_reconciler;
    this.#workerId = boundedIdentifier(options.worker_id);
    this.#batchSize = boundedInteger(options.batch_size, 25, 1, 200);
    this.#leaseMs = boundedInteger(options.lease_ms, 30_000, 1_000, 15 * 60_000);
    this.#reconcileDelayMs = boundedInteger(options.reconcile_delay_ms, 5_000, 100, 60 * 60_000);
    this.#maxReconcileAgeMs = boundedInteger(options.max_reconcile_age_ms, 15 * 60_000, this.#reconcileDelayMs, 7 * 24 * 60 * 60_000);
    this.#now = options.now ?? (() => new Date());
  }

  runOnce(tenantIdInput: string): Promise<VoiceReconciliationRunResult> {
    if (this.#shutdown) return Promise.reject(new VoiceError({ code: 'provider_unavailable', status: 503 }));
    if (this.#active) return this.#active;
    const tenantId = boundedIdentifier(tenantIdInput);
    this.#active = this.#run(tenantId).finally(() => { this.#active = null; });
    return this.#active;
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    await this.#active;
  }

  async #run(tenantId: string): Promise<VoiceReconciliationRunResult> {
    const now = this.#now();
    const commands = await this.#unitOfWork.run(tenantId, ({ commands }) => commands.claimCallUncertain({
      tenant_id: tenantId, worker_id: this.#workerId, now,
      lease_ms: this.#leaseMs, limit: this.#batchSize
    }));
    const result: VoiceReconciliationRunResult = {
      claimed: commands.length, succeeded: 0, failed: 0, pending: 0, unknown: 0, stale: 0
    };
    for (const command of commands) await this.#reconcile(command, result);
    return result;
  }

  async #reconcile(command: VoiceCallCommand, result: VoiceReconciliationRunResult): Promise<void> {
    let call: VoiceCall;
    let profile: VoiceDeploymentProfile;
    try {
      const loaded = await this.#unitOfWork.run(command.tenant_id, async ({ calls, configuration }) => {
        const foundCall = required(await calls.get(command.tenant_id, command.call_id));
        const foundProfile = required(await configuration.getProfile(command.tenant_id, foundCall.provider_profile_id));
        return { call: foundCall, profile: foundProfile };
      });
      call = loaded.call;
      profile = loaded.profile;
    } catch (error) {
      observeVoiceReconciliation({ adapter: 'other', result: 'pending' });
      await this.#release(command, classifyError(error), result, 'pending');
      return;
    }

    let adapter: Awaited<ReturnType<VoiceProviderRegistry['create']>> | null = null;
    let outcome: ReconcileOutcome;
    try {
      const specialized = await this.#commandReconciler?.({ call, command });
      if (specialized) {
        outcome = specialized;
      } else {
        adapter = await this.#registry.create(profile, { purpose: 'execute' });
        outcome = await adapter.reconcile({ call, command });
      }
    } catch (error) {
      await this.#release(command, classifyError(error), result, 'pending');
      return;
    } finally {
      await adapter?.close().catch(() => undefined);
    }

    try {
      observeVoiceReconciliation({ adapter: profile.adapter, result: outcome.state });
      if (outcome.state === 'succeeded') {
        await this.#settleTerminal(command, outcome, 'succeeded');
        result.succeeded += 1;
        return;
      }
      if (outcome.state === 'failed') {
        await this.#settleTerminal(command, outcome, 'failed', 'provider_command_failed');
        result.failed += 1;
        return;
      }
      if (outcome.state === 'pending') {
        await this.#release(command, 'provider_pending', result, 'pending');
        return;
      }
      if (this.#now().getTime() - new Date(command.created_at).getTime() >= this.#maxReconcileAgeMs) {
        await this.#settleTerminal(command, { ...outcome, provider_state: 'failed' }, 'failed', 'provider_result_unknown');
        result.failed += 1;
        return;
      }
      await this.#release(command, 'provider_result_unknown', result, 'unknown');
    } catch (error) {
      if (error instanceof VoiceError && error.code === 'lease_lost') {
        result.stale += 1;
        return;
      }
      throw error;
    }
  }

  async #settleTerminal(
    command: VoiceCallCommand,
    outcome: ReconcileOutcome,
    commandState: 'succeeded' | 'failed',
    errorCode = ''
  ): Promise<void> {
    await this.#unitOfWork.run(command.tenant_id, async ({ calls, commands }) => {
      const call = required(await calls.get(command.tenant_id, command.call_id, { for_update: true }));
      const providerState = outcome.provider_state || (commandState === 'failed' ? 'failed' : call.state);
      const transition = providerState === call.state ? {
        state: call.state,
        ringing_at: call.ringing_at,
        answered_at: call.answered_at,
        ended_at: call.ended_at,
        changed: false
      } : mergeProviderCallState(call.state, providerState, {
        ringing_at: call.ringing_at,
        answered_at: call.answered_at,
        ended_at: call.ended_at,
        occurred_at: this.#now().toISOString()
      });
      const updated: VoiceCall = {
        ...call,
        provider_call_id: outcome.provider_call_id || call.provider_call_id,
        provider_dialog_id: outcome.provider_dialog_id || call.provider_dialog_id,
        media_call_id: outcome.media_call_id || call.media_call_id,
        state: transition.state,
        ringing_at: transition.ringing_at,
        answered_at: transition.answered_at,
        ended_at: transition.ended_at,
        termination_reason: commandState === 'failed'
          && (command.kind === 'originate' || outcome.provider_state === 'failed')
          ? errorCode
          : call.termination_reason,
        revision: call.revision + 1,
        updated_at: this.#now().toISOString()
      };
      await calls.update(updated, call.revision);
      await commands.completeCall({
        tenant_id: command.tenant_id, command_id: command.id, worker_id: this.#workerId,
        state: commandState,
        provider_command_id: command.provider_command_id,
        result: safeVoiceProviderPayload({
          provider_state: outcome.provider_state,
          provider_call_id: outcome.provider_call_id,
          provider_dialog_id: outcome.provider_dialog_id,
          media_call_id: outcome.media_call_id
        }),
        error_code: errorCode
      });
    });
  }

  async #release(
    command: VoiceCallCommand,
    errorCode: string,
    result: VoiceReconciliationRunResult,
    counter: 'pending' | 'unknown'
  ): Promise<void> {
    try {
      await this.#unitOfWork.run(command.tenant_id, ({ commands }) => commands.releaseCall({
        tenant_id: command.tenant_id, command_id: command.id, worker_id: this.#workerId,
        state: 'uncertain', next_attempt_at: new Date(this.#now().getTime() + this.#reconcileDelayMs),
        provider_command_id: command.provider_command_id, error_code: errorCode
      }));
      result[counter] += 1;
    } catch (error) {
      if (error instanceof VoiceError && error.code === 'lease_lost') {
        result.stale += 1;
        return;
      }
      throw error;
    }
  }
}

function classifyError(error: unknown): string {
  return error instanceof VoiceError ? error.code : 'provider_unavailable';
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new VoiceError({ code: 'not_found', status: 404 });
  return value;
}

function boundedIdentifier(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) throw validationError();
  return result;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) throw validationError();
  return resolved;
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}
