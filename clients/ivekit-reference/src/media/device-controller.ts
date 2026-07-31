export type DevicePermissionState =
  | 'idle'
  | 'requesting'
  | 'granted'
  | 'denied'
  | 'error'
  | 'unsupported'
  | 'disposed';

export type MediaCallMode = 'voice' | 'video';
export type SelectableDeviceKind = 'audioinput' | 'videoinput' | 'audiooutput';

export interface DeviceChoice {
  readonly deviceId: string;
  readonly label: string;
}

export interface DeviceControllerSnapshot {
  readonly permission: DevicePermissionState;
  readonly mode: MediaCallMode;
  readonly microphoneEnabled: boolean;
  readonly cameraEnabled: boolean;
  readonly microphoneLevel: number;
  readonly outputSelectionSupported: boolean;
  readonly devices: Readonly<Record<SelectableDeviceKind, readonly DeviceChoice[]>>;
  readonly selected: Readonly<Record<SelectableDeviceKind, string>>;
  readonly error: string;
}

export interface MicrophoneMeter {
  dispose(): void;
}

export interface DeviceControllerInput {
  mediaDevices?: MediaDevices;
  meterFactory?: (stream: MediaStream, onLevel: (level: number) => void) => MicrophoneMeter;
  outputSelectionSupported?: boolean;
}

export interface DeviceController {
  getSnapshot(): DeviceControllerSnapshot;
  subscribe(listener: () => void): () => void;
  requestAccess(options: { mode: MediaCallMode }): Promise<void>;
  setMode(mode: MediaCallMode): void;
  selectDevice(kind: SelectableDeviceKind, deviceId: string): Promise<void>;
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  setCameraEnabled(enabled: boolean): Promise<void>;
  attachPreview(element: HTMLVideoElement): () => void;
  setOutputDevice(element: HTMLMediaElement, deviceId: string): Promise<void>;
  dispose(): Promise<void>;
}

type SnapshotDraft = {
  permission: DevicePermissionState;
  mode: MediaCallMode;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  microphoneLevel: number;
  outputSelectionSupported: boolean;
  devices: Record<SelectableDeviceKind, DeviceChoice[]>;
  selected: Record<SelectableDeviceKind, string>;
  error: string;
};

const emptyDevices = (): Record<SelectableDeviceKind, DeviceChoice[]> => ({
  audioinput: [],
  videoinput: [],
  audiooutput: []
});

const emptySelection = (): Record<SelectableDeviceKind, string> => ({
  audioinput: '',
  videoinput: '',
  audiooutput: ''
});

export class BrowserDeviceController implements DeviceController {
  private readonly mediaDevices: MediaDevices | null;
  private snapshot: DeviceControllerSnapshot;
  private readonly listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private preview: HTMLVideoElement | null = null;
  private meter: MicrophoneMeter | null = null;
  private generation = 0;
  private disposed = false;

  private readonly handleDeviceChange = async () => {
    try {
      await this.refreshDevices(true);
    } catch (cause) {
      if (!this.disposed) this.patch({ error: errorMessage(cause) });
    }
  };

  constructor(private readonly input: DeviceControllerInput = {}) {
    this.mediaDevices = input.mediaDevices || browserMediaDevices();
    this.snapshot = freezeSnapshot({
      permission: this.mediaDevices ? 'idle' : 'unsupported',
      mode: 'video',
      microphoneEnabled: true,
      cameraEnabled: true,
      microphoneLevel: 0,
      outputSelectionSupported: input.outputSelectionSupported ?? supportsOutputSelection(),
      devices: emptyDevices(),
      selected: emptySelection(),
      error: this.mediaDevices ? '' : 'Media devices are not supported by this browser'
    });
    this.mediaDevices?.addEventListener('devicechange', this.handleDeviceChange);
  }

  getSnapshot = (): DeviceControllerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async requestAccess(options: { mode: MediaCallMode }): Promise<void> {
    this.assertAvailable();
    const generation = ++this.generation;
    const cameraEnabled = options.mode === 'video'
      ? this.snapshot.mode === 'voice' || this.snapshot.cameraEnabled
      : false;
    this.patch({
      permission: 'requesting',
      mode: options.mode,
      cameraEnabled,
      error: ''
    });
    try {
      const constraints = this.constraints();
      if (!captureRequested(constraints)) {
        this.releaseStream();
        await this.refreshDevices(false);
        if (!this.isCurrent(generation)) throw new Error('Media device request cancelled');
        this.patch({ permission: 'granted', error: '' });
        return;
      }
      const stream = await this.mediaDevices!.getUserMedia(constraints);
      if (!this.isCurrent(generation)) {
        stopStream(stream);
        throw new Error('Media device request cancelled');
      }
      await this.replaceStream(stream);
      await this.refreshDevices(false);
      if (!this.isCurrent(generation)) throw new Error('Media device request cancelled');
      this.patch({ permission: 'granted', error: '' });
    } catch (cause) {
      if (!this.isCurrent(generation)) throw cause;
      const denied = isPermissionDenied(cause);
      this.patch({ permission: denied ? 'denied' : 'error', error: errorMessage(cause) });
      throw cause;
    }
  }

