import { randomUUID } from 'node:crypto';

import { canonicalContactCenterPayloadHash } from './canonical.js';
import { ContactCenterError } from './errors.js';
import type {
  ContactCenterOverflowVoicePort,
  ContactCenterRepository,
  ContactCenterUnitOfWork
} from './ports.js';
import type {
  ContactCenterOverflowAction,
  ContactCenterQueueEntry
} from './types.js';

export interface ContactCenterOverflowServiceOptions {
  unit_of_work: ContactCenterUnitOfWork;
  voice: ContactCenterOverflowVoicePort;
  id?: () => string;
  now?: () => Date;
}

export interface ContactCenterOverflowProcessingSummary {
  processed: number;
  completed: number;
  retried: number;
  failed: number;
}

export class ContactCenterOverflowService {
  readonly #unitOfWork: ContactCenterUnitOfWork;
  readonly #voice: ContactCenterOverflowVoicePort;
  readonly #id: () => string;
  readonly #now: () => Date;

  constructor(options: ContactCenterOverflowServiceOptions) {
    this.#unitOfWork = options.unit_of_work;
    this.#voice = options.voice;
    this.#id = options.id ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  async processDue(input: {
    tenant_id: string;
    limit: number;
    retry_delay_ms: number;
  }): Promise<ContactCenterOverflowProcessingSummary> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const limit = integer(input.limit, 1, 1_000, 'limit');
    const retryDelay = integer(input.retry_delay_ms, 0, 3_600_000, 'retry_delay_ms');
    const summary: ContactCenterOverflowProcessingSummary = {
      processed: 0, completed: 0, retried: 0, failed: 0
    };
    for (let index = 0; index < limit; index += 1) {
      const outcome = await this.#unitOfWork.run(tenantId, async ({ repository }) => {
        const now = this.#now();
        validDate(now);
        const action = await repository.getNextDueOverflowAction(tenantId, now);
        if (!action) return null;
        try {
          const resultRef = action.action === 'queue'
            ? await this.#enqueueTargetQueue(repository, action, now)
            : await this.#enqueueVoiceAction(action);
          await repository.updateOverflowAction({
            ...action,
            state: 'completed',
            attempt_count: action.attempt_count + 1,
            scheduled_for: now.toISOString(),
            result_ref: resultRef,
            error_code: '',
            updated_at: now.toISOString(),
            completed_at: now.toISOString()
          }, action.revision);
          return 'completed' as const;
        } catch (error) {
          const attempt = action.attempt_count + 1;
          const terminal = !isRetryable(error) || attempt >= action.max_attempts;
          await repository.updateOverflowAction({
            ...action,
            state: terminal ? 'failed' : 'retry_wait',
            attempt_count: attempt,
            scheduled_for: terminal
              ? now.toISOString()
              : new Date(now.getTime() + retryDelay).toISOString(),
            error_code: failureCode(error),
            updated_at: now.toISOString(),
            completed_at: terminal ? now.toISOString() : null
          }, action.revision);
          return terminal ? 'failed' as const : 'retried' as const;
        }
      });
      if (!outcome) break;
      summary.processed += 1;
      summary[outcome] += 1;
    }
    return summary;
  }

  async #enqueueTargetQueue(
    repository: ContactCenterRepository,
    action: ContactCenterOverflowAction,
    now: Date
  ): Promise<string> {
    if (!action.target_queue_id) throw invalidAction('missing_target_queue');
    const queue = await repository.getQueue(
      action.tenant_id,
      action.target_queue_id,
      { for_update: true }
    );
    if (!queue) throw invalidAction('target_queue_not_found');
    if (queue.status !== 'active') throw invalidAction('target_queue_not_active');
    if (await repository.countActiveEntries(action.tenant_id, queue.id) >= queue.max_size) {
      throw new ContactCenterError({
        code: 'capacity_exhausted',
        retryable: true,
        details: { queue_id: queue.id }
      });
    }
    const timestamp = now.toISOString();
    const idempotencyKey = `overflow:${action.id}:queue`;
    const payloadHash = canonicalContactCenterPayloadHash({
      source_entry_id: action.source_entry_id,
      queue_id: queue.id,
      call_id: action.call_id,
      priority: action.priority
    });
    const entry: ContactCenterQueueEntry = {
      id: identifier(this.#id(), 'queue_entry_id'),
      tenant_id: action.tenant_id,
      queue_id: queue.id,
      call_id: action.call_id,
      state: 'waiting',
      priority: action.priority,
      idempotency_key: idempotencyKey,
      payload_hash: payloadHash,
      entered_at: timestamp,
      offered_at: null,
      assigned_at: null,
      answered_at: null,
      ended_at: null,
      timeout_at: new Date(now.getTime() + queue.max_wait_seconds * 1_000).toISOString(),
      outcome_reason: '',
      metadata: {
        overflow_action_id: action.id,
        overflow_source_entry_id: action.source_entry_id
      },
      revision: 1,
      created_at: timestamp,
      updated_at: timestamp
    };
    return (await repository.insertEntry(entry)).id;
  }

  async #enqueueVoiceAction(action: ContactCenterOverflowAction): Promise<string> {
    if (action.action === 'queue') throw invalidAction('queue_action_requires_queue_handler');
    const result = await this.#voice.enqueue({
      tenant_id: action.tenant_id,
      call_id: action.call_id,
      action: action.action,
      target: action.target,
      idempotency_key: `overflow:${action.id}:voice`
    });
    return identifier(result.command_id, 'command_id');
  }
}

function invalidAction(reason: string): ContactCenterError {
  return new ContactCenterError({ code: 'conflict', details: { reason } });
}

function identifier(value: unknown, field: string): string {
  const output = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(output)) {
    throw new ContactCenterError({
      code: 'validation_failed', status: 422, details: { field }
    });
  }
  return output;
}

function integer(value: unknown, minimum: number, maximum: number, field: string): number {
  const output = Number(value);
  if (!Number.isInteger(output) || output < minimum || output > maximum) {
    throw new ContactCenterError({
      code: 'validation_failed', status: 422, details: { field }
    });
  }
  return output;
}

function validDate(value: Date): void {
  if (Number.isNaN(value.getTime())) {
    throw new ContactCenterError({
      code: 'validation_failed', status: 422, details: { field: 'now' }
    });
  }
}

function isRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' &&
    (error as { retryable?: unknown }).retryable === true);
}

function failureCode(error: unknown): string {
  const code = error && typeof error === 'object'
    ? String((error as { code?: unknown }).code || '')
    : '';
  return /^[a-z][a-z0-9_]{0,127}$/.test(code) ? code : 'overflow_execution_failed';
}
