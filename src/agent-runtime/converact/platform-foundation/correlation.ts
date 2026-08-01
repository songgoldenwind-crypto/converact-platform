export interface PlatformCorrelationContext {
  tenant_id: string;
  engagement_id?: string;
  profile_binding_id?: string;
  interaction_id?: string;
  communication_session_id?: string;
  call_id?: string;
  leg_id?: string;
  room_id?: string;
  resolution_id?: string;
  action_intent_id?: string;
  agent_run_id?: string;
  media_edge_id?: string;
  generation?: number;
  owner_epoch?: number;
  trace_id: string;
  span_id: string;
  request_id: string;
}

export type PlatformMetricLabel =
  | 'service'
  | 'region'
  | 'zone'
  | 'cell'
  | 'component'
  | 'operation'
  | 'status'
  | 'error_class'
  | 'dependency'
  | 'queue'
  | 'capability'
  | 'identity_kind';

export interface PlatformMetricLabelPolicy {
  allows(label: PlatformMetricLabel, value: string): boolean;
}

export type TelemetryDropReason = 'queue_full' | 'exporter_unavailable' | 'deadline_exceeded';

const CORRELATION_FIELDS = new Set([
  'tenant_id', 'engagement_id', 'profile_binding_id', 'interaction_id',
  'communication_session_id', 'call_id', 'leg_id', 'room_id', 'resolution_id',
  'action_intent_id', 'agent_run_id', 'media_edge_id', 'generation', 'owner_epoch',
  'trace_id', 'span_id', 'request_id'
]);
const REQUIRED_CORRELATION_FIELDS = ['tenant_id', 'trace_id', 'span_id', 'request_id'] as const;
const NUMERIC_CORRELATION_FIELDS = new Set(['generation', 'owner_epoch']);
const METRIC_LABELS: ReadonlySet<string> = new Set([
  'service', 'region', 'zone', 'cell', 'component', 'operation', 'status',
  'error_class', 'dependency', 'queue', 'capability', 'identity_kind'
]);
const METRIC_LABEL_POLICIES = new WeakSet<object>();
const MAX_VALUES_PER_METRIC_LABEL = 64;
const MAX_VALUES_PER_METRIC_POLICY = 256;
const HIGH_CARDINALITY_LABELS: ReadonlySet<string> = new Set([
  'tenant_id', 'profile_type', 'user_id', 'engagement_id', 'interaction_id', 'call_id',
  'leg_id', 'room_id', 'resolution_id', 'action_intent_id', 'agent_run_id',
  'media_edge_id', 'trace_id', 'request_id'
]);
const FORBIDDEN_KEY = /(?:secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|phone|mobile|email|raw[_-]?pii|media[_-]?payload)/iu;
const EMAIL_VALUE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const PHONE_VALUE = /(?:^|\D)\+?\d[\d\s()-]{8,}\d(?:$|\D)/u;
const SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/-]+=*|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,})/iu;
const MAX_REDACTION_DEPTH = 6;
const MAX_REDACTION_NODES = 256;
const MAX_CONTAINER_ITEMS = 64;
const MAX_STRING_BYTES = 1_024;
const MAX_REDACTED_BYTES = 32_768;

export function normalizeCorrelationContext(value: unknown): Readonly<PlatformCorrelationContext> {
  if (!plainRecord(value)) throw correlationError();
  const keys = Object.keys(value);
  if (keys.length < REQUIRED_CORRELATION_FIELDS.length || keys.length > CORRELATION_FIELDS.size
    || keys.some((key) => !CORRELATION_FIELDS.has(key))
    || REQUIRED_CORRELATION_FIELDS.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw correlationError();
  }
  if (!boundedIdentifier(value.tenant_id) || !boundedIdentifier(value.request_id)
    || typeof value.trace_id !== 'string' || !/^[a-f0-9]{32}$/u.test(value.trace_id)
    || typeof value.span_id !== 'string' || !/^[a-f0-9]{16}$/u.test(value.span_id)) {
    throw correlationError();
  }
  const normalized: Record<string, string | number> = {};
  for (const key of keys.sort()) {
    const item = value[key];
    if (NUMERIC_CORRELATION_FIELDS.has(key)) {
      if (!nonNegativeInteger(item)) throw correlationError();
      normalized[key] = item;
    } else {
      if (!boundedIdentifier(item)) throw correlationError();
      normalized[key] = item;
    }
  }
  return Object.freeze(normalized) as unknown as Readonly<PlatformCorrelationContext>;
}

export function assertMetricLabels(
  value: Readonly<Record<string, string>>,
  policy: PlatformMetricLabelPolicy
): Readonly<Partial<Record<PlatformMetricLabel, string>>> {
  if (!plainRecord(value) || Object.keys(value).length > METRIC_LABELS.size
    || !policy || typeof policy !== 'object' || !METRIC_LABEL_POLICIES.has(policy)) {
    throw new Error('metric_label_invalid');
  }
  const normalized: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    if (HIGH_CARDINALITY_LABELS.has(key)) throw new Error('metric_label_forbidden');
    if (!METRIC_LABELS.has(key) || !lowCardinalityValue(value[key])) throw new Error('metric_label_invalid');
    if (!policy.allows(key as PlatformMetricLabel, value[key])) {
      throw new Error('metric_label_value_not_allowed');
    }
    normalized[key] = value[key];
  }
  return Object.freeze(normalized) as Readonly<Partial<Record<PlatformMetricLabel, string>>>;
}

