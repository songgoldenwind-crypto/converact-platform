import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import React from 'react';
import type {
  IveKitSipWebPhone,
  IveKitSipWebPhoneState
} from '@converact/sdk/sip-webphone';
import type { IveKitVoiceExtensionSessionPlan } from '@converact/sdk';

import { installTestDom } from '../test-dom.js';

const closeDom = installTestDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { SipPhonePanel } = await import('./sip-phone-panel.js');

after(() => { cleanup(); closeDom(); });
afterEach(() => cleanup());

test('SIP phone panel exposes the complete single-call workflow without rendering credentials', async () => {
  const actions: string[] = [];
  let state: Readonly<IveKitSipWebPhoneState> = {
    registration: 'idle', call: 'idle', remote_identity: '', muted: false,
    input_device_id: '', output_device_id: '', error: null
  };
  const listeners = new Set<(value: Readonly<IveKitSipWebPhoneState>) => void>();
  const emit = (patch: Partial<IveKitSipWebPhoneState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };
  const phone: IveKitSipWebPhone = {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    async connect() { actions.push('connect'); emit({ registration: 'registered' }); },
    async disconnect() { actions.push('disconnect'); emit({ registration: 'stopped', call: 'idle' }); },
    async dial(target) { actions.push(`dial:${target}`); emit({ call: 'outgoing', remote_identity: target }); },
    async answer() { actions.push('answer'); emit({ call: 'active' }); },
    async reject() { actions.push('reject'); emit({ call: 'idle' }); },
    async hangup() { actions.push('hangup'); emit({ call: 'idle' }); },
    async setMuted(muted) { actions.push(`muted:${muted}`); emit({ muted }); },
    async setHeld(held) { actions.push(`held:${held}`); emit({ call: held ? 'held' : 'active' }); },
    async sendDtmf(tones) { actions.push(`dtmf:${tones}`); },
    async setInputDevice(id) { actions.push(`input:${id}`); emit({ input_device_id: id }); },
    async setOutputDevice(id) { actions.push(`output:${id}`); emit({ output_device_id: id }); },
    async listAudioDevices() {
      return [
        { device_id: 'mic-a', kind: 'audioinput', label: 'Desk microphone' },
        { device_id: 'speaker-a', kind: 'audiooutput', label: 'Desk speaker' }
      ];
    },
    attachRemoteAudio() { actions.push('attach'); },
    async dispose() { actions.push('dispose'); }
  };
  const view = render(<SipPhonePanel plan={sessionPlan()} createPhone={() => phone} />);

  assert.equal(view.container.textContent?.includes('ephemeral-secret'), false);
  fireEvent.click(view.getByTitle('Register SIP phone'));
  await waitFor(() => assert.ok(view.getByText('registered')));
  assert.equal((view.getByLabelText('Audio input') as HTMLSelectElement).options.length, 2);

  fireEvent.input(view.getByLabelText('SIP destination'), { target: { value: '1002' } });
  fireEvent.click(view.getByTitle('Dial SIP call'));
  await waitFor(() => assert.ok(actions.includes('dial:1002')));

  act(() => emit({ call: 'incoming', remote_identity: 'sip:customer@example.com' }));
  fireEvent.click(view.getByTitle('Answer incoming call'));
  await waitFor(() => assert.ok(actions.includes('answer')));
  fireEvent.click(view.getByTitle('Mute microphone'));
  await waitFor(() => assert.ok(actions.includes('muted:true')));
  fireEvent.click(view.getByTitle('Hold SIP call'));
  await waitFor(() => assert.ok(actions.includes('held:true')));
  fireEvent.click(view.getByTitle('Send DTMF 5'));
  await waitFor(() => assert.ok(actions.includes('dtmf:5')));
  fireEvent.change(view.getByLabelText('Audio input'), { target: { value: 'mic-a' } });
  await waitFor(() => assert.ok(actions.includes('input:mic-a')));
  fireEvent.change(view.getByLabelText('Audio output'), { target: { value: 'speaker-a' } });
  await waitFor(() => assert.ok(actions.includes('output:speaker-a')));

  act(() => emit({ call: 'incoming', remote_identity: 'sip:other@example.com' }));
  fireEvent.click(view.getByTitle('Reject incoming call'));
  await waitFor(() => assert.ok(actions.includes('reject')));
  view.unmount();
  await waitFor(() => assert.ok(actions.includes('dispose')));

  assert.ok(actions.includes('attach'));
  assert.ok(actions.includes('muted:true'));
  assert.ok(actions.includes('held:true'));
  assert.ok(actions.includes('dtmf:5'));
  assert.ok(actions.includes('input:mic-a'));
});

function sessionPlan(): IveKitVoiceExtensionSessionPlan {
  return {
    session_id: 'webrtc-session-a', extension_id: 'extension-a', transport: 'wss',
    websocket_url: 'wss://pbx.example/ws', address_of_record: 'sip:1001@pbx.example',
    authorization_username: 'webrtc-session-a', authorization_password: 'ephemeral-secret',
    display_name: 'Agent A', expires_at: '2099-07-13T09:05:00.000Z',
    register_expires_seconds: 300, ice_servers: [],
    capabilities: {
      incoming: true, outgoing: true, dtmf: true, hold: true, transfer: false,
      audio_input: true, audio_output: true
    }
  };
}
