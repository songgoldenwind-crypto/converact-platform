import { createHash, randomBytes } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import { MemoryPg, pgId, withPgTransaction } from '../../db-pg.js';
import { withPgBypass, withPgTenant } from '../../db-pg-tenant.js';
import type { ChatGateway, ChatPublishResult } from './chat-gateway.js';
import {
  CollaborationStore,
  type CollaborationMessageAttachmentInput,
  type CollaborationOutgoingMessageInput
} from './collaboration-store.js';
import type {
  CollaborationMessage,
  CollaborationMessageDeliveryAttempt,
  CollaborationMessageType,
  PolicyScanResult
} from './types.js';
import {
  TinodeFileDeliveryGate,
  type TinodeFileDeliveryTransition
} from './tinode-file-delivery-gate.js';
import { listCollaborationWorkerTenants } from './worker-tenant-scope.js';

const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000] as const;

export interface TinodeMessageDeliveryInput {
  tenant_id: string;
  session_id: string;
  sender_identity: string;
  message_type: CollaborationMessageType;
  body: string;
  original_language?: string;
  metadata?: Record<string, unknown>;
  attachments?: CollaborationMessageAttachmentInput[];
  provider_topic_id: string;
  provider_payload: string;
  policy_text?: string;
  idempotency_key?: string;
  reply_to_message_id?: string;
  forwarded_from_message_id?: string;
  mentions?: string[];
}

export interface TinodeMessageDeliveryResult {
  message: CollaborationMessage;
  policy: PolicyScanResult;
  created: boolean;
  replayed: boolean;
}

export interface TinodeDeliveryRunSummary {
  examined: number;
  claimed: number;
  delivered: number;
  retry_wait: number;
  failed: number;
}

export interface TinodeMessageDeliveryServiceInput {
  pg: PgQueryable;
  gateway: ChatGateway;
  now?: () => Date;
  retryDelaysMs?: readonly number[];
  maxAttempts?: number;
  claimLeaseMs?: number;
  onDeliveryUpdated?: (message: CollaborationMessage) => void | Promise<void>;
  fileSecurityGate?: Pick<
    TinodeFileDeliveryGate,
    'reconcileMessage' | 'reconcileDue' | 'reconcileFile'
  > | null;
  onFileSecurityTransition?: (
    transition: TinodeFileDeliveryTransition
  ) => void | Promise<void>;
}

interface DeliveryClaim {
  attempt_id: string;
  attempt_number: number;
  claim_token: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  sender_identity: string;
  provider: string;
  provider_topic_id: string;
  provider_payload: string;
  idempotency_key: string;
}

interface DeliveryOutcome {
  status: 'delivered' | 'retry_wait' | 'failed';
  provider_message_id: string;
  error_code: string;
  error_message: string;
  metadata: Record<string, unknown>;
}

interface DueMessage {
  id: string;
  tenant_id: string;
}

export class TinodeMessageDeliveryService {
  private readonly pg: PgQueryable;
  private readonly gateway: ChatGateway;
  private readonly now: () => Date;
  private readonly retryDelaysMs: readonly number[];
  private readonly maxAttempts: number;
  private readonly claimLeaseMs: number;
  private readonly onDeliveryUpdated?: (message: CollaborationMessage) => void | Promise<void>;
  private readonly fileSecurityGate: Pick<
    TinodeFileDeliveryGate,
    'reconcileMessage' | 'reconcileDue' | 'reconcileFile'
  > | null;

  constructor(input: TinodeMessageDeliveryServiceInput) {
    this.pg = input.pg;
    this.gateway = input.gateway;
    this.now = input.now || (() => new Date());
    this.retryDelaysMs = validRetryDelays(input.retryDelaysMs || DEFAULT_RETRY_DELAYS_MS);
    this.maxAttempts = positiveInteger(input.maxAttempts ?? 3, 'maxAttempts');
    this.claimLeaseMs = positiveInteger(input.claimLeaseMs ?? 30_000, 'claimLeaseMs');
    this.onDeliveryUpdated = input.onDeliveryUpdated;
    this.fileSecurityGate = input.fileSecurityGate === undefined
      ? input.pg instanceof MemoryPg
        ? null
        : new TinodeFileDeliveryGate({
          pg: input.pg,
          now: this.now,
          onTransition: input.onFileSecurityTransition
        })
      : input.fileSecurityGate;
  }

