import { createHash } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import { pgId, withPgTransaction } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';

export interface TinodeOperationsSnapshot {
  tenant_id: string;
  generated_at: string;
  delivery: {
    pending: number;
    publishing: number;
    retry_wait: number;
    failed: number;
    blocked_by_file_security: number;
    blocked: number;
    oldest_due_at: string | null;
    queue_lag_ms: number;
  };
  inbound: {
    cursors: number;
    active: number;
    error: number;
    paused: number;
    leased: number;
    max_cursor_lag_sequences: number;
    oldest_cursor_updated_at: string | null;
  };
  dead_letters: {
    open: number;
    retryable: number;
    terminal: number;
    oldest_open_at: string | null;
  };
}

export interface TinodeDeadLetterDescriptor {
  id: string;
  binding_id: string;
  event_id: string;
  event_kind: string;
  provider_sequence: number;
  provider_delete_id: number;
  error_code: string;
  error_message: string;
  payload_hash: string;
  retryable: boolean;
  retry_count: number;
  next_retry_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TinodeDeadLetterReplayResult {
  dead_letter: TinodeDeadLetterDescriptor;
  replay_id: string;
  replayed: boolean;
}

export interface TinodeMutationDeadLetterDescriptor {
  id: string;
  session_id: string;
  message_id: string;
  mutation_id: string;
  mutation_version: number;
  action: 'edit' | 'delete';
  attempt_count: number;
  max_attempts: number;
  error_code: string;
  error_message: string;
  created_at: string;
  updated_at: string;
}

export interface TinodeMutationDeadLetterReplayResult {
  dead_letter: TinodeMutationDeadLetterDescriptor;
  replay_id: string;
  replayed: boolean;
}

export class TinodeOperationsService {
  private readonly now: () => Date;

  constructor(private readonly input: { pg: PgQueryable; now?: () => Date }) {
    this.now = input.now || (() => new Date());
  }

