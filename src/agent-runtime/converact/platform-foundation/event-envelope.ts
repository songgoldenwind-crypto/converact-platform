import { createHash } from 'node:crypto';

export interface PlatformEventCorrelation {
  correlation_id: string;
  [field: string]: string | number;
}

export interface PlatformEventV2 {
  schema_version: 2;
  source_schema_version: 1 | 2;
  event_id: string;
  event_type: string;
  tenant_id: string;
  producer_identity: string;
  authority: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_revision: number;
  ordering_key: string;
  idempotency_key: string;
  payload_digest: string;
  occurred_at: string;
  observed_at: string;
  correlation: PlatformEventCorrelation;
  causation_event_id: string | null;
  purpose: string;
  region_policy: string;
  retention_policy: string;
  data: unknown;
  effect_semantics?: 'none' | 'state_projection_v1' | 'effect_receipt_v1';
  extensions: Readonly<Record<string, unknown>>;
}

export interface PlatformInboxState {
  payload_digest: string;
  aggregate_revision: number;
  event_id?: string;
  ordering_key?: string;
}

export type PlatformInboxWriteDecision =
  | 'insert'
  | 'replay'
  | 'stale'
  | 'conflict'
  | 'gap_requires_reconcile';

const MAX_PAYLOAD_BYTES = 65_536;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CORRELATION_FIELDS = 32;
const MAX_EXTENSION_FIELDS = 32;
const MAX_EXTENSION_BYTES = 16_384;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 8_192;
const EFFECT_SEMANTICS = new Set(['none', 'state_projection_v1', 'effect_receipt_v1']);
const REQUIRED_FIELDS = [
  'event_id',
  'event_type',
  'tenant_id',
  'producer_identity',
  'authority',
  'aggregate_type',
  'aggregate_id',
  'aggregate_revision',
  'ordering_key',
  'idempotency_key',
  'payload_digest',
  'occurred_at',
  'observed_at',
  'correlation',
  'causation_event_id',
  'purpose',
  'region_policy',
  'retention_policy',
  'data'
] as const;
const ENVELOPE_FIELDS = new Set<string>([
  'schema_version',
  ...REQUIRED_FIELDS,
  'effect_semantics'
]);

export function decodePlatformEvent(
  value: unknown,
  policy: { current_version: 2; read_versions: readonly [2, 1] }
): PlatformEventV2 | { quarantine: true; reason: string } {
  if (!validReadPolicy(policy)) return quarantine('reader_policy_invalid');
  if (!plainRecord(value)) return quarantine('event_invalid');
  const sourceVersion = value.schema_version;
  if (sourceVersion !== 1 && sourceVersion !== 2) return quarantine('unsupported_schema_version');
  if (!policy.read_versions.includes(sourceVersion)) return quarantine('unsupported_schema_version');
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) return quarantine(`missing_${field}`);
  }
  if (value.effect_semantics !== undefined
    && (typeof value.effect_semantics !== 'string' || !EFFECT_SEMANTICS.has(value.effect_semantics))) {
    return quarantine('unknown_effect_semantics');
  }
  if (!validEnvelopeIdentifiers(value)) return quarantine('event_identity_invalid');
  if (!nonNegativeInteger(value.aggregate_revision)) return quarantine('aggregate_revision_invalid');
  if (value.causation_event_id !== null && !boundedText(value.causation_event_id)) {
    return quarantine('causation_event_id_invalid');
  }
  if (canonicalTimestamp(value.occurred_at) === null || canonicalTimestamp(value.observed_at) === null) {
    return quarantine('event_timestamp_invalid');
  }
  const correlation = decodeCorrelation(value.correlation);
  if (!correlation) return quarantine('correlation_invalid');

  let canonicalData: string;
  try {
    if (typeof value.data === 'string'
      && Buffer.byteLength(value.data, 'utf8') > MAX_PAYLOAD_BYTES) {
      return quarantine('payload_too_large');
    }
    const canonicalLimit = typeof value.data === 'string'
      ? MAX_PAYLOAD_BYTES * 6 + 2
      : MAX_PAYLOAD_BYTES;
    canonicalData = canonicalJson(value.data, canonicalLimit);
  } catch {
    return quarantine('payload_too_large_or_invalid');
  }
  if (payloadBytes(value.data, canonicalData) > MAX_PAYLOAD_BYTES) return quarantine('payload_too_large');
  const digest = sha256(canonicalData);
  if (value.payload_digest !== digest) return quarantine('payload_digest_mismatch');

  const extensions = decodeExtensions(value);
  if (!extensions) return quarantine('extensions_invalid');
  if (Object.keys(extensions).length > 0
    && value.effect_semantics !== undefined
    && value.effect_semantics !== 'none') {
    return quarantine('unknown_extension_with_effect_semantics');
  }
  const normalizedData = deepFreezeJson(JSON.parse(canonicalData) as unknown);
  return Object.freeze({
    schema_version: policy.current_version,
    source_schema_version: sourceVersion,
    event_id: value.event_id,
    event_type: value.event_type,
    tenant_id: value.tenant_id,
    producer_identity: value.producer_identity,
    authority: value.authority,
    aggregate_type: value.aggregate_type,
    aggregate_id: value.aggregate_id,
    aggregate_revision: value.aggregate_revision,
    ordering_key: value.ordering_key,
    idempotency_key: value.idempotency_key,
    payload_digest: digest,
    occurred_at: value.occurred_at,
    observed_at: value.observed_at,
    correlation: Object.freeze(correlation),
    causation_event_id: value.causation_event_id,
    purpose: value.purpose,
    region_policy: value.region_policy,
    retention_policy: value.retention_policy,
    data: normalizedData,
    ...(value.effect_semantics === undefined ? {} : { effect_semantics: value.effect_semantics }),
    extensions: Object.freeze(extensions)
  }) as PlatformEventV2;
}

