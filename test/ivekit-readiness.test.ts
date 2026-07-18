import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import {
  createIveKitReadinessProbe,
  REQUIRED_MIGRATIONS
} from '../src/agent-runtime/ivekit/operations/readiness.js';

class ReadyPg implements PgQueryable {
  async query<R>(text: string): Promise<any> {
    if (/schema_migrations/i.test(text)) {
      return { rows: REQUIRED_MIGRATIONS.map((version) => ({ version })) as R[] };
    }
    if (/ivekit_notification_endpoints/i.test(text)) {
      return { rows: [{ active: '2', unhealthy: '1' }] as R[] };
    }
    if (/ivekit_runtime_heartbeats/i.test(text)) {
      return { rows: [{ state: 'running', heartbeat_at: new Date().toISOString() }] as R[] };
    }
    return { rows: [{ ready: 1 }] as R[] };
  }
}

const validEnv = {
  OPC_IVEKIT_AUDIT_IP_HMAC_KEY: Buffer.alloc(32, 1).toString('base64'),
  OPC_IVEKIT_RATE_LIMIT_HMAC_KEY: Buffer.alloc(32, 2).toString('base64')
};

test('readiness requires the RustDesk authorization claim upgrade', () => {
  assert.equal(REQUIRED_MIGRATIONS.at(-1), '095_rustdesk_authorization_claims');
});

test('readiness executes SQL, verifies migrations, and reports nonblocking provider degradation', async () => {
  const result = await createIveKitReadinessProbe({ pg: new ReadyPg(), env: validEnv }).probe();
  assert.equal(result.status, 'ready');
  assert.equal(result.checks.database.status, 'ok');
  assert.equal(result.checks.migrations.status, 'ok');
  assert.equal(result.checks.notification_providers.status, 'degraded');
  assert.equal(result.checks.notification_providers.blocking, false);
  assert.equal(result.checks.runtime_heartbeat.status, 'disabled');
});

test('readiness fails closed for missing database, migrations, or security keys', async () => {
  const missingDatabase = await createIveKitReadinessProbe({ pg: null, env: validEnv }).probe();
  assert.equal(missingDatabase.status, 'not_ready');
  assert.equal(missingDatabase.checks.database.status, 'failed');

  const invalidConfig = await createIveKitReadinessProbe({ pg: new ReadyPg(), env: {} }).probe();
  assert.equal(invalidConfig.status, 'not_ready');
  assert.deepEqual(invalidConfig.checks.configuration.missing_or_invalid, [
    'OPC_IVEKIT_AUDIT_IP_HMAC_KEY', 'OPC_IVEKIT_RATE_LIMIT_HMAC_KEY'
  ]);
});

test('readiness fails closed when placement is enabled without a valid signed snapshot', async () => {
  const env = { ...validEnv, OPC_IVEKIT_PLACEMENT_ENABLED: '1' };
  const missing = await createIveKitReadinessProbe({
    pg: new ReadyPg(),
    env
  }).probe();
  assert.equal(missing.status, 'not_ready');
  assert.deepEqual(missing.checks.placement_snapshot, {
    status: 'missing',
    snapshot_version: 0,
    error_code: 'placement_probe_missing'
  });

  const failed = await createIveKitReadinessProbe({
    pg: new ReadyPg(),
    env,
    placementProbe: {
      async probe() {
        throw Object.assign(new Error('do not expose local path'), {
          code: 'placement_snapshot_unavailable'
        });
      }
    }
  }).probe();
  assert.equal(failed.status, 'not_ready');
  assert.deepEqual(failed.checks.placement_snapshot, {
    status: 'failed',
    snapshot_version: 0,
    error_code: 'placement_snapshot_unavailable'
  });
});

test('readiness accepts a verified placement snapshot without contacting Cell admission', async () => {
  let probes = 0;
  const result = await createIveKitReadinessProbe({
    pg: new ReadyPg(),
    env: { ...validEnv, OPC_IVEKIT_PLACEMENT_ENABLED: '1' },
    placementProbe: {
      async probe() {
        probes += 1;
        return {
          snapshot_version: 42,
          generated_at: '2026-07-16T08:00:00.000Z',
          expires_at: '2026-07-16T08:01:00.000Z'
        };
      }
    }
  }).probe();
  assert.equal(result.status, 'ready');
  assert.equal(probes, 1);
  assert.deepEqual(result.checks.placement_snapshot, {
    status: 'ok',
    snapshot_version: 42,
    error_code: ''
  });
});