  async createAndDeliver(input: TinodeMessageDeliveryInput): Promise<TinodeMessageDeliveryResult> {
    validateDeliveryInput(input);
    const prepared = await withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const sessions = new CollaborationStore(pg);
      const payloadHash = deliveryPayloadHash(input);
      const outgoing: CollaborationOutgoingMessageInput = {
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        sender_identity: input.sender_identity,
        message_type: input.message_type,
        body: input.body,
        original_language: input.original_language,
        metadata: input.metadata,
        attachments: input.attachments,
        idempotency_key: input.idempotency_key,
        idempotency_payload_hash: payloadHash,
        provider: this.gateway.provider,
        provider_topic_id: input.provider_topic_id,
        provider_payload: input.provider_payload,
        provider_metadata: this.gateway.provider === 'local' ? { mode: 'local_mirror' } : {},
        provider_delivery_status: this.gateway.provider === 'tinode' ? 'pending' : 'not_required',
        reply_to_message_id: input.reply_to_message_id,
        forwarded_from_message_id: input.forwarded_from_message_id,
        mentions: input.mentions
      };
      const created = await sessions.postOutgoingMessage(outgoing);
      const policy = created.created
        ? await sessions.scanPolicy({
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          message_id: created.message.id,
          text: input.policy_text ?? input.body
        })
        : policyForEvents(await sessions.listPolicyEvents({
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          message_id: created.message.id
        }));
      return { ...created, policy };
    });

    if (!prepared.created || this.gateway.provider !== 'tinode') {
      return {
        message: prepared.message,
        policy: prepared.policy,
        created: prepared.created,
        replayed: !prepared.created
      };
    }
    await this.fileSecurityGate?.reconcileMessage({
      tenant_id: input.tenant_id,
      message_id: prepared.message.id
    });
    const claim = await withPgTenant(this.pg, input.tenant_id, (pg) =>
      new TinodeMessageDeliveryStore(pg).claimById({
        tenant_id: input.tenant_id,
        message_id: prepared.message.id,
        now: this.now(),
        lease_ms: this.claimLeaseMs,
        max_attempts: this.maxAttempts
      })
    );
    if (!claim) {
      const message = await this.getMessage({
        tenant_id: input.tenant_id,
        message_id: prepared.message.id
      });
      return {
        message: message || prepared.message,
        policy: prepared.policy,
        created: true,
        replayed: false
      };
    }

    const message = await this.publishAndComplete(claim);
    return {
      message,
      policy: prepared.policy,
      created: true,
      replayed: false
    };
  }

  async runDue(input: { tenant_id?: string; limit?: number } = {}): Promise<TinodeDeliveryRunSummary> {
    const limit = boundedLimit(input.limit);
    if (!input.tenant_id && !(this.pg instanceof MemoryPg)) {
      const tenants = await listCollaborationWorkerTenants(this.pg, 'tinode', this.now(), limit);
      const total: TinodeDeliveryRunSummary = {
        examined: 0,
        claimed: 0,
        delivered: 0,
        retry_wait: 0,
        failed: 0
      };
      for (const tenantId of tenants) {
        const result = await this.runDue({ tenant_id: tenantId, limit: Math.max(1, limit - total.examined) });
        total.examined += result.examined;
        total.claimed += result.claimed;
        total.delivered += result.delivered;
        total.retry_wait += result.retry_wait;
        total.failed += result.failed;
        if (total.examined >= limit) break;
      }
      return total;
    }
    if (input.tenant_id) {
      await this.fileSecurityGate?.reconcileDue({ tenant_id: input.tenant_id, limit });
    }
    await this.reconcileExpired(input.tenant_id);
    const due = await this.inScope(input.tenant_id, (pg) =>
      new TinodeMessageDeliveryStore(pg).listDue({
        tenant_id: input.tenant_id,
        now: this.now(),
        limit
      })
    );
    const summary: TinodeDeliveryRunSummary = {
      examined: due.length,
      claimed: 0,
      delivered: 0,
      retry_wait: 0,
      failed: 0
    };
    for (const candidate of due) {
      const claim = await this.inScope(candidate.tenant_id, (pg) =>
        new TinodeMessageDeliveryStore(pg).claimById({
          tenant_id: candidate.tenant_id,
          message_id: candidate.id,
          now: this.now(),
          lease_ms: this.claimLeaseMs,
          max_attempts: this.maxAttempts
        })
      );
      if (!claim) continue;
      summary.claimed += 1;
      const message = await this.publishAndComplete(claim);
      if (message.provider_delivery.status === 'delivered') summary.delivered += 1;
      if (message.provider_delivery.status === 'retry_wait') summary.retry_wait += 1;
      if (message.provider_delivery.status === 'failed') summary.failed += 1;
    }
    return summary;
  }

  async getMessage(input: { tenant_id: string; message_id: string }): Promise<CollaborationMessage | null> {
    await this.fileSecurityGate?.reconcileMessage(input);
    await this.reconcileExpired(input.tenant_id);
    return withPgTenant(this.pg, input.tenant_id, (pg) =>
      new CollaborationStore(pg).getMessage(input)
    );
  }

  async retryMessage(input: { tenant_id: string; message_id: string }): Promise<CollaborationMessage | null> {
    await this.fileSecurityGate?.reconcileMessage(input);
    await this.reconcileExpired(input.tenant_id);
    const claim = await withPgTenant(this.pg, input.tenant_id, (pg) =>
      new TinodeMessageDeliveryStore(pg).claimById({
        tenant_id: input.tenant_id,
        message_id: input.message_id,
        now: this.now(),
        lease_ms: this.claimLeaseMs,
        max_attempts: this.maxAttempts
      })
    );
    if (claim) return this.publishAndComplete(claim);
    return this.getMessage(input);
  }

  async listAttempts(input: {
    tenant_id: string;
    message_id: string;
  }): Promise<CollaborationMessageDeliveryAttempt[]> {
    return withPgTenant(this.pg, input.tenant_id, (pg) =>
      new TinodeMessageDeliveryStore(pg).listAttempts(input)
    );
  }

  async reconcileSecureFile(input: {
    tenant_id: string;
    secure_file_id: string;
    limit?: number;
  }): Promise<TinodeFileDeliveryTransition[]> {
    return this.fileSecurityGate?.reconcileFile(input) || [];
  }

  private async publishAndComplete(claim: DeliveryClaim): Promise<CollaborationMessage> {
    const outcome = await this.publish(claim);
    const message = await withPgTenant(this.pg, claim.tenant_id, (pg) =>
      new TinodeMessageDeliveryStore(pg).complete({
        claim,
        outcome,
        now: this.now(),
        max_attempts: this.maxAttempts,
        retry_delay_ms: retryDelayForAttempt(this.retryDelaysMs, claim.attempt_number)
      })
    );
    await this.onDeliveryUpdated?.(message);
    return message;
  }

  private async publish(claim: DeliveryClaim): Promise<DeliveryOutcome> {
    if (this.gateway.provider !== claim.provider) {
      return failedOutcome(
        'provider_not_configured',
        `configured chat gateway ${this.gateway.provider} cannot deliver ${claim.provider}`,
        false
      );
    }
    try {
      const result = await this.gateway.publishMessage({
        tenant_id: claim.tenant_id,
        session_id: claim.session_id,
        provider_topic_id: claim.provider_topic_id,
        sender_identity: claim.sender_identity,
        body: claim.provider_payload,
        metadata: {
          opc_message_id: claim.message_id,
          idempotency_key: claim.idempotency_key
        }
      });
      if (result.provider_sync_status !== 'published') {
        return failedOutcome(
          String(result.metadata.reason || 'provider_publish_failed'),
          'Tinode did not acknowledge the message publish',
          false,
          result.metadata
        );
      }
      return successfulOutcome(result);
    } catch (error) {
      const classified = classifyProviderError(error);
      return failedOutcome(classified.code, classified.message, classified.terminal);
    }
  }

  private async reconcileExpired(tenantId?: string): Promise<void> {
    await this.inScope(tenantId, (pg) =>
      new TinodeMessageDeliveryStore(pg).reconcileExpired({
        tenant_id: tenantId,
        now: this.now(),
        max_attempts: this.maxAttempts,
        retry_delays_ms: this.retryDelaysMs
      })
    );
  }

  private inScope<T>(tenantId: string | undefined, fn: (pg: PgQueryable) => Promise<T>): Promise<T> {
    return tenantId
      ? withPgTenant(this.pg, tenantId, fn)
      : withPgBypass(this.pg, fn);
  }
}

