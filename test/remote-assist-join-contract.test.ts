import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRemoteAssistConsentGrantPath,
  buildRemoteAssistConsentRevokePath,
  buildRemoteAssistMediaJoinPath,
  buildRemoteAssistEventPath,
  buildRemoteAssistRecordingStartPath,
  buildRemoteAssistRecordingStopPath,
  buildRemoteAssistVerifyPath,
  fetchRemoteAssistJoinVerification,
  fetchRemoteAssistMediaJoinPlan,
  postRemoteAssistConsentGrant,
  postRemoteAssistConsentRevoke,
  postRemoteAssistEvent,
  postRemoteAssistRecordingStart,
  postRemoteAssistRecordingStop,
  readRemoteAssistConsentEventResult,
  readRemoteAssistMediaJoinPlan,
  readRemoteAssistEventResult,
  readRemoteAssistRecordingResult,
  readRemoteAssistJoinVerification
} from '../frontend/src/pages/remote-assist-join.js';

test('remote assist verify path carries tenant session and token parameters', () => {
  const path = buildRemoteAssistVerifyPath({
    tenantId: 'tenant-1',
    remoteSessionId: 'remote A/B',
    token: 'signed.token+value'
  });

  const url = new URL(`http://localhost${path}`);
  assert.equal(url.pathname, '/api/collaboration/remote-assistance/remote%20A%2FB/web-assist/verify');
  assert.equal(url.searchParams.get('tenant_id'), 'tenant-1');
  assert.equal(url.searchParams.get('token'), 'signed.token+value');
});

test('remote assist verify parser unwraps the API data envelope', () => {
  const verified = readRemoteAssistJoinVerification({
    ok: true,
    status: 200,
    body: {
      data: {
        tenant_id: 'tenant-1',
        remote_session_id: 'remote-1',
        actor_identity: 'engineer-1',
        role: 'engineer',
        expires_at: '2099-01-01T00:00:00.000Z'
      }
    }
  });

  assert.equal(verified.actor_identity, 'engineer-1');
  assert.equal(verified.role, 'engineer');
});

test('remote assist verify parser surfaces token errors', () => {
  assert.throws(
    () =>
      readRemoteAssistJoinVerification({
        ok: false,
        status: 401,
        body: {
          error: {
            message: 'invalid Web Assist token',
            status: 401
          }
        }
      }),
    /invalid Web Assist token/
  );
});

test('remote assist fetcher fails before rendering a session when verify response is invalid', async () => {
  await assert.rejects(
    () =>
      fetchRemoteAssistJoinVerification(
        async () => ({
          ok: true,
          status: 200,
          json: async () => ({ data: { role: 'engineer' } })
        }),
        {
          tenantId: 'tenant-1',
          remoteSessionId: 'remote-1',
          token: 'signed-token'
        }
      ),
    /invalid remote assist verify response/
  );
});

test('remote assist event path carries tenant session and token parameters', () => {
  const path = buildRemoteAssistEventPath({
    tenantId: 'tenant-1',
    remoteSessionId: 'remote A/B',
    token: 'signed.token+value',
    eventType: 'screen.share_started',
    payload: { video: true }
  });

  const url = new URL(`http://localhost${path}`);
  assert.equal(url.pathname, '/api/collaboration/remote-assistance/remote%20A%2FB/web-assist/events');
  assert.equal(url.searchParams.get('tenant_id'), 'tenant-1');
  assert.equal(url.searchParams.get('token'), 'signed.token+value');
});

test('remote assist event parser unwraps the API data envelope', () => {
  const event = readRemoteAssistEventResult({
    ok: true,
    status: 201,
    body: {
      data: {
        remote_session_id: 'remote-1',
        actor_identity: 'buyer-1',
        event_type: 'screen.share_started',
        payload: { video: true },
        created_at: '2099-01-01T00:00:00.000Z'
      }
    }
  });

  assert.equal(event.actor_identity, 'buyer-1');
  assert.equal(event.event_type, 'screen.share_started');
  assert.deepEqual(event.payload, { video: true });
});

