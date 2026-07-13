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
  const denied = await request(state, 'GET', '/health', undefined, false);
  assert.equal(denied.status, 401);
  assert.doesNotMatch(denied.body, /voice-control-secret/);

  const health = await request(state, 'GET', '/health');
  assert.deepEqual(JSON.parse(health.body), {
    ready: true,
    database: 'postgres',
    capabilities: {
      management_http: true, json_rpc_routing: true, step_ivr: true, rwi: true,
      webrtc_extension: true, recording: true, sipflow: true, queue: true,
      postgres_backend: true
    }
  });
  assert.deepEqual(JSON.parse((await request(state, 'GET', '/version')).body), {
    version: 'controlled-rustpbx-v1'
  });

  const trunk = await request(state, 'PUT', '/management/trunks/trunk-a', {
    resource_id: 'trunk-a', desired_state: { direction: 'both' }
  });
  assert.deepEqual(JSON.parse(trunk.body), {
    provider_ref: 'controlled:trunk:trunk-a', revision: '1', applied: true
  });
  assert.equal((await request(state, 'POST', '/management/trunks/trunk-a/test', {
    resource_id: 'trunk-a'
  })).status, 200);
  assert.equal((await request(state, 'PUT', '/management/dids/did-a', {
    resource_id: 'did-a', desired_state: { e164: '+8613800138000', trunk_id: 'trunk-a' }
  })).status, 200);
  assert.equal((await request(state, 'PUT', '/management/extensions/extension-a', {
    resource_id: 'extension-a', desired_state: { extension: '1001' }
  })).status, 200);
  assert.equal((await request(state, 'PUT', '/management/routes/route-a', {
    resource_id: 'route-a', desired_state: { action: 'reject' }
  })).status, 200);
  assert.equal(state.resources.size, 4);
  assert.equal(state.resources.get('did:did-a')?.desired_state.e164, '+8613800138000');

  state.calls.set('provider-call-a', { state: 'active', action_id: 'action-a' });
  assert.deepEqual(JSON.parse((await request(
    state, 'GET', '/ami/v1/dialogs/provider-call-a'
  )).body), { state: 'active', provider_call_id: 'provider-call-a' });
  state.recordings.set('recording-a', { state: 'available', object_ref: 'controlled://recording-a' });
  assert.equal(JSON.parse((await request(
    state, 'GET', '/management/recordings/recording-a'
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
        accepted: true, call_id: 'controlled-call:command-originate-a'
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
    await waitFor(() => running.state.calls.has('controlled-call:command-uncertain-a'), 250);
    const dialog = await fetch(`${running.base_url}/ami/v1/dialogs/controlled-call%3Acommand-uncertain-a`, {
      headers: { authorization: 'Bearer voice-control-secret' }
    });
    assert.equal(dialog.status, 200);
    assert.equal((await dialog.json() as { state: string }).state, 'active');
    assert.equal(running.state.action_counts.get('command-uncertain-a'), 1);
  } finally {
    await client.close();
    await running.close();
  }
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
  const health = JSON.parse((await request(state, 'GET', '/health')).body);
  assert.equal(health.capabilities.queue, false);

  for (const mode of [
    'retryable_503', 'delayed_timeout', 'duplicate_events', 'out_of_order_events',
    'malformed_response', 'auth_failure'
  ] as const) {
    state.mode = mode;
    const response = await request(state, 'GET', '/version');
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