class TinodeMessageDeliveryStore {
  constructor(private readonly pg: PgQueryable) {}

  async claimById(input: {
    tenant_id: string;
    message_id: string;
    now: Date;
    lease_ms: number;
    max_attempts: number;
  }): Promise<DeliveryClaim | null> {
    const claimToken = randomBytes(32).toString('base64url');
    const claimHash = sha256(claimToken);
    const now = input.now.toISOString();
    const leaseUntil = new Date(input.now.getTime() + input.lease_ms).toISOString();
    return withPgTransaction(this.pg, async (pg) => {
      await pg.query(
        `UPDATE collaboration_message_delivery_attempts attempts
         SET status = 'lease_expired', completed_at = $3,
             error_code = 'claim_lease_expired', error_message = 'provider delivery claim lease expired'
         FROM collaboration_messages messages
         WHERE messages.id = $1 AND messages.tenant_id = $2
           AND messages.provider_delivery_status = 'publishing'
           AND messages.provider_delivery_lease_until <= $3
           AND attempts.message_id = messages.id
           AND attempts.attempt_number = messages.provider_delivery_attempts
           AND attempts.status = 'started'`,
        [input.message_id, input.tenant_id, now]
      );
      const result = await pg.query(
        `UPDATE collaboration_messages
         SET provider_delivery_status = 'publishing',
             provider_delivery_attempts = provider_delivery_attempts + 1,
             provider_delivery_claim_token_hash = $3,
             provider_delivery_lease_until = $4,
             provider_next_attempt_at = NULL,
             provider_last_error_code = '',
             provider_last_error_message = '',
             provider_delivery_updated_at = $5
         WHERE id = $1 AND tenant_id = $2 AND provider = 'tinode'
           AND provider_delivery_attempts < $6
           AND NOT EXISTS (
             SELECT 1
             FROM collaboration_message_attachments AS attachment
             JOIN collaboration_secure_files AS file
               ON file.tenant_id = attachment.tenant_id
              AND file.session_id = attachment.session_id
              AND file.id = attachment.secure_file_id
             WHERE attachment.tenant_id = collaboration_messages.tenant_id
               AND attachment.session_id = collaboration_messages.session_id
               AND attachment.message_id = collaboration_messages.id
               AND attachment.secure_file_id IS NOT NULL
               AND NOT (file.status = 'ready' AND file.threat_status = 'clean')
           )
           AND (
             provider_delivery_status = 'pending'
             OR (provider_delivery_status = 'retry_wait' AND (provider_next_attempt_at IS NULL OR provider_next_attempt_at <= $5))
             OR (provider_delivery_status = 'publishing' AND provider_delivery_lease_until <= $5)
           )
         RETURNING *`,
        [input.message_id, input.tenant_id, claimHash, leaseUntil, now, input.max_attempts]
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      const attemptNumber = Number(row.provider_delivery_attempts);
      const attemptId = pgId('cdelivery');
      await pg.query(
        `INSERT INTO collaboration_message_delivery_attempts
          (id, tenant_id, session_id, message_id, attempt_number, provider, status, started_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, 'started', $7, $8)`,
        [
          attemptId,
          row.tenant_id,
          row.session_id,
          row.id,
          attemptNumber,
          row.provider,
          now,
          JSON.stringify({ lease_until: leaseUntil })
        ]
      );
      return {
        attempt_id: attemptId,
        attempt_number: attemptNumber,
        claim_token: claimToken,
        tenant_id: String(row.tenant_id),
        session_id: String(row.session_id),
        message_id: String(row.id),
        sender_identity: String(row.sender_identity),
        provider: String(row.provider),
        provider_topic_id: String(row.provider_topic_id),
        provider_payload: String(row.provider_payload || ''),
        idempotency_key: String(row.idempotency_key || '')
      };
    });
  }

  async complete(input: {
    claim: DeliveryClaim;
    outcome: DeliveryOutcome;
    now: Date;
    max_attempts: number;
    retry_delay_ms: number;
  }): Promise<CollaborationMessage> {
    const now = input.now.toISOString();
    const terminal = input.outcome.status === 'failed' || input.claim.attempt_number >= input.max_attempts;
    const status = input.outcome.status === 'delivered'
      ? 'delivered'
      : terminal
        ? 'failed'
        : 'retry_wait';
    const nextAttemptAt = status === 'retry_wait'
      ? new Date(input.now.getTime() + input.retry_delay_ms).toISOString()
      : null;
    return withPgTransaction(this.pg, async (pg) => {
      const updated = await pg.query(
        `UPDATE collaboration_messages
         SET provider_delivery_status = $4,
             provider_message_id = $5,
             provider_delivery_claim_token_hash = '',
             provider_delivery_lease_until = NULL,
             provider_next_attempt_at = $6,
             provider_last_error_code = $7,
             provider_last_error_message = $8,
             provider_delivered_at = CASE WHEN $4 = 'delivered' THEN $9 ELSE provider_delivered_at END,
             provider_delivery_updated_at = $9,
             provider_delivery_metadata = $10
         WHERE id = $1 AND tenant_id = $2
           AND provider_delivery_status = 'publishing'
           AND provider_delivery_claim_token_hash = $3
         RETURNING *`,
        [
          input.claim.message_id,
          input.claim.tenant_id,
          sha256(input.claim.claim_token),
          status,
          input.outcome.provider_message_id,
          nextAttemptAt,
          input.outcome.error_code,
          input.outcome.error_message,
          now,
          JSON.stringify(input.outcome.metadata)
        ]
      );
      const row = updated.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        const current = await new CollaborationStore(pg).getMessage({
          tenant_id: input.claim.tenant_id,
          message_id: input.claim.message_id
        });
        if (!current) throw Object.assign(new Error('collaboration message not found'), { status: 404 });
        return current;
      }
      await pg.query(
        `UPDATE collaboration_message_delivery_attempts
         SET status = $3, provider_message_id = $4, error_code = $5,
             error_message = $6, completed_at = $7, metadata = $8
         WHERE id = $1 AND tenant_id = $2 AND status = 'started'`,
        [
          input.claim.attempt_id,
          input.claim.tenant_id,
          status,
          input.outcome.provider_message_id,
          input.outcome.error_code,
          input.outcome.error_message,
          now,
          JSON.stringify(input.outcome.metadata)
        ]
      );
      return (await new CollaborationStore(pg).getMessage({
        tenant_id: input.claim.tenant_id,
        message_id: input.claim.message_id
      }))!;
    });
  }

