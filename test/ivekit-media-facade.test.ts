import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { routeIveKitMediaApi } from '../src/agent-runtime/ivekit/media-http.js';
import { createLiveKitMediaModule } from '../src/agent-runtime/livekit/index.js';
import { resetMediaGatewayRegistryForTests } from '../src/agent-runtime/media-gateway/index.js';
import { createDatabase, run } from '../src/db.js';
import { getPgTenantContext } from '../src/db-pg-tenant.js';
import { createServer as createOpcServer } from '../src/http.js';
import { signAccessToken } from '../src/middleware/auth.js';
import { createTenant } from '../src/platform/tenant-core.js';

const API_KEY = 'test-ivekit-media-key';
const LIVEKIT_ENV_KEYS = [
  'LIVEKIT_URL',
  'LIVEKIT_PUBLIC_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'OPC_LIVEKIT_URL',
  'OPC_LIVEKIT_PUBLIC_URL',
  'OPC_LIVEKIT_API_KEY',
  'OPC_LIVEKIT_API_SECRET',
  'OPC_MEDIA_INVITE_SECRET',
  'LIVEKIT_MEDIA_INVITE_SECRET',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
  'OPC_SIP_VOLTE_ENABLED',
  'LIVEKIT_SIP_BRIDGE_TARGET',
  'RUSTPBX_LIVEKIT_TRUNK',
  'RUSTPBX_RWI_URL',
  'RUSTPBX_RWI_TOKEN'
];

function authHeaders(tenantId: string, userId = 'led-backend'): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    'X-Tenant-Id': tenantId,
    'X-User-Id': userId
  };
}

