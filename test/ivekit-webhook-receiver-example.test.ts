import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('LED webhook receiver example uses a durable external inbox and retry-safe status codes', () => {
  const source = readFileSync('sdk/ivekit/examples/webhook-receiver.ts', 'utf8');
  assert.match(source, /verifyIveKitWebhook/);
  assert.match(source, /IveKitWebhookReplayStore/);
  assert.match(source, /dependencies\.inbox\.claim/);
  assert.match(source, /inbox_unavailable/);
  assert.match(source, /secret_unavailable/);
  assert.match(source, /response\(503/);
  assert.match(source, /duplicate: result\.duplicate/);
  assert.doesNotMatch(source, /new Set|Memory|console\.|process\.env/);
});
