import { randomUUID } from 'node:crypto';

import { ContactCenterError } from './errors.js';
import type {
  ContactCenterAddressProtector,
  ContactCenterCallbackVoicePort,
  ContactCenterRepository,
  ContactCenterUnitOfWork
} from './ports.js';
import { transitionAssignment, transitionPresence, transitionQueueEntry } from './state-machine.js';
import type {
  ContactCenterCallback,
  ContactCenterCallbackListInput,
  ContactCenterCallbackState,
  ContactCenterPage,
  ContactCenterCallbackRecord
} from './types.js';

export interface ContactCenterCallbackServiceOptions {
  unit_of_work: ContactCenterUnitOfWork;
  address_protector: ContactCenterAddressProtector;
  voice: ContactCenterCallbackVoicePort;
  id?: () => string;
  now?: () => Date;
}

export interface ContactCenterCallbackProcessingSummary {
  processed: number;
  started: number;
  retried: number;
  failed: number;
}

export interface ContactCenterCallbackReconciliationSummary {
  scanned: number;
  updated: number;
}

export class ContactCenterCallbackService {
  readonly #unitOfWork: ContactCenterUnitOfWork;
  readonly #addressProtector: ContactCenterAddressProtector;
  readonly #voice: ContactCenterCallbackVoicePort;
  readonly #id: () => string;
  readonly #now: () => Date;

