import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { createLiveKitMediaModule } from '../src/agent-runtime/livekit/index.js';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import { routeMediaApi } from '../src/agent-runtime/livekit/media-http.js';
import type {
  RecordingAuditEvent,
  RouteMediaApiOptions
} from '../src/agent-runtime/livekit/media-http.js';
import { LiveKitRecordingService } from '../src/agent-runtime/livekit/recording-service.js';
import {
  markMediaRecordingEvidenceDeleted,
  recordMediaRecordingEvidence
} from '../src/agent-runtime/media-recording-evidence.js';
import { enforceRetentionPolicy } from '../src/agent-runtime/call-center/compliance/retention-policy.js';
import { createDatabase, one, run } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { createServer } from '../src/http.js';
import { createTenant } from '../src/platform/tenant-core.js';

test('recording start persists lifecycle and explicit retention metadata', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Recording retention lifecycle' });
  const media = createLiveKitMediaModule({ db });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'recording-retention-room'
  });
  const retentionUntil = '2027-01-01T00:00:00.000Z';

  const recording = await media.recordings.startRecording(tenant.id, null, room.room_name, {
    format: 'mp4',
    hasVideo: true,
    retentionUntil,
    businessRef: {
      tenant_id: tenant.id,
      type: 'service_order',
      id: 'order-recording-retention'
    }
  });

  assert.equal(recording.status, 'pending');
  assert.equal(recording.retention_until, retentionUntil);
  assert.equal(recording.object_status, 'unchecked');
  assert.equal(recording.failure_code, '');
  assert.match(recording.storage_url, /^s3:\/\/recordings\//);
  db.close();
});

test('recording start can resolve a tenant retention policy without coupling Media Core to call center', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Recording tenant retention policy' });
  const now = new Date('2026-07-10T00:00:00.000Z');
  const service = new LiveKitRecordingService(
    db,
    {
      livekitUrl: '',
      livekitApiKey: '',
      livekitApiSecret: '',
      minioBucket: 'recordings'
    },
    {
      now: () => now,
      resolveRetentionDays: (tenantId) => {
        assert.equal(tenantId, tenant.id);
        return 7;
      }
    }
  );

  const recording = await service.startRecording(tenant.id, null, 'tenant-retention-room', {
    businessRef: {
      tenant_id: tenant.id,
      type: 'service_order',
      id: 'order-tenant-retention'
    }
  });

  assert.equal(recording.retention_until, '2026-07-17T00:00:00.000Z');
  db.close();
});

test('default recording export returns a bounded stream instead of buffering the object', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Streaming recording export' });
  const dir = await mkdtemp(join(tmpdir(), 'opc-recording-stream-'));
  try {
    const path = join(dir, 'recording.webm');
    const body = Buffer.from('streamed-recording-body');
    await writeFile(path, body);
    const service = new LiveKitRecordingService(db);
    const recording = await service.startRecording(tenant.id, null, 'streaming-room', {
      format: 'webm',
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'stream-order' }
    });
    run(db, "UPDATE call_recordings SET storage_url = ?, status = 'completed' WHERE id = ?", [
      pathToFileURL(path).toString(), recording.id
    ]);

    const exported = await service.exportObject(recording.id);
    assert.equal(exported?.content, undefined);
    assert.ok(exported?.stream);
    const chunks: Buffer[] = [];
    for await (const chunk of exported!.stream!) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), body);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recording object inspection and export return content and emit an audit event', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Recording object export' });
  const media = createLiveKitMediaModule({ db });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'recording-object-export-room'
  });
  const recording = await media.recordings.startRecording(tenant.id, null, room.room_name, {
    format: 'mp4',
    hasVideo: true,
    retentionUntil: '2027-01-01T00:00:00.000Z',
    businessRef: {
      tenant_id: tenant.id,
      type: 'service_order',
      id: 'order-recording-export'
    }
  });
  const body = Buffer.from('recording export bytes');
  const checksum = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  const auditEvents: RecordingAuditEvent[] = [];
  const options: RouteMediaApiOptions = {
    resolveRecordingObject: async () => ({
      status: 'readable' as const,
      source: 's3' as const,
      content: body
    }),
    onRecordingAudit: async (event) => {
      auditEvents.push(event);
    }
  };

  const inspection = await routeMediaApi(
    db,
    'GET',
    `/api/media/livekit/recordings/${recording.id}/object`,
    new URL(`http://localhost/api/media/livekit/recordings/${recording.id}/object?tenant_id=${tenant.id}`),
    null,
    '',
    {},
    options
  ) as {
    status: string;
    readable: boolean;
    source: string;
    size_bytes: number;
    checksum: string;
  };

  assert.deepEqual(inspection, {
    status: 'readable',
    readable: true,
    source: 's3',
    size_bytes: body.length,
    checksum
  });
  assert.equal(media.recordings.getRecording(recording.id)?.object_status, 'readable');

  const exported = await routeMediaApi(
    db,
    'GET',
    `/api/media/livekit/recordings/${recording.id}/export`,
    new URL(`http://localhost/api/media/livekit/recordings/${recording.id}/export?tenant_id=${tenant.id}`),
    null,
    '',
    { 'x-actor-id': 'agent-exporter' },
    options
  ) as { contentType: string; data: Buffer; filename: string };

  assert.equal(exported.contentType, 'video/mp4');
  assert.deepEqual(exported.data, body);
  assert.match(exported.filename, new RegExp(`^${recording.id}\\.mp4$`));
  assert.equal(auditEvents.length, 2);
  assert.equal(auditEvents[0]?.action, 'media.recording.object_checked');
  assert.equal(auditEvents[1]?.action, 'media.recording.exported');
  assert.equal(auditEvents[1]?.actor_id, 'agent-exporter');
  assert.equal(auditEvents[1]?.recording_id, recording.id);
  assert.equal(auditEvents[1]?.checksum, checksum);
  db.close();
});

