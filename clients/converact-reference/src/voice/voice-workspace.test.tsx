import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import React from 'react';
import type {
  ConveractFabricClient,
  ConveractFabricVoiceCall,
  ConveractFabricVoiceCallCommand,
  ConveractFabricVoiceCommandKind,
  ConveractFabricVoiceControllerClient,
  ConveractFabricVoiceHttpClient
} from '@converact/sdk';

import { installTestDom } from '../test-dom.js';

const closeDom = installTestDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { VoiceWorkspace } = await import('./voice-workspace.js');

after(() => { cleanup(); closeDom(); });
afterEach(() => cleanup());

test('Voice workspace loads a call and executes state-valid controls', async () => {
  const requests: string[] = [];
  const client = fakeClient(requests, voiceCall('ringing'));
  const view = render(<VoiceWorkspace
    client={client}
    callId="voice-call-a"
    onCallIdChange={() => undefined}
    refreshVersion={0}
    businessRef={{ type: 'service_order', id: 'SO-100' }}
  />);

  await waitFor(() => assert.ok(view.getByText('+8613*******00')));
  await waitFor(() => assert.equal((view.getByTitle('Answer call') as HTMLButtonElement).disabled, false));
  assert.equal(view.getAllByText('ringing').length >= 1, true);
  assert.equal((view.getByTitle('Answer call') as HTMLButtonElement).disabled, false);
  assert.equal((view.getByTitle('Hold call') as HTMLButtonElement).disabled, true);

  await act(async () => {
    fireEvent.click(view.getByTitle('Answer call'));
    await Promise.resolve();
  });
  await waitFor(() => assert.ok(requests.includes('action:answer')));
  assert.ok(view.getByText('command-answer'));
});

test('Voice workspace dials with a business reference and prepares an extension session', async () => {
  const requests: string[] = [];
  const selected: string[] = [];
  const client = fakeClient(requests, voiceCall('active'));
  const view = render(<VoiceWorkspace
    client={client}
    callId=""
    onCallIdChange={(value) => selected.push(value)}
    refreshVersion={0}
    businessRef={{ type: 'service_order', id: 'SO-200' }}
  />);

  await act(async () => {
    fireEvent.input(view.getByLabelText('Profile'), { target: { value: 'profile-a' } });
    fireEvent.input(view.getByLabelText('From'), { target: { value: '1001' } });
    fireEvent.input(view.getByLabelText('To'), { target: { value: '+8613800138000' } });
  });
  const dialButton = view.getByTitle('Dial outbound call') as HTMLButtonElement;
  assert.deepEqual([
    (view.getByLabelText('Profile') as HTMLInputElement).value,
    (view.getByLabelText('From') as HTMLInputElement).value,
    (view.getByLabelText('To') as HTMLInputElement).value,
    (view.getByLabelText('Reference type') as HTMLInputElement).value,
    (view.getByLabelText('Reference ID') as HTMLInputElement).value
  ], ['profile-a', '1001', '+8613800138000', 'service_order', 'SO-200']);
  assert.equal(view.container.querySelector('.voice-phase')?.textContent, 'idle');
  assert.equal(dialButton.disabled, false);
  await act(async () => {
    fireEvent.submit(dialButton.closest('form') as HTMLFormElement);
    await Promise.resolve();
  });

  await waitFor(() => assert.deepEqual(selected, ['voice-call-a']));
  assert.ok(requests.includes('dial:service_order:SO-200'));

  await act(async () => {
    fireEvent.input(view.getByLabelText('Extension ID'), { target: { value: 'extension-a' } });
  });
  await act(async () => {
    fireEvent.click(view.getByTitle('Prepare extension session'));
    await Promise.resolve();
  });
  await waitFor(() => assert.ok(view.getByText('Session ready')));
  await waitFor(() => assert.ok(view.getByRole('region', { name: 'SIP WebPhone' })));
  assert.ok(requests.includes('capabilities'));
  assert.ok(requests.includes('extension:extension-a'));
  assert.equal(view.container.textContent?.includes('private-provider-secret'), false);
});

