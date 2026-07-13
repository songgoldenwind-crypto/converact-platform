import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath = 'src/migrations/049_ivekit_voice_route_deployment.sql';

test('Voice route deployment migration preserves payload immutability while allowing convergence', () => {
  assert.equal(existsSync(migrationPath), true, migrationPath);
  const sql = readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION opc_ivekit_voice_route_version_immutable\(\)/i);
  assert.match(sql, /SECURITY INVOKER/i);
  for (const field of [
    'NEW.id', 'NEW.tenant_id', 'NEW.route_id', 'NEW.version', 'NEW.rules',
    'NEW.payload_hash', 'NEW.published_by', 'NEW.published_at'
  ]) assert.match(sql, new RegExp(field.replace('.', '\\.')));
  assert.match(sql, /OLD\.deployment_state = 'applied'[\s\S]*NEW\.deployment_state <> 'applied'/i);
  assert.match(sql, /ERRCODE = '55000'/i);
  assert.doesNotMatch(sql, /SET\s+(rules|payload_hash|version|published_by|published_at)\s*=/i);
});
