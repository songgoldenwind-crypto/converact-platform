import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import {
  iveKitRuntimeComponents,
  startIveKitRuntimeHeartbeat
} from '../src/agent-runtime/converact/operations/runtime-heartbeat.js';

class RecordingPg implements PgQueryable {
  calls: Array<{ text: string; params: unknown[] }> = [];
  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    return { rows: [] as R[], rowCount: 0, command: '', oid: 0, fields: [] };
  }
}

test('runtime heartbeat publishes bounded components and terminal shutdown state', async () => {
  const pg = new RecordingPg();
  let tick = 0;
  const handle = startIveKitRuntimeHeartbeat({
    pg, instance_id: 'ivekit-a', components: ['api', 'retention_worker', 'api'],
    env: { CONVERACT_FABRIC_RUNTIME_HEARTBEAT_ENABLED: '1' },
    now: () => new Date(1784102400000 + tick++ * 1000)
  });
  await handle.ready;
  await handle.stop();
  assert.equal(pg.calls.length, 4);
  assert.deepEqual(JSON.parse(String(pg.calls[0]!.params[3])), ['api', 'retention_worker']);
  assert.deepEqual(pg.calls.map((call) => call.params[2]), [
    'starting', 'running', 'draining', 'stopped'
  ]);
  assert.equal(JSON.stringify(pg.calls).includes('secret'), false);
});

test('runtime component inventory reflects only enabled worker groups', () => {
  assert.deepEqual(iveKitRuntimeComponents({
    CONVERACT_FABRIC_RETENTION_WORKER_ENABLED: '1',
    CONVERACT_FABRIC_VOICE_WORKERS_ENABLED: 'true',
    CONVERACT_QUALITY_REVIEW_WORKER_ENABLED: '0'
  }), ['api', 'retention_worker', 'voice_workers']);
});