test('remote assist event fetcher sends JSON event payload', async () => {
  const calls: Array<{ path: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  await postRemoteAssistEvent(
    async (path, init) => {
      calls.push({ path, init });
      return {
        ok: true,
        status: 201,
        json: async () => ({
          data: {
            remote_session_id: 'remote-1',
            actor_identity: 'buyer-1',
            event_type: 'screen.share_started',
            payload: { video: true },
            created_at: '2099-01-01T00:00:00.000Z'
          }
        })
      };
    },
    {
      tenantId: 'tenant-1',
      remoteSessionId: 'remote-1',
      token: 'signed-token',
      eventType: 'screen.share_started',
      payload: { video: true }
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.headers?.['Content-Type'], 'application/json');
  assert.equal(calls[0].init?.body, JSON.stringify({ event_type: 'screen.share_started', payload: { video: true } }));
});

test('remote assist consent paths carry tenant session and token parameters', () => {
  const grantPath = buildRemoteAssistConsentGrantPath({
    tenantId: 'tenant-1',
    remoteSessionId: 'remote A/B',
    token: 'signed.token+value',
    scopes: ['view_screen']
  });
  const revokePath = buildRemoteAssistConsentRevokePath({
    tenantId: 'tenant-1',
    remoteSessionId: 'remote A/B',
    token: 'signed.token+value',
    scopes: ['view_screen']
  });

  const grantUrl = new URL(`http://localhost${grantPath}`);
  const revokeUrl = new URL(`http://localhost${revokePath}`);
  assert.equal(grantUrl.pathname, '/api/collaboration/remote-assistance/remote%20A%2FB/web-assist/consent/grant');
  assert.equal(revokeUrl.pathname, '/api/collaboration/remote-assistance/remote%20A%2FB/web-assist/consent/revoke');
  assert.equal(grantUrl.searchParams.get('tenant_id'), 'tenant-1');
  assert.equal(grantUrl.searchParams.get('token'), 'signed.token+value');
  assert.equal(revokeUrl.searchParams.get('tenant_id'), 'tenant-1');
  assert.equal(revokeUrl.searchParams.get('token'), 'signed.token+value');
});

test('remote assist consent parser unwraps grant and revoke events', () => {
  const event = readRemoteAssistConsentEventResult({
    ok: true,
    status: 201,
    body: {
      data: {
        id: 'consent-1',
        tenant_id: 'tenant-1',
        remote_session_id: 'remote-1',
        actor_identity: 'buyer-1',
        event_type: 'granted',
        scopes: ['view_screen'],
        expires_at: '2099-01-01T00:00:00.000Z',
        metadata: {},
        created_at: '2099-01-01T00:00:00.000Z'
      }
    }
  });

  assert.equal(event.event_type, 'granted');
  assert.deepEqual(event.scopes, ['view_screen']);
});

test('remote assist consent fetchers send explicit scopes', async () => {
  const calls: Array<{ path: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const fetcher = async (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ path, init });
    return {
      ok: true,
      status: 201,
      json: async () => ({
        data: {
          id: `consent-${calls.length}`,
          tenant_id: 'tenant-1',
          remote_session_id: 'remote-1',
          actor_identity: 'buyer-1',
          event_type: calls.length === 1 ? 'granted' : 'revoked',
          scopes: ['view_screen', 'record_screen'],
          expires_at: calls.length === 1 ? '2099-01-01T00:00:00.000Z' : null,
          metadata: {},
          created_at: '2099-01-01T00:00:00.000Z'
        }
      })
    };
  };

  await postRemoteAssistConsentGrant(fetcher, {
    tenantId: 'tenant-1',
    remoteSessionId: 'remote-1',
    token: 'signed-token',
    scopes: ['view_screen', 'record_screen'],
    expiresAt: '2099-01-01T00:00:00.000Z'
  });
  await postRemoteAssistConsentRevoke(fetcher, {
    tenantId: 'tenant-1',
    remoteSessionId: 'remote-1',
    token: 'signed-token',
    scopes: ['view_screen', 'record_screen']
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /\/web-assist\/consent\/grant/);
  assert.match(calls[1].path, /\/web-assist\/consent\/revoke/);
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[1].init?.method, 'POST');
  assert.equal(calls[0].init?.headers?.['Content-Type'], 'application/json');
  assert.equal(
    calls[0].init?.body,
    JSON.stringify({ scopes: ['view_screen', 'record_screen'], expires_at: '2099-01-01T00:00:00.000Z' })
  );
  assert.equal(calls[1].init?.body, JSON.stringify({ scopes: ['view_screen', 'record_screen'] }));
});

test('remote assist recording paths carry tenant session token and egress parameters', () => {
  const startPath = buildRemoteAssistRecordingStartPath({
    tenantId: 'tenant-1',
    remoteSessionId: 'remote A/B',
    token: 'signed.token+value'
  });
  const stopPath = buildRemoteAssistRecordingStopPath({
    tenantId: 'tenant-1',
    remoteSessionId: 'remote A/B',
    token: 'signed.token+value',
    egressId: 'egress A/B'
  });

  const startUrl = new URL(`http://localhost${startPath}`);
  const stopUrl = new URL(`http://localhost${stopPath}`);
  assert.equal(startUrl.pathname, '/api/collaboration/remote-assistance/remote%20A%2FB/web-assist/recordings/start');
  assert.equal(stopUrl.pathname, '/api/collaboration/remote-assistance/remote%20A%2FB/web-assist/recordings/egress%20A%2FB/stop');
  assert.equal(startUrl.searchParams.get('tenant_id'), 'tenant-1');
  assert.equal(startUrl.searchParams.get('token'), 'signed.token+value');
  assert.equal(stopUrl.searchParams.get('tenant_id'), 'tenant-1');
  assert.equal(stopUrl.searchParams.get('token'), 'signed.token+value');
});

test('remote assist recording parser unwraps recording evidence results', () => {
  const recording = readRemoteAssistRecordingResult({
    ok: true,
    status: 201,
    body: {
      data: {
        id: 'recording-1',
        tenant_id: 'tenant-1',
        format: 'mp4',
        storage_url: 'recordings/tenant-1/service_order/order-1/1.mp4',
        has_video: 1,
        egress_id: 'egress-1',
        evidence_record_id: 'evidence-1',
        evidence_record: {
          id: 'evidence-1',
          kind: 'video_recording'
        }
      }
    }
  });

  assert.equal(recording.id, 'recording-1');
  assert.equal(recording.egress_id, 'egress-1');
  assert.equal(recording.evidence_record_id, 'evidence-1');
  assert.equal(recording.evidence_record?.kind, 'video_recording');
});

test('remote assist recording fetchers start and stop screen recordings', async () => {
  const calls: Array<{ path: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const fetcher = async (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ path, init });
    return {
      ok: true,
      status: 201,
      json: async () => ({
        data: {
          id: 'recording-1',
          tenant_id: 'tenant-1',
          format: 'mp4',
          storage_url: 'recordings/tenant-1/service_order/order-1/1.mp4',
          has_video: 1,
          egress_id: 'egress-1',
          evidence_record_id: 'evidence-1',
          evidence_record: {
            id: 'evidence-1',
            kind: 'video_recording'
          }
        }
      })
    };
  };

  const started = await postRemoteAssistRecordingStart(fetcher, {
    tenantId: 'tenant-1',
    remoteSessionId: 'remote-1',
    token: 'signed-token',
    format: 'mp4'
  });
  await postRemoteAssistRecordingStop(fetcher, {
    tenantId: 'tenant-1',
    remoteSessionId: 'remote-1',
    token: 'signed-token',
    egressId: started.egress_id
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /\/web-assist\/recordings\/start/);
  assert.match(calls[1].path, /\/web-assist\/recordings\/egress-1\/stop/);
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[1].init?.method, 'POST');
  assert.equal(calls[0].init?.headers?.['Content-Type'], 'application/json');
  assert.equal(calls[0].init?.body, JSON.stringify({ format: 'mp4' }));
});