test('Voice workspace defers realtime refresh until an active command completes', async () => {
  const requests: string[] = [];
  let releaseAction!: (value: ConveractFabricVoiceCallCommand) => void;
  const actionResult = new Promise<ConveractFabricVoiceCallCommand>((resolve) => { releaseAction = resolve; });
  const client = fakeClient(requests, voiceCall('active'), {
    async enqueueCallAction(_callId, input) {
      requests.push(`action:${input.action}`);
      return actionResult;
    }
  });
  const common = {
    client,
    callId: 'voice-call-a',
    onCallIdChange: () => undefined,
    businessRef: { type: 'service_order', id: 'SO-300' }
  };
  const view = render(<VoiceWorkspace {...common} refreshVersion={0} />);
  await waitFor(() => assert.equal(requests.filter((value) => value === 'get:voice-call-a').length, 1));
  await waitFor(() => assert.equal((view.getByTitle('Hold call') as HTMLButtonElement).disabled, false));

  fireEvent.click(view.getByTitle('Hold call'));
  await waitFor(() => assert.ok(requests.includes('action:hold')));
  view.rerender(<VoiceWorkspace {...common} refreshVersion={1} />);
  assert.equal(requests.filter((value) => value === 'get:voice-call-a').length, 1);

  releaseAction(voiceCommand('hold'));
  await waitFor(() => assert.equal(requests.filter((value) => value === 'get:voice-call-a').length, 2));
});

test('Voice workspace fails closed for provider actions omitted by preflight', async () => {
  const requests: string[] = [];
  const client = fakeClient(requests, voiceCall('active'), {
    async getProfileCapabilities() {
      return voiceActionSnapshot({ park: false, pickup: false, dtmf: false });
    }
  });
  const view = render(<VoiceWorkspace
    client={client}
    callId="voice-call-a"
    onCallIdChange={() => undefined}
    refreshVersion={0}
  />);

  await waitFor(() => assert.ok(requests.includes('get:voice-call-a')));
  await waitFor(() => assert.equal((view.getByTitle('Open more voice controls') as HTMLButtonElement).disabled, false));
  await waitFor(() => assert.equal((view.getByTitle('Open DTMF keypad') as HTMLButtonElement).disabled, true));
  fireEvent.click(view.getByTitle('Open more voice controls'));
  assert.equal((view.getByTitle('Park call') as HTMLButtonElement).disabled, true);
  assert.equal((view.getByTitle('Pickup call') as HTMLButtonElement).disabled, true);
  assert.equal(requests.some((value) => value === 'action:park' || value === 'action:pickup'), false);
});

test('Voice workspace fails closed when the provider capability snapshot is not ready', async () => {
  const requests: string[] = [];
  const client = fakeClient(requests, voiceCall('active'), {
    async getProfileCapabilities() {
      return { ...voiceActionSnapshot(), status: 'failed' };
    }
  });
  const view = render(<VoiceWorkspace
    client={client}
    callId="voice-call-a"
    onCallIdChange={() => undefined}
    refreshVersion={0}
  />);

  await waitFor(() => assert.ok(requests.includes('get:voice-call-a')));
  await waitFor(() => assert.equal((view.getByTitle('Hold call') as HTMLButtonElement).disabled, true));
  assert.equal((view.getByTitle('Open more voice controls') as HTMLButtonElement).disabled, true);
});

