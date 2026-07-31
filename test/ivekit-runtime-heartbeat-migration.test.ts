import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('runtime heartbeat migration stores only bounded component state', () => {
  const sql = readFileSync('src/migrations/069_ivekit_runtime_heartbeats.sql', 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_runtime_heartbeats/i);
  assert.match(sql, /state IN \('starting', 'running', 'draining', 'stopped'\)/i);
  assert.match(sql, /components JSONB/i);
  assert.match(sql, /heartbeat_at TIMESTAMPTZ/i);
  assert.equal(/secret|token|password/i.test(sql), false);
});