test('remote assist media join path carries tenant session and token parameters', () => {
  const path = buildRemoteAssistMediaJoinPath({
    tenantId: 'tenant-1',
    remoteSessionId: 'remote A/B',
    token: 'signed.token+value'
  });

  const url = new URL(`http://localhost${path}`);
  assert.equal(url.pathname, '/api/collaboration/remote-assistance/remote%20A%2FB/web-assist/media/join');
  assert.equal(url.searchParams.get('tenant_id'), 'tenant-1');
  assert.equal(url.searchParams.get('token'), 'signed.token+value');
});

test('remote assist media join parser requires a LiveKit token plan', () => {
  const plan = readRemoteAssistMediaJoinPlan({
    ok: true,
    status: 200,
    body: {
      data: {
        mode: 'webrtc',
        token: {
          token: 'dev-token:room-1:buyer-1:customer',
          livekit_url: 'ws://localhost:7880',
          room_name: 'room-1'
        }
      }
    }
  });

  assert.equal(plan.token.token, 'dev-token:room-1:buyer-1:customer');
  assert.equal(plan.token.room_name, 'room-1');

  assert.throws(
    () =>
      readRemoteAssistMediaJoinPlan({
        ok: true,
        status: 200,
        body: { data: { mode: 'webrtc' } }
      }),
    /invalid remote assist media join response/
  );
});

test('remote assist media join fetcher calls the signed media endpoint', async () => {
  const calls: string[] = [];
  const plan = await fetchRemoteAssistMediaJoinPlan(
    async (path) => {
      calls.push(path);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            mode: 'webrtc',
            token: {
              token: 'dev-token:room-1:buyer-1:customer',
              livekit_url: 'ws://localhost:7880',
              room_name: 'room-1'
            }
          }
        })
      };
    },
    {
      tenantId: 'tenant-1',
      remoteSessionId: 'remote-1',
      token: 'signed-token'
    }
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/web-assist\/media\/join/);
  assert.equal(plan.token.room_name, 'room-1');
});
