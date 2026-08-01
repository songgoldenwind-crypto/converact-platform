import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath = 'src/migrations/086_ivekit_recording_manifests.sql';

test('recording manifest migration creates tenant-isolated authority and durable segment leases', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  for (const table of [
    'ivekit_recording_manifests',
    'ivekit_recording_segments',
    'ivekit_recording_segment_events',
    'ivekit_recording_upload_leases',
    'ivekit_recording_segment_uploads',
    'ivekit_recording_upload_parts'
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'));
    assert.match(sql, new RegExp(`CREATE POLICY tenant_isolation ON ${table}`, 'i'));
  }

  assert.match(sql, /source TEXT NOT NULL[\s\S]*'sip_voice'/i);
  assert.match(sql, /consent_id TEXT NOT NULL/i);
  assert.match(sql, /recording_mode TEXT NOT NULL/i);
  assert.match(sql, /retention_until TIMESTAMPTZ NOT NULL/i);
  assert.match(sql, /owner_epoch NUMERIC\(20,0\) NOT NULL/i);
  assert.match(sql, /UNIQUE \(tenant_id, manifest_id, track_id, sequence\)/i);
  assert.match(sql, /sha256 TEXT NOT NULL DEFAULT ''[\s\S]*\^\[a-f0-9\]\{64\}\$/i);
  assert.match(sql, /lease_token_hash TEXT NOT NULL DEFAULT ''/i);
  assert.match(sql, /lease_expires_at TIMESTAMPTZ/i);
  assert.match(sql, /next_attempt_at TIMESTAMPTZ/i);
  assert.match(sql, /attempt_count INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/i);
  assert.match(sql, /opc_ivekit_recording_worker_tenant_ids/i);
  assert.match(sql, /UNIQUE \(tenant_id, upload_id\)/i);
  assert.match(sql, /PRIMARY KEY \(tenant_id, segment_id, part_number\)/i);
  assert.doesNotMatch(sql, /media_bytes|audio_bytes|BYTEA|local_path/i);
});

test('recording migration links legacy voice rows without making media binary a database concern', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  assert.match(sql, /ALTER TABLE ivekit_voice_recordings[\s\S]*ADD COLUMN IF NOT EXISTS manifest_id TEXT/i);
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, manifest_id\)[\s\S]*REFERENCES ivekit_recording_manifests\(tenant_id, id\)/i
  );
  assert.match(sql, /object_ref TEXT NOT NULL DEFAULT ''/i);
  assert.match(sql, /local_ref TEXT NOT NULL DEFAULT ''/i);
  assert.doesNotMatch(sql, /postgres.*media|media.*postgres/i);
});

test('standalone migration order places recording manifests before runtime security', () => {
  const policy = JSON.parse(
    readFileSync('services/converact-service/source-policy.json', 'utf8')
  ) as { migrations: string[] };
  const recording = policy.migrations.indexOf('086_ivekit_recording_manifests.sql');
  const runtimeSecurity = policy.migrations.indexOf(
    'services/converact-service/migrations/090_ivekit_runtime_security.sql'
  );

  assert.ok(recording >= 0);
  assert.ok(runtimeSecurity > recording);
  assert.match(
    readFileSync('scripts/converact-delivery-bundle.ts', 'utf8'),
    /086_ivekit_recording_manifests\.sql/
  );
});
