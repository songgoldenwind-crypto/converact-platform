import { createHash } from 'node:crypto';

export interface DirectedMediaEdgeUsage {
  kind: 'directed_media_edge';
  tenant_id: string;
  interaction_id: string;
  edge_id: string;
  generation: number;
  direction: string;
}

export interface AiRunUsage {
  kind: 'ai_run';
  tenant_id: string;
  agent_run_id: string;
  generation: number;
}

export interface RecordingSegmentUsage {
  kind: 'recording_segment';
  tenant_id: string;
  manifest_id: string;
  segment_id: string;
  owner_epoch: number;
}

export interface ExternalActionUsage {
  kind: 'external_action';
  tenant_id: string;
  intent_id: string;
  attempt_generation: number;
}

export type BillableSource =
  | DirectedMediaEdgeUsage
  | AiRunUsage
  | RecordingSegmentUsage
  | ExternalActionUsage;

export interface UsageEntry {
  entry_id: string;
  tenant_id: string;
  billing_key: string;
  entry_kind: 'usage' | 'reversal' | 'credit';
  unit: string;
  quantity: number;
  receipt_id: string;
  receipt_digest: string;
  writer_id: string;
  writer_epoch: number;
  occurred_at: string;
  reverses_entry_id: string | null;
}

export interface UsageBalance {
  total_by_unit: Record<string, number>;
  total_by_billing_key: Record<string, number>;
}

export type UsageAppendDecision = 'append' | 'replay' | 'conflict' | 'stale_writer';

const USAGE_FIELDS = [
  'entry_id',
  'tenant_id',
  'billing_key',
  'entry_kind',
  'unit',
  'quantity',
  'receipt_id',
  'receipt_digest',
  'writer_id',
  'writer_epoch',
  'occurred_at',
  'reverses_entry_id'
] as const;
const QUANTITY_SCALE = 1_000_000;

export function platformBillingKey(source: BillableSource): string {
  if (!plainRecord(source)) throw billingError('billable_source_invalid');
  switch (source.kind) {
    case 'directed_media_edge':
      assertExactFields(source, [
        'kind', 'tenant_id', 'interaction_id', 'edge_id', 'generation', 'direction'
      ]);
      if (!keyPart(source.tenant_id) || !keyPart(source.interaction_id) || !keyPart(source.edge_id)
        || !positiveInteger(source.generation) || !keyPart(source.direction)) {
        throw billingError('billable_source_invalid');
      }
      return `edge:${source.tenant_id}:${source.interaction_id}:${source.edge_id}:${source.generation}:${source.direction}`;
    case 'ai_run':
      assertExactFields(source, ['kind', 'tenant_id', 'agent_run_id', 'generation']);
      if (!keyPart(source.tenant_id) || !keyPart(source.agent_run_id) || !positiveInteger(source.generation)) {
        throw billingError('billable_source_invalid');
      }
      return `ai:${source.tenant_id}:${source.agent_run_id}:${source.generation}`;
    case 'recording_segment':
      assertExactFields(source, ['kind', 'tenant_id', 'manifest_id', 'segment_id', 'owner_epoch']);
      if (!keyPart(source.tenant_id) || !keyPart(source.manifest_id) || !keyPart(source.segment_id)
        || !nonNegativeInteger(source.owner_epoch)) {
        throw billingError('billable_source_invalid');
      }
      return `recording:${source.tenant_id}:${source.manifest_id}:${source.segment_id}:${source.owner_epoch}`;
    case 'external_action':
      assertExactFields(source, ['kind', 'tenant_id', 'intent_id', 'attempt_generation']);
      if (!keyPart(source.tenant_id) || !keyPart(source.intent_id)
        || !positiveInteger(source.attempt_generation)) {
        throw billingError('billable_source_invalid');
      }
      return `action:${source.tenant_id}:${source.intent_id}:${source.attempt_generation}`;
    default:
      throw billingError('billable_source_invalid');
  }
}

export function platformBillingEffectId(source: BillableSource): string {
  return `billing:${createHash('sha256').update(platformBillingKey(source), 'utf8').digest('hex')}`;
}

export function decideUsageAppend(
  existing: UsageEntry | null,
  candidate: UsageEntry
): UsageAppendDecision {
  assertUsageEntry(candidate);
  if (!existing) return candidate.entry_kind === 'usage' ? 'append' : 'conflict';
  assertUsageEntry(existing);
  if (candidate.tenant_id !== existing.tenant_id) return 'conflict';
  if (candidate.billing_key !== existing.billing_key) {
    return candidate.entry_kind === 'usage' ? 'append' : 'conflict';
  }
  if (candidate.writer_epoch < existing.writer_epoch) return 'stale_writer';
  if (sameUsageEntry(existing, candidate)) return 'replay';
  if (candidate.writer_id !== existing.writer_id || candidate.writer_epoch !== existing.writer_epoch) {
    return 'conflict';
  }
  if (sameReceiptCharge(existing, candidate)) return 'replay';
  if (candidate.entry_id === existing.entry_id) return 'conflict';
  if (candidate.entry_kind !== 'usage' && candidate.reverses_entry_id === existing.entry_id
    && existing.entry_kind === 'usage' && candidate.unit === existing.unit) return 'append';
  return 'conflict';
}