export function platformPayloadDigest(data: unknown): string {
  return sha256(canonicalJson(data));
}

export function decideInboxWrite(
  existing: PlatformInboxState | null,
  incoming: PlatformEventV2
): PlatformInboxWriteDecision {
  if (!existing) return 'insert';
  if (existing.event_id !== undefined && existing.event_id === incoming.event_id) {
    return existing.payload_digest === incoming.payload_digest ? 'replay' : 'conflict';
  }
  if (existing.ordering_key !== undefined && existing.ordering_key !== incoming.ordering_key) {
    return 'insert';
  }
  if (incoming.aggregate_revision < existing.aggregate_revision) return 'stale';
  if (incoming.aggregate_revision === existing.aggregate_revision) {
    return existing.payload_digest === incoming.payload_digest ? 'replay' : 'conflict';
  }
  if (incoming.aggregate_revision > existing.aggregate_revision + 1) {
    return 'gap_requires_reconcile';
  }
  return 'insert';
}

function validReadPolicy(value: unknown): value is { current_version: 2; read_versions: readonly [2, 1] } {
  if (!plainRecord(value) || value.current_version !== 2 || !Array.isArray(value.read_versions)) return false;
  return value.read_versions.length === 2
    && value.read_versions[0] === 2
    && value.read_versions[1] === 1;
}

function validEnvelopeIdentifiers(value: Record<string, unknown>): value is Record<string, string | unknown> {
  for (const field of [
    'event_id', 'event_type', 'tenant_id', 'producer_identity', 'authority',
    'aggregate_type', 'aggregate_id', 'ordering_key', 'idempotency_key',
    'purpose', 'region_policy', 'retention_policy'
  ]) {
    if (!boundedText(value[field])) return false;
  }
  return typeof value.payload_digest === 'string' && /^[a-f0-9]{64}$/u.test(value.payload_digest);
}

function decodeCorrelation(value: unknown): PlatformEventCorrelation | null {
  if (!plainRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > MAX_CORRELATION_FIELDS
    || !boundedText(value.correlation_id)) return null;
  const result: Record<string, string | number> = {};
  for (const [key, item] of entries) {
    if (!boundedText(key)) return null;
    if (typeof item === 'string') {
      if (!boundedText(item)) return null;
      result[key] = item;
    } else if (nonNegativeInteger(item)) {
      result[key] = item;
    } else {
      return null;
    }
  }
  return result as PlatformEventCorrelation;
}

function decodeExtensions(value: Record<string, unknown>): Record<string, unknown> | null {
  const keys = Object.keys(value).filter((key) => !ENVELOPE_FIELDS.has(key)).sort();
  if (keys.length > MAX_EXTENSION_FIELDS) return null;
  const extensions: Record<string, unknown> = {};
  for (const key of keys) extensions[key] = value[key];
  try {
    const encoded = canonicalJson(extensions, MAX_EXTENSION_BYTES);
    return deepFreezeJson(JSON.parse(encoded) as Record<string, unknown>);
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown, maxBytes = Number.POSITIVE_INFINITY): string {
  const seen = new Set<object>();
  let nodes = 0;
  const encode = (item: unknown, depth: number): { text: string; bytes: number } => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error('json_bounds_exceeded');
    if (item === null) return encoded('null');
    if (typeof item === 'string') {
      if (Buffer.byteLength(item, 'utf8') > maxBytes) throw new Error('json_bounds_exceeded');
      return encoded(JSON.stringify(item));
    }
    if (typeof item === 'boolean') return encoded(JSON.stringify(item));
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('json_number_invalid');
      return encoded(JSON.stringify(Object.is(item, -0) ? 0 : item));
    }
    if (typeof item !== 'object') throw new Error('json_type_invalid');
    if (seen.has(item)) throw new Error('json_cycle');
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        const entries: string[] = [];
        let bytes = 2;
        for (const entry of item) {
          const child = encode(entry, depth + 1);
          bytes += child.bytes + (entries.length === 0 ? 0 : 1);
          assertByteBudget(bytes, maxBytes);
          entries.push(child.text);
        }
        return { text: `[${entries.join(',')}]`, bytes };
      }
      if (!plainRecord(item)) throw new Error('json_object_invalid');
      const keys = Object.keys(item).sort();
      const entries: string[] = [];
      let bytes = 2;
      for (const key of keys) {
        const encodedKey = encoded(JSON.stringify(key));
        const child = encode(item[key], depth + 1);
        bytes += encodedKey.bytes + 1 + child.bytes + (entries.length === 0 ? 0 : 1);
        assertByteBudget(bytes, maxBytes);
        entries.push(`${encodedKey.text}:${child.text}`);
      }
      return { text: `{${entries.join(',')}}`, bytes };
    } finally {
      seen.delete(item);
    }
  };
  const encodedValue = encode(value, 0);
  assertByteBudget(encodedValue.bytes, maxBytes);
  return encodedValue.text;

  function encoded(text: string): { text: string; bytes: number } {
    const bytes = Buffer.byteLength(text, 'utf8');
    assertByteBudget(bytes, maxBytes);
    return { text, bytes };
  }
}

function assertByteBudget(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) throw new Error('json_bounds_exceeded');
}

function payloadBytes(data: unknown, canonicalData: string): number {
  return Buffer.byteLength(typeof data === 'string' ? data : canonicalData, 'utf8');
}

function deepFreezeJson<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_IDENTIFIER_LENGTH
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function canonicalTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function quarantine(reason: string): { quarantine: true; reason: string } {
  return { quarantine: true, reason };
}