  async listDue(input: {
    tenant_id?: string;
    now: Date;
    limit: number;
  }): Promise<DueMessage[]> {
    const now = input.now.toISOString();
    const result = input.tenant_id
      ? await this.pg.query(
        `SELECT id, tenant_id FROM collaboration_messages
         WHERE tenant_id = $1 AND provider = 'tinode'
           AND (
             provider_delivery_status = 'pending'
             OR (provider_delivery_status = 'retry_wait' AND (provider_next_attempt_at IS NULL OR provider_next_attempt_at <= $2))
             OR (provider_delivery_status = 'publishing' AND provider_delivery_lease_until <= $2)
           )
         ORDER BY COALESCE(provider_next_attempt_at, created_at) ASC
         LIMIT $3`,
        [input.tenant_id, now, input.limit]
      )
      : await this.pg.query(
        `SELECT id, tenant_id FROM collaboration_messages
         WHERE provider = 'tinode'
           AND (
             provider_delivery_status = 'pending'
             OR (provider_delivery_status = 'retry_wait' AND (provider_next_attempt_at IS NULL OR provider_next_attempt_at <= $1))
             OR (provider_delivery_status = 'publishing' AND provider_delivery_lease_until <= $1)
           )
         ORDER BY COALESCE(provider_next_attempt_at, created_at) ASC
         LIMIT $2`,
        [now, input.limit]
      );
    return result.rows.map((row) => ({ id: String(row.id), tenant_id: String(row.tenant_id) }));
  }