test('recording retention cleanup supports dry-run and idempotent confirmed deletion', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Recording retention cleanup' });
  const media = createLiveKitMediaModule({ db });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'recording-retention-cleanup-room'
  });
  const recording = await media.recordings.startRecording(tenant.id, null, room.room_name, {
    format: 'ogg',
    retentionUntil: '2026-01-01T00:00:00.000Z',
    businessRef: {
      tenant_id: tenant.id,
      type: 'support_ticket',
      id: 'ticket-recording-cleanup'
    }
  });
  run(db, "UPDATE call_recordings SET status = 'completed' WHERE id = ?", [recording.id]);
  let deleteCalls = 0;
  const auditEvents: RecordingAuditEvent[] = [];
  const options: RouteMediaApiOptions = {
    deleteRecordingObject: async () => {
      deleteCalls += 1;
      return { status: 'deleted' as const, source: 's3' as const };
    },
    onRecordingAudit: async (event) => {
      auditEvents.push(event);
    }
  };

  const dryRun = await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/recordings/retention/cleanup',
    new URL('http://localhost/api/media/livekit/recordings/retention/cleanup'),
    {
      tenant_id: tenant.id,
      before: '2026-07-10T00:00:00.000Z',
      dry_run: true
    },
    '',
    {},
    options
  ) as { dry_run: boolean; candidates: number; deleted: number };

  assert.deepEqual(dryRun, { dry_run: true, candidates: 1, deleted: 0, failed: 0, results: [] });
  assert.equal(deleteCalls, 0);

  const cleaned = await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/recordings/retention/cleanup',
    new URL('http://localhost/api/media/livekit/recordings/retention/cleanup'),
    {
      tenant_id: tenant.id,
      before: '2026-07-10T00:00:00.000Z',
      dry_run: false,
      confirm: true
    },
    '',
    { 'x-actor-id': 'retention-worker' },
    options
  ) as { dry_run: boolean; candidates: number; deleted: number; failed: number };

  assert.equal(cleaned.dry_run, false);
  assert.equal(cleaned.candidates, 1);
  assert.equal(cleaned.deleted, 1);
  assert.equal(cleaned.failed, 0);
  assert.equal(deleteCalls, 1);
  assert.equal(media.recordings.getRecording(recording.id)?.status, 'deleted');
  assert.ok(media.recordings.getRecording(recording.id)?.deleted_at);
  assert.equal(auditEvents.at(-1)?.action, 'media.recording.retention_deleted');

  const replay = await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/recordings/retention/cleanup',
    new URL('http://localhost/api/media/livekit/recordings/retention/cleanup'),
    {
      tenant_id: tenant.id,
      before: '2026-07-10T00:00:00.000Z',
      dry_run: false,
      confirm: true
    },
    '',
    {},
    options
  ) as { candidates: number; deleted: number };

  assert.equal(replay.candidates, 0);
  assert.equal(replay.deleted, 0);
  assert.equal(deleteCalls, 1);
  db.close();
});

