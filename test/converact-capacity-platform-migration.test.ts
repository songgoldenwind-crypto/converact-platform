import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('platform campaign migration binds every scaling curve and endpoint run to fenced evidence', () => {
  const sql = readFileSync(
    'src/migrations/092_ivekit_capacity_platform_campaigns.sql',
    'utf8'
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_capacity_platform_campaigns/i);
  assert.match(sql, /capacity_claim IN \('none', 'platform_pass'\)/i);
  assert.match(sql, /controller_lease_epoch BIGINT/i);
  assert.match(sql, /REFERENCES ivekit_capacity_load_runs\(run_id\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_capacity_platform_scaling_refs/i);
  assert.match(sql, /REFERENCES ivekit_capacity_scaling_campaigns\(campaign_id\)/i);
  assert.match(sql, /UNIQUE \(platform_campaign_id, campaign_id\)/i);
  assert.doesNotMatch(sql, /sqlite/i);
});
