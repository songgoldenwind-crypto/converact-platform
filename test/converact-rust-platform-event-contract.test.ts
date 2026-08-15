import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  decideInboxWrite,
  decodePlatformEvent,
  type PlatformEventV2,
  type PlatformInboxState
} from '../src/agent-runtime/converact/platform-foundation/event-envelope.js';
import {
  decideEffectReceiptAppend,
  type EffectReceipt
} from '../src/agent-runtime/converact/platform-foundation/effect-receipt.js';

const POLICY = { current_version: 2, read_versions: [2, 1] as const } as const;
const fixture = JSON.parse(readFileSync(
  new URL('../server-rs/tests/fixtures/platform-event-receipts-v1.json', import.meta.url),
  'utf8'
)) as any;

test('Rust event fixture replays the active TypeScript envelope and inbox contract', () => {
  assert.equal(fixture.contract_version, 1);
  assert.equal(fixture.compatibility_policy_revision, 1);
  assert.equal(fixture.event_cases.length, 20);
  for (const vector of fixture.event_cases) {
    const input = mergeAndRemove(fixture.base_event, vector.overrides, vector.remove);
    const result = decodePlatformEvent(input, POLICY);
    if (vector.expected.quarantine === true) {
      assert.deepEqual(result, vector.expected, vector.name);
      continue;
    }
    assert.equal('quarantine' in result, false, vector.name);
    const event = result as PlatformEventV2;
    assert.equal(event.schema_version, 2, vector.name);
    assert.equal(event.source_schema_version, vector.expected.source_schema_version, vector.name);
    assert.deepEqual(event.extensions, vector.expected.extensions, vector.name);
    if (vector.expected.correlation) {
      assert.deepEqual(event.correlation, vector.expected.correlation, vector.name);
      assert.equal(Object.is(event.correlation.sequence, -0), false, vector.name);
    }
  }

  for (const vector of fixture.inbox_cases) {
    const input = mergeAndRemove(fixture.base_event, vector.incoming_overrides);
    const event = decodePlatformEvent(input, POLICY) as PlatformEventV2;
    assert.equal(decideInboxWrite(vector.existing as PlatformInboxState | null, event), vector.expected, vector.name);
  }
});

test('platform events reject non-scalar UTF-16 before a cross-runtime authority boundary', () => {
  const surrogate = String.fromCharCode(0xd800);
  const identifier = decodePlatformEvent({ ...fixture.base_event, event_id: surrogate }, POLICY);
  assert.deepEqual(identifier, { quarantine: true, reason: 'event_identity_invalid' });

  const data = decodePlatformEvent({
    ...fixture.base_event,
    data: surrogate,
    payload_digest: '0'.repeat(64)
  }, POLICY);
  assert.deepEqual(data, { quarantine: true, reason: 'payload_too_large_or_invalid' });
});

test('Rust event fixture is bound to the exact active TypeScript sources', () => {
  for (const source of fixture.current_sources) {
    const bytes = readFileSync(new URL(`../${source.path}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256, source.path);
  }
});

test('Rust idempotency fixture replays the active TypeScript effect transition contract', () => {
  for (const vector of fixture.effect_cases) {
    const history = vector.history.map((stage: string) => fixture.base_receipts[stage]) as EffectReceipt[];
    const candidate = mergeAndRemove(
      fixture.base_receipts[vector.candidate], vector.overrides
    ) as unknown as EffectReceipt;
    assert.equal(decideEffectReceiptAppend(history, candidate), vector.expected, vector.name);
  }
  for (const vector of fixture.invalid_receipt_cases) {
    const candidate = mergeAndRemove(
      fixture.base_receipts.accepted, vector.overrides, vector.remove
    ) as unknown as EffectReceipt;
    assert.equal(decideEffectReceiptAppend([], candidate), vector.expected, vector.name);
  }
  const surrogate = String.fromCharCode(0xd800);
  assert.equal(decideEffectReceiptAppend([], {
    ...fixture.base_receipts.accepted,
    writer_id: surrogate
  }), 'invalid_transition');
});

function mergeAndRemove(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
  remove: string[] = []
): Record<string, unknown> {
  const value = structuredClone(base);
  for (const [field, item] of Object.entries(overrides)) {
    Object.defineProperty(value, field, {
      value: expandFixtureValue(item), enumerable: true, configurable: true, writable: true
    });
  }
  for (const field of remove) delete value[field];
  return value;
}

function expandFixtureValue(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2
    && typeof (value as any).$repeat === 'string'
    && Number.isSafeInteger((value as any).count)) {
    return (value as any).$repeat.repeat((value as any).count);
  }
  return structuredClone(value);
}