test('retention cleanup remains retryable when evidence synchronization fails after object deletion', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Recording retention evidence retry' });
  let deleteCalls = 0;
  let lifecycleCalls = 0;
  const service = new LiveKitRecordingService(
    db,
    {
      livekitUrl: '',
      livekitApiKey: '',
      livekitApiSecret: '',
      minioBucket: 'recordings'
    },
    {
      deleteRecordingObject: async () => {
        deleteCalls += 1;
        return deleteCalls === 1
          ? { status: 'deleted' as const, source: 's3' as const }
          : { status: 'not_found' as const, source: 's3' as const };
      }
    }
  );
  const recording = await service.startRecording(tenant.id, null, 'retention-evidence-retry-room', {
    retentionUntil: '2020-01-01T00:00:00.000Z',
    businessRef: {
      tenant_id: tenant.id,
      type: 'service_order',
      id: 'order-retention-evidence-retry'
    }
  });
  run(db, "UPDATE call_recordings SET status = 'completed' WHERE id = ?", [recording.id]);
  const onDeleted = async () => {
    lifecycleCalls += 1;
    if (lifecycleCalls === 1) throw new Error('temporary evidence database failure');
  };

  const first = await service.cleanupExpiredRecordings(tenant.id, {
    before: '2026-07-10T00:00:00.000Z',
    dryRun: false,
    onDeleted
  });
  assert.equal(first.deleted, 0);
  assert.equal(first.failed, 1);
  assert.equal(first.results[0]?.error, 'recording_delete_lifecycle_sync_failed');
  assert.equal(service.getRecording(recording.id)?.status, 'completed');
  assert.equal(
    service.getRecording(recording.id)?.failure_code,
    'recording_delete_lifecycle_sync_failed'
  );

  const replay = await service.cleanupExpiredRecordings(tenant.id, {
    before: '2026-07-10T00:00:00.000Z',
    dryRun: false,
    onDeleted
  });
  assert.equal(replay.deleted, 1);
  assert.equal(replay.failed, 0);
  assert.equal(service.getRecording(recording.id)?.status, 'deleted');
  assert.equal(deleteCalls, 1);
  assert.equal(lifecycleCalls, 2);
  db.close();
});

test('configured egress start failure is persisted and returned as a provider failure', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Recording egress compensation' });
  const service = new LiveKitRecordingService(
    db,
    {
      livekitUrl: 'ws://livekit.example.test:7880',
      livekitApiKey: 'test-key',
      livekitApiSecret: 'test-secret',
      minioBucket: 'recordings'
    },
    {
      createEgressClient: () => ({
        startRoomCompositeEgress: async () => {
          throw new Error('provider unavailable with sensitive details');
        },
        stopEgress: async () => undefined
      })
    }
  );

  let recordingId = '';
  await assert.rejects(
    () => service.startRecording(tenant.id, null, 'egress-failure-room', {
      format: 'mp4',
      hasVideo: true,
      businessRef: {
        tenant_id: tenant.id,
        type: 'service_order',
        id: 'order-egress-failure'
      }
    }),
    (error: unknown) => {
      const typed = error as Error & { status?: number; code?: string; recording_id?: string };
      assert.equal(typed.status, 502);
      assert.equal(typed.code, 'livekit_egress_start_failed');
      recordingId = String(typed.recording_id || '');
      assert.ok(recordingId);
      assert.equal(typed.message.includes('sensitive details'), false);
      return true;
    }
  );

  const failed = service.getRecording(recordingId);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.failure_code, 'livekit_egress_start_failed');
  assert.equal(failed?.egress_id, '');
  db.close();
});

