import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createIveKitClient } from '../sdk/ivekit/src/index.js';
import { routeIveKitMediaApi } from '../src/agent-runtime/ivekit/media-http.js';
import type {
  IveKitMediaConnectionEventResult,
  IveKitMediaQualityReportResult,
  IveKitMediaQualitySummary
} from '../src/agent-runtime/livekit/types.js';
import { createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';
import { IveKitTenantEventStore } from '../src/agent-runtime/ivekit/tenant-event-store.js';
import { initWebSocket, shutdownWebSocket } from '../src/ws.js';

const JWT_SECRET = 'livekit-media-quality-jwt-secret-32-bytes';
const sampledAt = '2026-07-15T07:59:50.000Z';

test('media QoS routes are call-bound, self-scoped, and publish safe events', async () => {
  const previousSecret = process.env.OPC_JWT_SECRET;
  process.env.OPC_JWT_SECRET = JWT_SECRET;
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenantId = 'tenant_media_quality_http';
  const hostHeaders = jwtHeaders(tenantId, 'host-quality');
  const events: Array<{
    tenant_id: string;
    type: string;
    data: unknown;
    idempotency_key?: string;
  }> = [];
  const calls: Array<Record<string, unknown>> = [];
  let callId = '';
  const durableEvents = new IveKitTenantEventStore(pg, {
    cursor_secret: 'media-quality-http-event-secret'
  });
  const beforeEvents = await durableEvents.headCursor(tenantId);
  const wsServer = createServer();
  initWebSocket(wsServer, { eventStore: durableEvents });

  const participant = {
    tenant_id: tenantId,
    call_id: '',
    identity: 'host-quality',
    participant_status: 'joined' as const,
    connection_revision: 1,
    connection_state: 'connected' as const,
    connection_updated_at: sampledAt,
    last_disconnected_at: null,
    last_rejoined_at: null,
    quality_state: 'degraded' as const,
    quality_degraded_streak: 3,
    quality_recovered_streak: 0,
    last_quality_level: 'poor' as const,
    last_quality_sample_id: 'sample-http-1',
    last_qos_at: sampledAt
  };
  const qualityService = {
    reportQuality: async (input: Record<string, unknown>): Promise<IveKitMediaQualityReportResult> => {
      calls.push(input);
      const reportedAt = String(
        (input.snapshots as Array<{ sampled_at?: string }> | undefined)?.[0]?.sampled_at || sampledAt
      );
      return {
        accepted: 1,
        replayed: 0,
        participant_states: [{ ...participant, call_id: callId }],
        transitions: [{
          tenant_id: tenantId,
          call_id: callId,
          participant_identity: 'host-quality',
          connection_revision: 1,
          from: 'good',
          to: 'degraded',
          event_type: 'degraded',
          quality_level: 'poor',
          sampled_at: reportedAt
        }]
      };
    },
    getSummary: async (input: Record<string, unknown>): Promise<IveKitMediaQualitySummary> => {
      calls.push(input);
      return {
        tenant_id: tenantId,
        call_id: callId,
        generated_at: '2026-07-15T08:00:00.000Z',
        participants: [{ ...participant, call_id: callId }],
        recent_snapshots: []
      };
    },
    reportConnectionEvent: async (
      input: Record<string, unknown>
    ): Promise<IveKitMediaConnectionEventResult> => {
      calls.push(input);
      return {
        replayed: false,
        participant_state: { ...participant, call_id: callId, connection_state: 'rejoining' },
        event: {
          id: 'mconn-http-1',
          tenant_id: tenantId,
          call_id: callId,
          participant_identity: 'host-quality',
          event_id: 'connection-http-1',
          connection_revision: 2,
          event_type: 'rejoining',
          connection_state: 'rejoining',
          reason_code: 'network_change',
          occurred_at: sampledAt,
          received_at: sampledAt
        }
      };
    },
    prune: async () => 0
  };
  const options = {
    pg,
    mediaQualityService: qualityService,
    eventStore: {
      append: async (event: {
        tenant_id: string;
        type: string;
        data: unknown;
        idempotency_key?: string;
      }) => {
        events.push(event);
        await durableEvents.append(event);
      }
    }
  };

  try {
    const created = await route(
      db,
      'POST',
      '/api/ivekit/media/calls',
      {
        media: 'video',
        participant_identities: [],
        business_ref: { type: 'led_session', id: 'LED-QOS-1' }
      },
      hostHeaders,
      options
    ) as { data: { call: { id: string } } };
    callId = created.data.call.id;

    const qosPath = `/api/ivekit/media/calls/${callId}/qos`;
    const qos = await route(db, 'POST', qosPath, {
      snapshots: [{
        participant_identity: 'host-quality',
        connection_revision: 1,
        sample_id: 'sample-http-1',
        track_source: 'camera',
        quality_level: 'poor',
        packet_loss_ratio: 0.2,
        sampled_at: sampledAt
      }]
    }, hostHeaders, options) as {
      status: number;
      data: IveKitMediaQualityReportResult;
      afterCommit: () => Promise<void>;
    };
    assert.equal(qos.status, 202);
    assert.equal(qos.data.transitions[0]?.event_type, 'degraded');
    await qos.afterCommit();
    assert.equal(events[0]?.type, 'ivekit.media.qos.degraded');
    assert.match(events[0]?.idempotency_key || '', /^media-qos:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(events).includes('sdp'), false);
    assert.equal(JSON.stringify(events).includes('ice_candidate'), false);
    assert.equal(JSON.stringify(events).includes('token'), false);

    const summary = await route(db, 'GET', `${qosPath}?limit=10`, null, hostHeaders, options) as {
      data: IveKitMediaQualitySummary;
    };
    assert.equal(summary.data.call_id, callId);
    assert.equal(calls[1]?.limit, 10);

    const repeatedQos = await route(db, 'POST', qosPath, {
      snapshots: [{
        participant_identity: 'host-quality',
        connection_revision: 1,
        sample_id: 'sample-http-2',
        track_source: 'camera',
        quality_level: 'poor',
        packet_loss_ratio: 0.25,
        sampled_at: '2026-07-15T08:00:10.000Z'
      }]
    }, hostHeaders, options) as { afterCommit: () => Promise<void> };
    await repeatedQos.afterCommit();
    assert.equal(events[1]?.type, 'ivekit.media.qos.degraded');
    assert.match(events[1]?.idempotency_key || '', /^media-qos:[a-f0-9]{64}$/);
    assert.notEqual(events[0]?.idempotency_key, events[1]?.idempotency_key);

    const connectionPath = `/api/ivekit/media/calls/${callId}/connection-events`;
    const connection = await route(db, 'POST', connectionPath, {
      participant_identity: 'host-quality',
      event_id: 'connection-http-1',
      connection_revision: 2,
      event_type: 'rejoining',
      reason_code: 'network_change',
      occurred_at: sampledAt
    }, hostHeaders, options) as {
      status: number;
      data: IveKitMediaConnectionEventResult;
      afterCommit: () => Promise<void>;
    };
    assert.equal(connection.status, 202);
    await connection.afterCommit();
    assert.equal(events[2]?.type, 'ivekit.media.connection.rejoining');
    assert.match(events[2]?.idempotency_key || '', /^media-connection:[a-f0-9]{64}$/);
    assert.notEqual(events[1]?.idempotency_key, events[2]?.idempotency_key);
    const replay = await durableEvents.list({
      tenant_id: tenantId,
      user_id: 'host-quality',
      role: 'operator',
      cursor: beforeEvents,
      limit: 10
    });
    assert.deepEqual(replay.items.map((event) => event.type), [
      'ivekit.media.qos.degraded',
      'ivekit.media.qos.degraded',
      'ivekit.media.connection.rejoining'
    ]);

    await assert.rejects(
      () => route(db, 'POST', qosPath, {
        snapshots: [{
          participant_identity: 'someone-else',
          connection_revision: 1,
          sample_id: 'forbidden',
          track_source: 'camera',
          quality_level: 'good',
          sampled_at: sampledAt
        }]
      }, hostHeaders, options),
      (error: Error & { status?: number }) => error.status === 403
    );
  } finally {
    await shutdownWebSocket();
    wsServer.close();
    db.close();
    restoreEnv('OPC_JWT_SECRET', previousSecret);
  }
});

test('iveKit SDK maps QoS summary, report, and connection event routes', async () => {
  const calls: Array<{ method: string; url: URL; body: unknown }> = [];
  const client = createIveKitClient({
    baseUrl: 'https://ivekit.example.test',
    tenantId: 'tenant-media-sdk',
    apiKey: 'media-sdk-key',
    userId: 'host-sdk',
    fetch: async (input, init = {}) => {
      calls.push({
        method: init.method || 'GET',
        url: new URL(String(input)),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null
      });
      return Response.json({ accepted: 1, replayed: 0, participant_states: [], transitions: [] });
    }
  });
  const sample = {
    participant_identity: 'host-sdk',
    connection_revision: 1,
    sample_id: 'sdk-sample-1',
    track_source: 'microphone' as const,
    quality_level: 'good' as const,
    sampled_at: sampledAt
  };
  await client.media.reportCallQuality('call/sdk', [sample]);
  await client.media.getCallQuality('call/sdk', { limit: 25 });
  await client.media.reportCallConnectionEvent('call/sdk', {
    participant_identity: 'host-sdk',
    event_id: 'sdk-connection-1',
    connection_revision: 1,
    event_type: 'connected',
    occurred_at: sampledAt
  });

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.pathname}`), [
    'POST /api/ivekit/media/calls/call%2Fsdk/qos',
    'GET /api/ivekit/media/calls/call%2Fsdk/qos',
    'POST /api/ivekit/media/calls/call%2Fsdk/connection-events'
  ]);
  assert.equal(calls[1]?.url.searchParams.get('limit'), '25');
  assert.deepEqual((calls[0]?.body as { snapshots: unknown[] }).snapshots, [sample]);
});

function route(
  db: unknown,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  options: Parameters<typeof routeIveKitMediaApi>[7]
) {
  return routeIveKitMediaApi(
    db,
    method,
    path.split('?')[0],
    new URL(`http://localhost${path}`),
    body,
    '',
    headers,
    options
  );
}

function jwtHeaders(tenantId: string, userId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${signAccessToken({ sub: userId, tid: tenantId, role: 'operator' })}`
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
