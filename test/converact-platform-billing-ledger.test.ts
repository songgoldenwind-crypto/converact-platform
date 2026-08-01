import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideUsageAppend,
  platformBillingEffectId,
  platformBillingKey,
  reconstructUsage,
  type BillableSource,
  type UsageEntry
} from '../src/agent-runtime/converact/platform-foundation/billing-ledger.js';

test('four billable source types produce exact generation-bound keys', () => {
  const cases: Array<[BillableSource, string]> = [
    [{
      kind: 'directed_media_edge', tenant_id: 'tenant-a', interaction_id: 'interaction-a',
      edge_id: 'edge-a', generation: 3, direction: 'a_to_b'
    }, 'edge:tenant-a:interaction-a:edge-a:3:a_to_b'],
    [{
      kind: 'ai_run', tenant_id: 'tenant-a', agent_run_id: 'agent-run-a', generation: 4
    }, 'ai:tenant-a:agent-run-a:4'],
    [{
      kind: 'recording_segment', tenant_id: 'tenant-a', manifest_id: 'manifest-a',
      segment_id: 'segment-a', owner_epoch: 8
    }, 'recording:tenant-a:manifest-a:segment-a:8'],
    [{
      kind: 'external_action', tenant_id: 'tenant-a', intent_id: 'intent-a', attempt_generation: 2
    }, 'action:tenant-a:intent-a:2']
  ];
  for (const [source, expected] of cases) {
    assert.equal(platformBillingKey(source), expected);
    assert.match(platformBillingEffectId(source), /^billing:[a-f0-9]{64}$/u);
    assert.equal(platformBillingEffectId(source), platformBillingEffectId({ ...source }));
  }
  assert.notEqual(platformBillingEffectId(cases[0][0]), platformBillingEffectId(cases[1][0]));
  assert.throws(() => platformBillingKey({
    kind: 'ai_run', tenant_id: 'tenant:escape', agent_run_id: 'run-a', generation: 1
  }), /billable_source_invalid/);
});

function usage(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    entry_id: 'usage-a',
    tenant_id: 'tenant-a',
    billing_key: 'ai:tenant-a:agent-run-a:4',
    entry_kind: 'usage',
    unit: 'seconds',
    quantity: 10,
    receipt_id: 'receipt-a',
    receipt_digest: 'a'.repeat(64),
    writer_id: 'agent-runtime-usage-adapter',
    writer_epoch: 6,
    occurred_at: '2026-08-01T12:00:00.000Z',
    reverses_entry_id: null,
    ...overrides
  };
}

test('same receipt replays without charge and conflicts freeze rating', () => {
  const original = usage();
  assert.equal(decideUsageAppend(null, original), 'append');
  assert.equal(decideUsageAppend(original, { ...original }), 'replay');
  assert.equal(decideUsageAppend(original, usage({
    entry_id: 'retry-entry-a', receipt_id: 'retry-receipt-a'
  })), 'replay');
  assert.equal(decideUsageAppend(original, usage({ receipt_digest: 'b'.repeat(64) })), 'conflict');
  assert.equal(decideUsageAppend(original, usage({ writer_id: 'other-writer' })), 'conflict');
  assert.equal(decideUsageAppend(original, usage({ writer_epoch: 7 })), 'conflict');
  assert.equal(decideUsageAppend(original, usage({ writer_epoch: 5 })), 'stale_writer');
});

test('negative non-finite and mutable correction-shaped usage is rejected', () => {
  for (const quantity of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => decideUsageAppend(null, usage({ quantity })), /usage_entry_invalid/);
  }
  assert.throws(
    () => decideUsageAppend(null, usage({ reverses_entry_id: 'usage-prior' })),
    /usage_entry_invalid/
  );
  assert.throws(
    () => decideUsageAppend(null, usage({ entry_kind: 'reversal', reverses_entry_id: null })),
    /usage_entry_invalid/
  );
});

test('correction is a new reversal or credit entry and never mutates history', () => {
  const original = Object.freeze(usage());
  const credit = usage({
    entry_id: 'credit-a',
    entry_kind: 'credit',
    quantity: 3,
    receipt_id: 'receipt-credit-a',
    receipt_digest: 'b'.repeat(64),
    occurred_at: '2026-08-01T12:01:00.000Z',
    reverses_entry_id: original.entry_id
  });
  assert.equal(decideUsageAppend(original, credit), 'append');
  assert.equal(original.quantity, 10);
  assert.equal(decideUsageAppend(null, credit), 'conflict');
  assert.equal(decideUsageAppend(original, {
    ...credit,
    billing_key: 'ai:tenant-a:agent-run-other:1'
  }), 'conflict');
});

test('immutable entries and corrections reconstruct balances without mutable counters', () => {
  const original = usage();
  const replay = { ...original, entry_id: 'retry-entry-a', receipt_id: 'retry-receipt-a' };
  const credit = usage({
    entry_id: 'credit-a', entry_kind: 'credit', quantity: 3,
    receipt_id: 'receipt-credit-a', receipt_digest: 'b'.repeat(64),
    occurred_at: '2026-08-01T12:01:00.000Z', reverses_entry_id: original.entry_id
  });
  const edge = usage({
    entry_id: 'usage-edge', billing_key: 'edge:tenant-a:interaction-a:edge-a:3:a_to_b',
    quantity: 5, receipt_id: 'receipt-edge', receipt_digest: 'c'.repeat(64)
  });

  assert.deepEqual(reconstructUsage([credit, edge, replay, original]), {
    total_by_unit: { seconds: 12 },
    total_by_billing_key: {
      'ai:tenant-a:agent-run-a:4': 7,
      'edge:tenant-a:interaction-a:edge-a:3:a_to_b': 5
    }
  });
});

test('reconstruction rejects conflicting duplicates and over-correction', () => {
  const original = usage();
  assert.throws(
    () => reconstructUsage([original, usage({ receipt_digest: 'f'.repeat(64) })]),
    /usage_ledger_conflict/
  );
  assert.throws(
    () => reconstructUsage([original, usage({
      entry_id: 'reversal-a', entry_kind: 'reversal', quantity: 11,
      receipt_id: 'receipt-reversal-a', receipt_digest: 'd'.repeat(64),
      reverses_entry_id: original.entry_id
    })]),
    /usage_ledger_invalid/
  );
});