  setMode(mode: MediaCallMode): void {
    this.assertNotDisposed();
    if (this.snapshot.mode === mode) return;
    this.patch({ mode, cameraEnabled: mode === 'video' });
    this.stream?.getVideoTracks().forEach((track) => { track.enabled = mode === 'video'; });
  }

  async refreshDevices(reacquireOnFallback = true): Promise<void> {
    this.assertAvailable();
    const listed = await this.mediaDevices!.enumerateDevices();
    if (this.disposed) return;
    const devices = emptyDevices();
    for (const item of listed) {
      if (!isSelectableKind(item.kind)) continue;
      devices[item.kind].push(Object.freeze({
        deviceId: item.deviceId,
        label: item.label || defaultDeviceLabel(item.kind, devices[item.kind].length + 1)
      }));
    }
    const selected = { ...this.snapshot.selected };
    let captureFallback = false;
    for (const kind of selectableKinds) {
      const available = devices[kind];
      const previous = selected[kind];
      if (!available.some((item) => item.deviceId === previous)) {
        selected[kind] = available[0]?.deviceId || '';
        if (kind !== 'audiooutput' && previous !== selected[kind]) captureFallback = true;
      }
    }
    this.patch({ devices, selected });
    if (captureFallback && reacquireOnFallback && this.snapshot.permission === 'granted') {
      await this.reacquire();
    }
  }

  async selectDevice(kind: SelectableDeviceKind, deviceId: string): Promise<void> {
    this.assertAvailable();
    if (!this.snapshot.devices[kind].some((item) => item.deviceId === deviceId)) {
      throw new Error(`Selected ${kind} device is unavailable`);
    }
    if (this.snapshot.selected[kind] === deviceId) return;
    this.patch({ selected: { ...this.snapshot.selected, [kind]: deviceId } });
    if (kind !== 'audiooutput' && this.snapshot.permission === 'granted') await this.reacquire();
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    this.assertAvailable();
    this.patch({ microphoneEnabled: enabled });
    const tracks = this.stream?.getAudioTracks() || [];
    if (enabled && !tracks.length && this.snapshot.permission === 'granted') {
      await this.reacquire();
      return;
    }
    tracks.forEach((track) => { track.enabled = enabled; });
    if (!enabled) this.stopMeter();
    else if (this.stream) this.startMeter(this.stream);
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    this.assertAvailable();
    this.patch({ cameraEnabled: enabled, mode: enabled ? 'video' : this.snapshot.mode });
    const tracks = this.stream?.getVideoTracks() || [];
    if (enabled && !tracks.length && this.snapshot.permission === 'granted') {
      await this.reacquire();
      return;
    }
    tracks.forEach((track) => { track.enabled = enabled; });
  }

  attachPreview(element: HTMLVideoElement): () => void {
    this.assertNotDisposed();
    if (this.preview && this.preview !== element) this.preview.srcObject = null;
    this.preview = element;
    this.updatePreview();
    return () => {
      if (this.preview !== element) return;
      element.srcObject = null;
      this.preview = null;
    };
  }

