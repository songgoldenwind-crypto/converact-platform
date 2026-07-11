import {
  Camera,
  CameraOff,
  Headphones,
  LoaderCircle,
  Mic,
  MicOff,
  Phone,
  Video
} from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type {
  DeviceChoice,
  DeviceController,
  DeviceControllerSnapshot,
  SelectableDeviceKind
} from './device-controller.js';

export function PrejoinPanel(props: {
  controller: DeviceController;
  commandLabel?: 'Join' | 'Accept';
  pending?: boolean;
  onJoin(snapshot: DeviceControllerSnapshot): Promise<void>;
}) {
  const snapshot = useSyncExternalStore(
    props.controller.subscribe,
    props.controller.getSnapshot,
    props.controller.getSnapshot
  );
  const preview = useRef<HTMLVideoElement>(null);
  const [commandPending, setCommandPending] = useState(false);
  const [commandError, setCommandError] = useState('');
  const disabled = Boolean(props.pending || commandPending || snapshot.permission === 'requesting');
  const error = snapshot.error || commandError;

  useEffect(() => {
    if (!preview.current) return;
    return props.controller.attachPreview(preview.current);
  }, [props.controller]);

  const run = async (command: () => Promise<void>) => {
    setCommandError('');
    try {
      await command();
    } catch (cause) {
      setCommandError(errorMessage(cause));
    }
  };

  const join = async () => {
    if (disabled) return;
    setCommandPending(true);
    setCommandError('');
    try {
      if (snapshot.permission !== 'granted') {
        await props.controller.requestAccess({ mode: snapshot.mode });
      }
      await props.onJoin(props.controller.getSnapshot());
    } catch (cause) {
      setCommandError(errorMessage(cause));
    } finally {
      setCommandPending(false);
    }
  };

  return (
    <section className="prejoin-panel" aria-label="Call setup">
      <header className="prejoin-heading">
        <div>
          <h2>Ready to join</h2>
          <span className={`permission-state permission-${snapshot.permission}`}>{permissionLabel(snapshot.permission)}</span>
        </div>
        <div className="mode-switch" role="group" aria-label="Call mode">
          <button type="button" aria-pressed={snapshot.mode === 'voice'} disabled={disabled} onClick={() => props.controller.setMode('voice')}><Phone size={15} />Voice</button>
          <button type="button" aria-pressed={snapshot.mode === 'video'} disabled={disabled} onClick={() => props.controller.setMode('video')}><Video size={15} />Video</button>
        </div>
      </header>

      <div className={`prejoin-preview ${snapshot.cameraEnabled && snapshot.mode === 'video' ? 'camera-on' : 'camera-off'}`}>
        <video ref={preview} autoPlay playsInline aria-label="Camera preview" />
        {(!snapshot.cameraEnabled || snapshot.mode === 'voice') && <div className="preview-empty"><CameraOff size={28} /><span>Camera off</span></div>}
        <div
          className="microphone-level"
          role="progressbar"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(snapshot.microphoneLevel * 100)}
        >
          <span style={{ width: `${Math.round(snapshot.microphoneLevel * 100)}%` }} />
        </div>
        <div className="capture-controls" role="group" aria-label="Capture controls">
          <button
            type="button"
            className={snapshot.microphoneEnabled ? 'active' : ''}
            title={snapshot.microphoneEnabled ? 'Turn off microphone' : 'Turn on microphone'}
            aria-pressed={snapshot.microphoneEnabled}
            disabled={disabled}
            onClick={() => void run(() => props.controller.setMicrophoneEnabled(!snapshot.microphoneEnabled))}
          >
            {snapshot.microphoneEnabled ? <Mic size={18} /> : <MicOff size={18} />}
          </button>
          <button
            type="button"
            className={snapshot.cameraEnabled && snapshot.mode === 'video' ? 'active' : ''}
            title={snapshot.cameraEnabled && snapshot.mode === 'video' ? 'Turn off camera' : 'Turn on camera'}
            aria-pressed={snapshot.cameraEnabled && snapshot.mode === 'video'}
            disabled={disabled}
            onClick={() => void run(() => props.controller.setCameraEnabled(!snapshot.cameraEnabled || snapshot.mode === 'voice'))}
          >
            {snapshot.cameraEnabled && snapshot.mode === 'video' ? <Camera size={18} /> : <CameraOff size={18} />}
          </button>
        </div>
      </div>

      <div className="device-fields">
        <DeviceSelect label="Microphone" icon={<Mic size={15} />} kind="audioinput" devices={snapshot.devices.audioinput} selected={snapshot.selected.audioinput} disabled={disabled} onSelect={(kind, id) => run(() => props.controller.selectDevice(kind, id))} />
        <DeviceSelect label="Camera" icon={<Camera size={15} />} kind="videoinput" devices={snapshot.devices.videoinput} selected={snapshot.selected.videoinput} disabled={disabled || snapshot.mode === 'voice'} onSelect={(kind, id) => run(() => props.controller.selectDevice(kind, id))} />
        <DeviceSelect label="Speaker" icon={<Headphones size={15} />} kind="audiooutput" devices={snapshot.devices.audiooutput} selected={snapshot.selected.audiooutput} disabled={disabled || !snapshot.outputSelectionSupported} onSelect={(kind, id) => run(() => props.controller.selectDevice(kind, id))} />
        {!snapshot.outputSelectionSupported && <small className="output-unavailable">Output selection unavailable</small>}
      </div>

      {error && <div className="prejoin-error" role="alert">{error}</div>}
      <button type="button" className="join-command" disabled={disabled || snapshot.permission === 'unsupported' || snapshot.permission === 'disposed'} onClick={() => void join()}>
        {disabled ? <LoaderCircle className="spin" size={17} /> : <Phone size={17} />}
        {props.commandLabel || 'Join'}
      </button>
    </section>
  );
}

function DeviceSelect(props: {
  label: string;
  icon: React.ReactNode;
  kind: SelectableDeviceKind;
  devices: readonly DeviceChoice[];
  selected: string;
  disabled: boolean;
  onSelect(kind: SelectableDeviceKind, deviceId: string): void;
}) {
  return (
    <label className="device-field">
      <span>{props.icon}{props.label}</span>
      <select aria-label={props.label} value={props.selected} disabled={props.disabled || !props.devices.length} onChange={(event) => props.onSelect(props.kind, event.target.value)}>
        {!props.devices.length && <option value="">No device found</option>}
        {props.devices.map((device) => <option key={device.deviceId} value={device.deviceId} title={device.label}>{device.label}</option>)}
      </select>
    </label>
  );
}

function permissionLabel(state: DeviceControllerSnapshot['permission']): string {
  switch (state) {
    case 'requesting': return 'Requesting permission';
    case 'granted': return 'Devices ready';
    case 'denied': return 'Permission denied';
    case 'unsupported': return 'Media unavailable';
    case 'error': return 'Device error';
    case 'disposed': return 'Setup closed';
    default: return 'Permission required';
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