  async listAttempts(input: {
    tenant_id: string;
    message_id: string;
  }): Promise<CollaborationMessageDeliveryAttempt[]> {
    const message = await new CollaborationStore(this.pg).getMessage(input);
    if (!message) throw Object.assign(new Error('collaboration message not found'), { status: 404 });
    const result = await this.pg.query(
      `SELECT * FROM collaboration_message_delivery_attempts
       WHERE tenant_id = $1 AND message_id = $2
       ORDER BY attempt_number ASC`,
      [input.tenant_id, input.message_id]
    );
    return result.rows.map(decodeAttempt);
  }

  async reconcileExpired(input: {
    tenant_id?: string;
    now: Date;
    max_attempts: number;
    retry_delays_ms: readonly number[];
  }): Promise<void> {
    const now = input.now.toISOString();
    await withPgTransaction(this.pg, async (pg) => {
      const expired = input.tenant_id
        ? await pg.query(
          `SELECT id, tenant_id, provider_delivery_attempts
           FROM collaboration_messages
           WHERE tenant_id = $1 AND provider = 'tinode'
             AND provider_delivery_status = 'publishing'
             AND provider_delivery_lease_until <= $2
           ORDER BY provider_delivery_lease_until ASC
           FOR UPDATE`,
          [input.tenant_id, now]
        )
        : await pg.query(
          `SELECT id, tenant_id, provider_delivery_attempts
           FROM collaboration_messages
           WHERE provider = 'tinode'
             AND provider_delivery_status = 'publishing'
             AND provider_delivery_lease_until <= $1
           ORDER BY provider_delivery_lease_until ASC
           FOR UPDATE`,
          [now]
        );
      for (const row of expired.rows) {
        const attempts = Number(row.provider_delivery_attempts || 0);
        const status = attempts >= input.max_attempts ? 'failed' : 'retry_wait';
        const nextAttemptAt = status === 'retry_wait'
          ? new Date(input.now.getTime() + retryDelayForAttempt(input.retry_delays_ms, attempts)).toISOString()
          : null;
        const updated = await pg.query(
          `UPDATE collaboration_messages
           SET provider_delivery_status = $3,
               provider_delivery_claim_token_hash = '',
               provider_delivery_lease_until = NULL,
               provider_next_attempt_at = $4,
               provider_last_error_code = 'claim_lease_expired',
               provider_last_error_message = 'provider delivery claim lease expired',
               provider_delivery_updated_at = $5
           WHERE id = $1 AND tenant_id = $2
             AND provider_delivery_status = 'publishing'
             AND provider_delivery_lease_until <= $5
           RETURNING id, tenant_id, provider_delivery_attempts`,
          [row.id, row.tenant_id, status, nextAttemptAt, now]
        );
        if (updated.rows[0]) {
          await markLeaseExpiredAttempt(pg, row, now, status);
        }
      }
    });
  }
}