async function route(
  db: unknown,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = authHeaders('tenant_ivekit_media')
) {
  return routeIveKitMediaApi(
    db,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    headers
  );
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearLiveKitEnv(): void {
  for (const key of LIVEKIT_ENV_KEYS) delete process.env[key];
}

test('iveKit media facade exposes deployment capabilities through platform auth', async () => {
  const envSnapshot = snapshotEnv(['OPC_API_KEY', ...LIVEKIT_ENV_KEYS]);
  process.env.OPC_API_KEY = API_KEY;
  process.env.LIVEKIT_URL = 'wss://livekit.example.com';
  process.env.LIVEKIT_PUBLIC_URL = 'wss://livekit.example.com';
  process.env.LIVEKIT_API_KEY = 'livekit-key';
  process.env.LIVEKIT_API_SECRET = 'livekit-secret';
  process.env.OPC_MEDIA_INVITE_SECRET = 'invite-secret';
  process.env.MINIO_ACCESS_KEY = 'minio-key';
  process.env.MINIO_SECRET_KEY = 'minio-secret';
  process.env.OPC_SIP_VOLTE_ENABLED = '0';
  process.env.LIVEKIT_SIP_BRIDGE_TARGET = 'sip:livekit-bridge@livekit-sip:5061';
  process.env.RUSTPBX_LIVEKIT_TRUNK = 'livekit-bridge';
  process.env.RUSTPBX_RWI_URL = 'wss://rustpbx.example.com/rwi/v1';
  process.env.RUSTPBX_RWI_TOKEN = 'rwi-secret';
  const db = createDatabase(':memory:');
  try {
    const result = await route(
      db,
      'GET',
      '/api/ivekit/media/capabilities',
      null,
      authHeaders('tenant_capabilities')
    ) as {
      data: {
        provider: string;
        tenant_id: string;
        capabilities: Record<string, unknown>;
        config: Record<string, unknown>;
      };
    };

    assert.equal(result.data.provider, 'livekit');
    assert.equal(result.data.tenant_id, 'tenant_capabilities');
    assert.equal(result.data.capabilities.calls, true);
    assert.equal(result.data.capabilities.rooms, true);
    assert.equal(result.data.capabilities.join, true);
    assert.equal(result.data.capabilities.host_moderation, true);
    assert.equal(result.data.capabilities.recording, true);
    assert.equal(result.data.capabilities.web_assist, true);
    assert.equal(result.data.capabilities.sip_volte, 'planned');
    assert.equal(result.data.config.livekit_url_configured, true);
    assert.equal(result.data.config.livekit_public_url_configured, true);
    assert.equal(result.data.config.livekit_server_configured, true);
    assert.equal(result.data.config.livekit_browser_join_ready, true);
    assert.equal(result.data.config.livekit_api_key_configured, true);
    assert.equal(result.data.config.livekit_api_secret_configured, true);
    assert.equal(result.data.config.invite_secret_configured, true);
    assert.equal(result.data.config.egress_configured, true);
    assert.equal(JSON.stringify(result).includes('livekit-secret'), false);
    assert.equal(JSON.stringify(result).includes('minio-secret'), false);
    assert.equal(JSON.stringify(result).includes('rwi-secret'), false);

    process.env.OPC_SIP_VOLTE_ENABLED = '1';
    const activated = await route(
      db,
      'GET',
      '/api/ivekit/media/capabilities',
      null,
      authHeaders('tenant_capabilities')
    ) as { data: { capabilities: Record<string, unknown> } };
    assert.equal(activated.data.capabilities.sip_volte, 'planned');

    resetMediaGatewayRegistryForTests(null);
    const afterRestart = await route(
      db,
      'GET',
      '/api/ivekit/media/capabilities',
      null,
      authHeaders('tenant_capabilities')
    ) as { data: { capabilities: Record<string, unknown> } };
    assert.equal(afterRestart.data.capabilities.sip_volte, 'ready');
  } finally {
    resetMediaGatewayRegistryForTests(null);
    db.close();
    restoreEnv(envSnapshot);
  }
});

test('iveKit media facade creates rooms, prepares joins, lists participants, and starts recordings', async () => {
  process.env.OPC_API_KEY = API_KEY;
  clearLiveKitEnv();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'iveKit Media Tenant' }).id;

  const created = await route(
    db,
    'POST',
    '/api/ivekit/media/rooms',
    {
      tenant_id: 'tenant_from_body_must_be_ignored',
      purpose: 'video_service',
      room_name: 'led-media-room-1',
      business_ref: {
        type: 'service_order',
        id: 'order-led-media-1',
        display_name: 'LED media order',
        metadata: { project: 'led' }
      },
      metadata: { source: 'led' }
    },
    authHeaders(tenantId)
  ) as { status: number; data: { tenant_id: string; room_name: string; metadata: Record<string, any> } };

  assert.equal(created.status, 201);
  assert.equal(created.data.tenant_id, tenantId);
  assert.equal(created.data.room_name, 'led-media-room-1');
  assert.deepEqual(created.data.metadata.business_ref, {
    tenant_id: tenantId,
    type: 'service_order',
    id: 'order-led-media-1',
    display_name: 'LED media order',
    metadata: { project: 'led' }
  });

  const join = await route(
    db,
    'POST',
    '/api/ivekit/media/rooms/led-media-room-1/join',
    {
      identity: 'customer-led-1',
      role: 'customer',
      media: 'video',
      channel: 'webrtc'
    },
    authHeaders(tenantId)
  ) as { status: number; data: { mode: string; roomName: string; token: { token: string }; joinPath: string } };

  assert.equal(join.status, 201);
  assert.equal(join.data.mode, 'webrtc');
  assert.equal(join.data.roomName, 'led-media-room-1');
  assert.match(join.data.token.token, /^dev-token:/);
  assert.equal(join.data.joinPath, `/video?room=led-media-room-1&tenant_id=${tenantId}`);

  createLiveKitMediaModule({ db }).participants.upsertJoined({
    tenant_id: tenantId,
    room_name: 'led-media-room-1',
    identity: 'customer-led-1',
    role: 'customer',
    metadata: { display_name: 'LED Customer' }
  });

  const participants = await route(
    db,
    'GET',
    '/api/ivekit/media/rooms/led-media-room-1/participants',
    null,
    authHeaders(tenantId)
  ) as { data: Array<{ identity: string; role: string; status: string }> };

  assert.equal(participants.data[0]?.identity, 'customer-led-1');
  assert.equal(participants.data[0]?.role, 'customer');
  assert.equal(participants.data[0]?.status, 'joined');

  const recording = await route(
    db,
    'POST',
    '/api/ivekit/media/rooms/led-media-room-1/recordings/start',
    {
      business_ref: {
        type: 'service_order',
        id: 'order-led-media-1',
        display_name: 'LED media order'
      },
      format: 'mp4',
      has_video: true
    },
    authHeaders(tenantId)
  ) as { status: number; data: { tenant_id: string; business_ref: { id: string }; has_video: number; format: string } };

  assert.equal(recording.status, 201);
  assert.equal(recording.data.tenant_id, tenantId);
  assert.equal(recording.data.business_ref.id, 'order-led-media-1');
  assert.equal(recording.data.has_video, 1);
  assert.equal(recording.data.format, 'mp4');
  db.close();
});

