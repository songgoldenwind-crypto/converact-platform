import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createIveKitSipWebPhone,
  type IveKitSipAudioElement,
  type IveKitSipWebPhoneEngine,
  type IveKitSipWebPhoneEngineEvents
} from '../sdk/converact/src/sip-webphone.js';
import {
  parseIveKitVoiceExtensionSessionPlan,
  type IveKitVoiceExtensionSessionPlan
} from '../sdk/converact/src/voice-types.js';

const NOW = Date.parse('2026-07-13T09:00:00.000Z');

test('extension session plans reject unsafe transports, expiry, and missing ephemeral credentials', () => {
  assert.equal(parseIveKitVoiceExtensionSessionPlan(sessionPlan(), { now: () => NOW }).transport, 'wss');
  assert.throws(
    () => parseIveKitVoiceExtensionSessionPlan(
      { ...sessionPlan(), websocket_url: 'ws://pbx.example/ws' }, { now: () => NOW }
    ),
    /invalid voice extension session plan/
  );
  assert.throws(
    () => parseIveKitVoiceExtensionSessionPlan(
      { ...sessionPlan(), expires_at: '2026-07-13T08:59:59.000Z' }, { now: () => NOW }
    ),
    /expired voice extension session plan/
  );
  assert.throws(
    () => parseIveKitVoiceExtensionSessionPlan(
      { ...sessionPlan(), authorization_password: '' }, { now: () => NOW }
    ),
    /invalid voice extension session plan/
  );
});

test('SIP WebPhone drives registration, calling, media controls, and devices through one state model', async () => {
  const actions: string[] = [];
  let events!: IveKitSipWebPhoneEngineEvents;
  const engine: IveKitSipWebPhoneEngine = {
    async connect() { actions.push('connect'); events.registration('registered'); },
    async disconnect() { actions.push('disconnect'); events.registration('stopped'); },
    async dial(target) { actions.push(`dial:${target}`); events.call('outgoing', target); },
    async answer() { actions.push('answer'); events.call('active', 'sip:customer@example.com'); },
    async reject() { actions.push('reject'); events.call('idle', ''); },
    async hangup() { actions.push('hangup'); events.call('idle', ''); },
    async setMuted(muted) { actions.push(`muted:${muted}`); },
    async setHeld(held) { actions.push(`held:${held}`); events.call(held ? 'held' : 'active'); },
    async sendDtmf(tones) { actions.push(`dtmf:${tones}`); },
    async setInputDevice(id) { actions.push(`input:${id}`); },
    async setOutputDevice(id) { actions.push(`output:${id}`); },
    async listAudioDevices() {
      return [{ device_id: 'mic-a', kind: 'audioinput', label: 'Mic A' }];
    },
    attachRemoteAudio() { actions.push('attach'); }
  };
  const phone = createIveKitSipWebPhone({
    plan: sessionPlan(), now: () => NOW,
    engineFactory(input) { events = input.events; return engine; }
  });
  const phases: string[] = [];
  const unsubscribe = phone.subscribe((state) => phases.push(`${state.registration}:${state.call}`));

  await phone.connect();
  await phone.dial('sip:customer@example.com');
  events.call('active', 'sip:customer@example.com');
  await phone.setMuted(true);
  await phone.setHeld(true);
  await phone.sendDtmf('12#');
  await phone.setInputDevice('mic-a');
  await phone.setOutputDevice('speaker-a');
  await phone.setInputDevice('');
  await phone.setOutputDevice('');
  phone.attachRemoteAudio({} as IveKitSipAudioElement);
  assert.deepEqual(await phone.listAudioDevices(), [
    { device_id: 'mic-a', kind: 'audioinput', label: 'Mic A' }
  ]);
  await phone.setHeld(false);
  await phone.hangup();

  events.call('incoming', 'sip:customer@example.com');
  await phone.answer();
  await phone.hangup();
  events.call('incoming', 'sip:other@example.com');
  await phone.reject();
  await phone.disconnect();
  unsubscribe();

  assert.deepEqual(actions, [
    'connect', 'dial:sip:customer@example.com', 'muted:true', 'held:true', 'dtmf:12#',
    'input:mic-a', 'output:speaker-a', 'input:', 'output:', 'attach', 'held:false', 'hangup',
    'answer', 'hangup', 'reject', 'disconnect'
  ]);
  assert.ok(phases.includes('registered:outgoing'));
  assert.ok(phases.includes('registered:incoming'));
  assert.equal(phone.getSnapshot().registration, 'stopped');
  assert.equal(phone.getSnapshot().call, 'idle');
});

