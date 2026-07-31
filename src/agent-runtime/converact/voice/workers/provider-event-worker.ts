import { VoiceError } from '../errors.js';
import { observeVoiceProviderEvent } from '../metrics.js';
import type { PgQueryable } from '../../../../db-pg.js';
import type { VoiceProviderEventUnitOfWork } from '../ports.js';
import { isVoiceTerminalState, mergeProviderCallState } from '../state-machine.js';
import type { VoiceCall, VoiceProviderEvent } from '../types.js';
import type { VoiceRecordingService } from '../recording-service.js';

export interface VoiceProviderEventWorkerOptions {
  unit_of_work: VoiceProviderEventUnitOfWork;
  recording_service: VoiceRecordingService;
  worker_id: string;
  batch_size?: number;
  lease_ms?: number;
  max_attempts?: number;
  retry_base_ms?: number;
  retry_max_ms?: number;
  retry_jitter_ratio?: number;
  placement?: VoiceProviderEventPlacementPort;
  placement_worker_id?: string;
  now?: () => Date;
  random?: () => number;
}

export interface VoiceProviderEventPlacementPort {
  hasPlacement(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
    }
  ): Promise<boolean>;
  requestState(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
      desired_state: 'closed';
      reason: string;
    }
  ): Promise<void>;
  reconcileOne(input: {
    tenant_id: string;
    interaction_id: string;
    worker_id: string;
  }): Promise<'idle' | 'succeeded' | 'retry_wait' | 'failed'>;
}

export interface VoiceProviderEventWorkerResult {
  claimed: number;
  processed: number;
  retry_wait: number;
  failed: number;
  stale: number;
}

export class VoiceProviderEventWorker {
  readonly #unitOfWork: VoiceProviderEventUnitOfWork;
  readonly #recordingService: VoiceRecordingService;
  readonly #workerId: string;
  readonly #batchSize: number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #retryJitterRatio: number;
  readonly #placement?: VoiceProviderEventPlacementPort;
  readonly #placementWorkerId: string;
  readonly #now: () => Date;
  readonly #random: () => number;
  #active: Promise<VoiceProviderEventWorkerResult> | null = null;
  #shutdown = false;

