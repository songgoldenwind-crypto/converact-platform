import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createControlledVoiceProviderState,
  handleControlledVoiceProviderRequest,
  startControlledVoiceProvider
} from '../scripts/ivekit-controlled-voice-provider.js';
import {
  EnvVoiceSecretResolver,
  RustPbxRwiClient,
  type RustPbxRwiSafeEvent
} from '../src/agent-runtime/ivekit/voice/index.js';

test('controlled Voice provider implements safe Management and AMI contracts', async () => {
  const state = createControlledVoiceProviderState({ token: 'voice-control-secret' });
  const denied = await request(state, 'GET', '/api/pending-reloads', undefined, false);
  assert.equal(denied.status, 401);
  assert.doesNotMatch(denied.body, /voice-control-secret/);

  const health = await request(state, 'GET', '/api/pending-reloads');
  assert.deepEqual(JSON.parse(health.body), {
    pending_reloads: 0,
    capabilities: {
      management_http: true, json_rpc_routing: true, step_ivr: true, rwi: true,
      webrtc_extension: true, recording: true, sipflow: true, queue: true,
      postgres_backend: true
    }
  });
  assert.deepEqual(JSON.parse((await request(state, 'GET', '/ami/v1/health')).body), {
    ready: true,
    version: 'controlled-rustpbx-0.4.11',
    capabilities: {
      management_http: true, json_rpc_routing: true, step_ivr: true, rwi: true,
      webrtc_extension: true, recording: true, sipflow: true, queue: true,
      postgres_backend: true
    }
  });

  const trunk = await request(state, 'PUT', '/api/sip-trunk', {
    name: 'trunk-a', display_name: 'Trunk A', direction: 'bidirectional',
    sip_transport: 'udp', max_concurrent: 4, auth_password: 'trunk-password'
  });
  assert.equal(JSON.parse(trunk.body).id, 1);
  const trunks = JSON.parse((await request(state, 'POST', '/api/sip-trunk', {
    page: 1, per_page: 100, filters: { q: 'trunk-a' }
  })).body);
  assert.equal(trunks.items[0].name, 'trunk-a');
  assert.equal(JSON.parse((await request(state, 'POST', '/api/diagnostics/trunks/options', {
    trunk: 'trunk-a', transport: 'udp'
  })).body).success, true);
  assert.equal((await request(state, 'POST', '/ami/v1/reload/trunks')).status, 200);

  const extension = await request(state, 'PUT', '/api/extensions', {
    extension: '1001', display_name: 'Agent 1001', sip_password: 'extension-password'
  });
  assert.equal(JSON.parse(extension.body).id, 2);
  assert.equal(state.resources.size, 2);
  assert.equal(state.resources.get('trunk:1')?.desired_state.name, 'trunk-a');

  state.calls.set('provider-call-a', { state: 'active', action_id: 'action-a' });
  assert.deepEqual(JSON.parse((await request(state, 'GET', '/ami/v1/dialogs')).body), [{
    id: 'provider-call-a', call_id: 'provider-call-a', provider_call_id: 'provider-call-a',
    state: 'active', source: 'active_call_registry'
  }]);
  state.recordings.set('recording-a', { state: 'available', object_ref: 'controlled://recording-a' });
  assert.equal(JSON.parse((await request(
    state, 'GET', '/api/call-records/recording-a/metadata'
  )).body).object_ref, 'controlled://recording-a');
});

test('controlled Voice RWI uses official completion envelopes and executes each action once', async () => {
  const running = await startControlledVoiceProvider({
    host: '127.0.0.1', port: 0,
    state: createControlledVoiceProviderState({ token: 'voice-control-secret' })
  });
  const client = rwiClient(running.rwi_url, 'voice-control-secret');
  const events: RustPbxRwiSafeEvent[] = [];
  client.onEvent((event) => events.push(event));
  try {
    await client.connect();
    assert.equal((await client.preflight()).ready, true);
    const result = await client.execute({
      command_id: 'command-originate-a', kind: 'originate', call_id: 'call-a',
      payload: { destination: 'sip:masked@controlled.invalid' }
    });
    assert.deepEqual(result, {
      state: 'succeeded', action_id: 'command-originate-a', result: {
        accepted: true, call_id: 'call-a'
      }
    });
    assert.equal(running.state.action_counts.get('command-originate-a'), 1);
    await waitFor(() => events.some((event) => event.event_type === 'call_state_change'));
  } finally {
    await client.close();
    await running.close();
  }
});