function fakeClient(
  requests: string[],
  call: ConveractFabricVoiceCall,
  overrides: Partial<VoiceWorkspaceTestClient> = {}
): ConveractFabricClient {
  const voice: VoiceWorkspaceTestClient = {
    async getCapabilities() {
      requests.push('capabilities');
      return {
        api_version: 'v1', tenant_id: 'tenant-a', capabilities: {
          deployment_profiles: true, sip_trunks: true, dids: true, extensions: true,
          extension_sessions: true, routes: true, calls: true, call_control: true,
          provider_events: true, recordings: true, parking_slots: true, livekit_sip_bridge: true,
          provider_webhooks: true
        }
      };
    },
    async getProfileCapabilities() {
      requests.push('profile-capabilities');
      return voiceActionSnapshot();
    },
    async createOutboundCall(input) {
      requests.push(`dial:${input.business_ref.type}:${input.business_ref.id}`);
      return { call, command: voiceCommand('originate') };
    },
    async getCall(callId) {
      requests.push(`get:${callId}`);
      return call;
    },
    async enqueueCallAction(_callId, input) {
      requests.push(`action:${input.action}`);
      return voiceCommand(input.action);
    },
    async createLiveKitBridge() {
      requests.push('bridge');
      return voiceCommand('livekit_bridge_create');
    },
    async createExtensionSession(extensionId) {
      requests.push(`extension:${extensionId}`);
      return {
        session_id: 'webrtc-session-a', extension_id: extensionId, transport: 'wss',
        websocket_url: 'wss://pbx.example/ws', address_of_record: 'sip:1001@pbx.example',
        authorization_username: 'webrtc-session-a',
        authorization_password: 'private-provider-secret', display_name: 'Agent A',
        expires_at: '2099-07-13T09:05:00.000Z', register_expires_seconds: 300,
        ice_servers: [], capabilities: {
          incoming: true, outgoing: true, dtmf: true, hold: true, transfer: false,
          audio_input: true, audio_output: true
        }
      };
    },
    ...overrides
  };
  return { voice } as unknown as ConveractFabricClient;
}

type VoiceWorkspaceTestClient = ConveractFabricVoiceControllerClient & Pick<
  ConveractFabricVoiceHttpClient,
  'getProfileCapabilities'
>;

function voiceActionSnapshot(overrides: Partial<Record<ConveractFabricVoiceCommandKind, boolean>> = {}) {
  const kinds: ConveractFabricVoiceCommandKind[] = [
    'originate', 'answer', 'hangup', 'dtmf', 'hold', 'resume', 'blind_transfer',
    'warm_transfer', 'conference', 'park', 'pickup', 'recording_start',
    'recording_pause', 'recording_resume', 'recording_stop', 'livekit_bridge_create'
  ];
  return {
    id: 'voice-capabilities-a', tenant_id: 'tenant-a', profile_id: 'profile-a',
    provider: 'controlled', provider_version: 'controlled-v1', status: 'ready' as const,
    capabilities: {
      management_http: true, json_rpc_routing: true, step_ivr: true, rwi: true,
      webrtc_extension: true, recording: true, sipflow: true, queue: true,
      postgres_backend: true
    },
    capability_schema_version: 1 as const,
    action_capabilities: {
      commands: Object.fromEntries(kinds.map((kind) => [kind, overrides[kind] ?? true])) as Record<ConveractFabricVoiceCommandKind, boolean>,
      conference_operations: { create: true, add: true, remove: true, destroy: true }
    },
    config_hash: 'a'.repeat(64), error_code: '', error_message: '',
    checked_at: '2026-07-13T00:00:00.000Z', created_at: '2026-07-13T00:00:00.000Z'
  };
}

function voiceCall(state: ConveractFabricVoiceCall['state']): ConveractFabricVoiceCall {
  return {
    id: 'voice-call-a', tenant_id: 'tenant-a', business_ref: { type: 'service_order', id: 'SO-100' },
    provider_profile_id: 'profile-a', provider_call_id: '', provider_dialog_id: '', media_call_id: null,
    direction: 'outbound', state, from: { kind: 'extension', redacted: '10**' },
    to: { kind: 'e164', redacted: '+8613*******00' }, idempotency_key: 'dial-key',
    initiated_by: 'operator-a', metadata: {}, ringing_at: '2026-07-13T00:00:00.000Z',
    answered_at: state === 'active' ? '2026-07-13T00:00:01.000Z' : null,
    ended_at: null, termination_reason: '', revision: 1,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function voiceCommand(kind: ConveractFabricVoiceCommandKind): ConveractFabricVoiceCallCommand {
  return {
    id: `command-${kind}`, tenant_id: 'tenant-a', call_id: 'voice-call-a', kind,
    state: 'pending', idempotency_key: `key-${kind}`, attempt_count: 0, max_attempts: 5,
    next_attempt_at: null, provider_command_id: '', result: {}, error_code: '',
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z',
    completed_at: null
  };
}
