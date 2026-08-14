import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createConveractFabricHttpServer } from '../src/agent-runtime/converact/http-server.js';
import type { ConveractFabricReadinessResult } from '../src/agent-runtime/converact/operations/readiness.js';
import { listenOnRandomPort } from './test-helpers.js';

const states = readinessStates();

test('Rust runtime health fixture replays the active TypeScript HTTP contract', async (t) => {
  const fixture = JSON.parse(readFileSync(
    new URL('../server-rs/tests/fixtures/runtime-health-v1.json', import.meta.url),
    'utf8'
  )) as {
    sources: string[];
    request_id: string;
    cases: Array<{
      name: string;
      path: '/livez' | '/readyz' | '/health';
      state: keyof typeof states | null;
      status: number;
      body_bytes: string;
      probe_count_delta: number;
      headers: Record<string, string>;
    }>;
  };
  assert.deepEqual(fixture.sources, [
    'src/agent-runtime/converact/http-server.ts',
    'src/agent-runtime/converact/operations/readiness.ts'
  ]);

  let current = states.ready;
  let probes = 0;
  const server = createConveractFabricHttpServer({
    db: {},
    pg: null,
    readinessProbe: {
      async probe() {
        probes += 1;
        return current;
      }
    }
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  const port = await listenOnRandomPort(server);

  for (const vector of fixture.cases) {
    if (vector.state) current = states[vector.state];
    const before = probes;
    const response = await fetch(`http://127.0.0.1:${port}${vector.path}`, {
      headers: { 'x-request-id': fixture.request_id }
    });
    assert.equal(response.status, vector.status, vector.name);
    assert.equal(await response.text(), vector.body_bytes, `${vector.name}: body`);
    assert.equal(probes - before, vector.probe_count_delta, `${vector.name}: probes`);
    for (const [name, value] of Object.entries(vector.headers)) {
      assert.equal(response.headers.get(name), value, `${vector.name}: ${name}`);
    }
  }
});

function readinessStates(): Record<string, ConveractFabricReadinessResult> & {
  ready: ConveractFabricReadinessResult;
} {
  const checks = (
    overrides: Partial<ConveractFabricReadinessResult['checks']> = {}
  ): ConveractFabricReadinessResult['checks'] => ({
    database: { status: 'ok' },
    migrations: { status: 'ok', missing: [] },
    configuration: { status: 'ok', missing_or_invalid: [] },
    notification_providers: {
      status: 'not_configured', active: 0, unhealthy: 0, blocking: false
    },
    runtime_heartbeat: { status: 'disabled', instance_id: '' },
    placement_snapshot: { status: 'disabled', snapshot_version: 0, error_code: '' },
    ...overrides
  });
  return {
    ready: { status: 'ready', checks: checks() },
    database_failed: {
      status: 'not_ready',
      checks: checks({
        database: { status: 'failed' },
        migrations: {
          status: 'failed', missing: ['116_converact_sip_capability_recovery_fence']
        },
        notification_providers: {
          status: 'unknown', active: 0, unhealthy: 0, blocking: false
        }
      })
    },
    heartbeat_stale: {
      status: 'not_ready',
      checks: checks({ runtime_heartbeat: { status: 'stale', instance_id: 'node-a' } })
    },
    heartbeat_draining: {
      status: 'not_ready',
      checks: checks({ runtime_heartbeat: { status: 'draining', instance_id: 'node-a' } })
    },
    placement_failed: {
      status: 'not_ready',
      checks: checks({
        placement_snapshot: {
          status: 'failed', snapshot_version: 0,
          error_code: 'placement_snapshot_unavailable'
        }
      })
    },
    notification_blocking_unknown: {
      status: 'not_ready',
      checks: checks({
        notification_providers: {
          status: 'unknown', active: 0, unhealthy: 0, blocking: true
        }
      })
    }
  };
}
