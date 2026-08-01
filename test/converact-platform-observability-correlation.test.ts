import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertMetricLabels,
  decideTelemetryExport,
  normalizeCorrelationContext,
  redactObservabilityValue
} from '../src/agent-runtime/converact/platform-foundation/correlation.js';
import {
  metricsRegistry,
  platformTelemetryDroppedTotal,
  recordPlatformTelemetryDrop
} from '../src/metrics.js';

test('correlation accepts bounded high-cardinality identifiers in controlled context', () => {
  const context = normalizeCorrelationContext({
    tenant_id: 'tenant-a',
    engagement_id: 'engagement-a',
    interaction_id: 'interaction-a',
    communication_session_id: 'session-a',
    call_id: 'provider-call@example.net',
    leg_id: 'leg-a',
    room_id: 'room-a',
    resolution_id: 'resolution-a',
    action_intent_id: 'intent-a',
    agent_run_id: 'agent-run-a',
    media_edge_id: 'edge-a',
    generation: 4,
    owner_epoch: 8,
    trace_id: 'a'.repeat(32),
    span_id: 'b'.repeat(16),
    request_id: 'request-a'
  });
  assert.equal(context.call_id, 'provider-call@example.net');
  assert.equal(Object.isFrozen(context), true);
});

test('correlation rejects missing malformed unknown and overlong fields', () => {
  const base = {
    tenant_id: 'tenant-a', trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), request_id: 'request-a'
  };
  for (const candidate of [
    { ...base, tenant_id: '' },
    { ...base, trace_id: 'not-a-trace' },
    { ...base, span_id: 'c'.repeat(17) },
    { ...base, request_id: 'x'.repeat(257) },
    { ...base, generation: -1 },
    { ...base, unknown_id: 'unknown-a' }
  ]) assert.throws(() => normalizeCorrelationContext(candidate), /correlation_context_invalid/);
});

test('metric labels allow only bounded low-cardinality dimensions', () => {
  assert.deepEqual(assertMetricLabels({
    service: 'platform-core', region: 'us-east', operation: 'event_decode', status: 'ok'
  }), {
    operation: 'event_decode', region: 'us-east', service: 'platform-core', status: 'ok'
  });
  for (const key of [
    'tenant_id', 'profile_type', 'user_id', 'engagement_id', 'interaction_id',
    'call_id', 'room_id', 'agent_run_id', 'trace_id', 'request_id'
  ]) {
    assert.throws(() => assertMetricLabels({ [key]: 'high-cardinality-a' }), /metric_label_forbidden/, key);
  }
  assert.throws(() => assertMetricLabels({ status: 'x'.repeat(129) }), /metric_label_invalid/);
});

test('recursive redaction removes secret keys and PII-shaped values before sink', () => {
  const redacted = redactObservabilityValue({
    status: 'failed',
    authorization: 'Bearer abc.def.ghi',
    nested: {
      client_secret: 'super-secret',
      contact: 'person@example.com',
      phone_hint: '+1 (415) 555-1212',
      safe: ['ready', { private_key: '-----BEGIN PRIVATE KEY-----' }]
    }
  });
  assert.deepEqual(redacted, {
    nested: {
      client_secret: '[REDACTED]',
      contact: '[REDACTED]',
      phone_hint: '[REDACTED]',
      safe: ['ready', { private_key: '[REDACTED]' }]
    },
    status: 'failed',
    authorization: '[REDACTED]'
  });
  assert.equal(JSON.stringify(redacted).includes('super-secret'), false);
  assert.equal(Object.isFrozen(redacted), true);
});

test('redaction rejects cycles and excessive depth while truncating huge strings', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => redactObservabilityValue(cyclic), /observability_value_invalid/);
  assert.throws(() => redactObservabilityValue({
    a: { b: { c: { d: { e: { f: { g: 'too-deep' } } } } } }
  }), /observability_value_invalid/);
  assert.throws(() => redactObservabilityValue({ items: Array.from({ length: 65 }, (_, i) => i) }),
    /observability_value_invalid/);
  const result = redactObservabilityValue({ message: 'x'.repeat(4_096) }) as { message: string };
  assert.ok(result.message.length <= 1_024);
  assert.match(result.message, /\[TRUNCATED\]$/);
});

test('exporter pressure and outage return bounded drops without changing business result', () => {
  const base = {
    queue_size: 0,
    max_queue_size: 128,
    exporter_state: 'ready' as const,
    now_monotonic_ms: 5_000,
    deadline_monotonic_ms: 6_000
  };
  assert.deepEqual(decideTelemetryExport(base), { accepted: true });
  assert.deepEqual(decideTelemetryExport({ ...base, queue_size: 128 }), {
    accepted: false, reason: 'queue_full'
  });
  assert.deepEqual(decideTelemetryExport({ ...base, exporter_state: 'down' }), {
    accepted: false, reason: 'exporter_unavailable'
  });
  assert.deepEqual(decideTelemetryExport({ ...base, now_monotonic_ms: 6_000 }), {
    accepted: false, reason: 'deadline_exceeded'
  });
  assert.deepEqual(decideTelemetryExport({ ...base, exporter_state: 'timed_out' }), {
    accepted: false, reason: 'deadline_exceeded'
  });
});

test('foundation telemetry drop metric has a fixed low-cardinality reason label', async () => {
  platformTelemetryDroppedTotal.reset();
  recordPlatformTelemetryDrop('queue_full');
  recordPlatformTelemetryDrop('exporter_unavailable');
  const output = await metricsRegistry.getSingleMetricAsString('converact_platform_telemetry_dropped_total');
  assert.match(output, /reason="queue_full"/);
  assert.match(output, /reason="exporter_unavailable"/);
  assert.doesNotMatch(output, /tenant_id|profile_type|call_id|room_id/);
});