  async snapshot(tenantId: string): Promise<TinodeOperationsSnapshot> {
    const generatedAt = this.now();
    return withPgTenant(this.input.pg, tenantId, async (pg) => {
      const delivery = await pg.query(
          `SELECT
             COUNT(*) FILTER (WHERE provider_delivery_status = 'pending')::INTEGER AS pending,
             COUNT(*) FILTER (WHERE provider_delivery_status = 'publishing')::INTEGER AS publishing,
             COUNT(*) FILTER (WHERE provider_delivery_status = 'retry_wait')::INTEGER AS retry_wait,
             COUNT(*) FILTER (WHERE provider_delivery_status = 'failed')::INTEGER AS failed,
             COUNT(*) FILTER (
               WHERE provider_delivery_status = 'blocked_by_file_security'
             )::INTEGER AS blocked_by_file_security,
             COUNT(*) FILTER (WHERE provider_delivery_status = 'blocked')::INTEGER AS blocked,
             MIN(COALESCE(provider_next_attempt_at, created_at)) FILTER (
               WHERE provider_delivery_status IN ('pending', 'publishing', 'retry_wait')
             ) AS oldest_due_at
           FROM collaboration_messages
           WHERE tenant_id = $1 AND provider = 'tinode'`,
          [tenantId]
        );
      const inbound = await pg.query(
          `SELECT
             COUNT(*)::INTEGER AS cursors,
             COUNT(*) FILTER (WHERE cursor.status = 'active')::INTEGER AS active,
             COUNT(*) FILTER (WHERE cursor.status = 'error')::INTEGER AS error,
             COUNT(*) FILTER (WHERE cursor.status = 'paused')::INTEGER AS paused,
             COUNT(*) FILTER (WHERE cursor.lease_until > $2)::INTEGER AS leased,
             COALESCE(MAX(GREATEST(
               COALESCE(event.latest_data_seq, cursor.last_data_seq) - cursor.last_data_seq,
               0
             )), 0)::BIGINT AS max_cursor_lag_sequences,
             MIN(cursor.updated_at) AS oldest_cursor_updated_at
           FROM tinode_inbound_cursors AS cursor
           LEFT JOIN (
             SELECT binding_id, MAX(provider_sequence) AS latest_data_seq
             FROM tinode_inbound_events
             WHERE tenant_id = $1 AND event_kind = 'data'
             GROUP BY binding_id
           ) AS event ON event.binding_id = cursor.binding_id
           WHERE cursor.tenant_id = $1`,
          [tenantId, generatedAt.toISOString()]
        );
      const deadLetters = await pg.query(
          `SELECT
             COUNT(*) FILTER (WHERE resolved_at IS NULL)::INTEGER AS open,
             COUNT(*) FILTER (
               WHERE resolved_at IS NULL AND retryable = 1
             )::INTEGER AS retryable,
             COUNT(*) FILTER (
               WHERE resolved_at IS NULL AND retryable = 0
             )::INTEGER AS terminal,
             MIN(created_at) FILTER (WHERE resolved_at IS NULL) AS oldest_open_at
           FROM tinode_inbound_dead_letters
           WHERE tenant_id = $1`,
          [tenantId]
        );
      const deliveryRow = delivery.rows[0] || {};
      const inboundRow = inbound.rows[0] || {};
      const deadLetterRow = deadLetters.rows[0] || {};
      const oldestDueAt = nullableTimestamp(deliveryRow.oldest_due_at);
      return {
        tenant_id: tenantId,
        generated_at: generatedAt.toISOString(),
        delivery: {
          pending: numberValue(deliveryRow.pending),
          publishing: numberValue(deliveryRow.publishing),
          retry_wait: numberValue(deliveryRow.retry_wait),
          failed: numberValue(deliveryRow.failed),
          blocked_by_file_security: numberValue(deliveryRow.blocked_by_file_security),
          blocked: numberValue(deliveryRow.blocked),
          oldest_due_at: oldestDueAt,
          queue_lag_ms: oldestDueAt
            ? Math.max(0, generatedAt.getTime() - new Date(oldestDueAt).getTime())
            : 0
        },
        inbound: {
          cursors: numberValue(inboundRow.cursors),
          active: numberValue(inboundRow.active),
          error: numberValue(inboundRow.error),
          paused: numberValue(inboundRow.paused),
          leased: numberValue(inboundRow.leased),
          max_cursor_lag_sequences: numberValue(inboundRow.max_cursor_lag_sequences),
          oldest_cursor_updated_at: nullableTimestamp(inboundRow.oldest_cursor_updated_at)
        },
        dead_letters: {
          open: numberValue(deadLetterRow.open),
          retryable: numberValue(deadLetterRow.retryable),
          terminal: numberValue(deadLetterRow.terminal),
          oldest_open_at: nullableTimestamp(deadLetterRow.oldest_open_at)
        }
      };
    });
  }

