import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import test from 'node:test';

import { createDatabase } from '../src/db.js';
import { one, run } from '../src/db-compat.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { createLiveKitMediaModule, LiveKitRoomStore } from '../src/agent-runtime/livekit/index.js';

const policy = JSON.parse(readFileSync('services/ivekit-service/source-policy.json', 'utf8')) as {
  migrations: string[];
};

test('standalone foundation creates only the communication prerequisites', () => {
  const sql = readFileSync('services/ivekit-service/migrations/000_ivekit_foundation.sql', 'utf8');
  const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(created, ['audit_logs', 'call_recordings', 'livekit_rooms', 'tenants']);
  for (const forbidden of [
    'users', 'leads', 'campaigns', 'voice_call_sessions', 'ivr_', 'crm_', 'outbound_'
  ]) assert.doesNotMatch(sql, new RegExp(`\\b${forbidden}`, 'i'), forbidden);
  assert.match(sql, /call_recordings[\s\S]*call_session_id TEXT NOT NULL/);
  assert.doesNotMatch(sql, /call_recordings[\s\S]*media_call_id/);
});

test('standalone migration order includes RLS and communication overlays but excludes OPC schemas', () => {
  const migrations = policy.migrations.map((path) => basename(path));
  assert.deepEqual(migrations.slice(0, 3), [
    '000_ivekit_foundation.sql',
    '009_tenant_rls.sql',
    '010_force_rls.sql'
  ]);
  for (const excluded of [
    '001_init.sql',
    '005_full_schema.sql',
    '023_ivr_tenant_rls.sql',
    '031_legacy_runtime_schema_rls.sql',
    '032_runtime_least_privilege.sql'
  ]) assert.equal(migrations.includes(excluded), false, excluded);
  assert.equal(migrations.at(-1), '090_ivekit_runtime_security.sql');
  const runtimeSecurity = readFileSync(
    'services/ivekit-service/migrations/090_ivekit_runtime_security.sql',
    'utf8'
  );
  assert.match(runtimeSecurity, /current_user = 'opc_admin'/);
  assert.match(runtimeSecurity, /opc_rustdesk_session_by_external_id/);
  assert.doesNotMatch(runtimeSecurity, /\busers\b|voice_call_sessions|call-center|ivr_/i);
});

test('standalone service exposes a compiled migration entrypoint', () => {
  const servicePackage = JSON.parse(readFileSync('services/ivekit-service/package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  const dockerfile = readFileSync('services/ivekit-service/Dockerfile', 'utf8');
  assert.equal(servicePackage.scripts.migrate, 'node dist/ivekit-migrate.js');
  assert.match(dockerfile, /COPY migrations \.\/migrations/);
  assert.doesNotMatch(dockerfile, /tsx|scripts\/run-postgres-migrations/);
});

test('generic media module does not write the legacy OPC voice session', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Standalone media tenant' });
  run(db, 'INSERT INTO voice_call_sessions (id, tenant_id) VALUES (?, ?)', ['voice_generic', tenant.id]);

  await createLiveKitMediaModule({ db }).rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    call_session_id: 'voice_generic',
    room_name: 'standalone-generic-room'
  });

  const row = one(db, 'SELECT * FROM voice_call_sessions WHERE id = ?', ['voice_generic']);
  assert.equal(row?.livekit_room_name, '');
  db.close();
});

test('legacy direct room store keeps OPC voice session synchronization', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Legacy media tenant' });
  run(db, 'INSERT INTO voice_call_sessions (id, tenant_id) VALUES (?, ?)', ['voice_legacy', tenant.id]);

  await new LiveKitRoomStore(db).createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    call_session_id: 'voice_legacy',
    room_name: 'legacy-room'
  });

  const row = one(db, 'SELECT * FROM voice_call_sessions WHERE id = ?', ['voice_legacy']);
  assert.equal(row?.livekit_room_name, 'legacy-room');
  db.close();
});