  constructor(options: ContactCenterCallbackServiceOptions) {
    this.#unitOfWork = options.unit_of_work;
    this.#addressProtector = options.address_protector;
    this.#voice = options.voice;
    this.#id = options.id ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  async request(input: {
    tenant_id: string;
    queue_entry_id: string;
    source_call_id: string;
    address: { kind: 'e164' | 'extension' | 'sip_uri'; value: string };
    scheduled_for?: string;
    max_attempts?: number;
    actor: string;
    idempotency_key: string;
  }): Promise<{ callback: ContactCenterCallback; replayed: boolean }> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const entryId = identifier(input.queue_entry_id, 'queue_entry_id');
    const sourceCallId = identifier(input.source_call_id, 'source_call_id');
    const idempotencyKey = idempotency(input.idempotency_key);
    const actor = identifier(input.actor, 'actor');
    const maxAttempts = integer(input.max_attempts ?? 3, 1, 20, 'max_attempts');
    const now = this.#now();
    validDate(now, 'now');
    const scheduledFor = input.scheduled_for === undefined
      ? now.toISOString()
      : timestamp(input.scheduled_for, 'scheduled_for');
    const sourceCall = await this.#voice.getSourceCall(tenantId, sourceCallId);
    if (!sourceCall || sourceCall.tenant_id !== tenantId) throw notFound('source_call');
    const protectedAddress = await this.#addressProtector.protect(
      tenantId,
      requiredText(input.address?.value, 'address.value', 1_024),
      addressKind(input.address?.kind)
    );
    const replayExpectation = {
      entry_id: entryId,
      source_call_id: sourceCallId,
      business_ref_type: sourceCall.business_ref.type,
      business_ref_id: sourceCall.business_ref.id,
      address_kind: input.address.kind,
      address_hmac: protectedAddress.hmac,
      scheduled_for: scheduledFor,
      max_attempts: maxAttempts,
      requested_by: actor
    };

    return this.#unitOfWork.run(tenantId, async ({ repository }) => {
      const replay = await repository.findCallbackByIdempotencyKey(tenantId, idempotencyKey);
      if (replay) {
        assertCallbackReplay(replay, replayExpectation);
        return { callback: callbackProjection(replay), replayed: true };
      }

      const entry = required(
        await repository.getEntry(tenantId, entryId, { for_update: true }),
        'queue_entry'
      );
      const concurrentReplay = await repository.findCallbackByIdempotencyKey(
        tenantId,
        idempotencyKey
      );
      if (concurrentReplay) {
        assertCallbackReplay(concurrentReplay, replayExpectation);
        return { callback: callbackProjection(concurrentReplay), replayed: true };
      }
      if (entry.call_id !== sourceCallId) throw conflict('source_call_mismatch');
      const queue = required(
        await repository.getQueue(tenantId, entry.queue_id, { for_update: true }),
        'queue'
      );
      if (queue.status !== 'active') throw conflict('queue_not_active');
      if (entry.state !== 'waiting' && entry.state !== 'offered') {
        throw conflict('queue_entry_not_callback_eligible');
      }

      if (entry.state === 'offered') {
        await releaseOutstandingOffer(repository, entry.id, tenantId, now.toISOString());
      }

      const createdAt = now.toISOString();
      const candidate: ContactCenterCallbackRecord = {
        id: this.#id(), tenant_id: tenantId, queue_id: entry.queue_id,
        queue_entry_id: entry.id, source_call_id: sourceCallId, outbound_call_id: null,
        business_ref_type: identifier(sourceCall.business_ref.type, 'business_ref.type'),
        business_ref_id: identifier(sourceCall.business_ref.id, 'business_ref.id'),
        address_kind: input.address.kind,
        address_ciphertext: protectedAddress.ciphertext,
        address_hmac: protectedAddress.hmac,
        address_redacted: protectedAddress.redacted,
        state: scheduledFor > createdAt ? 'scheduled' : 'requested',
        scheduled_for: scheduledFor,
        attempt_count: 0,
        max_attempts: maxAttempts,
        idempotency_key: idempotencyKey,
        requested_by: actor,
        cancelled_by: '',
        failure_code: '',
        revision: 1,
        created_at: createdAt,
        updated_at: createdAt,
        completed_at: null
      };
      const callback = await repository.insertCallback(candidate);
      if (callback.id !== candidate.id) {
        assertCallbackReplay(callback, replayExpectation);
        return { callback: callbackProjection(callback), replayed: true };
      }
      await repository.updateEntry({
        ...entry,
        state: transitionQueueEntry(entry.state, 'request_callback'),
        ended_at: createdAt,
        timeout_at: null,
        outcome_reason: 'callback_requested',
        updated_at: createdAt
      }, entry.revision);
      return { callback: callbackProjection(callback), replayed: false };
    });
  }

  cancel(input: {
    tenant_id: string;
    callback_id: string;
    actor: string;
    reason?: string;
  }): Promise<ContactCenterCallback> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const callbackId = identifier(input.callback_id, 'callback_id');
    const actor = identifier(input.actor, 'actor');
    const reason = input.reason === undefined ? 'cancelled' : requiredText(input.reason, 'reason', 256);
    return this.#unitOfWork.run(tenantId, async ({ repository }) => {
      const callback = required(
        await repository.getCallback(tenantId, callbackId, { for_update: true }),
        'callback'
      );
      if (callback.state === 'cancelled') return callbackProjection(callback);
      if (callback.state !== 'requested' && callback.state !== 'scheduled') {
        throw conflict('callback_already_dialing');
      }
      const now = this.#now().toISOString();
      return callbackProjection(await repository.updateCallback({
        ...callback,
        state: 'cancelled',
        cancelled_by: actor,
        failure_code: reason,
        completed_at: now,
        updated_at: now
      }, callback.revision));
    });
  }

  get(tenantIdInput: string, callbackIdInput: string): Promise<ContactCenterCallback> {
    const tenantId = identifier(tenantIdInput, 'tenant_id');
    const callbackId = identifier(callbackIdInput, 'callback_id');
    return this.#unitOfWork.run(tenantId, async ({ repository }) => callbackProjection(required(
      await repository.getCallback(tenantId, callbackId),
      'callback'
    )));
  }

  list(input: ContactCenterCallbackListInput): Promise<ContactCenterPage<ContactCenterCallback>> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const limit = integer(input.limit ?? 50, 1, 200, 'limit');
    const queueId = input.queue_id === undefined ? undefined : identifier(input.queue_id, 'queue_id');
    const state = input.state === undefined ? undefined : callbackState(input.state);
    const cursor = input.cursor === undefined ? undefined : requiredText(input.cursor, 'cursor', 2_000);
    return this.#unitOfWork.run(tenantId, async ({ repository }) => {
      const page = await repository.listCallbacks({
        tenant_id: tenantId,
        limit,
        ...(queueId ? { queue_id: queueId } : {}),
        ...(state ? { state } : {}),
        ...(cursor ? { cursor } : {})
      });
      return { items: page.items.map(callbackProjection), next_cursor: page.next_cursor };
    });
  }

  async processDue(input: {
    tenant_id: string;
    limit: number;
    retry_delay_ms: number;
  }): Promise<ContactCenterCallbackProcessingSummary> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const limit = integer(input.limit, 1, 1_000, 'limit');
    const retryDelay = integer(input.retry_delay_ms, 0, 3_600_000, 'retry_delay_ms');
    const summary: ContactCenterCallbackProcessingSummary = {
      processed: 0, started: 0, retried: 0, failed: 0
    };
    for (let index = 0; index < limit; index += 1) {
      const outcome = await this.#unitOfWork.run(tenantId, async ({ repository }) => {
        const now = this.#now();
        const callback = await repository.getNextDueCallback(tenantId, now);
        if (!callback) return null;
        const attempt = callback.attempt_count + 1;
        let outbound: { call_id: string };
        try {
          const clearTarget = await this.#addressProtector.reveal(
            tenantId,
            callback.address_ciphertext,
            callback.address_kind
          );
          outbound = await this.#voice.createOutbound({ callback, clear_target: clearTarget, attempt });
        } catch (error) {
          const terminal = !isRetryable(error) || attempt >= callback.max_attempts;
          await repository.updateCallback({
            ...callback,
            state: terminal ? 'failed' : 'scheduled',
            scheduled_for: terminal
              ? null
              : new Date(now.getTime() + retryDelay).toISOString(),
            attempt_count: attempt,
            failure_code: failureCode(error),
            completed_at: terminal ? now.toISOString() : null,
            updated_at: now.toISOString()
          }, callback.revision);
          return terminal ? 'failed' as const : 'retried' as const;
        }
        await repository.updateCallback({
          ...callback,
          outbound_call_id: identifier(outbound.call_id, 'outbound_call_id'),
          state: 'dialing',
          scheduled_for: null,
          attempt_count: attempt,
          failure_code: '',
          updated_at: now.toISOString()
        }, callback.revision);
        return 'started' as const;
      });
      if (!outcome) break;
      summary.processed += 1;
      summary[outcome] += 1;
    }
    return summary;
  }

  reconcile(input: {
    tenant_id: string;
    limit: number;
  }): Promise<ContactCenterCallbackReconciliationSummary> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const limit = integer(input.limit, 1, 1_000, 'limit');
    return this.#unitOfWork.run(tenantId, async ({ repository }) => {
      const callbacks = await repository.listCallbacksForReconciliation(tenantId, limit);
      let updated = 0;
      for (const callback of callbacks) {
        const call = callback.outbound_call_id
          ? await this.#voice.getCallState(tenantId, callback.outbound_call_id)
          : null;
        const next = reconciledState(callback, call);
        if (!next) continue;
        const now = this.#now().toISOString();
        await repository.updateCallback({
          ...callback,
          state: next.state,
          failure_code: next.failure_code,
          completed_at: next.terminal ? now : null,
          updated_at: now
        }, callback.revision);
        updated += 1;
      }
      return { scanned: callbacks.length, updated };
    });
  }
}

