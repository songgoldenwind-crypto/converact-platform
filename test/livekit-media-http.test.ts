import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createLiveKitMediaModule } from '../src/agent-runtime/livekit/index.js';
import { routeMediaApi } from '../src/agent-runtime/livekit/media-http.js';
import { recordMediaRecordingEvidence } from '../src/agent-runtime/media-recording-evidence.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { getPgTenantContext } from '../src/db-pg-tenant.js';
import { createTenant } from '../src/platform/tenant-core.js';

function signInviteForTest(input: {
  secret: string;
  tenantId: string;
  roomName: string;
  role: 'customer';
  media: 'voice' | 'video';
  expiresAt: string;
}): string {
  return createHmac('sha256', input.secret)
    .update([input.tenantId, input.roomName, input.role, input.media, input.expiresAt].join('\n'))
    .digest('base64url');
}

test('media HTTP router exposes LiveKit room, token, webhook, and participant endpoints', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Media HTTP' });
  const room = await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/rooms',
    new URL('http://localhost/api/media/livekit/rooms'),
    {
      tenant_id: tenant.id,
      purpose: 'video_service',
      room_name: 'tenant-media-http-room'
    },
    '',
    {}
  );

  assert.equal((room as { room_name: string }).room_name, 'tenant-media-http-room');

  const token = await routeMediaApi(
    db,
    'GET',
    '/api/media/livekit/token',
    new URL(`http://localhost/api/media/livekit/token?room_name=tenant-media-http-room&identity=customer_http&role=customer&tenant_id=${tenant.id}`),
    null,
    '',
    {}
  );

  assert.match((token as { token: string }).token, /^dev-token:/);

  const joinPlan = await routeMediaApi(
    db,
    'GET',
    '/api/media/livekit/join',
    new URL(`http://localhost/api/media/livekit/join?channel=webrtc&room_name=tenant-media-http-room&identity=customer_http&role=customer&tenant_id=${tenant.id}&media=video`),
    null,
    '',
    {}
  );

  assert.equal((joinPlan as { mode: string }).mode, 'webrtc');
  assert.equal((joinPlan as { joinPath: string }).joinPath, `/video?room=tenant-media-http-room&tenant_id=${tenant.id}`);

  const webhook = await routeMediaApi(
    db,
    'POST',
    '/api/media/webhooks/livekit',
    new URL('http://localhost/api/media/webhooks/livekit'),
    null,
    JSON.stringify({
      event: 'participant_joined',
      room: { name: 'tenant-media-http-room' },
      participant: { identity: 'customer_http', metadata: JSON.stringify({ role: 'customer' }) }
    }),
    {}
  );

  assert.equal((webhook as { ok: boolean }).ok, true);

  const participants = await routeMediaApi(
    db,
    'GET',
    '/api/media/livekit/rooms/tenant-media-http-room/participants',
    new URL(`http://localhost/api/media/livekit/rooms/tenant-media-http-room/participants?tenant_id=${tenant.id}`),
    null,
    '',
    {}
  );

  assert.equal(Array.isArray(participants), true);
  assert.equal((participants as Array<{ identity: string; status: string }>)[0]?.identity, 'customer_http');
  assert.equal((participants as Array<{ identity: string; status: string }>)[0]?.status, 'joined');
  db.close();
});

test('media HTTP router exposes LiveKit recording start stop and list endpoints', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Media Recording HTTP' });
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    status: 'active',
    phone: '+81300006666'
  });
  await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/rooms',
    new URL('http://localhost/api/media/livekit/rooms'),
    {
      tenant_id: tenant.id,
      purpose: 'video_service',
      room_name: 'tenant-media-recording-room'
    },
    '',
    {}
  );

  const started = await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/recordings/start',
    new URL('http://localhost/api/media/livekit/recordings/start'),
    {
      tenant_id: tenant.id,
      call_session_id: session.id,
      room_name: 'tenant-media-recording-room',
      format: 'mp4',
      has_video: true
    },
    '',
    {}
  );

  assert.equal((started as { tenant_id: string }).tenant_id, tenant.id);
  assert.equal((started as { format: string }).format, 'mp4');
  assert.equal((started as { has_video: number }).has_video, 1);

  const listed = await routeMediaApi(
    db,
    'GET',
    '/api/media/livekit/recordings',
    new URL(`http://localhost/api/media/livekit/recordings?tenant_id=${tenant.id}`),
    null,
    '',
    {}
  );
  assert.equal(Array.isArray(listed), true);
  assert.equal((listed as Array<{ id: string }>).length, 1);

  const fetched = await routeMediaApi(
    db,
    'GET',
    `/api/media/livekit/recordings/${encodeURIComponent((started as { id: string }).id)}`,
    new URL(`http://localhost/api/media/livekit/recordings/${encodeURIComponent((started as { id: string }).id)}?tenant_id=${tenant.id}`),
    null,
    '',
    {}
  );
  assert.equal((fetched as { id: string }).id, (started as { id: string }).id);

  const stopped = await routeMediaApi(
    db,
    'POST',
    `/api/media/livekit/recordings/${encodeURIComponent((started as { egress_id: string }).egress_id)}/stop`,
    new URL(`http://localhost/api/media/livekit/recordings/${encodeURIComponent((started as { egress_id: string }).egress_id)}/stop?tenant_id=${tenant.id}`),
    null,
    '',
    {}
  );
  assert.equal((stopped as { id: string }).id, (started as { id: string }).id);
  db.close();
});