async function markLeaseExpiredAttempt(
  pg: PgQueryable,
  row: Record<string, unknown>,
  now: string,
  nextStatus: 'failed' | 'retry_wait'
): Promise<void> {
  await pg.query(
    `UPDATE collaboration_message_delivery_attempts
     SET status = 'lease_expired', completed_at = $4,
         error_code = 'claim_lease_expired', error_message = $5,
         metadata = $6
     WHERE tenant_id = $1 AND message_id = $2 AND attempt_number = $3 AND status = 'started'`,
    [
      row.tenant_id,
      row.id,
      row.provider_delivery_attempts,
      now,
      'provider delivery claim lease expired',
      JSON.stringify({ next_status: nextStatus })
    ]
  );
}

function successfulOutcome(result: ChatPublishResult): DeliveryOutcome {
  return {
    status: 'delivered',
    provider_message_id: result.provider_message_id,
    error_code: '',
    error_message: '',
    metadata: result.metadata
  };
}

function failedOutcome(
  code: string,
  message: string,
  terminal: boolean,
  metadata: Record<string, unknown> = {}
): DeliveryOutcome {
  return {
    status: terminal ? 'failed' : 'retry_wait',
    provider_message_id: '',
    error_code: safeErrorCode(code),
    error_message: safeErrorMessage(message),
    metadata
  };
}

