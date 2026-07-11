import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import { createIveKitMediaHooks } from '../src/agent-runtime/ivekit/media-hooks.js';
import type { EgressRecord } from '../src/agent-runtime/livekit/types.js';
import { all, createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
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
  const hooks = createIveKitMediaHooks({ db, pg });
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
  const hooks = createIveKitMediaHooks({ db, pg });

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
  const previous = process.env.OPC_RECORDING_RETENTION_DAYS;
  process.env.OPC_RECORDING_RETENTION_DAYS = '0';
  const db = createDatabase(':memory:');
  try {
    assert.throws(
      () => createIveKitMediaHooks({ db, pg: new MemoryPg() }),
      /OPC_RECORDING_RETENTION_DAYS must be an integer between 1 and 3650/
    );
  } finally {
    if (previous === undefined) delete process.env.OPC_RECORDING_RETENTION_DAYS;
    else process.env.OPC_RECORDING_RETENTION_DAYS = previous;
    db.close();
  }
});