test('media HTTP router starts recordings for non-call-center business refs', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Media BusinessRef HTTP' });
  await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/rooms',
    new URL('http://localhost/api/media/livekit/rooms'),
    {
      tenant_id: tenant.id,
      purpose: 'video_service',
      room_name: 'tenant-media-business-ref-room',
      metadata: {
        business_ref: {
          type: 'service_order',
          id: 'order-http-video'
        }
      }
    },
    '',
    {}
  );

  const started = await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/recordings/start',
    new URL('http://localhost/api/media/livekit/recordings/start'),
    {
      tenant_id: tenant.id,
      room_name: 'tenant-media-business-ref-room',
      business_ref: {
        type: 'service_order',
        id: 'order-http-video',
        display_name: 'LED order HTTP',
        metadata: { project: 'led' }
      },
      format: 'webm',
      has_video: true
    },
    '',
    {}
  ) as {
    call_session_id: string;
    business_ref: { tenant_id: string; type: string; id: string; display_name: string; metadata: Record<string, unknown> };
    storage_url: string;
  };

  assert.equal(started.call_session_id, '');
  assert.equal(started.business_ref.tenant_id, tenant.id);
  assert.equal(started.business_ref.type, 'service_order');
  assert.equal(started.business_ref.id, 'order-http-video');
  assert.equal(started.business_ref.display_name, 'LED order HTTP');
  assert.deepEqual(started.business_ref.metadata, { project: 'led' });
  assert.match(started.storage_url, /service_order\/order-http-video/);

  const listed = await routeMediaApi(
    db,
    'GET',
    '/api/media/livekit/recordings',
    new URL(`http://localhost/api/media/livekit/recordings?tenant_id=${tenant.id}`),
    null,
    '',
    {}
  ) as Array<{ business_ref: { id: string } }>;
  assert.equal(listed[0]?.business_ref?.id, 'order-http-video');
  db.close();
});

test('media HTTP router can attach a recording evidence result', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Media Evidence Callback' });
  await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/rooms',
    new URL('http://localhost/api/media/livekit/rooms'),
    {
      tenant_id: tenant.id,
      purpose: 'video_service',
      room_name: 'tenant-media-evidence-callback-room'
    },
    '',
    {}
  );

  const started = await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/recordings/start',
    new URL('http://localhost/api/media/livekit/recordings/start'),
    {
      tenant_id: tenant.id,
      room_name: 'tenant-media-evidence-callback-room',
      business_ref: { type: 'service_order', id: 'order-evidence-callback' },
      format: 'mp4',
      has_video: true
    },
    '',
    {},
    {
      onRecordingStarted: async (recording) => ({
        id: `evidence-${recording.id}`,
        kind: recording.has_video ? 'video_recording' : 'audio_recording'
      })
    }
  ) as { id: string; evidence_record_id: string; evidence_record: { id: string; kind: string } };

  assert.equal(started.evidence_record_id, `evidence-${started.id}`);
  assert.deepEqual(started.evidence_record, {
    id: `evidence-${started.id}`,
    kind: 'video_recording'
  });
  db.close();
});

test('media HTTP webhook can attach evidence for completed egress recordings', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Media Webhook Evidence' });
  await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/rooms',
    new URL('http://localhost/api/media/livekit/rooms'),
    {
      tenant_id: tenant.id,
      purpose: 'video_service',
      room_name: 'tenant-media-webhook-evidence-room',
      metadata: {
        business_ref: {
          type: 'service_order',
          id: 'order-webhook-evidence'
        }
      }
    },
    '',
    {}
  );

  const result = await routeMediaApi(
    db,
    'POST',
    '/api/media/webhooks/livekit',
    new URL('http://localhost/api/media/webhooks/livekit'),
    null,
    JSON.stringify({
      event: 'egress_ended',
      room: { name: 'tenant-media-webhook-evidence-room' },
      egressInfo: {
        egressId: 'egress-http-webhook-evidence',
        fileResults: [
          {
            fileType: 'mp4',
            location: 's3://recordings/order-webhook-evidence.mp4',
            duration: 1000,
            size: 4096
          }
        ]
      }
    }),
    {},
    {
      onRecordingCompleted: async (recording) => ({
        id: `evidence-${recording.id}`,
        kind: recording.has_video ? 'video_recording' : 'audio_recording'
      })
    }
  ) as { recording: { id: string }; evidence_record_id: string; evidence_record: { id: string; kind: string } };

  assert.equal(result.evidence_record_id, `evidence-${result.recording.id}`);
  assert.deepEqual(result.evidence_record, {
    id: `evidence-${result.recording.id}`,
    kind: 'video_recording'
  });
  db.close();
});

