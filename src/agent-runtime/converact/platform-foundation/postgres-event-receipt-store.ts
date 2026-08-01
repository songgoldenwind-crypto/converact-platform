import type { PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import {
  decideInboxWrite,
  type PlatformEventV2,
  type PlatformInboxState
} from './event-envelope.js';
import {
  decideEffectReceiptAppend,
  type EffectReceipt
} from './effect-receipt.js';

type Row = Record<string, unknown>;

export interface PlatformOutboxClaimInput {
  tenant_id: string;
  worker_id: string;
  lease_token_hash: string;
  now: Date;
  lease_ms: number;
  limit: number;
}

export interface PlatformOutboxClaim {
  id: string;
  tenant_id: string;
  event_id: string;
  payload_digest: string;
  aggregate_revision: number;
  ordering_key: string;
  lease_until: string;
}

export class PlatformFoundationStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PlatformFoundationStoreError';
  }
}

export class PostgresPlatformEventReceiptStore {
  constructor(private readonly pg: PgQueryable) {}

  appendInbox(input: {
    tenant_id: string;
    consumer_id: string;
    event: PlatformEventV2;
  }): Promise<{ status: 'inserted' | 'replay' }> {
    assertInboxInput(input);
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const inserted = await pg.query<Row>(
        `INSERT INTO converact_platform_inbox
          (tenant_id, consumer_id, event_id, payload_digest, aggregate_revision,
           ordering_key, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, consumer_id, event_id) DO NOTHING
         RETURNING tenant_id, consumer_id, event_id, payload_digest,
                   aggregate_revision, ordering_key`,
        [
          input.tenant_id,
          input.consumer_id,
          input.event.event_id,
          input.event.payload_digest,
          input.event.aggregate_revision,
          input.event.ordering_key,
          input.event.observed_at
        ]
      );
      if (inserted.rows.length > 1) storeError('platform_inbox_store_invalid');
      if (inserted.rows[0]) return { status: 'inserted' };

      const replay = await pg.query<Row>(
        `SELECT inbox.payload_digest, inbox.aggregate_revision,
                inbox.event_id, inbox.ordering_key
         FROM converact_platform_inbox inbox
         WHERE inbox.tenant_id = $1
           AND inbox.consumer_id = $2
           AND inbox.event_id = $3`,
        [input.tenant_id, input.consumer_id, input.event.event_id]
      );
      if (replay.rows.length !== 1) storeError('platform_inbox_conflict');
      const decision = decideInboxWrite(decodeInboxState(replay.rows[0]!), input.event);
      if (decision !== 'replay') storeError('platform_inbox_conflict');
      return { status: 'replay' };
    });
  }

  appendEffectReceipt(receipt: EffectReceipt): Promise<{ status: 'inserted' | 'replay' }> {
    assertReceiptIdentity(receipt);
    return withPgTenant(this.pg, receipt.tenant_id, async (pg) => {
      const current = await pg.query<Row>(
        `SELECT current_receipt.*
         FROM converact_platform_effect_receipts current_receipt
         WHERE current_receipt.tenant_id = $1
           AND current_receipt.effect_id = $2
           AND current_receipt.generation = (
             SELECT MAX(current_receipt.generation)
             FROM converact_platform_effect_receipts current_receipt
             WHERE current_receipt.tenant_id = $1
               AND current_receipt.effect_id = $2
           )
         ORDER BY CASE current_receipt.stage
           WHEN 'accepted' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END
         LIMIT 3
         FOR UPDATE`,
        [receipt.tenant_id, receipt.effect_id]
      );
      if (current.rows.length > 3) storeError('platform_effect_store_invalid');
      const history = current.rows.map(decodeEffectReceipt);
      const decision = decideEffectReceiptAppend(history, receipt);
      if (decision === 'replay') return { status: 'replay' };
      if (decision !== 'append') effectDecisionError(decision);

      const inserted = await pg.query<Row>(
        `INSERT INTO converact_platform_effect_receipts
          (tenant_id, receipt_id, effect_id, event_id, correlation_id, stage,
           generation, writer_id, owner_epoch, receipt_digest, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        effectReceiptParams(receipt)
      );
      if (inserted.rows.length > 1) storeError('platform_effect_store_invalid');
      if (inserted.rows[0]) {
        const stored = decodeEffectReceipt(inserted.rows[0]);
        if (!sameReceipt(stored, receipt)) storeError('platform_effect_store_invalid');
        return { status: 'inserted' };
      }

      const replay = await pg.query<Row>(
        `SELECT stored_receipt.*
         FROM converact_platform_effect_receipts stored_receipt
         WHERE stored_receipt.tenant_id = $1
           AND stored_receipt.effect_id = $2
           AND stored_receipt.stage = $3
           AND stored_receipt.generation = $4`,
        [receipt.tenant_id, receipt.effect_id, receipt.stage, receipt.generation]
      );
      if (replay.rows.length !== 1 || !sameReceipt(decodeEffectReceipt(replay.rows[0]!), receipt)) {
        storeError('platform_effect_conflict');
      }
      return { status: 'replay' };
    });
  }

  async claimOutbox(input: PlatformOutboxClaimInput): Promise<PlatformOutboxClaim[]> {
    assertClaim(input);
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const claimed = await pg.query<Row>(
        `WITH candidate AS (
           SELECT outbox.id
           FROM converact_platform_outbox outbox
           WHERE outbox.tenant_id = $1
             AND outbox.status IN ('pending', 'claimed')
             AND outbox.next_attempt_at <= $2
             AND (outbox.lease_until IS NULL OR outbox.lease_until <= $2)
           ORDER BY outbox.next_attempt_at, outbox.id
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         )
         UPDATE converact_platform_outbox outbox
         SET status = 'claimed', worker_id = $4, lease_token_hash = $5,
             lease_until = $2::timestamptz + ($6 * INTERVAL '1 millisecond'),
             attempt_count = outbox.attempt_count + 1
         FROM candidate
         WHERE outbox.tenant_id = $1 AND outbox.id = candidate.id
         RETURNING outbox.id, outbox.tenant_id, outbox.event_id,
                   outbox.payload_digest, outbox.aggregate_revision,
                   outbox.ordering_key, outbox.lease_until`,
        [
          input.tenant_id,
          input.now.toISOString(),
          input.limit,
          input.worker_id,
          input.lease_token_hash,
          input.lease_ms
        ]
      );
      if (claimed.rows.length > input.limit) storeError('platform_claim_store_invalid');
      return claimed.rows.map(decodeOutboxClaim);
    });
  }
}

function assertInboxInput(input: {
  tenant_id: string;
  consumer_id: string;
  event: PlatformEventV2;
}): void {
  if (!identifier(input.tenant_id) || !identifier(input.consumer_id)
    || input.event.tenant_id !== input.tenant_id
    || !identifier(input.event.event_id) || !identifier(input.event.ordering_key)
    || !sha256(input.event.payload_digest)
    || !Number.isSafeInteger(input.event.aggregate_revision)
    || input.event.aggregate_revision < 0) {
    storeError('platform_inbox_invalid');
  }
}

function assertReceiptIdentity(receipt: EffectReceipt): void {
  if (!identifier(receipt?.tenant_id) || !identifier(receipt?.effect_id)) {
    storeError('platform_effect_invalid');
  }
}

function assertClaim(input: PlatformOutboxClaimInput): void {
  if (!identifier(input.tenant_id) || !identifier(input.worker_id)
    || !sha256(input.lease_token_hash)
    || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())
    || !Number.isSafeInteger(input.lease_ms) || input.lease_ms < 1_000
    || input.lease_ms > 900_000
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
    storeError('platform_claim_invalid');
  }
}

function decodeInboxState(row: Row): PlatformInboxState {
  const aggregateRevision = integer(row.aggregate_revision);
  const state = {
    payload_digest: text(row.payload_digest),
    aggregate_revision: aggregateRevision,
    event_id: text(row.event_id),
    ordering_key: text(row.ordering_key)
  };
  if (!sha256(state.payload_digest) || !identifier(state.event_id)
    || !identifier(state.ordering_key) || aggregateRevision < 0) {
    storeError('platform_inbox_store_invalid');
  }
  return state;
}

function decodeEffectReceipt(row: Row): EffectReceipt {
  const receipt: EffectReceipt = {
    receipt_id: text(row.receipt_id),
    tenant_id: text(row.tenant_id),
    effect_id: text(row.effect_id),
    event_id: text(row.event_id),
    correlation_id: text(row.correlation_id),
    stage: text(row.stage) as EffectReceipt['stage'],
    generation: integer(row.generation),
    writer_id: text(row.writer_id),
    owner_epoch: integer(row.owner_epoch),
    receipt_digest: text(row.receipt_digest),
    observed_at: timestamp(row.observed_at)
  };
  const accepted = receiptShape(receipt, 'accepted', '0');
  const completed = receiptShape(receipt, 'completed', '1');
  const history = receipt.stage === 'accepted'
    ? []
    : receipt.stage === 'completed' ? [accepted] : [accepted, completed];
  if (decideEffectReceiptAppend(history, receipt) !== 'append') {
    storeError('platform_effect_store_invalid');
  }
  return receipt;
}

function receiptShape(
  receipt: EffectReceipt,
  stage: EffectReceipt['stage'],
  digestCharacter: string
): EffectReceipt {
  return {
    ...receipt,
    receipt_id: `shape-${stage}`,
    stage,
    receipt_digest: digestCharacter.repeat(64)
  };
}

function decodeOutboxClaim(row: Row): PlatformOutboxClaim {
  const claim: PlatformOutboxClaim = {
    id: text(row.id),
    tenant_id: text(row.tenant_id),
    event_id: text(row.event_id),
    payload_digest: text(row.payload_digest),
    aggregate_revision: integer(row.aggregate_revision),
    ordering_key: text(row.ordering_key),
    lease_until: timestamp(row.lease_until)
  };
  if (!identifier(claim.id) || !identifier(claim.tenant_id) || !identifier(claim.event_id)
    || !sha256(claim.payload_digest) || claim.aggregate_revision < 0
    || !identifier(claim.ordering_key)) storeError('platform_claim_store_invalid');
  return claim;
}

function effectReceiptParams(receipt: EffectReceipt): unknown[] {
  return [
    receipt.tenant_id, receipt.receipt_id, receipt.effect_id, receipt.event_id,
    receipt.correlation_id, receipt.stage, receipt.generation, receipt.writer_id,
    receipt.owner_epoch, receipt.receipt_digest, receipt.observed_at
  ];
}

function effectDecisionError(decision: Exclude<ReturnType<typeof decideEffectReceiptAppend>, 'append' | 'replay'>): never {
  const code = decision === 'stale_writer'
    ? 'platform_effect_stale_writer'
    : decision === 'conflict' ? 'platform_effect_conflict' : 'platform_effect_invalid_transition';
  return storeError(code);
}

function sameReceipt(left: EffectReceipt, right: EffectReceipt): boolean {
  return effectReceiptParams(left).every((value, index) => value === effectReceiptParams(right)[index]);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) storeError('platform_store_integer_invalid');
  return parsed;
}

function timestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(text(value));
  if (!Number.isFinite(parsed.getTime())) storeError('platform_store_timestamp_invalid');
  return parsed.toISOString();
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function storeError(code: string): never {
  throw new PlatformFoundationStoreError(code);
}
