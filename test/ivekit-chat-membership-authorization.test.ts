import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatGateway } from '../src/agent-runtime/collaboration/chat-gateway.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { TinodeProviderUserStore } from '../src/agent-runtime/collaboration/tinode-provider-user-store.js';
import { routeIveKitChatApi } from '../src/agent-runtime/ivekit/chat-http.js';
import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';

const API_KEY = 'test-ivekit-membership-key';
const JWT_SECRET = 'test-ivekit-membership-jwt-secret-32-bytes';

test('iveKit chat enforces active membership participant RBAC and non-revivable client plans', async () => {
  const previous = { apiKey: process.env.OPC_API_KEY, jwtSecret: process.env.OPC_JWT_SECRET };
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_JWT_SECRET = JWT_SECRET;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_membership_auth';
  try {
    const session = await store.openSession({
      tenant_id: tenantId,
      business_ref: { tenant_id: tenantId, type: 'service_order', id: 'AUTH-1' },
      title: 'Membership protected'
    });
    for (const [identity, role] of [
      ['member-agent', 'agent'],
      ['member-supervisor', 'supervisor'],
      ['left-member', 'customer']
    ] as const) {
      await systemRoute(pg, 'POST', `/api/ivekit/chat/sessions/${session.id}/participants`, {
        identity, role, display_name: identity
      }, tenantId);
    }
    await systemRoute(pg, 'POST', `/api/ivekit/chat/sessions/${session.id}/participants/leave`, {
      identity: 'left-member'
    }, tenantId);
    await store.postMessage({
      tenant_id: tenantId,
      session_id: session.id,
      sender_identity: 'member-agent',
      message_type: 'text',
      body: 'membership protected message'
    });

    const outsiderHeaders = jwtHeaders(tenantId, 'tenant-outsider');
    const outsiderList = await route(pg, 'GET', '/api/ivekit/chat/sessions?limit=10', null, outsiderHeaders) as {
      data: { items: unknown[] };
    };
    assert.deepEqual(outsiderList.data.items, []);
    const outsiderByRef = await route(
      pg,
      'GET',
      '/api/ivekit/chat/sessions/by-ref?business_ref_type=service_order&business_ref_id=AUTH-1',
      null,
      outsiderHeaders
    ) as { data: unknown[] };
    assert.deepEqual(outsiderByRef.data, []);
    for (const path of [
      `/api/ivekit/chat/sessions/${session.id}/messages`,
      `/api/ivekit/chat/sessions/${session.id}/findings`,
      `/api/ivekit/chat/sessions/${session.id}/attachments/missing/download`
    ]) {
      const denied = await route(pg, 'GET', path, null, outsiderHeaders) as { status: number };
      assert.equal(denied.status, 404, path);
    }

    const memberHeaders = jwtHeaders(tenantId, 'member-agent');
    const memberList = await route(pg, 'GET', '/api/ivekit/chat/sessions?limit=10', null, memberHeaders) as {
      data: { items: Array<{ id: string }> };
    };
    assert.deepEqual(memberList.data.items.map((item) => item.id), [session.id]);
    const memberMessages = await route(
      pg,
      'GET',
      `/api/ivekit/chat/sessions/${session.id}/messages`,
      null,
      memberHeaders
    ) as { data: Array<{ body: string }> };
    assert.equal(memberMessages.data[0]?.body, 'membership protected message');

    const leftHeaders = jwtHeaders(tenantId, 'left-member');
    const leftList = await route(pg, 'GET', '/api/ivekit/chat/sessions?limit=10', null, leftHeaders) as {
      data: { items: unknown[] };
    };
    assert.deepEqual(leftList.data.items, []);
    const leftPlan = await route(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${session.id}/client-plan`,
      { identity: 'left-member' },
      leftHeaders
    ) as { status: number };
    assert.equal(leftPlan.status, 404);

    const selfEscalation = await route(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${session.id}/participants`,
      { identity: 'member-agent', role: 'admin' },
      memberHeaders
    ) as { status: number };
    assert.equal(selfEscalation.status, 403);
    const removeOther = await route(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${session.id}/participants/leave`,
      { identity: 'member-supervisor' },
      memberHeaders
    ) as { status: number };
    assert.equal(removeOther.status, 403);

    const supervisorHeaders = jwtHeaders(tenantId, 'member-supervisor');
    const added = await route(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${session.id}/participants`,
      { identity: 'invited-customer', role: 'customer' },
      supervisorHeaders
    ) as { status: number; data: { identity: string } };
    assert.equal(added.status, 201);
    assert.equal(added.data.identity, 'invited-customer');
    const removed = await route(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${session.id}/participants/leave`,
      { identity: 'invited-customer' },
      supervisorHeaders
    ) as { status: number };
    assert.equal(removed.status, 201);

    const selfLeft = await route(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${session.id}/participants/leave`,
      { identity: 'member-agent' },
      memberHeaders
    ) as { status: number };
    assert.equal(selfLeft.status, 201);
    const afterLeave = await route(
      pg,
      'GET',
      `/api/ivekit/chat/sessions/${session.id}/messages`,
      null,
      memberHeaders
    ) as { status: number };
    assert.equal(afterLeave.status, 404);

    const systemPlanForLeft = await systemRoute(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${session.id}/client-plan`,
      { identity: 'left-member' },
      tenantId
    ) as { status: number };
    assert.equal(systemPlanForLeft.status, 404);

    const createdByUser = await route(
      pg,
      'POST',
      '/api/ivekit/chat/sessions',
      { business_ref: { type: 'support_ticket', id: 'AUTH-SELF' }, title: 'Creator membership' },
      jwtHeaders(tenantId, 'session-creator')
    ) as { status: number; data: { id: string } };
    assert.equal(createdByUser.status, 201);
    const creatorParticipant = (await store.listParticipants({
      tenant_id: tenantId,
      session_id: createdByUser.data.id
    })).find((item) => item.identity === 'session-creator');
    assert.equal(creatorParticipant?.role, 'agent');
    assert.equal(creatorParticipant?.left_at, null);
  } finally {
    restoreEnv('OPC_API_KEY', previous.apiKey);
    restoreEnv('OPC_JWT_SECRET', previous.jwtSecret);
  }
});

test('iveKit fails participant leave fast during a Tinode client-plan grant and succeeds on retry', async () => {
  const previous = {
    apiKey: process.env.OPC_API_KEY,
    publicWsUrl: process.env.TINODE_PUBLIC_WS_URL,
    tinodeApiKey: process.env.TINODE_API_KEY
  };
  process.env.OPC_API_KEY = API_KEY;
  process.env.TINODE_PUBLIC_WS_URL = 'wss://chat.example.test/v0/channels';
  process.env.TINODE_API_KEY = 'public-test-api-key';
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_membership_race';
  const started = deferred<void>();
  const releaseProvisioning = deferred<void>();
  const operations: string[] = [];
  const gateway: ChatGateway = {
    provider: 'tinode',
    ensureTopic: async () => ({
      provider: 'tinode',
      provider_topic_id: 'grp-membership-race',
      provider_status: 'bound',
      metadata: {}
    }),
    ensureUser: async () => {
      started.resolve();
      await releaseProvisioning.promise;
      return {
        provider_user_id: 'usr-membership-race',
        provider_auth_token: 'participant-test-token',
        metadata: {}
      };
    },
    addParticipant: async () => {
      operations.push('grant');
    },
    removeParticipant: async () => {
      operations.push('revoke');
    },
    publishMessage: async () => ({
      provider: 'tinode',
      provider_topic_id: 'grp-membership-race',
      provider_message_id: '',
      provider_sync_status: 'skipped',
      metadata: {}
    })
  };
  try {
    const session = await store.openSession({
      tenant_id: tenantId,
      business_ref: { tenant_id: tenantId, type: 'service_order', id: 'AUTH-RACE' }
    });
    await store.addParticipant({
      tenant_id: tenantId,
      session_id: session.id,
      identity: 'race-member',
      role: 'customer'
    });
    await store.ensureChatBinding({
      tenant_id: tenantId,
      session_id: session.id,
      provider: 'tinode',
      provider_topic_id: 'grp-membership-race'
    });

    const planPromise = systemRoute(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${session.id}/client-plan`,
      { identity: 'race-member' },
      tenantId,
      gateway
    ) as Promise<{ status: number }>;
    const provisioningStarted = await Promise.race([
      started.promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ]);
    assert.equal(provisioningStarted, true, 'client-plan must use the injected Tinode gateway');

    const leaveAttempt = systemRoute(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${session.id}/participants/leave`,
      { identity: 'race-member' },
      tenantId,
      gateway
    ).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    );
    const busy = await leaveAttempt;
    assert.equal((busy.error as { status?: number }).status, 409);
    assert.equal((busy.error as { code?: string }).code, 'collaboration_participant_busy');
    assert.equal((busy.error as { retryable?: boolean }).retryable, true);
    releaseProvisioning.resolve();

    const plan = await planPromise;
    assert.equal(plan.status, 201);
    const leave = await systemRoute(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${session.id}/participants/leave`,
      { identity: 'race-member' },
      tenantId,
      gateway
    ) as { status: number };
    assert.equal(leave.status, 201);
    assert.deepEqual(operations, ['grant', 'revoke']);
    const mapping = await new TinodeProviderUserStore(pg).getByIdentity({
      tenant_id: tenantId,
      session_id: session.id,
      provider: 'tinode',
      identity: 'race-member'
    });
    assert.equal(mapping?.provider_user_id, 'usr-membership-race');
    assert.equal(mapping?.status, 'revoked');
  } finally {
    releaseProvisioning.resolve();
    restoreEnv('OPC_API_KEY', previous.apiKey);
    restoreEnv('TINODE_PUBLIC_WS_URL', previous.publicWsUrl);
    restoreEnv('TINODE_API_KEY', previous.tinodeApiKey);
  }
});

async function route(
  pg: MemoryPg,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  chatGateway?: ChatGateway
) {
  return routeIveKitChatApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    headers,
    chatGateway ? { chatGateway } : undefined
  );
}

function systemRoute(
  pg: MemoryPg,
  method: string,
  path: string,
  body: unknown,
  tenantId: string,
  chatGateway?: ChatGateway
) {
  return route(pg, method, path, body, {
    'X-API-Key': API_KEY,
    'X-Tenant-Id': tenantId,
    'X-User-Id': 'led-service'
  }, chatGateway);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((currentResolve) => {
    resolve = currentResolve;
  });
  return { promise, resolve };
}

function jwtHeaders(tenantId: string, identity: string, role: 'owner' | 'admin' | 'operator' | 'viewer' = 'operator') {
  return { Authorization: `Bearer ${signAccessToken({ sub: identity, tid: tenantId, role }, 3_600)}` };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