test('media HTTP egress completion updates the recording evidence created at start', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'LiveKit Media Webhook Evidence Update' });
  await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/rooms',
    new URL('http://localhost/api/media/livekit/rooms'),
    {
      tenant_id: tenant.id,
      purpose: 'video_service',
      room_name: 'tenant-media-webhook-evidence-update-room',
      metadata: {
        business_ref: {
          type: 'service_order',
          id: 'order-webhook-evidence-update'
        }
      }
    },
    '',
    {}
  );

  const started = await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/recordings/start',
    new URL('http://localhost/api/media/livekit/recordings/start'),
    {
      tenant_id: tenant.id,
      room_name: 'tenant-media-webhook-evidence-update-room',
      business_ref: {
        type: 'service_order',
        id: 'order-webhook-evidence-update'
      },
      format: 'mp4',
      has_video: true
    },
    '',
    {},
    {
      onRecordingStarted: (recording, context) => recordMediaRecordingEvidence(pg, recording, context)
    }
  ) as { egress_id: string; evidence_record_id: string; evidence_record: { id: string; storage_url: string } };

  const completed = await routeMediaApi(
    db,
    'POST',
    '/api/media/webhooks/livekit',
    new URL('http://localhost/api/media/webhooks/livekit'),
    null,
    JSON.stringify({
      event: 'egress_ended',
      room: { name: 'tenant-media-webhook-evidence-update-room' },
      egressInfo: {
        egressId: started.egress_id,
        fileResults: [
          {
            fileType: 'mp4',
            location: 's3://recordings/order-webhook-evidence-update-final.mp4',
            duration: 4500,
            size: 16384
          }
        ]
      }
    }),
    {},
    {
      onRecordingCompleted: (recording, context) => recordMediaRecordingEvidence(pg, recording, context)
    }
  ) as {
    recording: { id: string; duration_ms: number; file_size_bytes: number };
    evidence_record_id: string;
    evidence_record: { id: string; storage_url: string; metadata: Record<string, unknown> };
  };

  assert.equal(completed.evidence_record_id, started.evidence_record_id);
  assert.equal(completed.evidence_record.id, started.evidence_record.id);
  assert.equal(completed.evidence_record.storage_url, 's3://recordings/order-webhook-evidence-update-final.mp4');
  assert.equal(completed.evidence_record.metadata.duration_ms, 4500);
  assert.equal(completed.evidence_record.metadata.file_size_bytes, 16384);
  db.close();
});

test('media HTTP webhook fails closed in production when LiveKit webhook credentials are not configured', async () => {
  const db = createDatabase(':memory:');
  const previousNodeEnv = process.env.NODE_ENV;
  const previousLiveKitUrl = process.env.LIVEKIT_URL;
  const previousLiveKitKey = process.env.LIVEKIT_API_KEY;
  const previousLiveKitSecret = process.env.LIVEKIT_API_SECRET;
  const previousOpcLiveKitUrl = process.env.CONVERACT_LIVEKIT_URL;
  const previousOpcLiveKitKey = process.env.CONVERACT_LIVEKIT_API_KEY;
  const previousOpcLiveKitSecret = process.env.CONVERACT_LIVEKIT_API_SECRET;
  process.env.NODE_ENV = 'production';
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  delete process.env.CONVERACT_LIVEKIT_URL;
  delete process.env.CONVERACT_LIVEKIT_API_KEY;
  delete process.env.CONVERACT_LIVEKIT_API_SECRET;

  try {
    await assert.rejects(
      () =>
        routeMediaApi(
          db,
          'POST',
          '/api/media/webhooks/livekit',
          new URL('http://localhost/api/media/webhooks/livekit'),
          null,
          JSON.stringify({
            event: 'room_started',
            room: { name: 'tenant-media-production-webhook-room', sid: 'RM_unsigned' }
          }),
          {}
        ),
      (error) => {
        assert.equal((error as { status?: number }).status, 401);
        assert.match((error as Error).message, /livekit webhook credentials are required/);
        return true;
      }
    );
  } finally {
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousLiveKitUrl == null) delete process.env.LIVEKIT_URL;
    else process.env.LIVEKIT_URL = previousLiveKitUrl;
    if (previousLiveKitKey == null) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = previousLiveKitKey;
    if (previousLiveKitSecret == null) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = previousLiveKitSecret;
    if (previousOpcLiveKitUrl == null) delete process.env.CONVERACT_LIVEKIT_URL;
    else process.env.CONVERACT_LIVEKIT_URL = previousOpcLiveKitUrl;
    if (previousOpcLiveKitKey == null) delete process.env.CONVERACT_LIVEKIT_API_KEY;
    else process.env.CONVERACT_LIVEKIT_API_KEY = previousOpcLiveKitKey;
    if (previousOpcLiveKitSecret == null) delete process.env.CONVERACT_LIVEKIT_API_SECRET;
    else process.env.CONVERACT_LIVEKIT_API_SECRET = previousOpcLiveKitSecret;
    db.close();
  }
});

