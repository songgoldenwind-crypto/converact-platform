import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('scaling campaign migration persists immutable run references and fenced finalization', () => {
  const sql = readFileSync(
    'src/migrations/091_ivekit_capacity_scaling_campaigns.sql',
    'utf8'
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_capacity_scaling_campaigns/i);
  assert.match(sql, /submission_sha256.*\^\[a-f0-9\]\{64\}\$/is);
  assert.match(sql, /controller_lease_epoch BIGINT/i);
  assert.match(sql, /state IN \('finalizing', 'completed', 'failed', 'not_run'\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_capacity_scaling_campaign_runs/i);
  assert.match(sql, /REFERENCES ivekit_capacity_load_runs\(run_id\)/i);
  assert.match(sql, /UNIQUE \(campaign_id, run_id\)/i);
  assert.match(sql, /PRIMARY KEY \(campaign_id, units, attempt\)/i);
  assert.doesNotMatch(sql, /sqlite/i);
});