  constructor(options: VoiceProviderEventWorkerOptions) {
    this.#unitOfWork = options.unit_of_work;
    this.#recordingService = options.recording_service;
    this.#workerId = boundedIdentifier(options.worker_id);
    this.#batchSize = boundedInteger(options.batch_size, 25, 1, 200);
    this.#leaseMs = boundedInteger(options.lease_ms, 30_000, 1_000, 15 * 60_000);
    this.#maxAttempts = boundedInteger(options.max_attempts, 5, 1, 100);
    this.#retryBaseMs = boundedInteger(options.retry_base_ms, 1_000, 100, 60_000);
    this.#retryMaxMs = boundedInteger(options.retry_max_ms, 60_000, this.#retryBaseMs, 24 * 60 * 60_000);
    this.#retryJitterRatio = boundedNumber(options.retry_jitter_ratio, 0.2, 0, 1);
    this.#placement = options.placement;
    this.#placementWorkerId = boundedIdentifier(
      options.placement_worker_id || `${this.#workerId}:placement`
    );
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
  }

  runOnce(tenantIdInput: string): Promise<VoiceProviderEventWorkerResult> {
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

  async #run(tenantId: string): Promise<VoiceProviderEventWorkerResult> {
    const events = await this.#unitOfWork.run(tenantId, ({ events: repository }) => repository.claimDue({
      tenant_id: tenantId,
      worker_id: this.#workerId,
      now: this.#now(),
      lease_ms: this.#leaseMs,
      limit: this.#batchSize
    }));
    const result: VoiceProviderEventWorkerResult = {
      claimed: events.length, processed: 0, retry_wait: 0, failed: 0, stale: 0
    };
    for (const event of events) await this.#process(event, result);
    return result;
  }

  async #process(event: VoiceProviderEvent, result: VoiceProviderEventWorkerResult): Promise<void> {
    let adapter = 'other';
    try {
      const placementCallId = await this.#unitOfWork.run(event.tenant_id, async (context) => {
        try {
          adapter = (await context.configuration.getProfile(event.tenant_id, event.profile_id))?.adapter
            ?? 'other';
        } catch {
          // Metrics metadata is best-effort and must never change event convergence.
          adapter = 'other';
        }
        const call = event.call_id
          ? await context.calls.get(event.tenant_id, event.call_id, { for_update: true })
          : await context.calls.findByProviderCallId(
            event.tenant_id,
            event.profile_id,
            providerCallId(event),
            { for_update: true }
          );
        if (!call || call.provider_profile_id !== event.profile_id) {
          throw new VoiceError({ code: 'not_found', retryable: true, status: 404 });
        }
        const updated = projectCall(call, event, this.#now().toISOString());
        if (event.event_type === 'call.cdr') {
          await this.#recordingService.project(context, updated, event);
        }
        if (!sameProjection(call, updated)) await context.calls.update(updated, call.revision);
        let closePlacement = false;
        if (this.#placement && context.pg && isVoiceTerminalState(updated.state) &&
            await this.#placement.hasPlacement(context.pg, {
              tenant_id: event.tenant_id,
              interaction_id: updated.id
            })) {
          await this.#placement.requestState(context.pg, {
            tenant_id: event.tenant_id,
            interaction_id: updated.id,
            desired_state: 'closed',
            reason: 'voice_provider_terminal'
          });
          closePlacement = true;
        }
        await context.events.complete({
          tenant_id: event.tenant_id,
          event_id: event.id,
          worker_id: this.#workerId
        });
        return closePlacement ? updated.id : null;
      });
      if (placementCallId && this.#placement) {
        await this.#placement.reconcileOne({
          tenant_id: event.tenant_id,
          interaction_id: placementCallId,
          worker_id: this.#placementWorkerId
        }).catch((error) => {
          console.error(
            '[voice-provider-event] placement reconciliation failed:',
            error instanceof Error ? error.message : String(error)
          );
        });
      }
      result.processed += 1;
      observeVoiceProviderEvent({
        adapter,
        event_type: event.event_type,
        result: 'processed',
        lag_seconds: eventLagSeconds(event, this.#now())
      });
    } catch (error) {
      if (error instanceof VoiceError && error.code === 'lease_lost') {
        result.stale += 1;
        observeVoiceProviderEvent({
          adapter, event_type: event.event_type, result: 'stale',
          lag_seconds: eventLagSeconds(event, this.#now())
        });
        return;
      }
      await this.#release(event, error, result, adapter);
    }
  }

  async #release(
    event: VoiceProviderEvent,
    error: unknown,
    result: VoiceProviderEventWorkerResult,
    adapter: string
  ): Promise<void> {
    const classified = classify(error);
    const retry = classified.retryable && event.attempt_count < this.#maxAttempts;
    const state = retry ? 'retry_wait' as const : 'failed' as const;
    try {
      await this.#unitOfWork.run(event.tenant_id, ({ events }) => events.release({
        tenant_id: event.tenant_id,
        event_id: event.id,
        worker_id: this.#workerId,
        state,
        next_attempt_at: retry
          ? new Date(this.#now().getTime() + this.#retryDelay(event.attempt_count))
          : null,
        error_code: classified.code
      }));
      result[state] += 1;
      observeVoiceProviderEvent({
        adapter, event_type: event.event_type, result: state,
        lag_seconds: eventLagSeconds(event, this.#now())
      });
    } catch (releaseError) {
      if (releaseError instanceof VoiceError && releaseError.code === 'lease_lost') {
        result.stale += 1;
        return;
      }
      throw releaseError;
    }
  }

  #retryDelay(attemptCount: number): number {
    const exponential = Math.min(this.#retryMaxMs, this.#retryBaseMs * (2 ** Math.max(0, attemptCount - 1)));
    const jitter = exponential * this.#retryJitterRatio * ((this.#random() * 2) - 1);
    return Math.max(this.#retryBaseMs, Math.min(this.#retryMaxMs, Math.round(exponential + jitter)));
  }
}