test('media HTTP router exposes LiveKit room lifecycle and agent dispatch endpoints', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Media Lifecycle HTTP' });
  await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/rooms',
    new URL('http://localhost/api/media/livekit/rooms'),
    {
      tenant_id: tenant.id,
      purpose: 'video_service',
      room_name: 'tenant-media-lifecycle-room'
    },
    '',
    {}
  );

  const found = await routeMediaApi(
    db,
    'GET',
    '/api/media/livekit/rooms/tenant-media-lifecycle-room',
    new URL(`http://localhost/api/media/livekit/rooms/tenant-media-lifecycle-room?tenant_id=${tenant.id}`),
    null,
    '',
    {}
  );
  assert.equal((found as { room_name: string }).room_name, 'tenant-media-lifecycle-room');

  const dispatch = await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/agent-dispatch',
    new URL('http://localhost/api/media/livekit/agent-dispatch'),
    {
      tenant_id: tenant.id,
      room_name: 'tenant-media-lifecycle-room',
      agent_name: 'support-ai',
      metadata: { business_ref: 'external-service:demo' }
    },
    '',
    {}
  );
  assert.equal((dispatch as { room_name: string }).room_name, 'tenant-media-lifecycle-room');
  assert.equal((dispatch as { agent_name: string }).agent_name, 'support-ai');
  assert.equal((dispatch as { dispatched: boolean }).dispatched, false);

  const closed = await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/rooms/tenant-media-lifecycle-room/close',
    new URL(`http://localhost/api/media/livekit/rooms/tenant-media-lifecycle-room/close?tenant_id=${tenant.id}`),
    null,
    '',
    {}
  );
  assert.equal((closed as { status: string }).status, 'closed');

  await assert.rejects(
    () =>
      routeMediaApi(
        db,
        'GET',
        '/api/media/livekit/join',
        new URL(`http://localhost/api/media/livekit/join?channel=webrtc&room_name=tenant-media-lifecycle-room&identity=customer_after_close&role=customer&tenant_id=${tenant.id}&media=video`),
        null,
        '',
        {}
      ),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /room is closed/);
      return true;
    }
  );

  await assert.rejects(
    () =>
      routeMediaApi(
        db,
        'GET',
        '/api/media/livekit/token',
        new URL(`http://localhost/api/media/livekit/token?room_name=tenant-media-lifecycle-room&identity=agent_after_close&role=agent&tenant_id=${tenant.id}`),
        null,
        '',
        {}
      ),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /room is closed/);
      return true;
    }
  );

  await assert.rejects(
    () =>
      routeMediaApi(
        db,
        'POST',
        '/api/media/livekit/agent-dispatch',
        new URL('http://localhost/api/media/livekit/agent-dispatch'),
        {
          tenant_id: tenant.id,
          room_name: 'tenant-media-lifecycle-room',
          agent_name: 'support-ai',
          metadata: {}
        },
        '',
        {}
      ),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /room is closed/);
      return true;
    }
  );

  await assert.rejects(
    () =>
      routeMediaApi(
        db,
        'POST',
        '/api/media/livekit/recordings/start',
        new URL('http://localhost/api/media/livekit/recordings/start'),
        {
          tenant_id: tenant.id,
          call_session_id: 'call-after-close',
          room_name: 'tenant-media-lifecycle-room',
          format: 'mp4',
          has_video: true
        },
        '',
        {}
      ),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /room is closed/);
      return true;
    }
  );
  db.close();
});

test('media HTTP management endpoints reject tenant mismatches when tenant_id is provided', async () => {
  const db = createDatabase(':memory:');
  const tenantA = createTenant(db, { name: 'LiveKit Media Tenant A' });
  const tenantB = createTenant(db, { name: 'LiveKit Media Tenant B' });
  await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/rooms',
    new URL('http://localhost/api/media/livekit/rooms'),
    {
      tenant_id: tenantA.id,
      purpose: 'video_service',
      room_name: 'tenant-media-tenant-scope-room'
    },
    '',
    {}
  );

  await routeMediaApi(
    db,
    'POST',
    '/api/media/webhooks/livekit',
    new URL('http://localhost/api/media/webhooks/livekit'),
    null,
    JSON.stringify({
      event: 'participant_joined',
      room: { name: 'tenant-media-tenant-scope-room' },
      participant: { identity: 'customer_tenant_scope', metadata: JSON.stringify({ role: 'customer' }) }
    }),
    {}
  );

  const started = await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/recordings/start',
    new URL('http://localhost/api/media/livekit/recordings/start'),
    {
      tenant_id: tenantA.id,
      room_name: 'tenant-media-tenant-scope-room',
      business_ref: { type: 'service_order', id: 'order-tenant-scope' },
      format: 'mp4',
      has_video: true
    },
    '',
    {}
  ) as { id: string; egress_id: string };

  const endpoints = [
    () =>
      routeMediaApi(
        db,
        'GET',
        '/api/media/livekit/rooms/tenant-media-tenant-scope-room',
        new URL(`http://localhost/api/media/livekit/rooms/tenant-media-tenant-scope-room?tenant_id=${tenantB.id}`),
        null,
        '',
        {}
      ),
    () =>
      routeMediaApi(
        db,
        'GET',
        '/api/media/livekit/rooms/tenant-media-tenant-scope-room/participants',
        new URL(`http://localhost/api/media/livekit/rooms/tenant-media-tenant-scope-room/participants?tenant_id=${tenantB.id}&include_left=1`),
        null,
        '',
        {}
      ),
    () =>
      routeMediaApi(
        db,
        'GET',
        `/api/media/livekit/recordings/${encodeURIComponent(started.id)}`,
        new URL(`http://localhost/api/media/livekit/recordings/${encodeURIComponent(started.id)}?tenant_id=${tenantB.id}`),
        null,
        '',
        {}
      ),
    () =>
      routeMediaApi(
        db,
        'POST',
        `/api/media/livekit/recordings/${encodeURIComponent(started.egress_id)}/stop`,
        new URL(`http://localhost/api/media/livekit/recordings/${encodeURIComponent(started.egress_id)}/stop?tenant_id=${tenantB.id}`),
        null,
        '',
        {}
      ),
    () =>
      routeMediaApi(
        db,
        'POST',
        '/api/media/livekit/rooms/tenant-media-tenant-scope-room/close',
        new URL(`http://localhost/api/media/livekit/rooms/tenant-media-tenant-scope-room/close?tenant_id=${tenantB.id}`),
        null,
        '',
        {}
      )
  ];

  for (const callEndpoint of endpoints) {
    await assert.rejects(callEndpoint, (error) => {
      assert.equal((error as { status?: number }).status, 404);
      assert.match((error as Error).message, /not found/);
      return true;
    });
  }

  const participants = await routeMediaApi(
    db,
    'GET',
    '/api/media/livekit/rooms/tenant-media-tenant-scope-room/participants',
    new URL(`http://localhost/api/media/livekit/rooms/tenant-media-tenant-scope-room/participants?tenant_id=${tenantA.id}`),
    null,
    '',
    {}
  ) as Array<{ identity: string }>;
  assert.equal(participants[0]?.identity, 'customer_tenant_scope');

  db.close();
});

