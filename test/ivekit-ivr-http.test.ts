import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeIveKitIvrApi } from '../src/agent-runtime/ivekit/ivr/index.js';
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
