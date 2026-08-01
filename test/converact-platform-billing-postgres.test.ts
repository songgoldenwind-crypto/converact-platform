import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import type { UsageEntry } from '../src/agent-runtime/converact/platform-foundation/billing-ledger.js';
import {
  PlatformBillingStoreError,
  PostgresPlatformBillingLedgerStore
} from '../src/agent-runtime/converact/platform-foundation/postgres-billing-ledger-store.js';

class RecordingPg implements PgQueryable {
  calls: Array<{ text: string; params: unknown[] }> = [];
  constructor(private readonly respond: (text: string, params: unknown[]) => unknown[] = () => []) {}
  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    const rows = this.respond(text, params) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

test('usage append elects one tenant-scoped writer and inserts immutable entry', async () => {
  const candidate = usage();
  const pg = new RecordingPg((sql) => {
    if (/SELECT entry\./i.test(sql)) return [];
    if (/SELECT writer\./i.test(sql)) return [];
    if (/INSERT INTO converact_platform_billing_writers/i.test(sql)) return [{
      tenant_id: candidate.tenant_id, billing_key: candidate.billing_key,
      writer_id: candidate.writer_id, writer_epoch: candidate.writer_epoch
    }];
    if (/INSERT INTO converact_platform_usage_entries/i.test(sql)) return [candidate];
    return [];
  });
  const result = await new PostgresPlatformBillingLedgerStore(pg).append(candidate);
  assert.deepEqual(result, { status: 'inserted' });
  for (const call of pg.calls.filter((item) => /converact_platform_(?:billing|usage)/i.test(item.text))) {
    assert.equal(call.params[0], 'tenant-a');
    assert.match(call.text, /tenant_id = \$1|\(tenant_id,[\s\S]*VALUES\s*\(\$1,/i);
  }
});

test('same receipt digest replays while changed digest conflicts', async () => {
  const original = usage();
  const replayPg = new RecordingPg((sql) => /SELECT entry\./i.test(sql) ? [original] : []);
  const replay = await new PostgresPlatformBillingLedgerStore(replayPg).append(usage({
    entry_id: 'retry-entry', receipt_id: 'retry-receipt'
  }));
  assert.deepEqual(replay, { status: 'replay' });
  assert.equal(replayPg.calls.some((call) => /INSERT INTO converact_platform_usage_entries/i.test(call.text)), false);

  const conflictPg = new RecordingPg((sql) => /SELECT entry\./i.test(sql) ? [original] : []);
  await assert.rejects(
    () => new PostgresPlatformBillingLedgerStore(conflictPg).append(usage({
      receipt_digest: 'f'.repeat(64)
    })),
    (error: unknown) => (error as PlatformBillingStoreError).code === 'platform_usage_conflict'
  );
});

test('writer epoch is fenced before a stale usage write', async () => {
  const pg = new RecordingPg((sql) => {
    if (/SELECT entry\./i.test(sql)) return [];
    if (/SELECT writer\./i.test(sql)) return [{
      tenant_id: 'tenant-a', billing_key: usage().billing_key,
      writer_id: 'rating-worker-new', writer_epoch: 8
    }];
    return [];
  });
  await assert.rejects(
    () => new PostgresPlatformBillingLedgerStore(pg).append(usage({ writer_epoch: 7 })),
    (error: unknown) => (error as PlatformBillingStoreError).code === 'platform_usage_stale_writer'
  );
  assert.equal(pg.calls.some((call) => /INSERT INTO converact_platform_usage_entries/i.test(call.text)), false);
});

test('credit requires an exact original entry under the same writer fence', async () => {
  const original = usage();
  const credit = usage({
    entry_id: 'credit-a', entry_kind: 'credit', quantity: 3, receipt_id: 'receipt-credit-a',
    receipt_digest: 'b'.repeat(64), reverses_entry_id: original.entry_id
  });
  const pg = new RecordingPg((sql) => {
    if (/SELECT entry\.[\s\S]*entry_id = \$2 OR/i.test(sql)) return [];
    if (/SELECT writer\./i.test(sql)) return [{
      tenant_id: original.tenant_id, billing_key: original.billing_key,
      writer_id: original.writer_id, writer_epoch: original.writer_epoch
    }];
    if (/entry\.entry_id = \$2[\s\S]*FOR UPDATE/i.test(sql)) return [original];
    if (/INSERT INTO converact_platform_usage_entries/i.test(sql)) return [credit];
    return [];
  });
  assert.deepEqual(await new PostgresPlatformBillingLedgerStore(pg).append(credit), { status: 'inserted' });
});

test('credit cannot exceed the remaining immutable usage quantity', async () => {
  const original = usage();
  const credit = usage({
    entry_id: 'credit-over', entry_kind: 'credit', quantity: 11,
    receipt_id: 'receipt-credit-over', receipt_digest: 'c'.repeat(64),
    reverses_entry_id: original.entry_id
  });
  const pg = new RecordingPg((sql) => {
    if (/SELECT entry\.[\s\S]*entry_id = \$2 OR/i.test(sql)) return [];
    if (/SELECT writer\./i.test(sql)) return [{
      tenant_id: original.tenant_id, billing_key: original.billing_key,
      writer_id: original.writer_id, writer_epoch: original.writer_epoch
    }];
    if (/entry\.entry_id = \$2[\s\S]*FOR UPDATE/i.test(sql)) return [original];
    if (/SUM\(entry\.quantity\)/i.test(sql)) return [{ corrected_quantity: '0' }];
    return [];
  });
  await assert.rejects(
    () => new PostgresPlatformBillingLedgerStore(pg).append(credit),
    (error: unknown) => (error as PlatformBillingStoreError).code === 'platform_usage_conflict'
  );
  assert.equal(pg.calls.some((call) => /INSERT INTO converact_platform_usage_entries/i.test(call.text)), false);
});

function usage(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    entry_id: 'usage-a', tenant_id: 'tenant-a', billing_key: 'ai:tenant-a:agent-run-a:4',
    entry_kind: 'usage', unit: 'seconds', quantity: 10, receipt_id: 'receipt-a',
    receipt_digest: 'a'.repeat(64), writer_id: 'rating-worker-a', writer_epoch: 6,
    occurred_at: '2026-08-01T12:00:00.000Z', reverses_entry_id: null, ...overrides
  };
}
