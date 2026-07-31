import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

import { installTestDom } from '../test-dom.js';
import type {
  DeviceController,
  DeviceControllerSnapshot,
  MediaCallMode,
  SelectableDeviceKind
} from './device-controller.js';
import { PrejoinPanel } from './prejoin-panel.js';

let closeDom: () => void;

before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

test('prejoin panel routes mode, capture, and device controls through the controller', async () => {
  const controller = new FakeController(snapshot());
  const view = render(<PrejoinPanel controller={controller} onJoin={async () => undefined} />);
  assert.equal(controller.previewAttached, 1);

  fireEvent.click(view.getByRole('button', { name: 'Voice' }));
  fireEvent.click(view.getByTitle('Turn off microphone'));
  fireEvent.click(view.getByTitle('Turn on camera'));
  fireEvent.change(view.getByLabelText('Microphone'), { target: { value: 'mic-2' } });
  fireEvent.change(view.getByLabelText('Camera'), { target: { value: 'cam-2' } });
  fireEvent.change(view.getByLabelText('Speaker'), { target: { value: 'speaker-2' } });

  await waitFor(() => assert.deepEqual(controller.calls, [
    'mode:voice',
    'microphone:false',
    'camera:true',
    'device:audioinput:mic-2',
    'device:videoinput:cam-2',
    'device:audiooutput:speaker-2'
  ]));
  view.unmount();
  assert.equal(controller.previewDetached, 1);
});

test('permission failure stays visible and never invokes Join', async () => {
  const controller = new FakeController(snapshot({ permission: 'idle' }));
  controller.accessError = new Error('Camera permission denied');
  let joins = 0;
  const view = render(<PrejoinPanel controller={controller} onJoin={async () => { joins += 1; }} />);
  fireEvent.click(view.getByRole('button', { name: 'Join' }));
  await waitFor(() => assert.match(view.getByRole('alert').textContent || '', /permission denied/));
  assert.equal(joins, 0);
  assert.equal(controller.calls.includes('access:video'), true);
});

test('granted prejoin exposes level and passes the latest immutable snapshot to Accept', async () => {
  const controller = new FakeController(snapshot({ permission: 'granted', microphoneLevel: 0.37 }));
  let joined: DeviceControllerSnapshot | null = null;
  const view = render(<PrejoinPanel commandLabel="Accept" controller={controller} onJoin={async (value) => { joined = value; }} />);
  assert.equal(view.getByRole('progressbar').getAttribute('aria-valuenow'), '37');
  fireEvent.click(view.getByRole('button', { name: 'Accept' }));
  await waitFor(() => assert.equal(joined, controller.getSnapshot()));
  assert.equal(controller.calls.some((item) => item.startsWith('access:')), false);
});

test('unsupported output selection is disabled without hiding other devices', () => {
  const controller = new FakeController(snapshot({ outputSelectionSupported: false }));
  const view = render(<PrejoinPanel controller={controller} onJoin={async () => undefined} />);
  assert.equal((view.getByLabelText('Speaker') as HTMLSelectElement).disabled, true);
  assert.equal((view.getByLabelText('Microphone') as HTMLSelectElement).disabled, false);
  assert.ok(view.getByText('Output selection unavailable'));
});

class FakeController implements DeviceController {
  readonly calls: string[] = [];
  previewAttached = 0;
  previewDetached = 0;
  accessError?: Error;
  private readonly listeners = new Set<() => void>();

  constructor(private value: DeviceControllerSnapshot) {}
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  async requestAccess({ mode }: { mode: MediaCallMode }) {
    this.calls.push(`access:${mode}`);
    if (this.accessError) {
      this.value = snapshot({ permission: 'denied', error: this.accessError.message });
      this.emit();
      throw this.accessError;
    }
    this.value = snapshot({ ...this.value, permission: 'granted' });
    this.emit();
  }
  setMode(mode: MediaCallMode) {
    this.calls.push(`mode:${mode}`);
    this.value = snapshot({ ...this.value, mode, cameraEnabled: mode === 'video' });
    this.emit();
  }
  async selectDevice(kind: SelectableDeviceKind, deviceId: string) {
    this.calls.push(`device:${kind}:${deviceId}`);
    this.value = snapshot({ ...this.value, selected: { ...this.value.selected, [kind]: deviceId } });
    this.emit();
  }
  async setMicrophoneEnabled(enabled: boolean) {
    this.calls.push(`microphone:${enabled}`);
    this.value = snapshot({ ...this.value, microphoneEnabled: enabled });
    this.emit();
  }
  async setCameraEnabled(enabled: boolean) {
    this.calls.push(`camera:${enabled}`);
    this.value = snapshot({ ...this.value, cameraEnabled: enabled });
    this.emit();
  }
  attachPreview() {
    this.previewAttached += 1;
    return () => { this.previewDetached += 1; };
  }
  async setOutputDevice() {}
  async dispose() {}
  private emit() { for (const listener of this.listeners) listener(); }
}

function snapshot(overrides: Partial<DeviceControllerSnapshot> = {}): DeviceControllerSnapshot {
  const value: DeviceControllerSnapshot = {
    permission: 'granted',
    mode: 'video',
    microphoneEnabled: true,
    cameraEnabled: false,
    microphoneLevel: 0,
    outputSelectionSupported: true,
    devices: {
      audioinput: [{ deviceId: 'mic-1', label: 'Desk microphone' }, { deviceId: 'mic-2', label: 'Headset microphone' }],
      videoinput: [{ deviceId: 'cam-1', label: 'Front camera' }, { deviceId: 'cam-2', label: 'Document camera' }],
      audiooutput: [{ deviceId: 'speaker-1', label: 'Desk speakers' }, { deviceId: 'speaker-2', label: 'Headset speakers' }]
    },
    selected: { audioinput: 'mic-1', videoinput: 'cam-1', audiooutput: 'speaker-1' },
    error: '',
    ...overrides
  };
  return Object.freeze(value);
}
