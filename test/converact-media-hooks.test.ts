import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import { createConveractFabricMediaHooks } from '../src/agent-runtime/converact/media-hooks.js';
import type { EgressRecord } from '../src/agent-runtime/livekit/types.js';
import { all, createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import type { PgQueryable } from '../src/db-pg.js';
import { createTenant } from '../src/platform/tenant-core.js';

function recording(tenantId: string): EgressRecord {
  return {
    id: 'recording-standalone-hooks',
    tenant_id: tenantId,
    call_session_id: '',
    business_ref_type: 'service_order',
    business_ref_id: 'order-standalone-hooks',
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order-standalone-hooks'
    },
    source: 'livekit_egress',
    format: 'mp4',
    storage_url: 's3://recordings/order-standalone-hooks.mp4',
    duration_ms: null,
    file_size_bytes: null,
    has_video: 1,
    egress_id: 'egress-standalone-hooks',
    status: 'pending',
    retention_until: '2027-07-11T00:00:00.000Z',
    object_status: 'unchecked',
    object_checked_at: null,
    failure_code: '',
    completed_at: null,
    deleted_at: null,
    updated_at: '2026-07-11T00:00:00.000Z',
    created_at: '2026-07-11T00:00:00.000Z'
  };
}

test('standalone media hooks create and delete recording evidence', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenantId = createTenant(db, { name: 'Standalone Media Hooks' }).id;
  const hooks = createConveractFabricMediaHooks({ db, pg });
  const source = recording(tenantId);

  const evidence = await hooks.onRecordingStarted?.(source, { roomName: 'room-standalone-hooks' });
  assert.ok(evidence && typeof evidence === 'object');
  const listed = await createCollaborationModule({ pg }).remote.listEvidence({
    tenant_id: tenantId,
    business_ref: source.business_ref
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.metadata.room_name, 'room-standalone-hooks');

  await hooks.onRecordingDeleted?.(
    { ...source, status: 'deleted', object_status: 'deleted', deleted_at: '2026-07-11T01:00:00.000Z' },
    { actorId: 'retention-worker', source: 'retention_cleanup' }
  );
  const deleted = await createCollaborationModule({ pg }).remote.listEvidenceBySession({
    tenant_id: tenantId,
    session_id: source.id
  });
  assert.equal(deleted[0]?.metadata.object_status, 'deleted');
  assert.equal(deleted[0]?.metadata.deleted_by, 'retention-worker');
  db.close();
});

test('standalone media hooks write tenant-scoped recording audit', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenantId = createTenant(db, { name: 'Standalone Media Audit' }).id;
  const hooks = createConveractFabricMediaHooks({ db, pg });

  await hooks.onRecordingAudit?.({
    tenant_id: tenantId,
    actor_id: 'engineer-1',
    action: 'media.recording.exported',
    recording_id: 'recording-audit-1',
    business_ref_type: 'service_order',
    business_ref_id: 'order-audit-1',
    status: 'completed',
    source: 's3',
    size_bytes: 1024,
    checksum: 'sha256:abc'
  });

  const rows = all(db, 'SELECT * FROM audit_logs WHERE tenant_id = ?', [tenantId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.actor_id, 'engineer-1');
  assert.equal(rows[0]?.action, 'media.recording.exported');
  assert.equal(rows[0]?.object_type, 'media_recording');
  assert.equal(rows[0]?.object_id, 'recording-audit-1');
  assert.match(String(rows[0]?.metadata), /order-audit-1/);
  db.close();
});

test('standalone media hooks reject invalid retention configuration', () => {
  const previous = process.env.CONVERACT_RECORDING_RETENTION_DAYS;
  process.env.CONVERACT_RECORDING_RETENTION_DAYS = '0';
  const db = createDatabase(':memory:');
  try {
    assert.throws(
      () => createConveractFabricMediaHooks({ db, pg: new MemoryPg() }),
      /CONVERACT_RECORDING_RETENTION_DAYS must be an integer between 1 and 3650/
    );
  } finally {
    if (previous === undefined) delete process.env.CONVERACT_RECORDING_RETENTION_DAYS;
    else process.env.CONVERACT_RECORDING_RETENTION_DAYS = previous;
    db.close();
  }
});

test('standalone media hooks enter the recording tenant PostgreSQL transaction', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const pg = {
    async query() {
      throw new Error('unscoped pool query must not be used');
    },
    async connect() {
      return client;
    }
  } as unknown as PgQueryable;
  const source = {
    ...recording('tenant-recording-hook'),
    business_ref_type: '',
    business_ref_id: '',
    business_ref: null
  } as EgressRecord;
  const hooks = createConveractFabricMediaHooks({ db: {}, pg });

  await hooks.onRecordingCompleted?.(source, { roomName: 'room-recording-hook' });

  const tenantQuery = queries.find((entry) => entry.sql.includes("set_config('app.current_tenant'"));
  assert.deepEqual(tenantQuery?.params, ['tenant-recording-hook']);
  assert.equal(queries[0]?.sql, 'BEGIN');
  assert.equal(queries.at(-1)?.sql, 'COMMIT');
});

test('recording deletion removes realtime speech projections in the recording tenant transaction', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const pg = {
    async query() {
      throw new Error('unscoped pool query must not be used');
    },
    async connect() {
      return client;
    }
  } as unknown as PgQueryable;
  const tenantId = 'tenant-recording-deletion';
  const interactionId = 'call-recording-deletion';
  const hooks = createConveractFabricMediaHooks({ db: {}, pg });

  await hooks.onRecordingDeleted?.(
    {
      ...recording(tenantId),
      media_call_id: interactionId,
      status: 'deleted',
      object_status: 'deleted',
      deleted_at: '2026-07-23T02:00:00.000Z'
    },
    { actorId: 'retention-worker', source: 'retention_cleanup' }
  );

  const tenantQuery = queries.find((entry) => entry.sql.includes("set_config('app.current_tenant'"));
  const projectionDelete = queries.find((entry) =>
    /DELETE FROM ivekit_realtime_speech_segments/i.test(entry.sql)
  );
  assert.deepEqual(tenantQuery?.params, [tenantId]);
  assert.deepEqual(projectionDelete?.params, [tenantId, interactionId]);
  assert.equal(queries[0]?.sql, 'BEGIN');
  assert.equal(queries.at(-1)?.sql, 'COMMIT');
});
