import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('migration 063 defines tenant-isolated QoS snapshots and monotonic connection events', () => {
  const migration = readFileSync('src/migrations/063_livekit_media_quality.sql', 'utf8');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS ivekit_media_quality_snapshots/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ivekit_media_connection_events/i);
  assert.match(migration, /connection_revision BIGINT NOT NULL DEFAULT 0/i);
  assert.match(migration, /connection_state TEXT NOT NULL DEFAULT 'disconnected'/i);
  assert.match(migration, /quality_state TEXT NOT NULL DEFAULT 'unknown'/i);
  assert.match(migration, /UNIQUE \(tenant_id, call_id, participant_identity, connection_revision, sample_id, track_source\)/i);
  assert.match(migration, /UNIQUE \(tenant_id, call_id, participant_identity, event_id\)/i);
  for (const table of ['ivekit_media_quality_snapshots', 'ivekit_media_connection_events']) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'));
    assert.match(migration, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'));
    assert.match(migration, new RegExp(`CREATE POLICY tenant_isolation ON ${table}`, 'i'));
  }
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_media_quality_snapshots TO opc_runtime/i);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_media_connection_events TO opc_runtime/i);
});

test('standalone source graph orders media quality before runtime security', () => {
  const sourcePolicy = JSON.parse(
    readFileSync('services/ivekit-service/source-policy.json', 'utf8')
  ) as { migrations: string[] };
  const quality = sourcePolicy.migrations.indexOf('063_livekit_media_quality.sql');
  const runtimeSecurity = sourcePolicy.migrations.indexOf(
    'services/ivekit-service/migrations/090_ivekit_runtime_security.sql'
  );
  assert.ok(quality >= 0);
  assert.ok(runtimeSecurity > quality);

  const delivery = readFileSync('scripts/ivekit-delivery-bundle.ts', 'utf8');
  assert.match(delivery, /063_livekit_media_quality\.sql/);
});

test('OpenAPI, environment, events, SDK, and metrics expose the bounded QoS contract', () => {
  const openapi = readFileSync('docs/openapi.yaml', 'utf8');
  const markdown = readFileSync('docs/ivekit-openapi.md', 'utf8');
  const metrics = readFileSync(
    'src/agent-runtime/livekit/media-quality-metrics.ts',
    'utf8'
  );
  const sdk = readFileSync('sdk/ivekit/src/http-sdk.ts', 'utf8');
  for (const path of [
    '/api/ivekit/media/calls/{call_id}/qos:',
    '/api/ivekit/media/calls/{call_id}/connection-events:'
  ]) assert.match(openapi, new RegExp(escapeRegExp(path)));
  for (const schema of [
    'IveKitMediaQualitySnapshotInput',
    'IveKitMediaQualityReportResult',
    'IveKitMediaQualitySummary',
    'IveKitMediaConnectionEventInput',
    'IveKitMediaConnectionEventResult'
  ]) assert.match(openapi, new RegExp(`    ${schema}:`));
  assert.match(markdown, /ivekit\.media\.qos\.degraded/);
  assert.match(markdown, /SDP、ICE/);
  assert.match(sdk, /reportCallQuality/);
  assert.match(sdk, /reportCallConnectionEvent/);
  assert.doesNotMatch(metrics, /labelNames:\s*\[[^\]]*(?:tenant|call|participant)/s);
  for (const envFile of ['.env.example', 'services/ivekit-service/env.example']) {
    const env = readFileSync(envFile, 'utf8');
    assert.match(env, /OPC_MEDIA_QOS_DEGRADED_SAMPLES=3/);
    assert.match(env, /OPC_MEDIA_QOS_RETENTION_MS=604800000/);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
