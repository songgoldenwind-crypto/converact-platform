export type EffectReceiptStage = 'accepted' | 'completed' | 'state_observed';

export interface EffectReceipt {
  receipt_id: string;
  tenant_id: string;
  effect_id: string;
  event_id: string;
  correlation_id: string;
  stage: EffectReceiptStage;
  generation: number;
  writer_id: string;
  owner_epoch: number;
  receipt_digest: string;
  observed_at: string;
}

export interface EffectAuditLink {
  tenant_id: string;
  effect_id: string;
  event_id: string;
  receipt_id: string;
  correlation_id: string;
}

export type EffectReceiptAppendDecision =
  | 'append'
  | 'replay'
  | 'conflict'
  | 'stale_writer'
  | 'invalid_transition';

const RECEIPT_FIELDS = [
  'receipt_id',
  'tenant_id',
  'effect_id',
  'event_id',
  'correlation_id',
  'stage',
  'generation',
  'writer_id',
  'owner_epoch',
  'receipt_digest',
  'observed_at'
] as const;
const STAGES: readonly EffectReceiptStage[] = ['accepted', 'completed', 'state_observed'];

export function decideEffectReceiptAppend(
  history: readonly EffectReceipt[],
  candidate: EffectReceipt
): EffectReceiptAppendDecision {
  if (!validReceipt(candidate) || !validHistory(history)) return 'invalid_transition';
  if (history.length === 0) return candidate.stage === 'accepted' ? 'append' : 'invalid_transition';

  const current = orderedHistory(history);
  const head = current[current.length - 1];
  if (candidate.tenant_id !== head.tenant_id || candidate.effect_id !== head.effect_id) return 'conflict';
  if (candidate.generation < head.generation || candidate.owner_epoch < head.owner_epoch) {
    return 'stale_writer';
  }
  if (candidate.owner_epoch === head.owner_epoch && candidate.writer_id !== head.writer_id) {
    return 'conflict';
  }
  if (candidate.generation > head.generation) {
    return candidate.stage === 'accepted' ? 'append' : 'invalid_transition';
  }

  const sameStage = current.find((item) => item.stage === candidate.stage);
  if (sameStage) return sameReceipt(sameStage, candidate) ? 'replay' : 'conflict';
  const expected = STAGES[current.length];
  return candidate.stage === expected ? 'append' : 'invalid_transition';
}

export function effectNeedsReconcile(history: readonly EffectReceipt[]): boolean {
  if (history.length === 0) return false;
  if (!validHistory(history)) return true;
  const current = orderedHistory(history);
  return current.length !== STAGES.length || current.at(-1)?.stage !== 'state_observed';
}

export function createEffectAuditLink(receipt: EffectReceipt): Readonly<EffectAuditLink> {
  if (!validReceipt(receipt)) throw new Error('effect_receipt_shape_invalid');
  return Object.freeze({
    tenant_id: receipt.tenant_id,
    effect_id: receipt.effect_id,
    event_id: receipt.event_id,
    receipt_id: receipt.receipt_id,
    correlation_id: receipt.correlation_id
  });
}

function validHistory(history: readonly EffectReceipt[]): boolean {
  if (!Array.isArray(history) || history.length > STAGES.length || !history.every(validReceipt)) return false;
  if (history.length === 0) return true;
  const ordered = orderedHistory(history);
  const first = ordered[0];
  let lastEpoch = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    if (item.tenant_id !== first.tenant_id || item.effect_id !== first.effect_id
      || item.generation !== first.generation || item.stage !== STAGES[index]
      || item.owner_epoch < lastEpoch) return false;
    lastEpoch = item.owner_epoch;
  }
  return true;
}

function orderedHistory(history: readonly EffectReceipt[]): EffectReceipt[] {
  return [...history].sort((left, right) => stageIndex(left.stage) - stageIndex(right.stage));
}

function sameReceipt(left: EffectReceipt, right: EffectReceipt): boolean {
  return RECEIPT_FIELDS.every((field) => left[field] === right[field]);
}

function validReceipt(value: EffectReceipt): boolean {
  if (!plainRecord(value) || Object.keys(value).length !== RECEIPT_FIELDS.length
    || !RECEIPT_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(value, field))) return false;
  for (const field of [
    'receipt_id', 'tenant_id', 'effect_id', 'event_id', 'correlation_id', 'writer_id'
  ] as const) {
    if (!boundedText(value[field])) return false;
  }
  if (!STAGES.includes(value.stage) || !positiveInteger(value.generation)
    || !nonNegativeInteger(value.owner_epoch)
    || !/^[a-f0-9]{64}$/u.test(value.receipt_digest)
    || canonicalTimestamp(value.observed_at) === null) return false;
  return true;
}

function stageIndex(stage: EffectReceiptStage): number {
  return STAGES.indexOf(stage);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
    && validUnicodeScalarString(value);
}

function validUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
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
