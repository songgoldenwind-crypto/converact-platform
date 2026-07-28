import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import {
  createIveKitReadinessProbe,
  REQUIRED_MIGRATIONS
} from '../src/agent-runtime/ivekit/operations/readiness.js';

class ReadyPg implements PgQueryable {
  readonly queries: string[] = [];

  async query<R>(text: string): Promise<any> {
    this.queries.push(text);
    if (/opc_ivekit_applied_migration_versions/i.test(text)) {
      return { rows: REQUIRED_MIGRATIONS.map((version) => ({ version })) as R[] };
    }
    if (/\bFROM\s+(?:public\.)?schema_migrations\b/i.test(text)) {
      throw new Error('permission denied for table schema_migrations');
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

test('readiness requires the latest communication correctness migrations', () => {
  assert.equal(REQUIRED_MIGRATIONS.includes('095_rustdesk_authorization_claims'), true);
  assert.equal(REQUIRED_MIGRATIONS.includes('104_ivekit_cell_admission_ledger_runtime'), true);
  assert.equal(REQUIRED_MIGRATIONS.includes('105_tinode_closed_session_inbound'), true);
  assert.equal(REQUIRED_MIGRATIONS.at(-1), '106_tinode_open_session_mutation_queue');
});

test('readiness executes SQL, verifies migrations, and reports nonblocking provider degradation', async () => {
  const pg = new ReadyPg();
  const result = await createIveKitReadinessProbe({ pg, env: validEnv }).probe();
  assert.equal(result.status, 'ready');
  assert.equal(result.checks.database.status, 'ok');
  assert.equal(result.checks.migrations.status, 'ok');
  assert.equal(result.checks.notification_providers.status, 'degraded');
  assert.equal(result.checks.notification_providers.blocking, false);
  assert.equal(result.checks.runtime_heartbeat.status, 'disabled');
  assert.equal(pg.queries.some((query) => /opc_ivekit_applied_migration_versions/i.test(query)), true);
  assert.equal(pg.queries.some((query) => /\bFROM\s+(?:public\.)?schema_migrations\b/i.test(query)), false);
});

test('readiness migration exposes only a bounded migration-version probe to the runtime role', () => {
  assert.equal(REQUIRED_MIGRATIONS.at(-1), '106_tinode_open_session_mutation_queue');
  const sql = readFileSync(
    new URL('../src/migrations/101_ivekit_migration_readiness.sql', import.meta.url),
    'utf8'
  );
  assert.match(sql, /opc_ivekit_applied_migration_versions\(TEXT\[\]\)/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /cardinality\(p_versions\).*256/s);
  assert.match(sql, /REVOKE ALL ON FUNCTION.*FROM PUBLIC/s);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION.*TO opc_runtime/s);
});

test('root and standalone migration sets share the runtime security marker required by readiness', () => {
  const root = readFileSync(
    new URL('../src/migrations/090_ivekit_runtime_security.sql', import.meta.url),
    'utf8'
  );
  const standalone = readFileSync(
    new URL('../services/ivekit-service/migrations/090_ivekit_runtime_security.sql', import.meta.url),
    'utf8'
  );
  assert.equal(root, standalone);
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
