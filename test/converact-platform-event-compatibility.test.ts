import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideInboxWrite,
  decodePlatformEvent,
  platformPayloadDigest,
  type PlatformEventV2
} from '../src/agent-runtime/converact/platform-foundation/event-envelope.js';

const POLICY = { current_version: 2, read_versions: [2, 1] as const } as const;

function event(
  data: unknown = { state: 'ready' },
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema_version: 2,
    event_id: 'event-a',
    event_type: 'interaction.state.changed',
    tenant_id: 'tenant-a',
    producer_identity: 'workload-interaction-a',
    authority: 'Converact Interaction',
    aggregate_type: 'interaction',
    aggregate_id: 'interaction-a',
    aggregate_revision: 7,
    ordering_key: 'tenant-a:interaction:interaction-a',
    idempotency_key: 'interaction-a:7',
    payload_digest: platformPayloadDigest(data),
    occurred_at: '2026-08-01T12:00:00.000Z',
    observed_at: '2026-08-01T12:00:00.010Z',
    correlation: { correlation_id: 'correlation-a', interaction_id: 'interaction-a' },
    causation_event_id: null,
    purpose: 'interaction_state_projection',
    region_policy: 'tenant-primary',
    retention_policy: 'event-30d',
    data,
    ...overrides
  };
}

function decoded(input: Record<string, unknown>): PlatformEventV2 {
  const result = decodePlatformEvent(input, POLICY);
  assert.equal('quarantine' in result, false, JSON.stringify(result));
  return result as PlatformEventV2;
}

test('valid v2 and declared v1 normalize deterministically', () => {
  const v2 = decoded(event({ z: 2, a: 1 }));
  const v1 = decoded(event({ a: 1, z: 2 }, { schema_version: 1 }));

  assert.equal(v2.schema_version, 2);
  assert.equal(v2.source_schema_version, 2);
  assert.equal(v1.schema_version, 2);
  assert.equal(v1.source_schema_version, 1);
  assert.equal(v1.payload_digest, v2.payload_digest);
  assert.deepEqual(v1.data, { a: 1, z: 2 });
});

test('unknown major and unknown effect semantics quarantine fail closed', () => {
  assert.deepEqual(
    decodePlatformEvent(event({}, { schema_version: 3 }), POLICY),
    { quarantine: true, reason: 'unsupported_schema_version' }
  );
  assert.deepEqual(
    decodePlatformEvent(event({}, { effect_semantics: 'execute_external_v99' }), POLICY),
    { quarantine: true, reason: 'unknown_effect_semantics' }
  );
});

test('unknown minor fields are preserved only when the event declares no effect semantics', () => {
  const additive = decoded(event({}, {
    effect_semantics: 'none',
    future_projection_hint: { mode: 'compact' }
  }));
  assert.deepEqual(additive.extensions, {
    future_projection_hint: { mode: 'compact' }
  });

  for (const effectSemantics of ['state_projection_v1', 'effect_receipt_v1'] as const) {
    assert.deepEqual(
      decodePlatformEvent(event({}, {
        effect_semantics: effectSemantics,
        future_effect_instruction: { operation: 'unknown' }
      }), POLICY),
      { quarantine: true, reason: 'unknown_extension_with_effect_semantics' },
      effectSemantics
    );
  }
});

test('missing ordering authority producer correlation purpose or region is rejected', () => {
  for (const field of [
    'ordering_key', 'authority', 'producer_identity', 'correlation', 'purpose', 'region_policy'
  ]) {
    const candidate = event();
    delete candidate[field];
    const result = decodePlatformEvent(candidate, POLICY);
    assert.deepEqual(result, { quarantine: true, reason: `missing_${field}` }, field);
  }
});

test('payload digest is canonical and mismatches quarantine', () => {
  assert.equal(platformPayloadDigest({ z: 2, a: 1 }), platformPayloadDigest({ a: 1, z: 2 }));
  assert.deepEqual(
    decodePlatformEvent(event({ state: 'changed' }, { payload_digest: '0'.repeat(64) }), POLICY),
    { quarantine: true, reason: 'payload_digest_mismatch' }
  );
});

test('normalized digest-bound payload is immutable', () => {
  const result = decoded(event({ nested: { state: 'ready' } }));
  assert.equal(Object.isFrozen(result.data), true);
  assert.equal(Object.isFrozen((result.data as { nested: object }).nested), true);
  assert.throws(() => {
    (result.data as { nested: { state: string } }).nested.state = 'tampered';
  }, TypeError);
  assert.equal(platformPayloadDigest(result.data), result.payload_digest);
});

test('cross-node wall skew does not become an event ordering decision', () => {
  const result = decodePlatformEvent(event({}, {
    occurred_at: '2026-08-01T12:00:01.000Z',
    observed_at: '2026-08-01T12:00:00.900Z'
  }), POLICY);
  assert.equal('quarantine' in result, false, JSON.stringify(result));
});

test('payload byte upper bound accepts 0 and 65536 but rejects 65537', () => {
  for (const [size, accepted] of [[0, true], [65_536, true], [65_537, false]] as const) {
    const data = 'x'.repeat(size);
    const result = decodePlatformEvent(event(data), POLICY);
    assert.equal('quarantine' in result, !accepted, `payload bytes ${size}`);
    if (!accepted) assert.deepEqual(result, { quarantine: true, reason: 'payload_too_large' });
  }
});

test('inbox duplicate replay conflict stale and revision gap decisions are explicit', () => {
  const incoming = decoded(event());
  assert.equal(decideInboxWrite(null, incoming), 'insert');
  assert.equal(decideInboxWrite({
    event_id: incoming.event_id,
    ordering_key: incoming.ordering_key,
    payload_digest: incoming.payload_digest,
    aggregate_revision: 7
  }, incoming), 'replay');
  assert.equal(decideInboxWrite({
    event_id: incoming.event_id,
    ordering_key: incoming.ordering_key,
    payload_digest: 'f'.repeat(64),
    aggregate_revision: 7
  }, incoming), 'conflict');
  assert.equal(decideInboxWrite({
    event_id: 'event-prior',
    ordering_key: incoming.ordering_key,
    payload_digest: 'e'.repeat(64),
    aggregate_revision: 8
  }, incoming), 'stale');
  assert.equal(decideInboxWrite({
    event_id: 'event-prior',
    ordering_key: incoming.ordering_key,
    payload_digest: 'e'.repeat(64),
    aggregate_revision: 4
  }, incoming), 'gap_requires_reconcile');
});

test('reorder across distinct ordering keys is independently insertable', () => {
  const incoming = decoded(event({}, {
    event_id: 'event-b',
    aggregate_id: 'interaction-b',
    aggregate_revision: 1,
    ordering_key: 'tenant-a:interaction:interaction-b',
    idempotency_key: 'interaction-b:1'
  }));
  assert.equal(decideInboxWrite({
    event_id: 'event-a',
    ordering_key: 'tenant-a:interaction:interaction-a',
    payload_digest: 'a'.repeat(64),
    aggregate_revision: 99
  }, incoming), 'insert');
});