test('egress start is compensated when the provider succeeds but persistence conflicts', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Recording egress persistence compensation' });
  run(
    db,
    `INSERT INTO call_recordings
      (id, tenant_id, business_ref_type, business_ref_id, source, format, storage_url,
       egress_id, status, retention_until)
     VALUES (?, ?, 'service_order', 'existing-order', 'livekit_egress', 'mp4', ?, ?, 'recording', ?)`,
    [
      'crec_existing_egress',
      tenant.id,
      's3://recordings/existing.mp4',
      'EG_duplicate_provider_id',
      '2027-01-01T00:00:00.000Z'
    ]
  );
  const stopped: string[] = [];
  const service = new LiveKitRecordingService(
    db,
    {
      livekitUrl: 'ws://livekit.example.test:7880',
      livekitApiKey: 'test-key',
      livekitApiSecret: 'test-secret',
      minioBucket: 'recordings'
    },
    {
      createEgressClient: () => ({
        startRoomCompositeEgress: async () => ({ egressId: 'EG_duplicate_provider_id' }),
        stopEgress: async (egressId) => {
          stopped.push(egressId);
        }
      })
    }
  );

  let failedRecordingId = '';
  await assert.rejects(
    () => service.startRecording(tenant.id, null, 'egress-persistence-conflict-room', {
      format: 'mp4',
      businessRef: {
        tenant_id: tenant.id,
        type: 'service_order',
        id: 'order-egress-persistence-conflict'
      }
    }),
    (error: unknown) => {
      const typed = error as Error & { code?: string; recording_id?: string };
      assert.equal(typed.code, 'livekit_egress_persistence_failed');
      failedRecordingId = String(typed.recording_id || '');
      return true;
    }
  );

  assert.deepEqual(stopped, ['EG_duplicate_provider_id']);
  assert.equal(service.getRecording(failedRecordingId)?.status, 'failed');
  assert.equal(
    service.getRecording(failedRecordingId)?.failure_code,
    'livekit_egress_persistence_failed'
  );
  db.close();
});

test('duplicate egress_ended webhook updates one row and notifies completion once', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Recording webhook replay' });
  let completionNotifications = 0;
  const media = createLiveKitMediaModule({
    db,
    recordingEvents: {
      notifyRecordingCompleted() {
        completionNotifications += 1;
      }
    }
  });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'recording-webhook-replay-room',
    metadata: {
      business_ref: {
        type: 'service_order',
        id: 'order-webhook-replay'
      }
    }
  });
  const payload = JSON.stringify({
    event: 'egress_ended',
    room: { name: room.room_name },
    egressInfo: {
      egressId: 'EG_webhook_replay',
      fileResults: [{
        fileType: 'mp4',
        location: 's3://recordings/order-webhook-replay.mp4',
        duration: 5000,
        size: 4096
      }]
    }
  });

  const first = await media.webhooks.handleWebhook(payload);
  const replay = await media.webhooks.handleWebhook(payload);

  assert.equal(first.recording?.id, replay.recording?.id);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.recording?.status, 'completed');
  assert.ok(replay.recording?.completed_at);
  assert.equal(media.recordings.listRecordings(tenant.id).length, 1);
  assert.equal(completionNotifications, 1);
  db.close();
});

test('recording evidence inherits the recording retention deadline', async () => {
  const pg = new MemoryPg();
  const retentionUntil = '2027-06-01T00:00:00.000Z';
  const evidence = await recordMediaRecordingEvidence(pg, {
    id: 'crec_retention_evidence',
    tenant_id: 'tenant_retention_evidence',
    call_session_id: '',
    business_ref_type: 'service_order',
    business_ref_id: 'order-retention-evidence',
    business_ref: {
      tenant_id: 'tenant_retention_evidence',
      type: 'service_order',
      id: 'order-retention-evidence'
    },
    source: 'livekit_egress',
    format: 'mp4',
    storage_url: 's3://recordings/order-retention-evidence.mp4',
    duration_ms: 1000,
    file_size_bytes: 1024,
    has_video: 1,
    egress_id: 'EG_retention_evidence',
    status: 'completed',
    retention_until: retentionUntil,
    object_status: 'readable',
    object_checked_at: '2026-07-10T00:00:00.000Z',
    failure_code: '',
    completed_at: '2026-07-10T00:00:00.000Z',
    deleted_at: null,
    updated_at: '2026-07-10T00:00:00.000Z',
    created_at: '2026-07-10T00:00:00.000Z'
  });

  assert.equal(evidence?.retention_until, retentionUntil);
  assert.equal(evidence?.metadata.retention_until, retentionUntil);
});

