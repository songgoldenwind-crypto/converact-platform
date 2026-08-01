import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConveractFabricHttpSdkError } from '../sdk/converact/src/http-sdk.js';
import {
  createConveractFabricVoiceController,
  type ConveractFabricVoiceControllerClient
} from '../sdk/converact/src/voice-controller.js';
import type {
  ConveractFabricVoiceCall,
  ConveractFabricVoiceCallCommand,
  ConveractFabricVoiceCommandKind,
  ConveractFabricVoiceCreateOutboundCallInput
} from '../sdk/converact/src/voice-types.js';

test('Voice controller exposes every WebPhone action and publishes stable state', async () => {
  const requests: Array<{ kind: ConveractFabricVoiceCommandKind; payload: Record<string, unknown>; key: string }> = [];
  const states: string[] = [];
  const client = voiceClient({
    async enqueueCallAction(_callId, input, options) {
      requests.push({ kind: input.action, payload: input.payload ?? {}, key: options.idempotencyKey });
      return command(input.action);
    }
  });
  let keySequence = 0;
  const controller = createConveractFabricVoiceController({
    client,
    idempotencyKey: () => `key-${++keySequence}`
  });
  const unsubscribe = controller.subscribe((state) => states.push(`${state.phase}:${state.pending_action ?? ''}`));

  await controller.dial(outboundInput());
  await controller.answer();
  await controller.sendDtmf('12#');
  await controller.hold();
  await controller.resume();
  await controller.blindTransfer({ kind: 'extension', value: '1002' });
  await controller.warmTransfer({ kind: 'sip_uri', value: 'sip:1003@pbx.internal' });
  await controller.conference('conference-a');
  await controller.createConference('conference-b', { backend: 'internal', max_members: 10, record: true });
  await controller.addToConference('conference-b');
  await controller.removeFromConference('conference-b');
  await controller.destroyConference('conference-b');
  await controller.park('701');
  await controller.pickup('701');
  await controller.startRecording();
  await controller.pauseRecording();
  await controller.resumeRecording();
  await controller.stopRecording();
  await controller.createLiveKitBridge('trunk-a');
  await controller.hangup();
  unsubscribe();

  assert.deepEqual(requests.map((request) => request.kind), [
    'answer', 'dtmf', 'hold', 'resume', 'blind_transfer', 'warm_transfer',
    'conference', 'conference', 'conference', 'conference', 'conference',
    'park', 'pickup', 'recording_start', 'recording_pause',
    'recording_resume', 'recording_stop', 'hangup'
  ]);
  assert.deepEqual(requests[1]!.payload, { digits: '12#' });
  assert.deepEqual(requests[4]!.payload, { target: '1002' });
  assert.deepEqual(requests[5]!.payload, { target: 'sip:1003@pbx.internal' });
  assert.deepEqual(requests[6]!.payload, { conference_id: 'conference-a' });
  assert.deepEqual(requests[7]!.payload, {
    operation: 'create', conference_id: 'conference-b', backend: 'internal',
    max_members: 10, record: true
  });
  assert.deepEqual(requests[8]!.payload, { operation: 'add', conference_id: 'conference-b' });
  assert.deepEqual(requests[9]!.payload, { operation: 'remove', conference_id: 'conference-b' });
  assert.deepEqual(requests[10]!.payload, { operation: 'destroy', conference_id: 'conference-b' });
  assert.deepEqual(requests[11]!.payload, { slot: '701' });
  assert.equal(controller.getSnapshot().call?.id, 'call-a');
  assert.equal(controller.getSnapshot().command?.kind, 'hangup');
  assert.equal(controller.getSnapshot().phase, 'ready');
  assert.equal(states.includes('submitting:dtmf'), true);
  assert.equal(states.at(-1), 'ready:');
  assert.throws(
    () => controller.blindTransfer({ kind: 'e164', value: '1002' }),
    /valid E\.164/
  );
});

test('Voice controller reuses an idempotency key only after ambiguous failure', async () => {
  const keys: string[] = [];
  let attempts = 0;
  let keySequence = 0;
  const client = voiceClient({
    async enqueueCallAction(_callId, input, options) {
      keys.push(options.idempotencyKey);
      attempts += 1;
      if (attempts === 1) {
        throw new ConveractFabricHttpSdkError('request timed out', 0, 'POST', '/actions', null);
      }
      return command(input.action);
    }
  });
  const controller = createConveractFabricVoiceController({
    client,
    idempotencyKey: () => `retry-key-${++keySequence}`
  });
  await controller.selectCall('call-a');

  await assert.rejects(() => controller.hold(), /timed out/);
  assert.equal(controller.getSnapshot().error?.retryable, true);
  await controller.hold();
  await controller.hold();

  assert.deepEqual(keys, ['retry-key-1', 'retry-key-1', 'retry-key-2']);
  assert.equal(controller.getSnapshot().error, null);
});