test('iveKit media facade keeps rooms tenant scoped', async () => {
  process.env.OPC_API_KEY = API_KEY;
  clearLiveKitEnv();
  const db = createDatabase(':memory:');
  const tenantA = createTenant(db, { name: 'Tenant A' }).id;
  const tenantB = createTenant(db, { name: 'Tenant B' }).id;
  await route(
    db,
    'POST',
    '/api/ivekit/media/rooms',
    {
      purpose: 'video_service',
      room_name: 'tenant-scoped-media-room',
      business_ref: { type: 'service_order', id: 'order-tenant-a' }
    },
    authHeaders(tenantA)
  );

  await assert.rejects(
    () =>
      route(
        db,
        'POST',
        '/api/ivekit/media/rooms/tenant-scoped-media-room/join',
        {
          identity: 'customer-cross-tenant',
          role: 'customer'
        },
        authHeaders(tenantB)
      ),
    /media room not found/
  );
  db.close();
});

test('legacy room join is system-only so JWT users cannot mint arbitrary identities or agent roles', async () => {
  const envSnapshot = snapshotEnv(['OPC_API_KEY', 'OPC_JWT_SECRET', ...LIVEKIT_ENV_KEYS]);
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_JWT_SECRET = 'ivekit-media-facade-jwt-secret';
  clearLiveKitEnv();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'Legacy join tenant' }).id;
  try {
    await route(db, 'POST', '/api/ivekit/media/rooms', {
      room_name: 'legacy-system-room', purpose: 'video_service'
    }, authHeaders(tenantId));
    const token = signAccessToken({ sub: 'member-1', tid: tenantId, role: 'operator' });
    await assert.rejects(
      () => route(db, 'POST', '/api/ivekit/media/rooms/legacy-system-room/join', {
        identity: 'forged-host', role: 'agent', channel: 'webrtc'
      }, { authorization: `Bearer ${token}` }),
      (error: any) => error.status === 403 && /system role required/i.test(error.message)
    );
  } finally {
    db.close();
    restoreEnv(envSnapshot);
  }
});

test('iveKit media facade accepts LiveKit webhook raw bodies without platform auth', async () => {
  process.env.OPC_API_KEY = API_KEY;
  clearLiveKitEnv();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'iveKit Webhook Tenant' }).id;
  try {
    await route(
      db,
      'POST',
      '/api/ivekit/media/rooms',
      {
        purpose: 'video_service',
        room_name: 'ivekit-webhook-room',
        business_ref: { type: 'service_order', id: 'order-webhook' }
      },
      authHeaders(tenantId)
    );

    const rawBody = JSON.stringify({
      event: 'participant_joined',
      room: { name: 'ivekit-webhook-room' },
      participant: {
        identity: 'customer-webhook',
        metadata: JSON.stringify({ role: 'customer' })
      }
    });
    const result = await routeIveKitMediaApi(
      db,
      'POST',
      '/api/ivekit/media/webhooks/livekit',
      new URL('http://localhost/api/ivekit/media/webhooks/livekit'),
      rawBody,
      rawBody,
      {}
    ) as { ok: boolean };

    assert.equal(result.ok, true);
    const participants = createLiveKitMediaModule({ db }).participants.listByRoom('ivekit-webhook-room');
    assert.equal(participants[0]?.tenant_id, tenantId);
    assert.equal(participants[0]?.identity, 'customer-webhook');
  } finally {
    db.close();
  }
});

