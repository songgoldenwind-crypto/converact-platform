import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCustomerMediaJoinPath,
  customerMediaJoinErrorMessage,
  fetchCustomerMediaJoinPlan,
  readCustomerMediaJoinPlan,
  type CustomerMediaJoinError
} from '../frontend/src/pages/video-call-join.js';

test('customer video join path carries tenant, room, identity, media and signed invite parameters', () => {
  const path = buildCustomerMediaJoinPath({
    roomName: 'room A/B',
    identity: 'customer 1',
    tenantId: 'tenant-x',
    invite: 'signed+value==',
    expiresAt: '1893456000000'
  });

  const url = new URL(`http://localhost${path}`);
  assert.equal(url.pathname, '/api/media/livekit/join');
  assert.equal(url.searchParams.get('channel'), 'webrtc');
  assert.equal(url.searchParams.get('room_name'), 'room A/B');
  assert.equal(url.searchParams.get('identity'), 'customer 1');
  assert.equal(url.searchParams.get('role'), 'customer');
  assert.equal(url.searchParams.get('tenant_id'), 'tenant-x');
  assert.equal(url.searchParams.get('media'), 'video');
  assert.equal(url.searchParams.get('invite'), 'signed+value==');
  assert.equal(url.searchParams.get('expires_at'), '1893456000000');
});

test('customer video join parser unwraps the API data envelope', () => {
  const plan = readCustomerMediaJoinPlan({
    ok: true,
    status: 200,
    body: {
      data: {
        mode: 'webrtc',
        token: {
          token: 'livekit-token',
          livekit_url: 'wss://livekit.example'
        }
      }
    }
  });

  assert.equal(plan.token.token, 'livekit-token');
  assert.equal(plan.token.livekit_url, 'wss://livekit.example');
});

test('customer video join parser surfaces media API errors instead of returning an invalid token plan', () => {
  assert.throws(() => {
    try {
      readCustomerMediaJoinPlan({
        ok: false,
        status: 401,
        body: {
          error: {
            message: 'missing or invalid media invite',
            status: 401
          }
        }
      });
    } catch (error) {
      const joinError = error as CustomerMediaJoinError;
      assert.equal(joinError.code, 'invite_invalid_or_expired');
      assert.equal(joinError.status, 401);
      assert.equal(
        customerMediaJoinErrorMessage(joinError),
        '邀请已失效或签名无效，请重新获取邀请链接'
      );
      throw error;
    }
  }, /missing or invalid media invite/);
});

test('customer video join parser exposes a stable closed-room failure state', () => {
  assert.throws(() => {
    try {
      readCustomerMediaJoinPlan({
        ok: false,
        status: 409,
        body: { error: { message: 'media room is closed' } }
      });
    } catch (error) {
      const joinError = error as CustomerMediaJoinError;
      assert.equal(joinError.code, 'room_closed');
      assert.equal(customerMediaJoinErrorMessage(joinError), '通话已结束');
      throw error;
    }
  }, /media room is closed/);
});

test('customer video join fetcher fails before LiveKit connect when the server returns no token', async () => {
  await assert.rejects(async () => {
    try {
      await fetchCustomerMediaJoinPlan(
        async () => ({
          ok: true,
          status: 200,
          json: async () => ({ data: { mode: 'webrtc' } })
        }),
        {
          roomName: 'room-1',
          identity: 'customer-1',
          tenantId: 'tenant-1'
        }
      );
    } catch (error) {
      assert.equal((error as CustomerMediaJoinError).code, 'token_missing');
      throw error;
    }
  }, /invalid media join response/);
});

test('customer video join parser rejects production tokens without a LiveKit URL', () => {
  assert.throws(() => {
    try {
      readCustomerMediaJoinPlan({
        ok: true,
        status: 200,
        body: {
          token: {
            token: 'production-token'
          }
        }
      });
    } catch (error) {
      assert.equal((error as CustomerMediaJoinError).code, 'livekit_url_missing');
      throw error;
    }
  }, /livekit url is required/);
});

test('customer video join parser allows dev tokens without a LiveKit URL', () => {
  const plan = readCustomerMediaJoinPlan({
    ok: true,
    status: 200,
    body: {
      token: {
        token: 'dev-token:room-1:customer-1:customer'
      }
    }
  });

  assert.equal(plan.token.token, 'dev-token:room-1:customer-1:customer');
});
