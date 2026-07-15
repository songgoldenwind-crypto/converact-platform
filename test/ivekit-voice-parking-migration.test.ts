import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync('src/migrations/058_ivekit_voice_parking.sql', 'utf8');

test('Voice parking migration provides durable tenant-scoped slot authority', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_voice_parking_slots/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, profile_id\)[\s\S]*ivekit_voice_deployment_profiles\(tenant_id, id\)/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, parked_call_id\)[\s\S]*ivekit_voice_calls\(tenant_id, id\)/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, park_command_id\)[\s\S]*ivekit_voice_call_commands\(tenant_id, id\)/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_voice_parking_active_slot[\s\S]*WHERE state IN \('parking', 'parked', 'retrieving'\)/i);
  assert.match(sql, /CHECK \(slot ~ '\^\[A-Za-z0-9\]/i);
  assert.match(sql, /expires_at TIMESTAMPTZ NOT NULL/i);
});

test('Voice parking slots force RLS for table owners', () => {
  assert.match(sql, /ALTER TABLE ivekit_voice_parking_slots ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /ALTER TABLE ivekit_voice_parking_slots FORCE ROW LEVEL SECURITY/i);
  assert.match(sql, /CREATE POLICY tenant_isolation ON ivekit_voice_parking_slots FOR ALL/i);
  assert.match(sql, /tenant_id = opc_current_tenant\(\)/i);
});