  async setOutputDevice(element: HTMLMediaElement, deviceId: string): Promise<void> {
    this.assertNotDisposed();
    const sinkElement = element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
    if (!this.snapshot.outputSelectionSupported || typeof sinkElement.setSinkId !== 'function') {
      throw new Error('Audio output selection is not supported by this browser');
    }
    await sinkElement.setSinkId(deviceId);
    if (this.snapshot.selected.audiooutput !== deviceId) {
      this.patch({ selected: { ...this.snapshot.selected, audiooutput: deviceId } });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.mediaDevices?.removeEventListener('devicechange', this.handleDeviceChange);
    this.releaseStream();
    if (this.preview) this.preview.srcObject = null;
    this.preview = null;
    this.patch({ permission: 'disposed', microphoneLevel: 0 });
    this.listeners.clear();
  }

  private async reacquire(): Promise<void> {
    const generation = ++this.generation;
    try {
      const constraints = this.constraints();
      if (!captureRequested(constraints)) {
        this.releaseStream();
        this.patch({ error: '' });
        return;
      }
      const stream = await this.mediaDevices!.getUserMedia(constraints);
      if (!this.isCurrent(generation)) {
        stopStream(stream);
        return;
      }
      await this.replaceStream(stream);
      this.patch({ error: '' });
    } catch (cause) {
      if (this.isCurrent(generation)) this.patch({ error: errorMessage(cause) });
      throw cause;
    }
  }

  private constraints(): MediaStreamConstraints {
    return {
      audio: this.snapshot.microphoneEnabled
        ? selectedConstraint(this.snapshot.selected.audioinput)
        : false,
      video: this.snapshot.mode === 'video' && this.snapshot.cameraEnabled
        ? selectedConstraint(this.snapshot.selected.videoinput)
        : false
    };
  }

  private async replaceStream(stream: MediaStream): Promise<void> {
    this.releaseStream();
    this.stream = stream;
    stream.getAudioTracks().forEach((track) => { track.enabled = this.snapshot.microphoneEnabled; });
    stream.getVideoTracks().forEach((track) => { track.enabled = this.snapshot.cameraEnabled; });
    this.updatePreview();
    if (this.snapshot.microphoneEnabled && stream.getAudioTracks().length) this.startMeter(stream);
  }

  private releaseStream(): void {
    this.stopMeter();
    stopStream(this.stream);
    this.stream = null;
  }

  private startMeter(stream: MediaStream): void {
    this.stopMeter();
    const factory = this.input.meterFactory || createBrowserMeter;
    this.meter = factory(stream, (level) => {
      const next = clampLevel(level);
      if (!this.disposed && Math.abs(this.snapshot.microphoneLevel - next) >= 0.01) {
        this.patch({ microphoneLevel: next });
      }
    });
  }

  private stopMeter(): void {
    this.meter?.dispose();
    this.meter = null;
    if (this.snapshot.microphoneLevel !== 0) this.patch({ microphoneLevel: 0 });
  }

  private updatePreview(): void {
    if (!this.preview) return;
    this.preview.muted = true;
    this.preview.srcObject = this.stream;
    if (this.stream) void this.preview.play().catch(() => undefined);
  }

  private patch(update: Partial<SnapshotDraft>): void {
    this.snapshot = freezeSnapshot({
      ...this.snapshot,
      ...update,
      devices: update.devices || cloneDevices(this.snapshot.devices),
      selected: update.selected ? { ...update.selected } : { ...this.snapshot.selected }
    });
    for (const listener of this.listeners) listener();
  }

  private assertAvailable(): void {
    this.assertNotDisposed();
    if (!this.mediaDevices) throw new Error('Media devices are not supported by this browser');
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('Device controller is disposed');
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }
}

const selectableKinds: readonly SelectableDeviceKind[] = ['audioinput', 'videoinput', 'audiooutput'];

function browserMediaDevices(): MediaDevices | null {
  return typeof navigator !== 'undefined' && navigator.mediaDevices ? navigator.mediaDevices : null;
}

function supportsOutputSelection(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

function selectedConstraint(deviceId: string): true | MediaTrackConstraints {
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

function captureRequested(constraints: MediaStreamConstraints): boolean {
  return constraints.audio !== false || constraints.video !== false;
}

function isSelectableKind(kind: MediaDeviceKind): kind is SelectableDeviceKind {
  return kind === 'audioinput' || kind === 'videoinput' || kind === 'audiooutput';
}

function defaultDeviceLabel(kind: SelectableDeviceKind, index: number): string {
  const name = kind === 'audioinput' ? 'Microphone' : kind === 'videoinput' ? 'Camera' : 'Speaker';
  return `${name} ${index}`;
}

function freezeSnapshot(draft: SnapshotDraft): DeviceControllerSnapshot {
  const devices = Object.freeze({
    audioinput: Object.freeze([...draft.devices.audioinput]),
    videoinput: Object.freeze([...draft.devices.videoinput]),
    audiooutput: Object.freeze([...draft.devices.audiooutput])
  });
  return Object.freeze({
    ...draft,
    devices,
    selected: Object.freeze({ ...draft.selected })
  });
}

function cloneDevices(devices: DeviceControllerSnapshot['devices']): Record<SelectableDeviceKind, DeviceChoice[]> {
  return {
    audioinput: [...devices.audioinput],
    videoinput: [...devices.videoinput],
    audiooutput: [...devices.audiooutput]
  };
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function isPermissionDenied(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'NotAllowedError' || cause.name === 'PermissionDeniedError');
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function clampLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
}

function createBrowserMeter(stream: MediaStream, onLevel: (level: number) => void): MicrophoneMeter {
  const audioGlobal = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const AudioContextConstructor = typeof AudioContext === 'undefined'
    ? audioGlobal.webkitAudioContext || null
    : AudioContext;
  if (!AudioContextConstructor || typeof requestAnimationFrame === 'undefined') return { dispose() {} };
  const context = new AudioContextConstructor();
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  const source = context.createMediaStreamSource(stream);
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  let frame = 0;
  let disposed = false;
  const sample = () => {
    if (disposed) return;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) {
      const normalized = (value - 128) / 128;
      sum += normalized * normalized;
    }
    onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3));
    frame = requestAnimationFrame(sample);
  };
  frame = requestAnimationFrame(sample);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      void context.close();
    }
  };
}
