import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import {
  createConveractFabricReadinessProbe,
  REQUIRED_MIGRATIONS
} from '../src/agent-runtime/converact/operations/readiness.js';

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
  CONVERACT_FABRIC_AUDIT_IP_HMAC_KEY: Buffer.alloc(32, 1).toString('base64'),
  CONVERACT_FABRIC_RATE_LIMIT_HMAC_KEY: Buffer.alloc(32, 2).toString('base64')
};

test('readiness requires the latest communication correctness migrations', () => {
  assert.equal(REQUIRED_MIGRATIONS.includes('095_rustdesk_authorization_claims'), true);
  assert.equal(REQUIRED_MIGRATIONS.includes('104_ivekit_cell_admission_ledger_runtime'), true);
  assert.equal(REQUIRED_MIGRATIONS.includes('105_tinode_closed_session_inbound'), true);
  assert.equal(REQUIRED_MIGRATIONS.includes('107_ivekit_sip_effect_oracle'), true);
  assert.equal(REQUIRED_MIGRATIONS.includes('108_converact_platform_identity_consent'), true);
  assert.equal(REQUIRED_MIGRATIONS.includes('109_converact_platform_event_receipts'), true);
  assert.equal(REQUIRED_MIGRATIONS.includes('110_converact_platform_usage_ledger'), true);
  assert.equal(REQUIRED_MIGRATIONS.at(-1), '112_converact_platform_history_receipt_integrity');
});

test('readiness executes SQL, verifies migrations, and reports nonblocking provider degradation', async () => {
  const pg = new ReadyPg();
  const result = await createConveractFabricReadinessProbe({ pg, env: validEnv }).probe();
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
  assert.equal(REQUIRED_MIGRATIONS.at(-1), '112_converact_platform_history_receipt_integrity');
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
    new URL('../services/converact-service/migrations/090_ivekit_runtime_security.sql', import.meta.url),
    'utf8'
  );
  assert.equal(root, standalone);
});

test('readiness fails closed for missing database, migrations, or security keys', async () => {
  const missingDatabase = await createConveractFabricReadinessProbe({ pg: null, env: validEnv }).probe();
  assert.equal(missingDatabase.status, 'not_ready');
  assert.equal(missingDatabase.checks.database.status, 'failed');

  const invalidConfig = await createConveractFabricReadinessProbe({ pg: new ReadyPg(), env: {} }).probe();
  assert.equal(invalidConfig.status, 'not_ready');
  assert.deepEqual(invalidConfig.checks.configuration.missing_or_invalid, [
    'CONVERACT_FABRIC_AUDIT_IP_HMAC_KEY', 'CONVERACT_FABRIC_RATE_LIMIT_HMAC_KEY'
  ]);
});

test('readiness fails closed when placement is enabled without a valid signed snapshot', async () => {
  const env = { ...validEnv, CONVERACT_FABRIC_PLACEMENT_ENABLED: '1' };
  const missing = await createConveractFabricReadinessProbe({
    pg: new ReadyPg(),
    env
  }).probe();
  assert.equal(missing.status, 'not_ready');
  assert.deepEqual(missing.checks.placement_snapshot, {
    status: 'missing',
    snapshot_version: 0,
    error_code: 'placement_probe_missing'
  });

  const failed = await createConveractFabricReadinessProbe({
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
  const result = await createConveractFabricReadinessProbe({
    pg: new ReadyPg(),
    env: { ...validEnv, CONVERACT_FABRIC_PLACEMENT_ENABLED: '1' },
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

test('readiness starts independent probes concurrently after the bounded database gate', async () => {
  const pending = new Map<string, (value: any) => void>();
  let placementResolve: ((value: any) => void) | null = null;
  const pg: PgQueryable = {
    async query<R>(text: string): Promise<any> {
      if (/SELECT 1 AS ready/i.test(text)) return { rows: [{ ready: 1 }] as R[] };
      return new Promise((resolve) => pending.set(text, resolve));
    }
  };
  const probe = createConveractFabricReadinessProbe({
    pg,
    env: {
      ...validEnv,
      CONVERACT_FABRIC_PLACEMENT_ENABLED: '1',
      CONVERACT_FABRIC_RUNTIME_HEARTBEAT_ENABLED: '1'
    },
    instanceId: 'node-a',
    probeTimeoutMs: 5_000,
    placementProbe: {
      probe: () => new Promise((resolve) => { placementResolve = resolve; })
    }
  });
  const resultPromise = probe.probe();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pending.size, 3, 'migration, provider, and heartbeat probes must be in flight together');
  assert.notEqual(placementResolve, null, 'placement probe must share the same bounded wave');
  for (const [sql, resolve] of pending) {
    if (/migration_versions/i.test(sql)) {
      resolve({ rows: REQUIRED_MIGRATIONS.map((version) => ({ version })) });
    } else if (/notification_endpoints/i.test(sql)) {
      resolve({ rows: [{ active: '1', unhealthy: '0' }] });
    } else {
      resolve({ rows: [{ state: 'running', heartbeat_at: new Date().toISOString() }] });
    }
  }
  placementResolve!({
    snapshot_version: 7,
    generated_at: '2026-08-01T12:00:00.000Z',
    expires_at: '2026-08-01T12:01:00.000Z'
  });
  assert.equal((await resultPromise).status, 'ready');
});

test('readiness returns not_ready when a driver never settles before the injected overall deadline', async () => {
  const pg: PgQueryable = {
    query: async () => new Promise(() => undefined)
  };
  const result = await Promise.race([
    createConveractFabricReadinessProbe({
      pg,
      env: validEnv,
      probeTimeoutMs: 100,
      scheduler: {
        now: () => 0,
        setTimeout(callback) {
          queueMicrotask(callback);
          return 1;
        },
        clearTimeout() {}
      }
    }).probe(),
    new Promise<'external_timeout'>((resolve) => setTimeout(() => resolve('external_timeout'), 100))
  ]);
  if (result === 'external_timeout') assert.fail('readiness probe exceeded its own deadline');
  assert.equal(result.status, 'not_ready');
  assert.equal(result.checks.database.status, 'failed');
});