test('SIP WebPhone unregisters when its ephemeral plan expires', async () => {
  let now = NOW;
  let expire!: () => void;
  const actions: string[] = [];
  let events!: IveKitSipWebPhoneEngineEvents;
  const phone = createIveKitSipWebPhone({
    plan: sessionPlan(), now: () => now,
    timer: {
      set(callback) { expire = callback; return 'expiry-timer'; },
      clear() { actions.push('clear-expiry'); }
    },
    engineFactory(input) {
      events = input.events;
      return {
        async connect() { actions.push('connect'); events.registration('registered'); },
        async disconnect() { actions.push('disconnect'); },
        async dial() {}, async answer() {}, async reject() {}, async hangup() {},
        async setMuted() {}, async setHeld() {}, async sendDtmf() {},
        async setInputDevice() {}, async setOutputDevice() {},
        async listAudioDevices() { return []; }, attachRemoteAudio() {}
      };
    }
  });

  await phone.connect();
  now = Date.parse(sessionPlan().expires_at);
  expire();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(actions.includes('disconnect'));
  assert.equal(phone.getSnapshot().registration, 'stopped');
  assert.match(phone.getSnapshot().error || '', /expired/);
});

test('SIP WebPhone enforces session capabilities before touching its engine', async () => {
  const phone = createIveKitSipWebPhone({
    plan: sessionPlan({ capabilities: { ...sessionPlan().capabilities, outgoing: false, dtmf: false } }),
    now: () => NOW,
    engineFactory: () => ({
      async connect() {}, async disconnect() {}, async dial() {}, async answer() {}, async reject() {},
      async hangup() {}, async setMuted() {}, async setHeld() {}, async sendDtmf() {},
      async setInputDevice() {}, async setOutputDevice() {}, async listAudioDevices() { return []; },
      attachRemoteAudio() {}
    })
  });
  await assert.rejects(() => phone.dial('sip:customer@example.com'), /outgoing calls are unavailable/);
  await assert.rejects(() => phone.sendDtmf('1'), /DTMF is unavailable/);
});

test('SIP WebPhone keeps the selected device stable when switching fails', async () => {
  const phone = createIveKitSipWebPhone({
    plan: sessionPlan(), now: () => NOW,
    engineFactory: () => ({
      async connect() {}, async disconnect() {}, async dial() {}, async answer() {}, async reject() {},
      async hangup() {}, async setMuted() {}, async setHeld() {}, async sendDtmf() {},
      async setInputDevice() { throw new Error('media renegotiation rejected'); },
      async setOutputDevice() {}, async listAudioDevices() { return []; }, attachRemoteAudio() {}
    })
  });

  await assert.rejects(() => phone.setInputDevice('mic-b'), /media renegotiation rejected/);
  assert.equal(phone.getSnapshot().input_device_id, '');
});

test('SIP WebPhone surfaces an output-device binding failure', async () => {
  const phone = createIveKitSipWebPhone({ plan: sessionPlan(), now: () => NOW });
  await phone.setOutputDevice('speaker-b');
  phone.attachRemoteAudio({
    autoplay: false,
    srcObject: null,
    async play() {},
    async setSinkId() { throw new Error('speaker unavailable'); }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(phone.getSnapshot().error || '', /speaker unavailable/);
  await phone.dispose();
});

function sessionPlan(
  patch: Partial<IveKitVoiceExtensionSessionPlan> = {}
): IveKitVoiceExtensionSessionPlan {
  return {
    session_id: 'webrtc-session-a', extension_id: 'extension-a', transport: 'wss',
    websocket_url: 'wss://pbx.example/ws', address_of_record: 'sip:1001@pbx.example',
    authorization_username: 'webrtc-session-a', authorization_password: 'ephemeral-secret',
    display_name: 'Agent A', expires_at: '2026-07-13T09:05:00.000Z',
    register_expires_seconds: 300, ice_servers: [{ urls: 'stun:stun.example:3478' }],
    capabilities: {
      incoming: true, outgoing: true, dtmf: true, hold: true, transfer: false,
      audio_input: true, audio_output: true
    },
    ...patch
  };
}
