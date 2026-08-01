import type { PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import {
  decideUsageAppend,
  type UsageAppendDecision,
  type UsageEntry
} from './billing-ledger.js';

type Row = Record<string, unknown>;

interface BillingWriter {
  tenant_id: string;
  billing_key: string;
  writer_id: string;
  writer_epoch: number;
}

export class PlatformBillingStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PlatformBillingStoreError';
  }
}

export class PostgresPlatformBillingLedgerStore {
  constructor(private readonly pg: PgQueryable) {}

  append(candidate: UsageEntry): Promise<{ status: 'inserted' | 'replay' }> {
    assertCandidate(candidate);
    return withPgTenant(this.pg, candidate.tenant_id, async (pg) => {
      const collision = await readCandidateCollision(pg, candidate);
      if (collision) return decideExisting(collision, candidate);

      const writer = await resolveWriter(pg, candidate);
      assertWriterFence(writer, candidate);

      let target: UsageEntry | null = null;
      if (candidate.entry_kind === 'usage') {
        target = await readBaseUsage(pg, candidate);
      } else {
        target = await readCorrectionTarget(pg, candidate);
        if (!target) billingStoreError('platform_usage_conflict');
        await assertCorrectionCapacity(pg, target, candidate);
      }

      const decision = decideUsageAppend(target, candidate);
      if (decision === 'replay') return { status: 'replay' };
      if (decision !== 'append') usageDecisionError(decision);

      const inserted = await pg.query<Row>(
        `INSERT INTO converact_platform_usage_entries
          (tenant_id, entry_id, billing_key, entry_kind, unit, quantity,
           receipt_id, receipt_digest, writer_id, writer_epoch, occurred_at,
           reverses_entry_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        usageParams(candidate)
      );
      if (inserted.rows.length > 1) billingStoreError('platform_usage_store_invalid');
      if (inserted.rows[0]) {
        if (!sameUsage(decodeUsage(inserted.rows[0]), candidate)) {
          billingStoreError('platform_usage_store_invalid');
        }
        return { status: 'inserted' };
      }

      const raced = await readCandidateCollision(pg, candidate);
      if (!raced) billingStoreError('platform_usage_conflict');
      return decideExisting(raced, candidate);
    });
  }
}

async function readCandidateCollision(
  pg: PgQueryable,
  candidate: UsageEntry
): Promise<UsageEntry | null> {
  const result = await pg.query<Row>(
    `SELECT entry.*
     FROM converact_platform_usage_entries entry
     WHERE entry.tenant_id = $1
       AND (entry.entry_id = $2 OR
            (entry.billing_key = $3 AND entry.receipt_digest = $4))
     ORDER BY (entry.entry_id = $2) DESC
     LIMIT 2
     FOR UPDATE`,
    [candidate.tenant_id, candidate.entry_id, candidate.billing_key, candidate.receipt_digest]
  );
  if (result.rows.length > 1) billingStoreError('platform_usage_conflict');
  return result.rows[0] ? decodeUsage(result.rows[0]) : null;
}

async function resolveWriter(pg: PgQueryable, candidate: UsageEntry): Promise<BillingWriter> {
  const current = await readWriter(pg, candidate.tenant_id, candidate.billing_key);
  if (current) return current;
  if (candidate.entry_kind !== 'usage') billingStoreError('platform_usage_conflict');

  const inserted = await pg.query<Row>(
    `INSERT INTO converact_platform_billing_writers
      (tenant_id, billing_key, writer_id, writer_epoch)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING tenant_id, billing_key, writer_id, writer_epoch`,
    [candidate.tenant_id, candidate.billing_key, candidate.writer_id, candidate.writer_epoch]
  );
  if (inserted.rows.length > 1) billingStoreError('platform_usage_store_invalid');
  if (inserted.rows[0]) return decodeWriter(inserted.rows[0]);
  const raced = await readWriter(pg, candidate.tenant_id, candidate.billing_key);
  if (!raced) billingStoreError('platform_usage_conflict');
  return raced;
}

async function readWriter(
  pg: PgQueryable,
  tenantId: string,
  billingKey: string
): Promise<BillingWriter | null> {
  const result = await pg.query<Row>(
    `SELECT writer.*
     FROM converact_platform_billing_writers writer
     WHERE writer.tenant_id = $1 AND writer.billing_key = $2
     ORDER BY writer.writer_epoch DESC
     LIMIT 1
     FOR UPDATE`,
    [tenantId, billingKey]
  );
  if (result.rows.length > 1) billingStoreError('platform_usage_store_invalid');
  return result.rows[0] ? decodeWriter(result.rows[0]) : null;
}

async function readBaseUsage(pg: PgQueryable, candidate: UsageEntry): Promise<UsageEntry | null> {
  const result = await pg.query<Row>(
    `SELECT entry.*
     FROM converact_platform_usage_entries entry
     WHERE entry.tenant_id = $1
       AND entry.billing_key = $2
       AND entry.entry_kind = 'usage'
     LIMIT 1
     FOR UPDATE`,
    [candidate.tenant_id, candidate.billing_key]
  );
  if (result.rows.length > 1) billingStoreError('platform_usage_store_invalid');
  return result.rows[0] ? decodeUsage(result.rows[0]) : null;
}

async function readCorrectionTarget(
  pg: PgQueryable,
  candidate: UsageEntry
): Promise<UsageEntry | null> {
  const result = await pg.query<Row>(
    `SELECT entry.*
     FROM converact_platform_usage_entries entry
     WHERE entry.tenant_id = $1
       AND entry.entry_id = $2
       AND entry.billing_key = $3
       AND entry.entry_kind = 'usage'
     FOR UPDATE`,
    [candidate.tenant_id, candidate.reverses_entry_id, candidate.billing_key]
  );
  if (result.rows.length > 1) billingStoreError('platform_usage_store_invalid');
  return result.rows[0] ? decodeUsage(result.rows[0]) : null;
}

async function assertCorrectionCapacity(
  pg: PgQueryable,
  target: UsageEntry,
  candidate: UsageEntry
): Promise<void> {
  const result = await pg.query<Row>(
    `SELECT COALESCE(SUM(entry.quantity), 0) AS corrected_quantity
     FROM converact_platform_usage_entries entry
     WHERE entry.tenant_id = $1
       AND entry.billing_key = $2
       AND entry.reverses_entry_id = $3`,
    [candidate.tenant_id, candidate.billing_key, target.entry_id]
  );
  if (result.rows.length > 1) billingStoreError('platform_usage_store_invalid');
  const corrected = result.rows[0] ? numeric(result.rows[0].corrected_quantity) : 0;
  if (corrected + candidate.quantity > target.quantity) {
    billingStoreError('platform_usage_conflict');
  }
}

function decideExisting(
  existing: UsageEntry,
  candidate: UsageEntry
): { status: 'replay' } {
  const decision = decideUsageAppend(existing, candidate);
  if (decision !== 'replay') usageDecisionError(decision);
  return { status: 'replay' };
}

function assertWriterFence(writer: BillingWriter, candidate: UsageEntry): void {
  if (candidate.writer_epoch < writer.writer_epoch) {
    billingStoreError('platform_usage_stale_writer');
  }
  if (candidate.writer_epoch !== writer.writer_epoch || candidate.writer_id !== writer.writer_id) {
    billingStoreError('platform_usage_conflict');
  }
}

function assertCandidate(candidate: UsageEntry): void {
  try {
    if (decideUsageAppend(candidate, candidate) !== 'replay') throw new Error('invalid');
  } catch {
    billingStoreError('platform_usage_invalid');
  }
}

function decodeWriter(row: Row): BillingWriter {
  const writer = {
    tenant_id: text(row.tenant_id),
    billing_key: text(row.billing_key),
    writer_id: text(row.writer_id),
    writer_epoch: integer(row.writer_epoch)
  };
  if (!writer.tenant_id || !writer.billing_key || !writer.writer_id || writer.writer_epoch < 0) {
    billingStoreError('platform_usage_store_invalid');
  }
  return writer;
}

function decodeUsage(row: Row): UsageEntry {
  const entry: UsageEntry = {
    entry_id: text(row.entry_id),
    tenant_id: text(row.tenant_id),
    billing_key: text(row.billing_key),
    entry_kind: text(row.entry_kind) as UsageEntry['entry_kind'],
    unit: text(row.unit),
    quantity: numeric(row.quantity),
    receipt_id: text(row.receipt_id),
    receipt_digest: text(row.receipt_digest),
    writer_id: text(row.writer_id),
    writer_epoch: integer(row.writer_epoch),
    occurred_at: timestamp(row.occurred_at),
    reverses_entry_id: row.reverses_entry_id == null ? null : text(row.reverses_entry_id)
  };
  try {
    if (decideUsageAppend(entry, entry) !== 'replay') throw new Error('invalid');
  } catch {
    billingStoreError('platform_usage_store_invalid');
  }
  return entry;
}

function usageParams(entry: UsageEntry): unknown[] {
  return [
    entry.tenant_id, entry.entry_id, entry.billing_key, entry.entry_kind, entry.unit,
    entry.quantity, entry.receipt_id, entry.receipt_digest, entry.writer_id,
    entry.writer_epoch, entry.occurred_at, entry.reverses_entry_id
  ];
}

function sameUsage(left: UsageEntry, right: UsageEntry): boolean {
  return usageParams(left).every((value, index) => value === usageParams(right)[index]);
}

function usageDecisionError(decision: UsageAppendDecision): never {
  if (decision === 'stale_writer') billingStoreError('platform_usage_stale_writer');
  if (decision === 'conflict') billingStoreError('platform_usage_conflict');
  billingStoreError('platform_usage_invalid');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) billingStoreError('platform_usage_store_invalid');
  return parsed;
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) billingStoreError('platform_usage_store_invalid');
  return parsed;
}

function timestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(text(value));
  if (!Number.isFinite(parsed.getTime())) billingStoreError('platform_usage_store_invalid');
  return parsed.toISOString();
}

function billingStoreError(code: string): never {
  throw new PlatformBillingStoreError(code);
}
