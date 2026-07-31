import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import { PostgresIveKitRateLimitStore } from '../src/agent-runtime/converact/operations/rate-limit/index.js';

class RecordingPg implements PgQueryable {
  calls: Array<{ text: string; params: unknown[] }> = [];
  constructor(private readonly respond: (text: string, params: unknown[]) => unknown[] = () => []) {}
  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    const rows = this.respond(text, params) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

test('Postgres rate limit store atomically increments fixed-window buckets', async () => {
  const pg = new RecordingPg((sql, params) => /INSERT INTO ivekit_rate_limit_buckets/i.test(sql)
    ? [{ window_started_at: params[5], used_count: '1', limit_count: '60' }]
    : []);
  const result = await new PostgresIveKitRateLimitStore(pg).reserve(reservation());
  assert.equal(result.allowed, true);
  const insert = pg.calls.find((call) => /INSERT INTO ivekit_rate_limit_buckets/i.test(call.text))!;
  assert.match(insert.text, /ON CONFLICT/i);
  assert.match(insert.text, /used_count \+ EXCLUDED\.used_count/i);
  assert.equal(insert.params.includes('private-recipient'), false);
});

test('Postgres rate limit store returns bounded retry delay when a bucket is full', async () => {
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_rate_limit_buckets/i.test(sql)) return [];
    if (/SELECT window_started_at/i.test(sql)) {
      return [{ window_started_at: '2026-07-15T08:00:00.000Z', used_count: '10', limit_count: '10' }];
    }
    return [];
  });
  const result = await new PostgresIveKitRateLimitStore(pg).reserve(reservation());
  assert.deepEqual(result, {
    allowed: false, retry_after_seconds: 30, denied_scope: 'recipient'
  });
});

function reservation(): any {
  return {
    tenant_id: 'tenant-a', route_group: 'notification.create',
    dimensions: [{
      scope_type: 'recipient', scope_key_hmac: 'a'.repeat(64),
      limit: 10, window_seconds: 60, cost: 1
    }],
    now: '2026-07-15T08:00:30.000Z'
  };
}