async function releaseOutstandingOffer(
  repository: ContactCenterRepository,
  entryId: string,
  tenantId: string,
  now: string
): Promise<void> {
  const assignment = required(
    await repository.getActiveAssignmentForEntry(tenantId, entryId, { for_update: true }),
    'assignment'
  );
  const presence = required(
    await repository.getPresence(tenantId, assignment.agent_id, { for_update: true }),
    'agent_presence'
  );
  await repository.updateAssignment({
    ...assignment,
    state: transitionAssignment(assignment.state, 'revoke'),
    completed_at: now,
    outcome_reason: 'callback_requested',
    updated_at: now
  }, assignment.revision);
  const activeCount = Math.max(0, presence.active_voice_count - 1);
  await repository.updatePresence({
    ...presence,
    state: activeCount > 0 ? 'busy' : transitionPresence(presence.state, 'release'),
    active_voice_count: activeCount,
    current_call_id: activeCount > 0 ? presence.current_call_id : null,
    idle_since: activeCount > 0 ? null : now,
    updated_at: now
  }, presence.revision);
}

function callbackProjection(value: ContactCenterCallbackRecord): ContactCenterCallback {
  return {
    id: value.id,
    tenant_id: value.tenant_id,
    queue_id: value.queue_id,
    queue_entry_id: value.queue_entry_id,
    source_call_id: value.source_call_id,
    outbound_call_id: value.outbound_call_id,
    business_ref: { type: value.business_ref_type, id: value.business_ref_id },
    address: { kind: value.address_kind, redacted: value.address_redacted },
    state: value.state,
    scheduled_for: value.scheduled_for,
    attempt_count: value.attempt_count,
    max_attempts: value.max_attempts,
    requested_by: value.requested_by,
    cancelled_by: value.cancelled_by,
    failure_code: value.failure_code,
    revision: value.revision,
    created_at: value.created_at,
    updated_at: value.updated_at,
    completed_at: value.completed_at
  };
}

