import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  ContactCenterError,
  routeIveKitContactCenterApi,
  type ContactCenterHttpModule
} from '../src/agent-runtime/ivekit/contact-center/index.js';
import { signAccessToken } from '../src/middleware/auth.js';

test('Contact Center HTTP keeps configuration under signed tenant and admin authority', async (t) => {
  const auth = installAuth(t, 'admin-a', 'admin');
  const observed: Array<Record<string, unknown>> = [];
  const module = {
    configuration: {
      async listAgents(input: Record<string, unknown>) {
        observed.push({ operation: 'listAgents', ...input });
        return { items: [], next_cursor: null };
      },
      async createAgent(input: Record<string, unknown>) {
        observed.push({ operation: 'createAgent', ...input });
        return { agent: { id: 'agent-a', tenant_id: input.tenant_id }, presence: {}, skills: [] };
      },
      async createQueue(input: Record<string, unknown>) {
        observed.push({ operation: 'createQueue', ...input });
        return { queue: { id: 'queue-a', tenant_id: input.tenant_id }, memberships: [], skill_requirements: [] };
      }
    }
  } as unknown as ContactCenterHttpModule;
  const headers = { authorization: `Bearer ${auth}` };

  const listed = await routeIveKitContactCenterApi(
    null, 'GET', '/api/ivekit/contact-center/agents',
    new URL('http://localhost/api/ivekit/contact-center/agents?limit=25&status=active'),
    {}, '', headers, { module }
  ) as { data: { next_cursor: null } };
  assert.equal(listed.data.next_cursor, null);

  await routeIveKitContactCenterApi(
    null, 'POST', '/api/ivekit/contact-center/agents',
    new URL('http://localhost/api/ivekit/contact-center/agents'),
    { identity: 'agent-a', voice_capacity: 2 }, '',
    { ...headers, 'idempotency-key': 'agent-create-a' }, { module }
  );
  await routeIveKitContactCenterApi(
    null, 'POST', '/api/ivekit/contact-center/queues',
    new URL('http://localhost/api/ivekit/contact-center/queues'),
    { name: 'Support', routing_strategy: 'longest_idle' }, '',
    { ...headers, 'idempotency-key': 'queue-create-a' }, { module }
  );
  assert.deepEqual(observed.map((item) => [item.operation, item.tenant_id, item.actor]), [
    ['listAgents', 'tenant-a', undefined],
    ['createAgent', 'tenant-a', 'admin-a'],
    ['createQueue', 'tenant-a', 'admin-a']
  ]);
  assert.equal(observed[1]?.idempotency_key, 'agent-create-a');
  assert.equal(observed[2]?.idempotency_key, 'queue-create-a');

  await assert.rejects(
    () => routeIveKitContactCenterApi(
      null, 'POST', '/api/ivekit/contact-center/skills',
      new URL('http://localhost/api/ivekit/contact-center/skills'),
      { name: 'Sales' }, '', headers, { module }
    ),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'validation_failed'
  );

  await assert.rejects(
    () => routeIveKitContactCenterApi(
      null, 'POST', '/api/ivekit/contact-center/agents',
      new URL('http://localhost/api/ivekit/contact-center/agents?tenant_id=tenant-b'),
      { tenant_id: 'tenant-b', identity: 'agent-b' }, '', headers, { module }
    ),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'validation_failed'
  );
});

test('Contact Center HTTP permits presence changes only for the bound agent or admin', async (t) => {
  const token = installAuth(t, 'identity-a', 'operator');
  const updates: Array<Record<string, unknown>> = [];
  const module = {
    configuration: {
      async getAgent(_tenantId: string, agentId: string) {
        return {
          agent: { id: agentId, identity: agentId === 'agent-a' ? 'identity-a' : 'identity-b' },
          presence: {}, skills: []
        };
      },
      async updatePresence(input: Record<string, unknown>) {
        updates.push(input);
        return input;
      }
    }
  } as unknown as ContactCenterHttpModule;
  const headers = { authorization: `Bearer ${token}` };

  await routeIveKitContactCenterApi(
    null, 'POST', '/api/ivekit/contact-center/agents/agent-a/presence',
    new URL('http://localhost/api/ivekit/contact-center/agents/agent-a/presence'),
    { state: 'available', session_ref: 'browser-a' }, '', headers, { module }
  );
  assert.deepEqual(updates, [{
    tenant_id: 'tenant-a', actor: 'identity-a', agent_id: 'agent-a',
    state: 'available', session_ref: 'browser-a'
  }]);

  await assert.rejects(
    () => routeIveKitContactCenterApi(
      null, 'POST', '/api/ivekit/contact-center/agents/agent-b/presence',
      new URL('http://localhost/api/ivekit/contact-center/agents/agent-b/presence'),
      { state: 'available' }, '', headers, { module }
    ),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'not_found'
  );
});