function eventLagSeconds(event: VoiceProviderEvent, now: Date): number {
  const timestamp = event.occurred_at || event.received_at;
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? Math.max(0, (now.getTime() - time) / 1_000) : 0;
}

function projectCall(call: VoiceCall, event: VoiceProviderEvent, now: string): VoiceCall {
  const providerState = convergenceState(event);
  const transition = mergeProviderCallState(call.state, providerState, {
    ringing_at: call.ringing_at,
    answered_at: call.answered_at,
    ended_at: call.ended_at,
    occurred_at: event.occurred_at ?? now
  });
  const cdr = event.event_type === 'call.cdr';
  const durationMs = cdr ? optionalNonNegativeInteger(event.safe_payload.duration_ms) : null;
  const terminationReason = terminalEvent(event)
    ? optionalText(event.safe_payload.hangup_reason ?? event.safe_payload.reason, 128)
    : '';
  const metadata = cdr && durationMs !== null
    ? { ...call.metadata, cdr_duration_ms: durationMs }
    : call.metadata;
  return {
    ...call,
    provider_call_id: call.provider_call_id || providerCallId(event),
    state: transition.state,
    ringing_at: transition.ringing_at,
    answered_at: transition.answered_at,
    ended_at: transition.ended_at,
    termination_reason: terminationReason || call.termination_reason,
    metadata,
    revision: call.revision + 1,
    updated_at: now
  };
}

function convergenceState(event: VoiceProviderEvent): string {
  const fixed: Readonly<Record<string, string>> = {
    'call.incoming': 'ringing',
    'call.answered': 'answered',
    'call.hold': 'held',
    'call.hangup': 'completed',
    'call.no_answer': 'no_answer',
    'call.busy': 'busy',
    'call.transfer': 'transferring'
  };
  if (event.event_type === 'call.ringing' || event.event_type === 'call.cdr') return event.provider_state;
  const state = fixed[event.event_type];
  if (!state) throw new VoiceError({ code: 'protocol_mismatch', status: 422 });
  return state;
}

function terminalEvent(event: VoiceProviderEvent): boolean {
  return event.event_type === 'call.cdr' || event.event_type === 'call.hangup'
    || event.event_type === 'call.no_answer' || event.event_type === 'call.busy';
}

function sameProjection(left: VoiceCall, right: VoiceCall): boolean {
  return left.provider_call_id === right.provider_call_id
    && left.state === right.state
    && left.ringing_at === right.ringing_at
    && left.answered_at === right.answered_at
    && left.ended_at === right.ended_at
    && left.termination_reason === right.termination_reason
    && JSON.stringify(left.metadata) === JSON.stringify(right.metadata);
}

function providerCallId(event: VoiceProviderEvent): string {
  return boundedIdentifier(event.safe_payload.provider_call_id);
}

function optionalText(value: unknown, max: number): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new VoiceError({ code: 'protocol_mismatch', status: 422 });
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new VoiceError({ code: 'protocol_mismatch', status: 422 });
  return Number(value);
}

function classify(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof VoiceError) return { code: coarseCode(error.code), retryable: error.retryable };
  return { code: 'provider_unavailable', retryable: true };
}

function coarseCode(code: VoiceError['code']): string {
  if (code === 'validation_failed' || code === 'unsupported_provider_call_state') return 'protocol_mismatch';
  return code;
}

function boundedIdentifier(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new VoiceError({ code: 'protocol_mismatch', status: 422 });
  }
  return result;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new VoiceError({ code: 'validation_failed', status: 422 });
  }
  return resolved;
}

function boundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < min || resolved > max) {
    throw new VoiceError({ code: 'validation_failed', status: 422 });
  }
  return resolved;
}