export function reconstructUsage(input: readonly UsageEntry[]): UsageBalance {
  if (!Array.isArray(input) || input.length > 100_000) throw billingError('usage_ledger_invalid');
  const entries = new Map<string, UsageEntry>();
  for (const entry of input) {
    assertUsageEntry(entry);
    const existing = entries.get(entry.entry_id);
    if (!existing) entries.set(entry.entry_id, entry);
    else if (!sameUsageEntry(existing, entry)) throw billingError('usage_ledger_conflict');
  }

  const normalized: UsageEntry[] = [];
  const byReceiptDigest = new Map<string, UsageEntry>();
  for (const entry of entries.values()) {
    const receiptKey = `${entry.tenant_id}\u0000${entry.billing_key}\u0000${entry.receipt_digest}`;
    const existing = byReceiptDigest.get(receiptKey);
    if (!existing) {
      byReceiptDigest.set(receiptKey, entry);
      normalized.push(entry);
    } else if (!sameReceiptCharge(existing, entry)) {
      throw billingError('usage_ledger_conflict');
    }
  }

  const baseById = new Map<string, UsageEntry>();
  const baseByKey = new Map<string, UsageEntry>();
  for (const entry of normalized) {
    if (entry.entry_kind !== 'usage') continue;
    const existing = baseByKey.get(entry.billing_key);
    if (existing && existing.entry_id !== entry.entry_id) throw billingError('usage_ledger_conflict');
    baseById.set(entry.entry_id, entry);
    baseByKey.set(entry.billing_key, entry);
  }
  for (const entry of entries.values()) {
    if (entry.entry_kind !== 'usage' || baseById.has(entry.entry_id)) continue;
    const canonical = baseByKey.get(entry.billing_key);
    if (canonical && sameReceiptCharge(canonical, entry)) baseById.set(entry.entry_id, canonical);
  }

  const correctedMicros = new Map<string, number>();
  for (const entry of normalized) {
    if (entry.entry_kind === 'usage') continue;
    const target = baseById.get(entry.reverses_entry_id!);
    if (!target || target.tenant_id !== entry.tenant_id || target.billing_key !== entry.billing_key
      || target.unit !== entry.unit || target.writer_id !== entry.writer_id
      || target.writer_epoch !== entry.writer_epoch) throw billingError('usage_ledger_invalid');
    const next = (correctedMicros.get(target.entry_id) || 0) + quantityMicros(entry.quantity);
    if (next > quantityMicros(target.quantity)) throw billingError('usage_ledger_invalid');
    correctedMicros.set(target.entry_id, next);
  }

  const byUnit = new Map<string, number>();
  const byKey = new Map<string, number>();
  for (const entry of baseByKey.values()) {
    const net = quantityMicros(entry.quantity) - (correctedMicros.get(entry.entry_id) || 0);
    byUnit.set(entry.unit, (byUnit.get(entry.unit) || 0) + net);
    byKey.set(entry.billing_key, net);
  }
  return {
    total_by_unit: sortedScaledRecord(byUnit),
    total_by_billing_key: sortedScaledRecord(byKey)
  };
}

function assertUsageEntry(value: UsageEntry): void {
  if (!plainRecord(value) || Object.keys(value).length !== USAGE_FIELDS.length
    || !USAGE_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(value, field))) {
    throw billingError('usage_entry_invalid');
  }
  for (const field of ['entry_id', 'tenant_id', 'receipt_id', 'writer_id'] as const) {
    if (!keyPart(value[field])) throw billingError('usage_entry_invalid');
  }
  if (!boundedText(value.billing_key, 1_024) || !keyPart(value.unit)
    || !['usage', 'reversal', 'credit'].includes(value.entry_kind)
    || !/^[a-f0-9]{64}$/u.test(value.receipt_digest)
    || !nonNegativeInteger(value.writer_epoch) || canonicalTimestamp(value.occurred_at) === null) {
    throw billingError('usage_entry_invalid');
  }
  quantityMicros(value.quantity);
  if (value.entry_kind === 'usage') {
    if (value.reverses_entry_id !== null) throw billingError('usage_entry_invalid');
  } else if (!keyPart(value.reverses_entry_id)) {
    throw billingError('usage_entry_invalid');
  }
}

function quantityMicros(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER / QUANTITY_SCALE) {
    throw billingError('usage_entry_invalid');
  }
  const scaled = Math.round(value * QUANTITY_SCALE);
  if (!Number.isSafeInteger(scaled) || Math.abs(scaled / QUANTITY_SCALE - value) > 1e-9) {
    throw billingError('usage_entry_invalid');
  }
  return scaled;
}

function sameUsageEntry(left: UsageEntry, right: UsageEntry): boolean {
  return USAGE_FIELDS.every((field) => left[field] === right[field]);
}

function sameReceiptCharge(left: UsageEntry, right: UsageEntry): boolean {
  return left.tenant_id === right.tenant_id
    && left.billing_key === right.billing_key
    && left.entry_kind === right.entry_kind
    && left.unit === right.unit
    && left.quantity === right.quantity
    && left.receipt_digest === right.receipt_digest
    && left.writer_id === right.writer_id
    && left.writer_epoch === right.writer_epoch
    && left.reverses_entry_id === right.reverses_entry_id;
}

function sortedScaledRecord(values: ReadonlyMap<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of [...values.keys()].sort()) result[key] = values.get(key)! / QUANTITY_SCALE;
  return result;
}

function assertExactFields(value: Record<string, unknown>, fields: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw billingError('billable_source_invalid');
  }
}

function keyPart(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function canonicalTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function billingError(code: string): Error {
  return new Error(code);
}