test('media HTTP token and agent dispatch require tenant_id and reject mismatches', async () => {
  const db = createDatabase(':memory:');
  const tenantA = createTenant(db, { name: 'LiveKit Token Tenant A' });
  const tenantB = createTenant(db, { name: 'LiveKit Token Tenant B' });
  await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/rooms',
    new URL('http://localhost/api/media/livekit/rooms'),
    {
      tenant_id: tenantA.id,
      purpose: 'video_service',
      room_name: 'tenant-media-token-dispatch-scope-room'
    },
    '',
    {}
  );

  const rejects = [
    {
      call: () =>
        routeMediaApi(
          db,
          'GET',
          '/api/media/livekit/token',
          new URL('http://localhost/api/media/livekit/token?room_name=tenant-media-token-dispatch-scope-room&identity=agent_missing_tenant&role=agent'),
          null,
          '',
          {}
        ),
      status: 400,
      message: /tenant_id is required/
    },
    {
      call: () =>
        routeMediaApi(
          db,
          'GET',
          '/api/media/livekit/token',
          new URL(`http://localhost/api/media/livekit/token?room_name=tenant-media-token-dispatch-scope-room&identity=agent_wrong_tenant&role=agent&tenant_id=${tenantB.id}`),
          null,
          '',
          {}
        ),
      status: 404,
      message: /media room not found/
    },
    {
      call: () =>
        routeMediaApi(
          db,
          'POST',
          '/api/media/livekit/agent-dispatch',
          new URL('http://localhost/api/media/livekit/agent-dispatch'),
          {
            room_name: 'tenant-media-token-dispatch-scope-room',
            agent_name: 'support-ai'
          },
          '',
          {}
        ),
      status: 400,
      message: /tenant_id is required/
    },
    {
      call: () =>
        routeMediaApi(
          db,
          'POST',
          '/api/media/livekit/agent-dispatch',
          new URL('http://localhost/api/media/livekit/agent-dispatch'),
          {
            tenant_id: tenantB.id,
            room_name: 'tenant-media-token-dispatch-scope-room',
            agent_name: 'support-ai'
          },
          '',
          {}
        ),
      status: 404,
      message: /media room not found/
    },
    {
      call: () =>
        routeMediaApi(
          db,
          'POST',
          '/api/media/livekit/agent-dispatch',
          new URL('http://localhost/api/media/livekit/agent-dispatch'),
          {
            tenant_id: tenantA.id,
            room_name: 'tenant-media-token-dispatch-scope-room',
            agent_name: 'support-ai',
            metadata: { tenant_id: tenantB.id }
          },
          '',
          {}
        ),
      status: 400,
      message: /metadata tenant mismatch/
    }
  ];

  for (const item of rejects) {
    await assert.rejects(item.call, (error) => {
      assert.equal((error as { status?: number }).status, item.status);
      assert.match((error as Error).message, item.message);
      return true;
    });
  }

  const token = await routeMediaApi(
    db,
    'GET',
    '/api/media/livekit/token',
    new URL(`http://localhost/api/media/livekit/token?room_name=tenant-media-token-dispatch-scope-room&identity=agent_valid_tenant&role=agent&tenant_id=${tenantA.id}`),
    null,
    '',
    {}
  ) as { token: string };
  assert.match(token.token, /^dev-token:/);

  const dispatch = await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/agent-dispatch',
    new URL('http://localhost/api/media/livekit/agent-dispatch'),
    {
      tenant_id: tenantA.id,
      room_name: 'tenant-media-token-dispatch-scope-room',
      agent_name: 'support-ai',
      metadata: { business_ref: 'service_order:dispatch-valid' }
    },
    '',
    {}
  ) as { room_name: string; dispatched: boolean };
  assert.equal(dispatch.room_name, 'tenant-media-token-dispatch-scope-room');
  assert.equal(dispatch.dispatched, false);

  db.close();
});

