import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath = 'src/migrations/051_ivekit_ivr_resources.sql';

test('IVR resource migration adds optimistic revision and standalone delivery ordering', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  assert.match(sql, /ALTER TABLE ivekit_ivr_audio_assets[\s\S]*ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT ''/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_ivr_settings_tenant_singleton/i);
  for (const table of ['time_groups', 'region_groups', 'ring_groups']) {
    assert.match(sql, new RegExp(`idx_ivekit_ivr_${table}_status`, 'i'));
  }

  const sourcePolicy = readFileSync('services/converact-service/source-policy.json', 'utf8');
  const delivery = readFileSync('scripts/converact-delivery-bundle.ts', 'utf8');
  for (const source of [sourcePolicy, delivery]) assert.match(source, /051_ivekit_ivr_resources\.sql/);
  assert.ok(sourcePolicy.indexOf('050_ivekit_ivr_runtime.sql') < sourcePolicy.indexOf('051_ivekit_ivr_resources.sql'));
  assert.ok(sourcePolicy.indexOf('051_ivekit_ivr_resources.sql') < sourcePolicy.indexOf('090_ivekit_runtime_security.sql'));
});

