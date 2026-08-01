import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  ContactCenterError,
  routeConveractFabricContactCenterApi,
  type ContactCenterHttpModule
} from '../src/agent-runtime/converact/contact-center/index.js';
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

  const listed = await routeConveractFabricContactCenterApi(
    null, 'GET', '/api/ivekit/contact-center/agents',
    new URL('http://localhost/api/ivekit/contact-center/agents?limit=25&status=active'),
    {}, '', headers, { module }
  ) as { data: { next_cursor: null } };
  assert.equal(listed.data.next_cursor, null);

  await routeConveractFabricContactCenterApi(
    null, 'POST', '/api/ivekit/contact-center/agents',
    new URL('http://localhost/api/ivekit/contact-center/agents'),
    { identity: 'agent-a', voice_capacity: 2 }, '',
    { ...headers, 'idempotency-key': 'agent-create-a' }, { module }
  );
  await routeConveractFabricContactCenterApi(
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
    () => routeConveractFabricContactCenterApi(
      null, 'POST', '/api/ivekit/contact-center/skills',
      new URL('http://localhost/api/ivekit/contact-center/skills'),
      { name: 'Sales' }, '', headers, { module }
    ),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'validation_failed'
  );

  await assert.rejects(
    () => routeConveractFabricContactCenterApi(
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

  await routeConveractFabricContactCenterApi(
    null, 'POST', '/api/ivekit/contact-center/agents/agent-a/presence',
    new URL('http://localhost/api/ivekit/contact-center/agents/agent-a/presence'),
    { state: 'available', session_ref: 'browser-a' }, '', headers, { module }
  );
  assert.deepEqual(updates, [{
    tenant_id: 'tenant-a', actor: 'identity-a', agent_id: 'agent-a',
    state: 'available', session_ref: 'browser-a'
  }]);

  await assert.rejects(
    () => routeConveractFabricContactCenterApi(
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

  const offered = await routeConveractFabricContactCenterApi(
    null, 'POST', '/api/ivekit/contact-center/routing/assignments',
    new URL('http://localhost/api/ivekit/contact-center/routing/assignments'),
    { queue_id: 'queue-a', offer_ttl_seconds: 20 }, '', headers, { module }
  ) as { status: number };
  assert.equal(offered.status, 201);

  await routeConveractFabricContactCenterApi(
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
  const result = await routeConveractFabricContactCenterApi(
    null, 'GET', '/api/ivekit/contact-center/capabilities',
    new URL('http://localhost/api/ivekit/contact-center/capabilities'),
    {}, '', { authorization: `Bearer ${token}` }
  ) as { data: { capabilities: Record<string, boolean> } };
  assert.equal(result.data.capabilities.acd_routing, true);
  assert.equal(result.data.capabilities.queue_entries, true);
  assert.equal(result.data.capabilities.callbacks, true);
  assert.equal(result.data.capabilities.overflow, true);
  assert.equal(result.data.capabilities.queue_monitor, true);
  assert.equal(result.data.capabilities.supervisor, false);

  const enabled = await routeConveractFabricContactCenterApi(
    null, 'GET', '/api/ivekit/contact-center/capabilities',
    new URL('http://localhost/api/ivekit/contact-center/capabilities'),
    {}, '', { authorization: `Bearer ${token}` }, {
      supervisor_control: {
        supports: (mode) => mode === 'monitor',
        async start() { return { provider_session_id: 'provider-a' }; },
        async end() {}
      }
    }
  ) as { data: { capabilities: Record<string, boolean> } };
  assert.equal(enabled.data.capabilities.supervisor, true);
});

test('Contact Center HTTP exposes tenant-bound monitor snapshots to read-only users', async (t) => {
  const token = installAuth(t, 'viewer-a', 'viewer');
  const observed: string[] = [];
  const module = {
    monitor: {
      async snapshot(input: { tenant_id: string }) {
        observed.push(input.tenant_id);
        return { generated_at: '2026-07-13T09:30:00.000Z', queues: [], alerts: [] };
      }
    }
  } as unknown as ContactCenterHttpModule;
  const result = await routeConveractFabricContactCenterApi(
    null, 'GET', '/api/ivekit/contact-center/monitor',
    new URL('http://localhost/api/ivekit/contact-center/monitor'),
    {}, '', { authorization: `Bearer ${token}` }, { module }
  ) as { data: { generated_at: string } };
  assert.equal(result.data.generated_at, '2026-07-13T09:30:00.000Z');
  assert.deepEqual(observed, ['tenant-a']);
  await assert.rejects(
    () => routeConveractFabricContactCenterApi(
      null, 'GET', '/api/ivekit/contact-center/monitor',
      new URL('http://localhost/api/ivekit/contact-center/monitor?tenant_id=tenant-b'),
      {}, '', { authorization: `Bearer ${token}` }, { module }
    ),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'validation_failed'
  );
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
  const result = await routeConveractFabricContactCenterApi(
    null, 'GET', '/api/ivekit/contact-center/queues/queue-a/entries',
    new URL('http://localhost/api/ivekit/contact-center/queues/queue-a/entries?state=waiting&limit=25'),
    {}, '', { authorization: `Bearer ${token}` }, { module }
  ) as { data: { items: unknown[] } };
  assert.deepEqual(result.data.items, []);
  assert.deepEqual(observed, [{
    tenant_id: 'tenant-a', queue_id: 'queue-a', state: 'waiting', limit: 25
  }]);
});

test('Contact Center HTTP creates lists and cancels callbacks under authenticated tenant', async (t) => {
  const token = installAuth(t, 'identity-a', 'operator');
  const observed: Array<Record<string, unknown>> = [];
  const module = {
    callbacks: {
      async request(input: Record<string, unknown>) {
        observed.push({ operation: 'request', ...input });
        return { callback: { id: 'callback-a', address: { kind: 'e164', redacted: '+86******9000' } }, replayed: false };
      },
      async list(input: Record<string, unknown>) {
        observed.push({ operation: 'list', ...input });
        return { items: [], next_cursor: null };
      },
      async cancel(input: Record<string, unknown>) {
        observed.push({ operation: 'cancel', ...input });
        return { id: input.callback_id, state: 'cancelled' };
      }
    }
  } as unknown as ContactCenterHttpModule;
  const headers = { authorization: `Bearer ${token}` };

  const created = await routeConveractFabricContactCenterApi(
    null, 'POST', '/api/ivekit/contact-center/callbacks',
    new URL('http://localhost/api/ivekit/contact-center/callbacks'),
    {
      queue_entry_id: 'entry-a', source_call_id: 'call-a',
      address: { kind: 'e164', value: '+8613900139000' },
      scheduled_for: '2026-07-13T00:05:00.000Z', max_attempts: 4
    }, '', { ...headers, 'idempotency-key': 'callback-key-a' }, { module }
  ) as { status: number; data: { callback: { address: { redacted: string } } } };
  assert.equal(created.status, 201);
  assert.equal(created.data.callback.address.redacted, '+86******9000');

  await routeConveractFabricContactCenterApi(
    null, 'GET', '/api/ivekit/contact-center/callbacks',
    new URL('http://localhost/api/ivekit/contact-center/callbacks?queue_id=queue-a&state=scheduled&limit=20'),
    {}, '', headers, { module }
  );
  await routeConveractFabricContactCenterApi(
    null, 'POST', '/api/ivekit/contact-center/callbacks/callback-a/cancel',
    new URL('http://localhost/api/ivekit/contact-center/callbacks/callback-a/cancel'),
    { reason: 'customer_changed_mind' }, '', headers, { module }
  );

  assert.deepEqual(observed, [
    {
      operation: 'request', tenant_id: 'tenant-a', queue_entry_id: 'entry-a',
      source_call_id: 'call-a', address: { kind: 'e164', value: '+8613900139000' },
      scheduled_for: '2026-07-13T00:05:00.000Z', max_attempts: 4,
      actor: 'identity-a',
      idempotency_key: 'callback-key-a'
    },
    { operation: 'list', tenant_id: 'tenant-a', queue_id: 'queue-a', state: 'scheduled', limit: 20 },
    {
      operation: 'cancel', tenant_id: 'tenant-a', callback_id: 'callback-a',
      actor: 'identity-a',
      reason: 'customer_changed_mind'
    }
  ]);
});

test('Contact Center HTTP restricts supervisor actions to administrators and binds audit identity', async (t) => {
  const admin = installAuth(t, 'admin-a', 'admin');
  const observed: Array<Record<string, unknown>> = [];
  const module = {
    supervisor: {
      async start(input: Record<string, unknown>) {
        observed.push({ operation: 'start', ...input });
        return { id: 'supervisor-a', state: 'active' };
      },
      async end(input: Record<string, unknown>) {
        observed.push({ operation: 'end', ...input });
        return { id: input.session_id, state: 'ended' };
      }
    }
  } as unknown as ContactCenterHttpModule;
  const url = new URL('http://localhost/api/ivekit/contact-center/supervisor/actions');

  const started = await routeConveractFabricContactCenterApi(
    null, 'POST', '/api/ivekit/contact-center/supervisor/actions', url,
    {
      action: 'start', call_id: 'call-a', target_agent_id: 'agent-a',
      mode: 'whisper', authorization_ref: 'policy:supervisor:42'
    }, '', {
      authorization: `Bearer ${admin}`, 'idempotency-key': 'supervisor-key-a'
    }, { module }
  ) as { status: number };
  assert.equal(started.status, 201);
  await routeConveractFabricContactCenterApi(
    null, 'POST', '/api/ivekit/contact-center/supervisor/actions', url,
    { action: 'end', session_id: 'supervisor-a', reason: 'review_complete' }, '',
    { authorization: `Bearer ${admin}` }, { module }
  );
  assert.deepEqual(observed, [
    {
      operation: 'start', tenant_id: 'tenant-a', call_id: 'call-a',
      target_agent_id: 'agent-a', supervisor_identity: 'admin-a', mode: 'whisper',
      authorization_ref: 'policy:supervisor:42', idempotency_key: 'supervisor-key-a'
    },
    {
      operation: 'end', tenant_id: 'tenant-a', session_id: 'supervisor-a',
      supervisor_identity: 'admin-a', reason: 'review_complete'
    }
  ]);

  const operator = installAuth(t, 'operator-a', 'operator');
  await assert.rejects(
    () => routeConveractFabricContactCenterApi(
      null, 'POST', '/api/ivekit/contact-center/supervisor/actions', url,
      {
        action: 'start', call_id: 'call-a', target_agent_id: 'agent-a',
        mode: 'monitor', authorization_ref: 'policy:42'
      }, '', {
        authorization: `Bearer ${operator}`, 'idempotency-key': 'operator-key-a'
      }, { module }
    ),
    (error: unknown) => error instanceof ContactCenterError && error.status === 403
  );
});

function installAuth(
  t: TestContext,
  userId: string,
  role: 'admin' | 'operator' | 'viewer'
): string {
  const previousSecret = process.env.CONVERACT_JWT_SECRET;
  const previousIssuer = process.env.CONVERACT_AUTH_ISSUER;
  process.env.CONVERACT_JWT_SECRET = 'contact-center-http-test-secret';
  delete process.env.CONVERACT_AUTH_ISSUER;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.CONVERACT_JWT_SECRET;
    else process.env.CONVERACT_JWT_SECRET = previousSecret;
    if (previousIssuer === undefined) delete process.env.CONVERACT_AUTH_ISSUER;
    else process.env.CONVERACT_AUTH_ISSUER = previousIssuer;
  });
  return signAccessToken({ sub: userId, tid: 'tenant-a', role });
}