test('Contact Center HTTP binds routing actions to idempotency and authenticated agent identity', async (t) => {
  const token = installAuth(t, 'identity-a', 'operator');
  const observed: Array<Record<string, unknown>> = [];
  const module = {
    configuration: {
      async getAgentByIdentity(tenantId: string, identity: string) {
        observed.push({ operation: 'getAgentByIdentity', tenant_id: tenantId, identity });
        return { agent: { id: 'agent-a', identity }, presence: {}, skills: [] };
      }
    },
    queues: {
      async offerNext(input: Record<string, unknown>) {
        observed.push({ operation: 'offerNext', ...input });
        return { assignment: { id: 'assignment-a' }, entry: { id: 'entry-a' } };
      },
      async acceptOffer(input: Record<string, unknown>) {
        observed.push({ operation: 'acceptOffer', ...input });
        return input;
      }
    }
  } as unknown as ContactCenterHttpModule;
  const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'offer-key-a' };

  const offered = await routeIveKitContactCenterApi(
    null, 'POST', '/api/ivekit/contact-center/routing/assignments',
    new URL('http://localhost/api/ivekit/contact-center/routing/assignments'),
    { queue_id: 'queue-a', offer_ttl_seconds: 20 }, '', headers, { module }
  ) as { status: number };
  assert.equal(offered.status, 201);

  await routeIveKitContactCenterApi(
    null, 'POST', '/api/ivekit/contact-center/assignments/assignment-a/accept',
    new URL('http://localhost/api/ivekit/contact-center/assignments/assignment-a/accept'),
    { agent_id: 'agent-attacker' }, '', { authorization: `Bearer ${token}` }, { module }
  );
  assert.deepEqual(observed, [
    {
      operation: 'offerNext', tenant_id: 'tenant-a', queue_id: 'queue-a',
      idempotency_key: 'offer-key-a', offer_ttl_seconds: 20
    },
    { operation: 'getAgentByIdentity', tenant_id: 'tenant-a', identity: 'identity-a' },
    {
      operation: 'acceptOffer', tenant_id: 'tenant-a', assignment_id: 'assignment-a',
      agent_id: 'agent-a'
    }
  ]);
});

test('Contact Center HTTP advertises implemented and pending capability truth', async (t) => {
  const token = installAuth(t, 'admin-a', 'admin');
  const result = await routeIveKitContactCenterApi(
    null, 'GET', '/api/ivekit/contact-center/capabilities',
    new URL('http://localhost/api/ivekit/contact-center/capabilities'),
    {}, '', { authorization: `Bearer ${token}` }
  ) as { data: { capabilities: Record<string, boolean> } };
  assert.equal(result.data.capabilities.acd_routing, true);
  assert.equal(result.data.capabilities.queue_entries, true);
  assert.equal(result.data.capabilities.callbacks, false);
  assert.equal(result.data.capabilities.supervisor, false);
});

test('Contact Center HTTP lists tenant-bound queue entry snapshots', async (t) => {
  const token = installAuth(t, 'admin-a', 'admin');
  const observed: Array<Record<string, unknown>> = [];
  const module = {
    queues: {
      async listQueueEntries(input: Record<string, unknown>) {
        observed.push(input);
        return { items: [], next_cursor: null };
      }
    }
  } as unknown as ContactCenterHttpModule;
  const result = await routeIveKitContactCenterApi(
    null, 'GET', '/api/ivekit/contact-center/queues/queue-a/entries',
    new URL('http://localhost/api/ivekit/contact-center/queues/queue-a/entries?state=waiting&limit=25'),
    {}, '', { authorization: `Bearer ${token}` }, { module }
  ) as { data: { items: unknown[] } };
  assert.deepEqual(result.data.items, []);
  assert.deepEqual(observed, [{
    tenant_id: 'tenant-a', queue_id: 'queue-a', state: 'waiting', limit: 25
  }]);
});

function installAuth(
  t: TestContext,
  userId: string,
  role: 'admin' | 'operator'
): string {
  const previousSecret = process.env.OPC_JWT_SECRET;
  const previousIssuer = process.env.OPC_AUTH_ISSUER;
  process.env.OPC_JWT_SECRET = 'contact-center-http-test-secret';
  delete process.env.OPC_AUTH_ISSUER;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.OPC_JWT_SECRET;
    else process.env.OPC_JWT_SECRET = previousSecret;
    if (previousIssuer === undefined) delete process.env.OPC_AUTH_ISSUER;
    else process.env.OPC_AUTH_ISSUER = previousIssuer;
  });
  return signAccessToken({ sub: userId, tid: 'tenant-a', role });
}