function assertCallbackReplay(
  value: ContactCenterCallbackRecord,
  expected: {
    entry_id: string;
    source_call_id: string;
    business_ref_type: string;
    business_ref_id: string;
    address_kind: ContactCenterCallbackRecord['address_kind'];
    address_hmac: string;
    scheduled_for: string;
    max_attempts: number;
    requested_by: string;
  }
): void {
  if (value.queue_entry_id !== expected.entry_id ||
    value.source_call_id !== expected.source_call_id ||
    value.business_ref_type !== expected.business_ref_type ||
    value.business_ref_id !== expected.business_ref_id ||
    value.address_kind !== expected.address_kind ||
    value.address_hmac !== expected.address_hmac ||
    value.scheduled_for !== expected.scheduled_for ||
    value.max_attempts !== expected.max_attempts ||
    value.requested_by !== expected.requested_by) {
    throw new ContactCenterError({ code: 'idempotency_conflict', status: 409 });
  }
}

function required<T>(value: T | null, resource: string): T {
  if (!value) throw notFound(resource);
  return value;
}

function notFound(resource: string): ContactCenterError {
  return new ContactCenterError({ code: 'not_found', status: 404, details: { resource } });
}

function conflict(reason: string): ContactCenterError {
  return new ContactCenterError({ code: 'conflict', status: 409, details: { reason } });
}

function identifier(value: unknown, field: string): string {
  const output = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(output)) {
    throw new ContactCenterError({ code: 'validation_failed', status: 422, details: { field } });
  }
  return output;
}

function idempotency(value: unknown): string {
  const output = String(value ?? '').trim();
  if (!/^[\x21-\x7e]{1,200}$/.test(output)) {
    throw new ContactCenterError({ code: 'validation_failed', status: 422, details: { field: 'idempotency_key' } });
  }
  return output;
}

function integer(value: unknown, minimum: number, maximum: number, field: string): number {
  const output = Number(value);
  if (!Number.isInteger(output) || output < minimum || output > maximum) {
    throw new ContactCenterError({ code: 'validation_failed', status: 422, details: { field } });
  }
  return output;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output || output.length > maximum || /[\u0000-\u001f\u007f]/.test(output)) {
    throw new ContactCenterError({ code: 'validation_failed', status: 422, details: { field } });
  }
  return output;
}

function addressKind(value: unknown): ContactCenterCallbackRecord['address_kind'] {
  if (value !== 'e164' && value !== 'extension' && value !== 'sip_uri') {
    throw new ContactCenterError({ code: 'validation_failed', status: 422, details: { field: 'address.kind' } });
  }
  return value;
}

function callbackState(value: unknown): ContactCenterCallbackState {
  const allowed: ContactCenterCallbackState[] = [
    'requested', 'scheduled', 'dialing', 'connected', 'completed', 'cancelled', 'failed'
  ];
  if (!allowed.includes(value as ContactCenterCallbackState)) {
    throw new ContactCenterError({ code: 'validation_failed', status: 422, details: { field: 'state' } });
  }
  return value as ContactCenterCallbackState;
}

function timestamp(value: unknown, field: string): string {
  const output = new Date(String(value ?? ''));
  validDate(output, field);
  return output.toISOString();
}

function validDate(value: Date, field: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new ContactCenterError({ code: 'validation_failed', status: 422, details: { field } });
  }
}

function isRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { retryable?: unknown }).retryable === true);
}

function failureCode(error: unknown): string {
  const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code || '') : '';
  return /^[a-z][a-z0-9_]{0,127}$/.test(code) ? code : 'callback_start_failed';
}

function reconciledState(
  callback: ContactCenterCallbackRecord,
  call: { state: string; termination_reason: string } | null
): { state: ContactCenterCallbackRecord['state']; terminal: boolean; failure_code: string } | null {
  if (!call) return { state: 'failed', terminal: true, failure_code: 'voice_call_missing' };
  if (['active', 'held', 'transferring'].includes(call.state)) {
    return callback.state === 'connected'
      ? null
      : { state: 'connected', terminal: false, failure_code: '' };
  }
  if (call.state === 'completed') {
    return { state: 'completed', terminal: true, failure_code: '' };
  }
  if (['cancelled', 'missed', 'rejected', 'failed', 'timed_out'].includes(call.state)) {
    return {
      state: 'failed', terminal: true,
      failure_code: safeVoiceFailure(call.termination_reason, call.state)
    };
  }
  return null;
}

function safeVoiceFailure(reason: string, state: string): string {
  const value = String(reason || '').trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : `voice_${state}`;
}