export function createMetricLabelPolicy(
  value: Readonly<Partial<Record<PlatformMetricLabel, readonly string[]>>>
): Readonly<PlatformMetricLabelPolicy> {
  if (!plainRecord(value) || Object.keys(value).length < 1
    || Object.keys(value).length > METRIC_LABELS.size) throw metricPolicyError();
  const allowed = new Map<PlatformMetricLabel, ReadonlySet<string>>();
  let totalValues = 0;
  for (const key of Object.keys(value).sort()) {
    if (!METRIC_LABELS.has(key)) throw metricPolicyError();
    const entries = value[key as PlatformMetricLabel];
    if (!Array.isArray(entries) || entries.length < 1
      || entries.length > MAX_VALUES_PER_METRIC_LABEL) throw metricPolicyError();
    const values = new Set<string>();
    for (const entry of entries) {
      if (!lowCardinalityValue(entry) || highCardinalityValueShape(entry) || values.has(entry)) {
        throw metricPolicyError();
      }
      values.add(entry);
    }
    totalValues += values.size;
    if (totalValues > MAX_VALUES_PER_METRIC_POLICY) throw metricPolicyError();
    allowed.set(key as PlatformMetricLabel, values);
  }
  const policy: PlatformMetricLabelPolicy = Object.freeze({
    allows(label: PlatformMetricLabel, candidate: string): boolean {
      return allowed.get(label)?.has(candidate) === true;
    }
  });
  METRIC_LABEL_POLICIES.add(policy);
  return policy;
}

export function redactObservabilityValue(value: unknown): unknown {
  const seen = new Set<object>();
  let nodes = 0;
  const redact = (item: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_REDACTION_NODES || depth > MAX_REDACTION_DEPTH) throw observabilityError();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw observabilityError();
      return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item === 'string') {
      const sample = item.slice(0, 4_096);
      if (EMAIL_VALUE.test(sample) || PHONE_VALUE.test(sample) || SECRET_VALUE.test(sample)) return '[REDACTED]';
      return truncateUtf8(item, MAX_STRING_BYTES);
    }
    if (!item || typeof item !== 'object' || seen.has(item)) throw observabilityError();
    if (Array.isArray(item)) {
      if (item.length > MAX_CONTAINER_ITEMS) throw observabilityError();
      seen.add(item);
      try {
        return Object.freeze(item.map((entry) => redact(entry, depth + 1)));
      } finally {
        seen.delete(item);
      }
    }
    if (!plainRecord(item)) throw observabilityError();
    const ownKeys = Reflect.ownKeys(item);
    if (ownKeys.length > MAX_CONTAINER_ITEMS || ownKeys.some((key) => typeof key !== 'string')) {
      throw observabilityError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set || !descriptor.enumerable)) {
      throw observabilityError();
    }
    seen.add(item);
    try {
      const output: Record<string, unknown> = {};
      for (const key of (ownKeys as string[]).sort()) {
        if (!/^[A-Za-z0-9_.-]{1,100}$/u.test(key)) throw observabilityError();
        output[key] = FORBIDDEN_KEY.test(key)
          ? '[REDACTED]'
          : redact(descriptors[key].value, depth + 1);
      }
      return Object.freeze(output);
    } finally {
      seen.delete(item);
    }
  };
  const result = redact(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_REDACTED_BYTES) throw observabilityError();
  return result;
}

export function decideTelemetryExport(input: {
  queue_size: number;
  max_queue_size: number;
  exporter_state: 'ready' | 'down' | 'timed_out';
  now_monotonic_ms: number;
  deadline_monotonic_ms: number;
}): { accepted: true } | { accepted: false; reason: TelemetryDropReason } {
  if (!plainRecord(input) || Object.keys(input).length !== 5
    || !nonNegativeInteger(input.queue_size) || !positiveInteger(input.max_queue_size)
    || input.max_queue_size > 65_536 || input.queue_size > input.max_queue_size
    || !['ready', 'down', 'timed_out'].includes(input.exporter_state)
    || !validMonotonic(input.now_monotonic_ms) || !validMonotonic(input.deadline_monotonic_ms)) {
    throw new Error('telemetry_export_input_invalid');
  }
  if (input.exporter_state === 'timed_out'
    || input.now_monotonic_ms >= input.deadline_monotonic_ms) {
    return { accepted: false, reason: 'deadline_exceeded' };
  }
  if (input.exporter_state === 'down') return { accepted: false, reason: 'exporter_unavailable' };
  if (input.queue_size >= input.max_queue_size) return { accepted: false, reason: 'queue_full' };
  return { accepted: true };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '[TRUNCATED]';
  let prefix = value.slice(0, Math.min(value.length, maxBytes - suffix.length));
  while (prefix && Buffer.byteLength(prefix + suffix, 'utf8') > maxBytes) prefix = prefix.slice(0, -1);
  return `${prefix}${suffix}`;
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function lowCardinalityValue(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

function highCardinalityValueShape(value: string): boolean {
  return /^[a-f0-9]{32,64}$/iu.test(value)
    || /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(value)
    || /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
}

function metricPolicyError(): Error {
  return new Error('metric_label_policy_invalid');
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function validMonotonic(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function plainRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function correlationError(): Error {
  return new Error('correlation_context_invalid');
}

function observabilityError(): Error {
  return new Error('observability_value_invalid');
}
