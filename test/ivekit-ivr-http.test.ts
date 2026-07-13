import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IvrError, routeIveKitIvrApi, type IvrHttpModule } from '../src/agent-runtime/ivekit/ivr/index.js';
import { VoiceError } from '../src/agent-runtime/ivekit/voice/index.js';

const pg = { query: async () => { throw new Error('not used'); } };
const url = new URL('http://localhost/api/ivekit/ivr/provider-webhooks/rustpbx/profile-a/step');

test('IVR Step HTTP authenticates profile before passing trusted tenant context to the service', async () => {
  const calls: unknown[] = [];
  const result = await routeIveKitIvrApi(
    pg, 'POST', url.pathname, url,
    { profile_id: 'profile-a', provider_session_id: 'provider-a' },
    '{"profile_id":"profile-a"}', { 'x-pbx-key': 'secret' },
    {
      webhook_authenticator: {
        authenticate: async (input) => {
          calls.push(input);
          return {
            tenant_id: 'trusted-tenant', profile_id: 'profile-a', adapter: 'rustpbx',
            secret_refs: {}, method: 'service_key'
          };
        }
      },
      step_service: {
        handle: async (input) => {
          calls.push(input);
          return {
            action_node: { type: 'prompt', tts_text: 'Welcome' },
            session_id: 'session-a', session_state: 'waiting', replayed: false,
            event_sequence: 1, action_revision: 1
          };
        }
      }
    }
  ) as { data: unknown; headers: Record<string, string> };

  assert.deepEqual(result.data, { type: 'prompt', tts_text: 'Welcome' });
  assert.equal(result.headers['x-ivekit-ivr-session-id'], 'session-a');
  assert.equal((calls[1] as { tenant_id: string }).tenant_id, 'trusted-tenant');
  assert.equal((calls[0] as { raw_body: string }).raw_body, '{"profile_id":"profile-a"}');
});

test('IVR Step HTTP rejects non-RustPBX profiles and leaves unrelated routes untouched', async () => {
  assert.equal(await routeIveKitIvrApi(
    pg, 'GET', url.pathname, url, null
  ), undefined);
  await assert.rejects(() => routeIveKitIvrApi(
    pg, 'POST', url.pathname, url, {}, '{}', {}, {
      webhook_authenticator: {
        authenticate: async () => ({
          tenant_id: 'tenant-a', profile_id: 'profile-a', adapter: 'controlled',
          secret_refs: {}, method: 'service_key'
        })
      }
    }
  ), (error: unknown) => error instanceof VoiceError && error.code === 'webhook_auth_failed');
});

test('IVR HTTP exposes flow release, simulation, and session surfaces under signed tenant authority', async (t) => {
  const previous = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'ivr-system-key';
  t.after(() => {
    if (previous === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previous;
  });
  const observed: unknown[] = [];
  const module = {
    flow_store: {
      listFlows: async (tenant: string) => [{ id: 'flow-a', tenant_id: tenant }],
      getFlow: async () => ({ id: 'flow-a' }),
      listVersions: async () => [{ version: 1 }]
    },
    flows: {
      createFlow: async (input: unknown) => { observed.push(input); return { id: 'flow-a' }; },
      updateDraft: async (input: unknown) => input,
      validate: async () => ({ errors: [], warnings: [] }),
      publish: async (input: unknown) => { observed.push(input); return { replayed: false }; },
      rollback: async (input: unknown) => input
    },
    simulations: { simulate: async (input: unknown) => { observed.push(input); return { status: 'completed' }; } },
    session_store: { list: async () => [], get: async () => ({ id: 'session-a' }) },
    step_store: { list: async () => [] },
    sessions: { startSession: async (input: unknown) => input, advance: async (input: unknown) => input }
  } as unknown as IvrHttpModule;
  const headers = { 'x-api-key': 'ivr-system-key', 'x-tenant-id': 'tenant-a' };

  const listed = await routeIveKitIvrApi(
    pg, 'GET', '/api/ivekit/ivr/flows', new URL('http://localhost/api/ivekit/ivr/flows'),
    {}, '', headers, { module }
  ) as { data: { items: Array<{ tenant_id: string }> } };
  assert.equal(listed.data.items[0]?.tenant_id, 'tenant-a');

  await routeIveKitIvrApi(
    pg, 'POST', '/api/ivekit/ivr/flows/flow-a/publish',
    new URL('http://localhost/api/ivekit/ivr/flows/flow-a/publish'),
    { expected_draft_revision: 2 }, '', { ...headers, 'idempotency-key': 'publish-key-a' }, { module }
  );
  assert.deepEqual(observed[0], {
    tenant_id: 'tenant-a', actor: 'system', flow_id: 'flow-a',
    expected_draft_revision: 2, idempotency_key: 'publish-key-a'
  });

  const simulated = await routeIveKitIvrApi(
    pg, 'POST', '/api/ivekit/ivr/simulations',
    new URL('http://localhost/api/ivekit/ivr/simulations'),
    { flow_id: 'flow-a', script: [] }, '', headers, { module }
  ) as { data: { status: string } };
  assert.equal(simulated.data.status, 'completed');
  assert.equal((observed[1] as { tenant_id: string }).tenant_id, 'tenant-a');

  await assert.rejects(() => routeIveKitIvrApi(
    pg, 'GET', '/api/ivekit/ivr/flows',
    new URL('http://localhost/api/ivekit/ivr/flows?tenant_id=tenant-b'),
    {}, '', headers, { module }
  ), (error: unknown) => error instanceof IvrError && error.code === 'validation_failed');
});
