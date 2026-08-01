import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEffectAuditLink,
  decideEffectReceiptAppend,
  effectNeedsReconcile,
  type EffectReceipt,
  type EffectReceiptStage
} from '../src/agent-runtime/converact/platform-foundation/effect-receipt.js';

function receipt(stage: EffectReceiptStage, overrides: Partial<EffectReceipt> = {}): EffectReceipt {
  return {
    receipt_id: `receipt-${stage}`,
    tenant_id: 'tenant-a',
    effect_id: 'effect-a',
    event_id: `event-${stage}`,
    correlation_id: 'correlation-a',
    stage,
    generation: 4,
    writer_id: 'effect-worker-a',
    owner_epoch: 8,
    receipt_digest: ({
      accepted: 'a', completed: 'b', state_observed: 'c'
    } as const)[stage].repeat(64),
    observed_at: ({
      accepted: '2026-08-01T12:00:00.000Z',
      completed: '2026-08-01T12:00:01.000Z',
      state_observed: '2026-08-01T12:00:02.000Z'
    } as const)[stage],
    ...overrides
  };
}

test('accepted completed and state-observed are the only forward sequence', () => {
  const accepted = receipt('accepted');
  const completed = receipt('completed');
  const observed = receipt('state_observed');

  assert.equal(decideEffectReceiptAppend([], accepted), 'append');
  assert.equal(decideEffectReceiptAppend([], completed), 'invalid_transition');
  assert.equal(decideEffectReceiptAppend([], observed), 'invalid_transition');
  assert.equal(decideEffectReceiptAppend([accepted], completed), 'append');
  assert.equal(decideEffectReceiptAppend([accepted], observed), 'invalid_transition');
  assert.equal(decideEffectReceiptAppend([accepted, completed], observed), 'append');
  assert.equal(decideEffectReceiptAppend([accepted, completed, observed], observed), 'replay');
});

test('same stage key and digest replays while a changed receipt conflicts', () => {
  const accepted = receipt('accepted');
  assert.equal(decideEffectReceiptAppend([accepted], { ...accepted }), 'replay');
  assert.equal(decideEffectReceiptAppend([accepted], {
    ...accepted,
    receipt_digest: 'f'.repeat(64)
  }), 'conflict');
  assert.equal(decideEffectReceiptAppend([accepted], {
    ...accepted,
    receipt_id: 'receipt-duplicate-identity'
  }), 'conflict');
});

test('lower generation or owner epoch is fenced as a stale writer', () => {
  const accepted = receipt('accepted');
  assert.equal(decideEffectReceiptAppend([accepted], receipt('completed', { generation: 3 })), 'stale_writer');
  assert.equal(decideEffectReceiptAppend([accepted], receipt('completed', { owner_epoch: 7 })), 'stale_writer');
  assert.equal(decideEffectReceiptAppend([accepted], receipt('completed', {
    writer_id: 'takeover-worker', owner_epoch: 9
  })), 'append');
  assert.equal(decideEffectReceiptAppend([accepted], receipt('completed', {
    writer_id: 'different-worker', owner_epoch: 8
  })), 'conflict');
});

test('accepted-only and completed-only histories require query and reconcile', () => {
  const accepted = receipt('accepted');
  const completed = receipt('completed');
  const observed = receipt('state_observed');
  assert.equal(effectNeedsReconcile([]), false);
  assert.equal(effectNeedsReconcile([accepted]), true);
  assert.equal(effectNeedsReconcile([accepted, completed]), true);
  assert.equal(effectNeedsReconcile([accepted, completed, observed]), false);
});

test('a new generation must restart at accepted and cannot move backwards', () => {
  const prior = [receipt('accepted'), receipt('completed'), receipt('state_observed')];
  assert.equal(decideEffectReceiptAppend(prior, receipt('accepted', {
    receipt_id: 'receipt-generation-5', generation: 5, owner_epoch: 9
  })), 'append');
  assert.equal(decideEffectReceiptAppend(prior, receipt('completed', {
    receipt_id: 'receipt-generation-5-complete', generation: 5, owner_epoch: 9
  })), 'invalid_transition');
  assert.equal(decideEffectReceiptAppend(prior, receipt('accepted', {
    receipt_id: 'receipt-generation-3', generation: 3
  })), 'stale_writer');
});

test('audit link is exact and rejects raw request secret or payload fields', () => {
  assert.deepEqual(createEffectAuditLink(receipt('accepted')), {
    tenant_id: 'tenant-a',
    effect_id: 'effect-a',
    event_id: 'event-accepted',
    receipt_id: 'receipt-accepted',
    correlation_id: 'correlation-a'
  });
  for (const forbidden of ['raw_request', 'secret', 'payload']) {
    assert.throws(
      () => createEffectAuditLink({ ...receipt('accepted'), [forbidden]: 'sensitive' } as EffectReceipt),
      /effect_receipt_shape_invalid/,
      forbidden
    );
  }
  assert.throws(
    () => createEffectAuditLink({ ...receipt('accepted'), correlation_id: '' }),
    /effect_receipt_shape_invalid/
  );
});