test('recording evidence preserves its digest and records object deletion metadata', async () => {
  const pg = new MemoryPg();
  const recording = {
    id: 'crec_deleted_evidence',
    tenant_id: 'tenant_deleted_evidence',
    call_session_id: '',
    business_ref_type: 'service_order',
    business_ref_id: 'order-deleted-evidence',
    business_ref: {
      tenant_id: 'tenant_deleted_evidence',
      type: 'service_order',
      id: 'order-deleted-evidence'
    },
    source: 'livekit_egress' as const,
    format: 'mp4' as const,
    storage_url: 's3://recordings/order-deleted-evidence.mp4',
    duration_ms: 1000,
    file_size_bytes: 2048,
    has_video: 1,
    egress_id: 'EG_deleted_evidence',
    status: 'deleted' as const,
    retention_until: '2026-07-01T00:00:00.000Z',
    object_status: 'deleted' as const,
    object_checked_at: '2026-07-10T00:00:00.000Z',
    failure_code: '',
    completed_at: '2026-06-01T00:00:00.000Z',
    deleted_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
    created_at: '2026-06-01T00:00:00.000Z'
  };
  const initial = await recordMediaRecordingEvidence(pg, recording, {
    checksum: 'sha256:preserved-recording-digest'
  });

  const updated = await markMediaRecordingEvidenceDeleted(pg, recording, {
    deletedBy: 'retention-worker',
    deletionSource: 's3'
  });

  assert.equal(updated?.id, initial?.id);
  assert.equal(updated?.checksum, 'sha256:preserved-recording-digest');
  assert.equal(updated?.storage_url, recording.storage_url);
  assert.equal(updated?.metadata.object_status, 'deleted');
  assert.equal(updated?.metadata.deleted_by, 'retention-worker');
  assert.equal(updated?.metadata.deletion_source, 's3');
  assert.equal(updated?.metadata.deleted_at, recording.deleted_at);
});

test('recording lifecycle migration adds retention, state, and egress idempotency contracts', () => {
  const migration = readFileSync('src/migrations/026_media_recording_lifecycle.sql', 'utf8');

  assert.match(migration, /retention_until/i);
  assert.match(migration, /object_status/i);
  assert.match(migration, /failure_code/i);
  assert.match(migration, /deleted_at/i);
  assert.match(migration, /CREATE UNIQUE INDEX[\s\S]+egress_id/i);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
});

test('confirmed retention cleanup rejects requests without explicit confirmation', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Recording retention confirmation' });

  await assert.rejects(
    () => routeMediaApi(
      db,
      'POST',
      '/api/media/livekit/recordings/retention/cleanup',
      new URL('http://localhost/api/media/livekit/recordings/retention/cleanup'),
      {
        tenant_id: tenant.id,
        dry_run: false
      },
      '',
      {},
      {}
    ),
    (error: unknown) => {
      assert.equal((error as Error & { status?: number }).status, 400);
      assert.match((error as Error).message, /confirm/i);
      return true;
    }
  );

  assert.equal(one(db, 'SELECT COUNT(*) AS count FROM call_recordings')?.count, 0);
  db.close();
});

test('compliance retention discovers recording cleanup candidates without deleting evidence rows', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Recording compliance retention bridge' });
  const media = createLiveKitMediaModule({ db });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'recording-compliance-retention-room'
  });
  const recording = await media.recordings.startRecording(tenant.id, null, room.room_name, {
    retentionUntil: '2020-01-01T00:00:00.000Z',
    businessRef: {
      tenant_id: tenant.id,
      type: 'service_order',
      id: 'order-compliance-retention'
    }
  });
  run(db, "UPDATE call_recordings SET status = 'completed' WHERE id = ?", [recording.id]);

  const result = enforceRetentionPolicy(db, tenant.id, 'compliance-admin');

  assert.equal(result.recordings_deleted, 0);
  assert.equal(result.recording_cleanup_candidates, 1);
  assert.equal(media.recordings.getRecording(recording.id)?.id, recording.id);
  db.close();
});

