import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import { startPostgresConveractFabricRetentionWorker } from '../src/agent-runtime/converact/operations/retention/index.js';

class RecordingPg implements PgQueryable {
  calls: string[] = [];
  async query<R>(text: string): Promise<any> {
    this.calls.push(text);
    return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
  }
}

test('retention runtime remains idle when disabled', async () => {
  const pg = new RecordingPg();
  const handle = startPostgresConveractFabricRetentionWorker({
    pg,
    env: { CONVERACT_FABRIC_RETENTION_WORKER_ENABLED: '0' }
  });
  await handle.stop();
  assert.equal(pg.calls.length, 0);
});

test('retention runtime starts a due-policy scan and stops cleanly', async () => {
  const pg = new RecordingPg();
  const handle = startPostgresConveractFabricRetentionWorker({
    pg,
    env: {
      CONVERACT_FABRIC_RETENTION_WORKER_ENABLED: '1',
      CONVERACT_FABRIC_RETENTION_INTERVAL_MS: '60000'
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  await handle.stop();
  assert.equal(pg.calls.some((sql) => /opc_ivekit_retention_tenant_ids/i.test(sql)), true);
});
