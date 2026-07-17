import type { PgQueryable } from '../../db-pg.js';
import { pgId } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import {
  ChatMutationOutcomeUnknownError,
  type ChatGateway,
  type ChatMutationInput,
  type ChatMutationResult
} from './chat-gateway.js';

const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000] as const;

export interface TinodeMessageMutationClaim {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  mutation_id: string;
  mutation_version: number;
  action: 'edit' | 'delete';
  provider_topic_id: string;
  target_provider_message_id: string;
  body: string;
  attempt_count: number;
  max_attempts: number;
  claim_token: string;
  recovered_from_processing: boolean;
}

export interface TinodeMessageMutationRunSummary {
  examined: number;
  delivered: number;
  retry_wait: number;
  dead_letter: number;
  stale: number;
}

export interface TinodeMessageMutationStatus {
  id: string;
  mutation_id: string;
  mutation_version: number;
  action: 'edit' | 'delete';
  status: 'pending' | 'processing' | 'retry_wait' | 'delivered' | 'dead_letter';
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  provider_operation_id: string;
  last_error_code: string;
  last_error_message: string;
  completed_at: string | null;
  updated_at: string;
}

export interface TinodeMessageMutationStoreContract {
  listTenantIds(input: { now: Date; limit: number }): Promise<string[]>;
  claimNext(input: {
    tenant_id: string;
    now: Date;
    lease_ms: number;
  }): Promise<TinodeMessageMutationClaim | null>;
  complete(claim: TinodeMessageMutationClaim, result: ChatMutationResult, completedAt: Date): Promise<boolean>;
  fail(input: {
    claim: TinodeMessageMutationClaim;
    terminal: boolean;
    next_attempt_at: Date | null;
    error_code: string;
    error_message: string;
  }): Promise<boolean>;
}

export class TinodeMessageMutationService {
  private readonly store: TinodeMessageMutationStoreContract;
  private readonly gateway: Pick<ChatGateway, 'provider' | 'mutateMessage'>;
  private readonly now: () => Date;
  private readonly retryDelaysMs: readonly number[];
  private readonly leaseMs: number;
  private readonly onMutationUpdated?: (
    claim: TinodeMessageMutationClaim,
    status: TinodeMessageMutationStatus['status']
  ) => void | Promise<void>;

  constructor(input: {
    store: TinodeMessageMutationStoreContract;
    gateway: Pick<ChatGateway, 'provider' | 'mutateMessage'>;
    now?: () => Date;
    retryDelaysMs?: readonly number[];
    leaseMs?: number;
    onMutationUpdated?: (
      claim: TinodeMessageMutationClaim,
      status: TinodeMessageMutationStatus['status']
    ) => void | Promise<void>;
  }) {
    this.store = input.store;
    this.gateway = input.gateway;
    this.now = input.now || (() => new Date());
    this.retryDelaysMs = validRetryDelays(input.retryDelaysMs || DEFAULT_RETRY_DELAYS_MS);
    this.leaseMs = boundedInteger(input.leaseMs ?? 30_000, 1_000, 300_000, 'leaseMs');
    this.onMutationUpdated = input.onMutationUpdated;
  }

  async runDue(input: { tenant_id?: string; limit?: number } = {}): Promise<TinodeMessageMutationRunSummary> {
    const limit = boundedInteger(input.limit ?? 50, 1, 200, 'limit');
    const summary = emptySummary();
    const tenantIds = input.tenant_id
      ? [requiredString(input.tenant_id, 'tenant_id is required')]
      : await this.store.listTenantIds({ now: this.now(), limit });
    for (const tenantId of tenantIds) {
      while (summary.examined < limit) {
        const claim = await this.store.claimNext({
          tenant_id: tenantId,
          now: this.now(),
          lease_ms: this.leaseMs
        });
        if (!claim) break;
        summary.examined += 1;
        await this.processClaim(claim, summary);
      }
      if (summary.examined >= limit) break;
    }
    return summary;
  }