test('iveKit HTTP export streams bytes with download headers and persists an audit log', async () => {
  const previousApiKey = process.env.CONVERACT_API_KEY;
  process.env.CONVERACT_API_KEY = 'recording-export-api-key';
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'iveKit recording export HTTP' });
  const media = createLiveKitMediaModule({ db });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'ivekit-recording-export-http-room'
  });
  const recording = await media.recordings.startRecording(tenant.id, null, room.room_name, {
    format: 'mp4',
    hasVideo: true,
    businessRef: {
      tenant_id: tenant.id,
      type: 'service_order',
      id: 'order-ivekit-export-http'
    }
  });
  const dir = await mkdtemp(join(tmpdir(), 'opc-recording-export-http-'));
  const filePath = join(dir, 'recording.mp4');
  const content = Buffer.from('ivekit recording export http bytes');
  await writeFile(filePath, content);
  run(
    db,
    "UPDATE call_recordings SET storage_url = ?, status = 'completed' WHERE id = ?",
    [pathToFileURL(filePath).toString(), recording.id]
  );
  const server = createServer(db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/ivekit/media/recordings/${recording.id}/export`,
      {
        headers: {
          'x-api-key': 'recording-export-api-key',
          'x-tenant-id': tenant.id
        }
      }
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(
      response.headers.get('content-disposition'),
      `attachment; filename="${recording.id}.mp4"`
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);

    const audit = one(
      db,
      "SELECT * FROM audit_logs WHERE tenant_id = ? AND action = 'media.recording.exported' ORDER BY created_at DESC LIMIT 1",
      [tenant.id]
    );
    assert.equal(audit?.object_type, 'media_recording');
    assert.equal(audit?.object_id, recording.id);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    db.close();
    if (previousApiKey === undefined) delete process.env.CONVERACT_API_KEY;
    else process.env.CONVERACT_API_KEY = previousApiKey;
  }
});

test('iveKit HTTP retention cleanup deletes the object and reconciles PostgreSQL evidence', async () => {
  const previousApiKey = process.env.CONVERACT_API_KEY;
  process.env.CONVERACT_API_KEY = 'recording-cleanup-api-key';
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'iveKit recording cleanup HTTP' });
  const media = createLiveKitMediaModule({ db });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'ivekit-recording-cleanup-http-room'
  });
  const recording = await media.recordings.startRecording(tenant.id, null, room.room_name, {
    format: 'ogg',
    retentionUntil: '2020-01-01T00:00:00.000Z',
    businessRef: {
      tenant_id: tenant.id,
      type: 'service_order',
      id: 'order-ivekit-cleanup-http'
    }
  });
  const dir = await mkdtemp(join(tmpdir(), 'opc-recording-cleanup-http-'));
  const filePath = join(dir, 'recording.ogg');
  await writeFile(filePath, 'ivekit recording cleanup bytes');
  run(
    db,
    "UPDATE call_recordings SET storage_url = ?, status = 'completed' WHERE id = ?",
    [pathToFileURL(filePath).toString(), recording.id]
  );
  const completed = media.recordings.getRecording(recording.id)!;
  const evidence = await recordMediaRecordingEvidence(pg, completed, {
    checksum: 'sha256:cleanup-evidence-digest'
  });
  const server = createServer(db, pg);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/ivekit/media/recordings/retention/cleanup`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'recording-cleanup-api-key',
          'x-tenant-id': tenant.id
        },
        body: JSON.stringify({ dry_run: false, confirm: true })
      }
    );
    assert.equal(response.status, 200);
    const payload = await response.json() as { deleted: number; failed: number };
    assert.equal(payload.deleted, 1);
    assert.equal(payload.failed, 0);
    await assert.rejects(() => access(filePath), /ENOENT/);
    assert.equal(media.recordings.getRecording(recording.id)?.status, 'deleted');

    const listed = await createCollaborationModule({ pg }).remote.listEvidenceBySession({
      tenant_id: tenant.id,
      session_id: recording.id
    });
    assert.equal(listed[0]?.id, evidence?.id);
    assert.equal(listed[0]?.checksum, 'sha256:cleanup-evidence-digest');
    assert.equal(listed[0]?.metadata.object_status, 'deleted');
    assert.equal(listed[0]?.metadata.deleted_by, 'system');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    db.close();
    if (previousApiKey === undefined) delete process.env.CONVERACT_API_KEY;
    else process.env.CONVERACT_API_KEY = previousApiKey;
  }
});