test('media HTTP resource management endpoints require tenant_id', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Media Tenant Required' });
  await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/rooms',
    new URL('http://localhost/api/media/livekit/rooms'),
    {
      tenant_id: tenant.id,
      purpose: 'video_service',
      room_name: 'tenant-media-tenant-required-room'
    },
    '',
    {}
  );
  const started = await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/recordings/start',
    new URL('http://localhost/api/media/livekit/recordings/start'),
    {
      tenant_id: tenant.id,
      room_name: 'tenant-media-tenant-required-room',
      business_ref: { type: 'service_order', id: 'order-tenant-required' },
      format: 'mp4',
      has_video: true
    },
    '',
    {}
  ) as { id: string; egress_id: string };

  const endpoints = [
    () =>
      routeMediaApi(
        db,
        'GET',
        '/api/media/livekit/rooms/tenant-media-tenant-required-room',
        new URL('http://localhost/api/media/livekit/rooms/tenant-media-tenant-required-room'),
        null,
        '',
        {}
      ),
    () =>
      routeMediaApi(
        db,
        'GET',
        '/api/media/livekit/rooms/tenant-media-tenant-required-room/participants',
        new URL('http://localhost/api/media/livekit/rooms/tenant-media-tenant-required-room/participants'),
        null,
        '',
        {}
      ),
    () =>
      routeMediaApi(
        db,
        'GET',
        `/api/media/livekit/recordings/${encodeURIComponent(started.id)}`,
        new URL(`http://localhost/api/media/livekit/recordings/${encodeURIComponent(started.id)}`),
        null,
        '',
        {}
      ),
    () =>
      routeMediaApi(
        db,
        'POST',
        `/api/media/livekit/recordings/${encodeURIComponent(started.egress_id)}/stop`,
        new URL(`http://localhost/api/media/livekit/recordings/${encodeURIComponent(started.egress_id)}/stop`),
        null,
        '',
        {}
      ),
    () =>
      routeMediaApi(
        db,
        'POST',
        '/api/media/livekit/rooms/tenant-media-tenant-required-room/close',
        new URL('http://localhost/api/media/livekit/rooms/tenant-media-tenant-required-room/close'),
        null,
        '',
        {}
      )
  ];

  for (const callEndpoint of endpoints) {
    await assert.rejects(callEndpoint, (error) => {
      assert.equal((error as { status?: number }).status, 400);
      assert.match((error as Error).message, /tenant_id is required/);
      return true;
    });
  }

  db.close();
});

test('media HTTP router returns clear 400 errors for missing body fields', async () => {
  const db = createDatabase(':memory:');
  await assert.rejects(
    () =>
      routeMediaApi(
        db,
        'POST',
        '/api/media/livekit/agent-dispatch',
        new URL('http://localhost/api/media/livekit/agent-dispatch'),
        { metadata: { source: 'contract-test' } },
        '',
        {}
      ),
    (error) => {
      assert.equal((error as { status?: number }).status, 400);
      assert.match((error as Error).message, /room_name is required/);
      return true;
    }
  );
  db.close();
});

test('media HTTP router protects management endpoints with service token when configured', async () => {
  const previous = process.env.CONVERACT_MEDIA_API_TOKEN;
  process.env.CONVERACT_MEDIA_API_TOKEN = 'media-service-token';
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Media Auth HTTP' });

  try {
    await assert.rejects(
      () =>
        routeMediaApi(
          db,
          'POST',
          '/api/media/livekit/rooms',
          new URL('http://localhost/api/media/livekit/rooms'),
          {
            tenant_id: tenant.id,
            purpose: 'video_service',
            room_name: 'tenant-media-auth-room'
          },
          '',
          {}
        ),
      (error) => {
        assert.equal((error as { status?: number }).status, 401);
        assert.match((error as Error).message, /media api authorization/);
        return true;
      }
    );

    const room = await routeMediaApi(
      db,
      'POST',
      '/api/media/livekit/rooms',
      new URL('http://localhost/api/media/livekit/rooms'),
      {
        tenant_id: tenant.id,
        purpose: 'video_service',
        room_name: 'tenant-media-auth-room'
      },
      '',
      { authorization: 'Bearer media-service-token' }
    );
    assert.equal((room as { room_name: string }).room_name, 'tenant-media-auth-room');

    const customerJoin = await routeMediaApi(
      db,
      'GET',
      '/api/media/livekit/join',
      new URL(`http://localhost/api/media/livekit/join?channel=webrtc&room_name=tenant-media-auth-room&identity=customer_auth&role=customer&tenant_id=${tenant.id}&media=video`),
      null,
      '',
      {}
    );
    assert.equal((customerJoin as { mode: string }).mode, 'webrtc');

    await assert.rejects(
      () =>
        routeMediaApi(
          db,
          'GET',
          '/api/media/livekit/join',
          new URL(`http://localhost/api/media/livekit/join?channel=webrtc&room_name=tenant-media-auth-room&identity=agent_auth&role=agent&tenant_id=${tenant.id}&media=video`),
          null,
          '',
          {}
        ),
      (error) => {
        assert.equal((error as { status?: number }).status, 401);
        return true;
      }
    );

    const agentJoin = await routeMediaApi(
      db,
      'GET',
      '/api/media/livekit/join',
      new URL(`http://localhost/api/media/livekit/join?channel=webrtc&room_name=tenant-media-auth-room&identity=agent_auth&role=agent&tenant_id=${tenant.id}&media=video`),
      null,
      '',
      { Authorization: 'Bearer media-service-token' }
    );
    assert.equal((agentJoin as { mode: string }).mode, 'webrtc');
  } finally {
    if (previous == null) delete process.env.CONVERACT_MEDIA_API_TOKEN;
    else process.env.CONVERACT_MEDIA_API_TOKEN = previous;
    db.close();
  }
});