  private async processClaim(
    claim: TinodeMessageMutationClaim,
    summary: TinodeMessageMutationRunSummary
  ): Promise<void> {
    try {
      if (claim.action === 'edit' && claim.recovered_from_processing) {
        throw new ChatMutationOutcomeUnknownError(
          'Tinode edit claim expired while its publish outcome was unresolved'
        );
      }
      if (this.gateway.provider !== 'tinode' || !this.gateway.mutateMessage) {
        throw new Error('Tinode mutation provider is not configured');
      }
      const request: ChatMutationInput = {
        tenant_id: claim.tenant_id,
        session_id: claim.session_id,
        provider_topic_id: claim.provider_topic_id,
        target_provider_message_id: claim.target_provider_message_id,
        message_id: claim.message_id,
        mutation_id: claim.mutation_id,
        action: claim.action,
        body: claim.body
      };
      const result = await this.gateway.mutateMessage(request);
      if (result.provider_sync_status !== 'published') {
        throw new Error('Tinode mutation provider did not publish the operation');
      }
      const completed = await this.store.complete(claim, result, this.now());
      if (completed) {
        summary.delivered += 1;
        await this.onMutationUpdated?.(claim, 'delivered');
      } else summary.stale += 1;
    } catch (error) {
      const terminal = error instanceof ChatMutationOutcomeUnknownError
        || claim.attempt_count >= claim.max_attempts;
      const completedAt = this.now();
      const retryDelay = this.retryDelaysMs[Math.min(
        Math.max(0, claim.attempt_count - 1),
        this.retryDelaysMs.length - 1
      )] || 0;
      const failed = await this.store.fail({
        claim,
        terminal,
        next_attempt_at: terminal ? null : new Date(completedAt.getTime() + retryDelay),
        error_code: mutationErrorCode(error),
        error_message: redactMutationError(error)
      });
      if (!failed) summary.stale += 1;
      else if (terminal) {
        summary.dead_letter += 1;
        await this.onMutationUpdated?.(claim, 'dead_letter');
      } else {
        summary.retry_wait += 1;
        await this.onMutationUpdated?.(claim, 'retry_wait');
      }
    }
  }
}

export class TinodeMessageMutationStore implements TinodeMessageMutationStoreContract {
  constructor(private readonly pg: PgQueryable) {}

  async listTenantIds(input: { now: Date; limit: number }): Promise<string[]> {
    const result = await this.pg.query(
      'SELECT tenant_id FROM opc_tinode_mutation_tenant_ids($1, $2)',
      [input.now.toISOString(), input.limit]
    );
    return result.rows.map((row) => String(row.tenant_id));
  }