test('iveKit media webhook journals room and participant lifecycle events', async () => {
  process.env.OPC_API_KEY = API_KEY;
  clearLiveKitEnv();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'iveKit Webhook Event Tenant' }).id;
  const events: Array<{
    tenant_id: string;
    type: string;
    data: unknown;
    idempotency_key?: string;
  }> = [];
  const eventStore = {
    async append(event: (typeof events)[number]) {
      events.push(event);
    }
  };

  try {
    await route(
      db,
      'POST',
      '/api/ivekit/media/rooms',
      {
        purpose: 'video_service',
        room_name: 'ivekit-webhook-event-room',
        business_ref: { type: 'order_assignment', id: 'assignment-webhook-event' }
      },
      authHeaders(tenantId)
    );
    const tenantGuardedDb = {
      prepare(sql: string) {
        if (sql.includes('livekit_rooms')) {
          assert.equal(getPgTenantContext().tenantId, tenantId);
        }
        return db.prepare(sql);
      },
      exec(sql: string) {
        return db.exec(sql);
      }
    };

    for (const payload of [
      {
        id: 'livekit-event-room-started',
        event: 'room_started',
        room: {
          name: 'ivekit-webhook-event-room',
          sid: 'RM_event',
          metadata: JSON.stringify({ tenant_id: tenantId })
        }
      },
      {
        id: 'livekit-event-participant-joined',
        event: 'participant_joined',
        room: {
          name: 'ivekit-webhook-event-room',
          metadata: JSON.stringify({ tenant_id: tenantId })
        },
        participant: {
          identity: 'customer-webhook-event',
          metadata: JSON.stringify({ role: 'customer' })
        }
      }
    ]) {
      const rawBody = JSON.stringify(payload);
      await routeIveKitMediaApi(
        tenantGuardedDb,
        'POST',
        '/api/ivekit/media/webhooks/livekit',
        new URL('http://localhost/api/ivekit/media/webhooks/livekit'),
        rawBody,
        rawBody,
        {},
        { eventStore }
      );
    }

    assert.deepEqual(events.map((event) => event.type), [
      'ivekit.media.call.updated',
      'ivekit.media.participant.updated'
    ]);
    assert.deepEqual(events.map((event) => event.tenant_id), [tenantId, tenantId]);
    assert.deepEqual(events.map((event) => event.data), [
      {
        business_ref: { type: 'order_assignment', id: 'assignment-webhook-event' },
        room_name: 'ivekit-webhook-event-room',
        status: 'active'
      },
      {
        business_ref: { type: 'order_assignment', id: 'assignment-webhook-event' },
        identity: 'customer-webhook-event',
        participant_identity: 'customer-webhook-event',
        role: 'customer',
        room_name: 'ivekit-webhook-event-room',
        status: 'joined'
      }
    ]);
    assert.equal(events.every((event) => Boolean(event.idempotency_key)), true);
    assert.equal(new Set(events.map((event) => event.idempotency_key)).size, 2);
  } finally {
    db.close();
  }
});

test('iveKit media webhook completes recording evidence through the facade hook', async () => {
  process.env.OPC_API_KEY = API_KEY;
  clearLiveKitEnv();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'iveKit Webhook Evidence Tenant' }).id;
  try {
    await route(
      db,
      'POST',
      '/api/ivekit/media/rooms',
      {
        purpose: 'video_service',
        room_name: 'ivekit-webhook-evidence-room',
        business_ref: { type: 'service_order', id: 'order-webhook-evidence' }
      },
      authHeaders(tenantId)
    );
    const started = await route(
      db,
      'POST',
      '/api/ivekit/media/rooms/ivekit-webhook-evidence-room/recordings/start',
      {
        business_ref: { type: 'service_order', id: 'order-webhook-evidence' },
        format: 'mp4',
        has_video: true
      },
      authHeaders(tenantId)
    ) as { data: { egress_id: string } };
    let completedStatus = '';
    const rawBody = JSON.stringify({
      event: 'egress_ended',
      room: { name: 'ivekit-webhook-evidence-room' },
      egressInfo: {
        egressId: started.data.egress_id,
        fileResults: [{
          fileType: 'mp4',
          location: 's3://recordings/order-webhook-evidence.mp4',
          duration: 1000,
          size: 4096
        }]
      }
    });
    const result = await routeIveKitMediaApi(
      db,
      'POST',
      '/api/ivekit/media/webhooks/livekit',
      new URL('http://localhost/api/ivekit/media/webhooks/livekit'),
      rawBody,
      rawBody,
      {},
      {
        onRecordingCompleted: async (recording) => {
          completedStatus = recording.status;
          return { id: 'evidence-completed-1' };
        }
      }
    ) as { evidence_record_id: string };

    assert.equal(completedStatus, 'completed');
    assert.equal(result.evidence_record_id, 'evidence-completed-1');
  } finally {
    db.close();
  }
});