test('media HTTP management endpoints fail closed in production when service token is not configured', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Media Service Token Production' });
  const previousNodeEnv = process.env.NODE_ENV;
  const previousMediaToken = process.env.CONVERACT_MEDIA_API_TOKEN;
  const previousLegacyMediaToken = process.env.LIVEKIT_MEDIA_API_TOKEN;
  delete process.env.CONVERACT_MEDIA_API_TOKEN;
  delete process.env.LIVEKIT_MEDIA_API_TOKEN;
  process.env.NODE_ENV = 'production';

  try {
    await assert.rejects(
      () =>
        routeMediaApi(
          db,
          'POST',
          '/api/media/livekit/rooms',
          new URL('http://localhost/api/media/livekit/rooms'),
          {
            tenant_id: tenant.id,
            purpose: 'video_service',
            room_name: 'tenant-media-production-auth-room'
          },
          '',
          {}
        ),
      (error) => {
        assert.equal((error as { status?: number }).status, 401);
        assert.match((error as Error).message, /media api token is required/);
        return true;
      }
    );
  } finally {
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousMediaToken == null) delete process.env.CONVERACT_MEDIA_API_TOKEN;
    else process.env.CONVERACT_MEDIA_API_TOKEN = previousMediaToken;
    if (previousLegacyMediaToken == null) delete process.env.LIVEKIT_MEDIA_API_TOKEN;
    else process.env.LIVEKIT_MEDIA_API_TOKEN = previousLegacyMediaToken;
    db.close();
  }
});

test('media HTTP router requires signed customer invites when invite secret is configured', async () => {
  const previousInviteSecret = process.env.CONVERACT_MEDIA_INVITE_SECRET;
  const previousApiToken = process.env.CONVERACT_MEDIA_API_TOKEN;
  process.env.CONVERACT_MEDIA_INVITE_SECRET = 'media-invite-secret';
  delete process.env.CONVERACT_MEDIA_API_TOKEN;
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Signed Customer Invite' });

  try {
    await routeMediaApi(
      db,
      'POST',
      '/api/media/livekit/rooms',
      new URL('http://localhost/api/media/livekit/rooms'),
      {
        tenant_id: tenant.id,
        purpose: 'video_service',
        room_name: 'tenant-media-invite-room'
      },
      '',
      {}
    );

    const media = createLiveKitMediaModule({ db });
    const linkPlan = await media.joins.prepareJoin('webrtc', {
      tenantId: tenant.id,
      roomName: 'tenant-media-invite-room',
      identity: 'customer_invite_link',
      role: 'customer',
      media: 'video'
    });
    const joinPath = (linkPlan as { joinPath?: string }).joinPath || '';
    assert.match(joinPath, /[?&]expires_at=/);
    assert.match(joinPath, /[?&]invite=/);

    await assert.rejects(
      () =>
        routeMediaApi(
          db,
          'GET',
          '/api/media/livekit/join',
          new URL(`http://localhost/api/media/livekit/join?channel=webrtc&room_name=tenant-media-invite-room&identity=customer_no_invite&role=customer&tenant_id=${tenant.id}&media=video`),
          null,
          '',
          {}
        ),
      (error) => {
        assert.equal((error as { status?: number }).status, 401);
        assert.match((error as Error).message, /media invite/);
        return true;
      }
    );

    const expiredAt = String(Date.now() - 1000);
    const expiredInvite = signInviteForTest({
      secret: 'media-invite-secret',
      tenantId: tenant.id,
      roomName: 'tenant-media-invite-room',
      role: 'customer',
      media: 'video',
      expiresAt: expiredAt
    });
    await assert.rejects(
      () =>
        routeMediaApi(
          db,
          'GET',
          '/api/media/livekit/join',
          new URL(`http://localhost/api/media/livekit/join?channel=webrtc&room_name=tenant-media-invite-room&identity=customer_expired&role=customer&tenant_id=${tenant.id}&media=video&expires_at=${expiredAt}&invite=${expiredInvite}`),
          null,
          '',
          {}
        ),
      (error) => {
        assert.equal((error as { status?: number }).status, 401);
        assert.match((error as Error).message, /media invite/);
        return true;
      }
    );

    const joinUrl = new URL(`http://localhost${joinPath}`);
    const joined = await routeMediaApi(
      db,
      'GET',
      '/api/media/livekit/join',
      new URL(`http://localhost/api/media/livekit/join?channel=webrtc&room_name=${joinUrl.searchParams.get('room')}&identity=customer_signed&role=customer&tenant_id=${joinUrl.searchParams.get('tenant_id')}&media=video&expires_at=${joinUrl.searchParams.get('expires_at')}&invite=${joinUrl.searchParams.get('invite')}`),
      null,
      '',
      {}
    );
    assert.equal((joined as { mode: string }).mode, 'webrtc');
  } finally {
    if (previousInviteSecret == null) delete process.env.CONVERACT_MEDIA_INVITE_SECRET;
    else process.env.CONVERACT_MEDIA_INVITE_SECRET = previousInviteSecret;
    if (previousApiToken == null) delete process.env.CONVERACT_MEDIA_API_TOKEN;
    else process.env.CONVERACT_MEDIA_API_TOKEN = previousApiToken;
    db.close();
  }
});

