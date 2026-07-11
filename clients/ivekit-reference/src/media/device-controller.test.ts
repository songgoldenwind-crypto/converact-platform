import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BrowserDeviceController,
  type DeviceControllerSnapshot,
  type MicrophoneMeter
} from './device-controller.js';

test('device controller requests permission, enumerates devices, and remembers selection in memory', async () => {
  const media = new FakeMediaDevices();
  media.devices = [
    device('audioinput', 'mic-1', 'Desk microphone'),
    device('audioinput', 'mic-2', 'Headset microphone'),
    device('videoinput', 'cam-1', 'Front camera'),
    device('audiooutput', 'speaker-1', 'Desk speakers')
  ];
  media.streams.push(stream(track('audio'), track('video')), stream(track('audio'), track('video')));
  const states: DeviceControllerSnapshot[] = [];
  const controller = new BrowserDeviceController({ mediaDevices: media as never });
  controller.subscribe(() => states.push(controller.getSnapshot()));

  await controller.requestAccess({ mode: 'video' });
  assert.equal(states.some((item) => item.permission === 'requesting'), true);
  assert.equal(controller.getSnapshot().permission, 'granted');
  assert.equal(controller.getSnapshot().selected.audioinput, 'mic-1');
  assert.equal(controller.getSnapshot().selected.videoinput, 'cam-1');
  assert.equal(Object.isFrozen(controller.getSnapshot()), true);

  await controller.selectDevice('audioinput', 'mic-2');
  assert.equal(controller.getSnapshot().selected.audioinput, 'mic-2');
  assert.deepEqual(media.constraints.at(-1), {
    audio: { deviceId: { exact: 'mic-2' } },
    video: { deviceId: { exact: 'cam-1' } }
  });
});

test('device controller keeps permission denial visible and reports an empty device set', async () => {
  const deniedMedia = new FakeMediaDevices();
  const denied = new Error('Camera and microphone permission denied');
  denied.name = 'NotAllowedError';
  deniedMedia.error = denied;
  const deniedController = new BrowserDeviceController({ mediaDevices: deniedMedia as never });
  await assert.rejects(deniedController.requestAccess({ mode: 'video' }), /permission denied/);
  assert.equal(deniedController.getSnapshot().permission, 'denied');
  assert.match(deniedController.getSnapshot().error, /permission denied/);

  const emptyMedia = new FakeMediaDevices();
  emptyMedia.streams.push(stream());
  const emptyController = new BrowserDeviceController({ mediaDevices: emptyMedia as never });
  await emptyController.requestAccess({ mode: 'voice' });
  assert.deepEqual(emptyController.getSnapshot().devices.audioinput, []);
  assert.deepEqual(emptyController.getSnapshot().devices.videoinput, []);
});

test('device unplug falls back to an available selection and replaces the active stream', async () => {
  const media = new FakeMediaDevices();
  media.devices = [device('audioinput', 'mic-1', 'Desk'), device('audioinput', 'mic-2', 'Headset')];
  const firstTrack = track('audio');
  media.streams.push(stream(firstTrack), stream(track('audio')), stream(track('audio')));
  const controller = new BrowserDeviceController({ mediaDevices: media as never });
  await controller.requestAccess({ mode: 'voice' });
  await controller.selectDevice('audioinput', 'mic-2');

  media.devices = [device('audioinput', 'mic-1', 'Desk')];
  await media.emitDeviceChange();
  assert.equal(controller.getSnapshot().selected.audioinput, 'mic-1');
  assert.equal(media.constraints.length, 3);
  assert.equal(firstTrack.stopCalls, 1);
});

test('preview, capture tracks, device listener, and microphone sampling are cleaned up', async () => {
  const media = new FakeMediaDevices();
  media.devices = [device('audioinput', 'mic-1', 'Mic'), device('videoinput', 'cam-1', 'Camera')];
  const audio = track('audio');
  const video = track('video');
  media.streams.push(stream(audio, video));
  const meters: FakeMeter[] = [];
  const controller = new BrowserDeviceController({
    mediaDevices: media as never,
    meterFactory: (_stream, onLevel) => {
      const meter = new FakeMeter(onLevel);
      meters.push(meter);
      return meter;
    }
  });
  const preview = { srcObject: null, muted: false, play: async () => undefined } as unknown as HTMLVideoElement;
  controller.attachPreview(preview);
  await controller.requestAccess({ mode: 'video' });
  meters[0].sample(0.42);
  assert.equal(preview.srcObject === null, false);
  assert.equal(preview.muted, true);
  assert.equal(controller.getSnapshot().microphoneLevel, 0.42);

  await controller.dispose();
  assert.equal(preview.srcObject, null);
  assert.equal(audio.stopCalls, 1);
  assert.equal(video.stopCalls, 1);
  assert.equal(meters[0].disposeCalls, 1);
  assert.equal(media.listenerCount, 0);
});

test('output selection fails explicitly when setSinkId is unavailable', async () => {
  const controller = new BrowserDeviceController({
    mediaDevices: new FakeMediaDevices() as never,
    outputSelectionSupported: false
  });
  await assert.rejects(
    controller.setOutputDevice({} as HTMLMediaElement, 'speaker-1'),
    /not supported/
  );
});

test('listen-only prejoin never asks the browser for an invalid empty capture', async () => {
  const media = new FakeMediaDevices();
  media.devices = [device('audiooutput', 'speaker-1', 'Speakers')];
  const controller = new BrowserDeviceController({ mediaDevices: media as never });
  await controller.setMicrophoneEnabled(false);
  controller.setMode('voice');
  await controller.requestAccess({ mode: 'voice' });
  assert.equal(controller.getSnapshot().permission, 'granted');
  assert.equal(media.constraints.length, 0);
});

class FakeMediaDevices {
  devices: MediaDeviceInfo[] = [];
  streams: MediaStream[] = [];
  constraints: MediaStreamConstraints[] = [];
  error?: Error;
  private listeners = new Set<() => void | Promise<void>>();

  get listenerCount() { return this.listeners.size; }
  addEventListener(event: string, listener: () => void) {
    if (event === 'devicechange') this.listeners.add(listener);
  }
  removeEventListener(event: string, listener: () => void) {
    if (event === 'devicechange') this.listeners.delete(listener);
  }
  async getUserMedia(constraints: MediaStreamConstraints) {
    this.constraints.push(constraints);
    if (this.error) throw this.error;
    const next = this.streams.shift();
    if (!next) throw new Error('missing fake stream');
    return next;
  }
  async enumerateDevices() { return this.devices; }
  async emitDeviceChange() {
    await Promise.all([...this.listeners].map((listener) => listener()));
    await Promise.resolve();
  }
}

class FakeMeter implements MicrophoneMeter {
  disposeCalls = 0;
  constructor(private readonly onLevel: (level: number) => void) {}
  sample(level: number) { this.onLevel(level); }
  dispose() { this.disposeCalls += 1; }
}

type FakeTrack = MediaStreamTrack & { stopCalls: number };

function track(kind: 'audio' | 'video'): FakeTrack {
  return {
    kind,
    enabled: true,
    stopCalls: 0,
    stop() { this.stopCalls += 1; }
  } as FakeTrack;
}

function stream(...tracks: FakeTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((item) => item.kind === 'audio'),
    getVideoTracks: () => tracks.filter((item) => item.kind === 'video')
  } as unknown as MediaStream;
}

function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: '', toJSON: () => ({}) } as MediaDeviceInfo;
}