test('Voice controller discards an idempotency key after a terminal response', async () => {
  const keys: string[] = [];
  let attempts = 0;
  let keySequence = 0;
  const controller = createConveractFabricVoiceController({
    client: voiceClient({
      async enqueueCallAction(_callId, input, options) {
        keys.push(options.idempotencyKey);
        attempts += 1;
        if (attempts === 1) {
          throw new ConveractFabricHttpSdkError('invalid call state', 422, 'POST', '/actions', null);
        }
        return command(input.action);
      }
    }),
    idempotencyKey: () => `terminal-key-${++keySequence}`
  });
  await controller.selectCall('call-a');

  await assert.rejects(() => controller.hold(), /invalid call state/);
  assert.equal(controller.getSnapshot().error?.retryable, false);
  await controller.hold();

  assert.deepEqual(keys, ['terminal-key-1', 'terminal-key-2']);
});

test('Voice controller prepares extension sessions only when the capability is available', async () => {
  const controller = createConveractFabricVoiceController({
    client: voiceClient(),
    idempotencyKey: () => 'extension-key-a'
  });

  const plan = await controller.prepareExtensionSession('extension/a');
  assert.equal(plan.transport, 'wss');
  assert.equal(plan.websocket_url, 'wss://pbx.example/ws');
  assert.equal(plan.authorization_password, 'ephemeral-secret');
  assert.deepEqual(controller.getSnapshot().extension_session, plan);
  assert.equal(controller.getSnapshot().capabilities?.capabilities.extension_sessions, true);

  const unavailable = createConveractFabricVoiceController({
    client: voiceClient({ extensionSessions: false })
  });
  await assert.rejects(() => unavailable.prepareExtensionSession('extension-a'), /not available/);
  assert.equal(unavailable.getSnapshot().error?.status, 501);
});

function voiceClient(input: {
  extensionSessions?: boolean;
  enqueueCallAction?: ConveractFabricVoiceControllerClient['enqueueCallAction'];
} = {}): ConveractFabricVoiceControllerClient {
  return {
    async getCapabilities() {
      return {
        api_version: 'v1', tenant_id: 'tenant-a',
        capabilities: {
          deployment_profiles: true, sip_trunks: true, dids: true, extensions: true,
          extension_sessions: input.extensionSessions ?? true,
          routes: true, calls: true, call_control: true, provider_events: true,
          recordings: true, parking_slots: true, livekit_sip_bridge: true, provider_webhooks: true
        }
      };
    },
    async createOutboundCall() {
      return { call: call(), command: command('originate') };
    },
    async getCall() {
      return call();
    },
    enqueueCallAction: input.enqueueCallAction ?? (async (_callId, action) => command(action.action)),
    async createLiveKitBridge() {
      return command('livekit_bridge_create');
    },
    async createExtensionSession() {
      return {
        session_id: 'session-a', extension_id: 'extension-a', transport: 'wss',
        websocket_url: 'wss://pbx.example/ws', address_of_record: 'sip:1001@pbx.example',
        authorization_username: 'session-a', authorization_password: 'ephemeral-secret',
        expires_at: '2099-07-13T09:05:00.000Z', register_expires_seconds: 300,
        ice_servers: [], capabilities: {
          incoming: true, outgoing: true, dtmf: true, hold: true, transfer: false,
          audio_input: true, audio_output: true
        }
      };
    }
  };
}

function outboundInput(): ConveractFabricVoiceCreateOutboundCallInput {
  return {
    profile_id: 'profile-a',
    from: { kind: 'extension', value: '1001' },
    to: { kind: 'e164', value: '+8613800138000' },
    business_ref: { type: 'service_order', id: 'order-a' }
  };
}

function call(): ConveractFabricVoiceCall {
  return {
    id: 'call-a', tenant_id: 'tenant-a', business_ref: { type: 'service_order', id: 'order-a' },
    provider_profile_id: 'profile-a', provider_call_id: '', provider_dialog_id: '', media_call_id: null,
    direction: 'outbound', state: 'active',
    from: { kind: 'extension', redacted: '10**' }, to: { kind: 'e164', redacted: '+8613*******00' },
    idempotency_key: 'dial-key', initiated_by: 'operator-a', metadata: {}, ringing_at: null,
    answered_at: '2026-07-13T00:00:00.000Z', ended_at: null, termination_reason: '', revision: 1,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function command(kind: ConveractFabricVoiceCommandKind): ConveractFabricVoiceCallCommand {
  return {
    id: `command-${kind}`, tenant_id: 'tenant-a', call_id: 'call-a', kind, state: 'pending',
    idempotency_key: `key-${kind}`, attempt_count: 0, max_attempts: 5, next_attempt_at: null,
    provider_command_id: '', result: {}, error_code: '', created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z', completed_at: null
  };
}
