import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { installTestDom } from '../test-dom.js';
import { MediaToolbar } from './media-toolbar.js';

let closeDom: () => void;
before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

test('media toolbar exposes bounded capture, layout, device, recording, and hangup commands', () => {
  const calls: string[] = [];
  const view = render(<MediaToolbar
    local={{ microphone: false, camera: true, screen: false, screenAudio: false }}
    layout="grid"
    recording={false}
    disabled={false}
    onMicrophone={(enabled) => { calls.push(`microphone:${enabled}`); }}
    onCamera={(enabled) => { calls.push(`camera:${enabled}`); }}
    onScreenShare={(enabled, options) => { calls.push(`screen:${enabled}:${Boolean(options?.audio)}`); }}
    onLayout={(layout) => { calls.push(`layout:${layout}`); }}
    onDevices={() => { calls.push('devices'); }}
    onRecording={(recording) => { calls.push(`recording:${recording}`); }}
    onHangup={() => { calls.push('hangup'); }}
  />);
  fireEvent.click(view.getByTitle('Turn on microphone'));
  fireEvent.click(view.getByTitle('Turn off camera'));
  fireEvent.click(view.getByTitle('Share screen'));
  fireEvent.click(view.getByTitle('Speaker layout'));
  fireEvent.click(view.getByTitle('Choose devices'));
  fireEvent.click(view.getByTitle('Start recording'));
  fireEvent.click(view.getByTitle('Hang up'));
  assert.deepEqual(calls, [
    'microphone:true', 'camera:false', 'screen:true:true', 'layout:speaker',
    'devices', 'recording:true', 'hangup'
  ]);
});

test('media toolbar keeps dimensions stable and disables every command while pending or terminal', () => {
  const view = render(<MediaToolbar
    local={{ microphone: true, camera: true, screen: true, screenAudio: false }}
    layout="screen_share"
    recording
    disabled
    onMicrophone={() => undefined}
    onCamera={() => undefined}
    onScreenShare={() => undefined}
    onLayout={() => undefined}
    onDevices={() => undefined}
    onRecording={() => undefined}
    onHangup={() => undefined}
  />);
  const buttons = [...view.container.querySelectorAll('button')];
  assert.equal(buttons.length, 9);
  assert.equal(buttons.every((button) => button.disabled), true);
  assert.equal(view.getByTitle('Screen share layout').getAttribute('aria-pressed'), 'true');
});