test('signed customer joins establish a tenant RLS context after invite verification', async () => {
  const previousSecret = process.env.CONVERACT_MEDIA_INVITE_SECRET;
  const previousMediaToken = process.env.CONVERACT_MEDIA_API_TOKEN;
  process.env.CONVERACT_MEDIA_INVITE_SECRET = 'customer-join-rls-secret';
  delete process.env.CONVERACT_MEDIA_API_TOKEN;
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Customer join RLS context' });
  await routeMediaApi(
    db,
    'POST',
    '/api/media/livekit/rooms',
    new URL('http://localhost/api/media/livekit/rooms'),
    {
      tenant_id: tenant.id,
      purpose: 'video_service',
      room_name: 'customer-join-rls-room'
    }
  );
  const guardedDb = {
    prepare(sql: string) {
      if (sql.includes('FROM livekit_rooms')) {
        assert.equal(getPgTenantContext().tenantId, tenant.id);
      }
      return db.prepare(sql);
    },
    exec(sql: string) {
      return db.exec(sql);
    }
  };
  const expiresAt = String(Date.now() + 60_000);
  const invite = signInviteForTest({
    secret: 'customer-join-rls-secret',
    tenantId: tenant.id,
    roomName: 'customer-join-rls-room',
    role: 'customer',
    media: 'video',
    expiresAt
  });

  try {
    const result = await routeMediaApi(
      guardedDb,
      'GET',
      '/api/media/livekit/join',
      new URL(`http://localhost/api/media/livekit/join?tenant_id=${tenant.id}&room_name=customer-join-rls-room&identity=customer_rls&role=customer&media=video&expires_at=${expiresAt}&invite=${invite}`),
      null
    );
    assert.equal((result as { mode: string }).mode, 'webrtc');
    assert.equal(getPgTenantContext().tenantId, undefined);
  } finally {
    db.close();
    if (previousSecret === undefined) delete process.env.CONVERACT_MEDIA_INVITE_SECRET;
    else process.env.CONVERACT_MEDIA_INVITE_SECRET = previousSecret;
    if (previousMediaToken === undefined) delete process.env.CONVERACT_MEDIA_API_TOKEN;
    else process.env.CONVERACT_MEDIA_API_TOKEN = previousMediaToken;
  }
});

test('media HTTP customer join fails closed in production when invite signing is not configured', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Media Invite Production' });
  const previousInviteSecret = process.env.CONVERACT_MEDIA_INVITE_SECRET;
  const previousLegacyInviteSecret = process.env.LIVEKIT_MEDIA_INVITE_SECRET;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousMediaToken = process.env.CONVERACT_MEDIA_API_TOKEN;
  const previousLiveKitUrl = process.env.LIVEKIT_URL;
  const previousLiveKitPublicUrl = process.env.LIVEKIT_PUBLIC_URL;
  const previousLiveKitApiKey = process.env.LIVEKIT_API_KEY;
  const previousLiveKitApiSecret = process.env.LIVEKIT_API_SECRET;
  delete process.env.CONVERACT_MEDIA_INVITE_SECRET;
  delete process.env.LIVEKIT_MEDIA_INVITE_SECRET;
  process.env.NODE_ENV = 'production';
  process.env.CONVERACT_MEDIA_API_TOKEN = 'media-service-token';

  try {
    await routeMediaApi(
      db,
      'POST',
      '/api/media/livekit/rooms',
      new URL('http://localhost/api/media/livekit/rooms'),
      {
        tenant_id: tenant.id,
        purpose: 'video_service',
        room_name: 'tenant-media-production-invite-room'
      },
      '',
      { authorization: 'Bearer media-service-token' }
    );

    await assert.rejects(
      () =>
        routeMediaApi(
          db,
          'GET',
          '/api/media/livekit/join',
          new URL(`http://localhost/api/media/livekit/join?channel=webrtc&room_name=tenant-media-production-invite-room&identity=customer_unsigned&role=customer&tenant_id=${tenant.id}&media=video`),
          null,
          '',
          {}
        ),
      (error) => {
        assert.equal((error as { status?: number }).status, 401);
        assert.match((error as Error).message, /media invite signing is required/);
        return true;
      }
    );

    process.env.LIVEKIT_URL = 'ws://livekit:7880';
    process.env.LIVEKIT_PUBLIC_URL = 'wss://livekit.example.com';
    process.env.LIVEKIT_API_KEY = 'test-livekit-key';
    process.env.LIVEKIT_API_SECRET = 'test-livekit-secret';
    const serviceJoin = await routeMediaApi(
      db,
      'GET',
      '/api/media/livekit/join',
      new URL(`http://localhost/api/media/livekit/join?channel=webrtc&room_name=tenant-media-production-invite-room&identity=service_customer&role=customer&tenant_id=${tenant.id}&media=video`),
      null,
      '',
      { authorization: 'Bearer media-service-token' }
    );
    assert.equal((serviceJoin as { mode: string }).mode, 'webrtc');
  } finally {
    if (previousInviteSecret == null) delete process.env.CONVERACT_MEDIA_INVITE_SECRET;
    else process.env.CONVERACT_MEDIA_INVITE_SECRET = previousInviteSecret;
    if (previousLegacyInviteSecret == null) delete process.env.LIVEKIT_MEDIA_INVITE_SECRET;
    else process.env.LIVEKIT_MEDIA_INVITE_SECRET = previousLegacyInviteSecret;
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousMediaToken == null) delete process.env.CONVERACT_MEDIA_API_TOKEN;
    else process.env.CONVERACT_MEDIA_API_TOKEN = previousMediaToken;
    if (previousLiveKitUrl == null) delete process.env.LIVEKIT_URL;
    else process.env.LIVEKIT_URL = previousLiveKitUrl;
    if (previousLiveKitPublicUrl == null) delete process.env.LIVEKIT_PUBLIC_URL;
    else process.env.LIVEKIT_PUBLIC_URL = previousLiveKitPublicUrl;
    if (previousLiveKitApiKey == null) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = previousLiveKitApiKey;
    if (previousLiveKitApiSecret == null) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = previousLiveKitApiSecret;
    db.close();
  }
});