  async listDeadLetters(input: {
    tenant_id: string;
    state?: 'open' | 'resolved' | 'all';
    limit?: number;
  }): Promise<TinodeDeadLetterDescriptor[]> {
    const state = input.state || 'open';
    if (!['open', 'resolved', 'all'].includes(state)) throw operationsError('invalid dead-letter state', 400);
    const limit = boundedLimit(input.limit);
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const stateClause = state === 'open'
        ? 'AND dead.resolved_at IS NULL'
        : state === 'resolved'
          ? 'AND dead.resolved_at IS NOT NULL'
          : '';
      const result = await pg.query(
        `SELECT dead.*, event.event_kind, event.provider_sequence, event.provider_delete_id
         FROM tinode_inbound_dead_letters AS dead
         JOIN tinode_inbound_events AS event
           ON event.tenant_id = dead.tenant_id AND event.id = dead.event_id
         WHERE dead.tenant_id = $1 ${stateClause}
         ORDER BY dead.created_at DESC, dead.id DESC
         LIMIT $2`,
        [input.tenant_id, limit]
      );
      return result.rows.map(decodeDeadLetter);
    });
  }

  async replayDeadLetter(input: {
    tenant_id: string;
    dead_letter_id: string;
    requested_by: string;
    idempotency_key: string;
  }): Promise<TinodeDeadLetterReplayResult> {
    const idempotencyKey = requiredText(input.idempotency_key, 'idempotency_key', 128);
    const requestedBy = requiredText(input.requested_by, 'requested_by', 255);
    const deadLetterId = requiredText(input.dead_letter_id, 'dead_letter_id', 255);
    const payloadHash = sha256(JSON.stringify({ dead_letter_id: deadLetterId }));
    return withPgTenant(this.input.pg, input.tenant_id, (tenantPg) =>
      withPgTransaction(tenantPg, async (pg) => {
        const deadLetterResult = await pg.query(
          `SELECT dead.*, event.event_kind, event.provider_sequence, event.provider_delete_id
           FROM tinode_inbound_dead_letters AS dead
           JOIN tinode_inbound_events AS event
             ON event.tenant_id = dead.tenant_id AND event.id = dead.event_id
           WHERE dead.tenant_id = $1 AND dead.id = $2
           FOR UPDATE OF dead`,
          [input.tenant_id, deadLetterId]
        );
        if (!deadLetterResult.rows[0]) throw operationsError('Tinode dead letter not found', 404);
        const replayId = pgId('tidlreplay');
        const inserted = await pg.query(
          `INSERT INTO tinode_inbound_dead_letter_replays
            (id, tenant_id, dead_letter_id, idempotency_key, payload_hash, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [replayId, input.tenant_id, deadLetterId, idempotencyKey, payloadHash, requestedBy]
        );
        if (!inserted.rows[0]) {
          const existing = await pg.query(
            `SELECT id, dead_letter_id, payload_hash
             FROM tinode_inbound_dead_letter_replays
             WHERE tenant_id = $1 AND idempotency_key = $2`,
            [input.tenant_id, idempotencyKey]
          );
          const row = existing.rows[0];
          if (!row || String(row.dead_letter_id) !== deadLetterId || String(row.payload_hash) !== payloadHash) {
            throw operationsError('Idempotency-Key payload conflict', 409);
          }
          return {
            dead_letter: decodeDeadLetter(deadLetterResult.rows[0]),
            replay_id: String(row.id),
            replayed: true
          };
        }
        const now = this.now().toISOString();
        const updated = await pg.query(
          `UPDATE tinode_inbound_dead_letters
           SET retryable = 1, next_retry_at = $3, resolved_at = NULL, updated_at = $3
           WHERE tenant_id = $1 AND id = $2
           RETURNING *`,
          [input.tenant_id, deadLetterId, now]
        );
        return {
          dead_letter: decodeDeadLetter({
            ...deadLetterResult.rows[0],
            ...updated.rows[0]
          }),
          replay_id: replayId,
          replayed: false
        };
      })
    );
  }

  async listMutationDeadLetters(input: {
    tenant_id: string;
    limit?: number;
  }): Promise<TinodeMutationDeadLetterDescriptor[]> {
    const limit = boundedLimit(input.limit);
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM tinode_message_mutation_outbox
         WHERE tenant_id = $1 AND status = 'dead_letter'
         ORDER BY updated_at DESC, id DESC
         LIMIT $2`,
        [input.tenant_id, limit]
      );
      return result.rows.map(decodeMutationDeadLetter);
    });
  }

  async replayMutationDeadLetter(input: {
    tenant_id: string;
    outbox_id: string;
    requested_by: string;
    idempotency_key: string;
  }): Promise<TinodeMutationDeadLetterReplayResult> {
    const idempotencyKey = requiredText(input.idempotency_key, 'idempotency_key', 128);
    const requestedBy = requiredText(input.requested_by, 'requested_by', 255);
    const outboxId = requiredText(input.outbox_id, 'outbox_id', 255);
    const payloadHash = sha256(JSON.stringify({ outbox_id: outboxId }));
    return withPgTenant(this.input.pg, input.tenant_id, (tenantPg) =>
      withPgTransaction(tenantPg, async (pg) => {
        const outbox = await pg.query(
          `SELECT * FROM tinode_message_mutation_outbox
           WHERE tenant_id = $1 AND id = $2
           FOR UPDATE`,
          [input.tenant_id, outboxId]
        );
        if (!outbox.rows[0]) throw operationsError('Tinode mutation dead letter not found', 404);
        const replayId = pgId('tmreplay');
        const inserted = await pg.query(
          `INSERT INTO tinode_message_mutation_replays
            (id, tenant_id, outbox_id, idempotency_key, payload_hash, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [replayId, input.tenant_id, outboxId, idempotencyKey, payloadHash, requestedBy]
        );
        if (!inserted.rows[0]) {
          const existing = await pg.query(
            `SELECT id, outbox_id, payload_hash FROM tinode_message_mutation_replays
             WHERE tenant_id = $1 AND idempotency_key = $2`,
            [input.tenant_id, idempotencyKey]
          );
          const row = existing.rows[0];
          if (!row || String(row.outbox_id) !== outboxId || String(row.payload_hash) !== payloadHash) {
            throw operationsError('Idempotency-Key payload conflict', 409);
          }
          return {
            dead_letter: decodeMutationDeadLetter(outbox.rows[0]),
            replay_id: String(row.id),
            replayed: true
          };
        }
        if (String(outbox.rows[0].status) !== 'dead_letter') {
          throw operationsError('Tinode mutation is not dead-lettered', 409);
        }
        const now = this.now().toISOString();
        const updated = await pg.query(
          `UPDATE tinode_message_mutation_outbox
           SET status = 'retry_wait', attempt_count = 0, next_attempt_at = $3,
               claim_token = '', claimed_until = NULL,
               last_error_code = '', last_error_message = '', updated_at = $3
           WHERE tenant_id = $1 AND id = $2
           RETURNING *`,
          [input.tenant_id, outboxId, now]
        );
        return {
          dead_letter: decodeMutationDeadLetter(updated.rows[0]),
          replay_id: replayId,
          replayed: false
        };
      })
    );
  }
}

function decodeMutationDeadLetter(row: Record<string, unknown>): TinodeMutationDeadLetterDescriptor {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    message_id: String(row.message_id),
    mutation_id: String(row.mutation_id),
    mutation_version: numberValue(row.mutation_version),
    action: String(row.action) as 'edit' | 'delete',
    attempt_count: numberValue(row.attempt_count),
    max_attempts: numberValue(row.max_attempts),
    error_code: String(row.last_error_code || ''),
    error_message: safeErrorMessage(row.last_error_message),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
}

function decodeDeadLetter(row: Record<string, unknown>): TinodeDeadLetterDescriptor {
  return {
    id: String(row.id),
    binding_id: String(row.binding_id),
    event_id: String(row.event_id),
    event_kind: String(row.event_kind),
    provider_sequence: numberValue(row.provider_sequence),
    provider_delete_id: numberValue(row.provider_delete_id),
    error_code: String(row.error_code || ''),
    error_message: safeErrorMessage(row.error_message),
    payload_hash: String(row.payload_hash || ''),
    retryable: Number(row.retryable || 0) === 1,
    retry_count: numberValue(row.retry_count),
    next_retry_at: nullableTimestamp(row.next_retry_at),
    resolved_at: nullableTimestamp(row.resolved_at),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
}

function safeErrorMessage(value: unknown): string {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}

function numberValue(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value || ''));
  if (!Number.isFinite(date.getTime())) throw new Error('invalid Tinode operations timestamp');
  return date.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value == null || value === '' ? null : timestamp(value);
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isInteger(limit) || limit <= 0) throw operationsError('limit must be a positive integer', 400);
  return Math.min(limit, 500);
}

function requiredText(value: unknown, field: string, max: number): string {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\r\n\u0000]/.test(text)) {
    throw operationsError(`${field} is invalid`, 400);
  }
  return text;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function operationsError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}