function classifyProviderError(error: unknown): { code: string; message: string; terminal: boolean } {
  const candidate = error as { code?: unknown; status?: unknown; message?: unknown };
  const numericCode = Number(candidate.code || candidate.status || 0);
  const terminal = numericCode >= 400 && numericCode < 500 && numericCode !== 408 && numericCode !== 429;
  return {
    code: numericCode ? `provider_${numericCode}` : 'provider_unavailable',
    message: String(candidate.message || error || 'Tinode provider unavailable'),
    terminal
  };
}

function decodeAttempt(row: Record<string, unknown>): CollaborationMessageDeliveryAttempt {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    message_id: String(row.message_id),
    attempt_number: Number(row.attempt_number),
    provider: String(row.provider),
    status: String(row.status) as CollaborationMessageDeliveryAttempt['status'],
    provider_message_id: String(row.provider_message_id || ''),
    error_code: String(row.error_code || ''),
    error_message: String(row.error_message || ''),
    started_at: timestamp(row.started_at),
    completed_at: row.completed_at ? timestamp(row.completed_at) : null,
    metadata: parseMetadata(row.metadata)
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value || '{}')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function policyForEvents(events: PolicyScanResult['events']): PolicyScanResult {
  return { matched: events.length > 0, events, findings: [] };
}

function deliveryPayloadHash(input: TinodeMessageDeliveryInput): string {
  return sha256(stableJson({
    sender_identity: input.sender_identity,
    message_type: input.message_type,
    body: input.body,
    original_language: input.original_language || '',
    metadata: input.metadata || {},
    attachments: input.attachments || [],
    provider_topic_id: input.provider_topic_id,
    provider_payload: input.provider_payload,
    reply_to_message_id: input.reply_to_message_id || '',
    forwarded_from_message_id: input.forwarded_from_message_id || '',
    mentions: input.mentions || []
  }));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function validateDeliveryInput(input: TinodeMessageDeliveryInput): void {
  for (const [field, value] of Object.entries({
    tenant_id: input.tenant_id,
    session_id: input.session_id,
    sender_identity: input.sender_identity,
    provider_topic_id: input.provider_topic_id
  })) {
    if (!String(value || '').trim()) {
      throw Object.assign(new Error(`${field} is required`), { status: 400 });
    }
  }
  if (!String(input.body || '').trim() && !(input.attachments || []).length) {
    throw Object.assign(new Error('body or attachments required'), { status: 400 });
  }
}

function validRetryDelays(value: readonly number[]): readonly number[] {
  if (!value.length || value.some((delay) => !Number.isInteger(delay) || delay < 0)) {
    throw new Error('retryDelaysMs must contain non-negative integers');
  }
  return value;
}

function retryDelayForAttempt(delays: readonly number[], attemptNumber: number): number {
  return delays[Math.min(Math.max(attemptNumber - 1, 0), delays.length - 1)] || 0;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
  return Math.min(limit, 200);
}

function safeErrorCode(value: string): string {
  const normalized = String(value || 'provider_error').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
  return normalized.slice(0, 64) || 'provider_error';
}

function safeErrorMessage(value: string): string {
  return String(value || 'provider delivery failed')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s]+/gi, '$1[redacted]')
    .trim()
    .slice(0, 500);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}