test('iveKit media webhook releases each terminal Egress job and hides placement internals', async () => {
  process.env.OPC_API_KEY = API_KEY;
  clearLiveKitEnv();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'iveKit Egress Placement Tenant' }).id;
  const closed: Array<{ tenant_id: string; job_id: string; reservation_id: string; owner_epoch: string }> = [];
  const pg = { async query() { return { rows: [], rowCount: 0 }; } };
  const egressPlacement = {
    async closeJobById(_pg: unknown, input: typeof closed[number] & { reason: string }) {
      closed.push(input);
    }
  };
  try {
    await route(db, 'POST', '/api/ivekit/media/rooms', {
      purpose: 'video_service', room_name: 'ivekit-egress-placement-room',
      business_ref: { type: 'service_order', id: 'order-egress-placement' }
    }, authHeaders(tenantId));
    const started = await route(db, 'POST',
      '/api/ivekit/media/rooms/ivekit-egress-placement-room/recordings/start', {
        business_ref: { type: 'service_order', id: 'order-egress-placement' },
        format: 'mp4', has_video: true, recording_mode: 'track',
        tracks: [
          { track_id: 'TR_audio', kind: 'audio', source: 'microphone' },
          { track_id: 'TR_video', kind: 'video', source: 'camera' }
        ]
      }, authHeaders(tenantId)) as { data: { id: string } };
    const recordingModule = createLiveKitMediaModule({ db });
    const jobs = recordingModule.recordings.listEgressJobs(started.data.id);
    assert.equal(jobs.length, 2);
    for (const job of jobs) {
      run(db, `UPDATE livekit_egress_jobs
        SET reservation_id = ?, owner_epoch = ? WHERE id = ?`, [
        `reservation-${job.id}`, '12884901889', job.id
      ]);
    }

    const jobsResult = await routeIveKitMediaApi(
      db, 'GET', `/api/ivekit/media/recordings/${started.data.id}/jobs`,
      new URL(`http://localhost/api/ivekit/media/recordings/${started.data.id}/jobs`),
      null, '', authHeaders(tenantId)
    ) as { data: Array<Record<string, unknown>> };
    for (const job of jobsResult.data) {
      assert.equal('storage_url' in job, false);
      assert.equal('reservation_id' in job, false);
      assert.equal('owner_epoch' in job, false);
      assert.equal('reconcile_worker_id' in job, false);
      assert.equal('reconcile_lease_until' in job, false);
    }

    for (const job of jobs) {
      const rawBody = JSON.stringify({
        event: 'egress_ended', room: { name: 'ivekit-egress-placement-room' },
        egressInfo: { egressId: job.egress_id, status: 3, fileResults: [] }
      });
      await routeIveKitMediaApi(
        db, 'POST', '/api/ivekit/media/webhooks/livekit',
        new URL('http://localhost/api/ivekit/media/webhooks/livekit'),
        rawBody, rawBody, {}, { pg: pg as never, egressPlacement: egressPlacement as never }
      );
    }

    assert.deepEqual(closed.map(({ tenant_id, job_id, reservation_id, owner_epoch }) => ({
      tenant_id, job_id, reservation_id, owner_epoch
    })), jobs.map((job) => ({
      tenant_id: tenantId,
      job_id: job.id,
      reservation_id: `reservation-${job.id}`,
      owner_epoch: '12884901889'
    })));
  } finally {
    db.close();
  }
});

test('iveKit media facade is registered in the main HTTP router', async () => {
  process.env.OPC_API_KEY = API_KEY;
  clearLiveKitEnv();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'HTTP Router Media Tenant' }).id;
  const server = createOpcServer(db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ivekit/media/capabilities`, {
      headers: authHeaders(tenantId)
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { provider: string; tenant_id: string };
    assert.equal(payload.provider, 'livekit');
    assert.equal(payload.tenant_id, tenantId);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