test('controlled Voice timeout converges by dialog lookup without a second originate', async () => {
  const running = await startControlledVoiceProvider({
    host: '127.0.0.1', port: 0,
    state: createControlledVoiceProviderState({
      token: 'voice-control-secret', mode: 'async_success_after_timeout', response_delay_ms: 50
    })
  });
  const client = rwiClient(running.rwi_url, 'voice-control-secret', 15);
  try {
    await client.connect();
    const result = await client.execute({
      command_id: 'command-uncertain-a', kind: 'originate', call_id: 'call-a',
      payload: { destination: 'sip:masked@controlled.invalid' }
    });
    assert.deepEqual(result, {
      state: 'uncertain', action_id: 'command-uncertain-a', error_code: 'provider_timeout'
    });
    await waitFor(() => running.state.calls.has('call-a'), 250);
    const dialog = await fetch(`${running.base_url}/ami/v1/dialogs`, {
      headers: { authorization: 'Bearer voice-control-secret' }
    });
    assert.equal(dialog.status, 200);
    assert.equal((await dialog.json() as Array<{ state: string }>)[0]?.state, 'active');
    assert.equal(running.state.action_counts.get('command-uncertain-a'), 1);
  } finally {
    await client.close();
    await running.close();
  }
});

test('controlled Voice management can commit a mutation before its response times out', async () => {
  const state = createControlledVoiceProviderState({
    token: 'voice-control-secret', mode: 'async_success_after_timeout', response_delay_ms: 50
  });
  const lookup = await request(state, 'POST', '/api/sip-trunk', {
    page: 1, per_page: 100, filters: { q: 'trunk-uncertain' }
  });
  assert.equal(lookup.delay_ms, 0);

  const mutation = await request(state, 'PUT', '/api/sip-trunk', {
    name: 'trunk-uncertain', auth_password: 'trunk-password'
  });
  assert.equal(mutation.delay_ms, 50);
  assert.equal(state.resources.get('trunk:1')?.desired_state.name, 'trunk-uncertain');
});

test('controlled Voice modes cover capability absence, failures, malformed data, and package entrypoint', async () => {
  const state = createControlledVoiceProviderState({
    token: 'voice-control-secret', control_token: 'mode-control-secret'
  });
  const denied = await handleControlledVoiceProviderRequest({
    method: 'POST', path: '/__control/mode', headers: {}, body: { mode: 'capability_absence' }
  }, state);
  assert.equal(denied.status, 401);
  const changed = await handleControlledVoiceProviderRequest({
    method: 'POST', path: '/__control/mode',
    headers: { authorization: 'Bearer mode-control-secret' },
    body: { mode: 'capability_absence' }
  }, state);
  assert.equal(changed.status, 200);
  const health = JSON.parse((await request(state, 'GET', '/api/pending-reloads')).body);
  assert.equal(health.capabilities.queue, false);

  for (const mode of [
    'retryable_503', 'delayed_timeout', 'duplicate_events', 'out_of_order_events',
    'malformed_response', 'auth_failure'
  ] as const) {
    state.mode = mode;
    const response = await request(state, 'GET', '/ami/v1/health');
    if (mode === 'retryable_503') assert.equal(response.status, 503);
    if (mode === 'delayed_timeout') assert.ok(response.delay_ms > 0);
    if (mode === 'malformed_response') assert.throws(() => JSON.parse(response.body));
    if (mode === 'auth_failure') assert.equal(response.status, 401);
  }

  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['ivekit:controlled-voice-provider'], 'tsx scripts/ivekit-controlled-voice-provider.ts');
});

function request(
  state: ReturnType<typeof createControlledVoiceProviderState>,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  authenticated = true
) {
  return handleControlledVoiceProviderRequest({
    method, path,
    headers: authenticated ? { authorization: `Bearer ${state.token}` } : {},
    body: body ?? {}
  }, state);
}

function rwiClient(url: string, token: string, commandTimeoutMs = 100): RustPbxRwiClient {
  return new RustPbxRwiClient({
    url,
    token_ref: 'env://CONTROLLED_RWI_TOKEN',
    secret_resolver: new EnvVoiceSecretResolver({
      env: { CONTROLLED_RWI_TOKEN: token }, allowlist: { rwi: ['CONTROLLED_RWI_TOKEN'] }
    }),
    connect_timeout_ms: 250,
    command_timeout_ms: commandTimeoutMs,
    heartbeat_timeout_ms: 500,
    reconnect_initial_ms: 1_000,
    reconnect_max_ms: 1_000,
    reconnect_jitter_ratio: 0
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