  async getByMutation(input: {
    tenant_id: string;
    mutation_id: string;
  }): Promise<TinodeMessageMutationStatus | null> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM tinode_message_mutation_outbox
         WHERE tenant_id = $1 AND mutation_id = $2`,
        [input.tenant_id, input.mutation_id]
      );
      return result.rows[0] ? decodeStatus(result.rows[0]) : null;
    });
  }

  async claimNext(input: {
    tenant_id: string;
    now: Date;
    lease_ms: number;
  }): Promise<TinodeMessageMutationClaim | null> {
    const claimToken = pgId('tmclaim');
    const claimedUntil = new Date(input.now.getTime() + input.lease_ms).toISOString();
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `WITH candidate AS (
           SELECT outbox.id, outbox.status AS previous_status, message.provider_message_id
           FROM tinode_message_mutation_outbox AS outbox
           JOIN collaboration_messages AS message
             ON message.id = outbox.message_id AND message.tenant_id = outbox.tenant_id
           WHERE outbox.tenant_id = $1
             AND message.provider = 'tinode'
             AND message.provider_message_id <> ''
             AND outbox.attempt_count < outbox.max_attempts
             AND (
               outbox.status = 'pending'
               OR (outbox.status = 'retry_wait' AND (outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= $2))
               OR (outbox.status = 'processing' AND outbox.claimed_until <= $2)
             )
             AND NOT EXISTS (
               SELECT 1 FROM tinode_message_mutation_outbox AS earlier
               WHERE earlier.tenant_id = outbox.tenant_id
                 AND earlier.message_id = outbox.message_id
                 AND earlier.mutation_version < outbox.mutation_version
                 AND earlier.status <> 'delivered'
             )
           ORDER BY outbox.created_at ASC, outbox.id ASC
           FOR UPDATE OF outbox SKIP LOCKED
           LIMIT 1
         )
         UPDATE tinode_message_mutation_outbox AS outbox
         SET status = 'processing', attempt_count = outbox.attempt_count + 1,
             claim_token = $3, claimed_until = $4,
             target_provider_message_id = candidate.provider_message_id,
             next_attempt_at = NULL, updated_at = $2
         FROM candidate
         WHERE outbox.id = candidate.id
         RETURNING outbox.*, candidate.previous_status`,
        [input.tenant_id, input.now.toISOString(), claimToken, claimedUntil]
      );
      return result.rows[0] ? decodeClaim(result.rows[0]) : null;
    });
  }

  async complete(
    claim: TinodeMessageMutationClaim,
    result: ChatMutationResult,
    completedAt: Date
  ): Promise<boolean> {
    return withPgTenant(this.pg, claim.tenant_id, async (pg) => {
      const updated = await pg.query(
        `UPDATE tinode_message_mutation_outbox
         SET status = 'delivered', provider_operation_id = $4,
             claim_token = '', claimed_until = NULL, completed_at = $5, updated_at = $5,
             last_error_code = '', last_error_message = ''
         WHERE id = $1 AND tenant_id = $2 AND status = 'processing' AND claim_token = $3`,
        [claim.id, claim.tenant_id, claim.claim_token, result.provider_operation_id, completedAt.toISOString()]
      );
      return Number(updated.rowCount || 0) === 1;
    });
  }

  async fail(input: {
    claim: TinodeMessageMutationClaim;
    terminal: boolean;
    next_attempt_at: Date | null;
    error_code: string;
    error_message: string;
  }): Promise<boolean> {
    return withPgTenant(this.pg, input.claim.tenant_id, async (pg) => {
      const now = new Date().toISOString();
      const updated = await pg.query(
        `UPDATE tinode_message_mutation_outbox
         SET status = $4, next_attempt_at = $5,
             claim_token = '', claimed_until = NULL,
             last_error_code = $6, last_error_message = $7, updated_at = $8
         WHERE id = $1 AND tenant_id = $2 AND status = 'processing' AND claim_token = $3`,
        [
          input.claim.id,
          input.claim.tenant_id,
          input.claim.claim_token,
          input.terminal ? 'dead_letter' : 'retry_wait',
          input.next_attempt_at?.toISOString() || null,
          input.error_code,
          input.error_message,
          now
        ]
      );
      return Number(updated.rowCount || 0) === 1;
    });
  }
}

function decodeClaim(row: Record<string, unknown>): TinodeMessageMutationClaim {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    message_id: String(row.message_id),
    mutation_id: String(row.mutation_id),
    mutation_version: Number(row.mutation_version),
    action: String(row.action) as 'edit' | 'delete',
    provider_topic_id: String(row.provider_topic_id),
    target_provider_message_id: String(row.target_provider_message_id),
    body: String(row.body || ''),
    attempt_count: Number(row.attempt_count),
    max_attempts: Number(row.max_attempts),
    claim_token: String(row.claim_token),
    recovered_from_processing: String(row.previous_status) === 'processing'
  };
}

function decodeStatus(row: Record<string, unknown>): TinodeMessageMutationStatus {
  return {
    id: String(row.id),
    mutation_id: String(row.mutation_id),
    mutation_version: Number(row.mutation_version),
    action: String(row.action) as 'edit' | 'delete',
    status: String(row.status) as TinodeMessageMutationStatus['status'],
    attempt_count: Number(row.attempt_count || 0),
    max_attempts: Number(row.max_attempts || 0),
    next_attempt_at: nullableTimestamp(row.next_attempt_at),
    provider_operation_id: String(row.provider_operation_id || ''),
    last_error_code: String(row.last_error_code || ''),
    last_error_message: String(row.last_error_message || '').slice(0, 500),
    completed_at: nullableTimestamp(row.completed_at),
    updated_at: String(row.updated_at)
  };
}

function emptySummary(): TinodeMessageMutationRunSummary {
  return { examined: 0, delivered: 0, retry_wait: 0, dead_letter: 0, stale: 0 };
}

function validRetryDelays(value: readonly number[]): readonly number[] {
  if (!value.length || value.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 3_600_000)) {
    throw new Error('retryDelaysMs must contain integers between 0 and 3600000');
  }
  return [...value];
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function mutationErrorCode(error: unknown): string {
  if (error instanceof ChatMutationOutcomeUnknownError) return 'provider_outcome_uncertain';
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) return 'provider_timeout';
  if (/not configured/i.test(message)) return 'provider_not_configured';
  if (/reject|forbid|permission|invalid/i.test(message)) return 'provider_rejected';
  return 'provider_unavailable';
}

function redactMutationError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(\b(?:apikey|token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(?:bearer|basic)\s+[^\s]+/gi, '[redacted authorization]')
    .slice(0, 500);
}

function nullableTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
