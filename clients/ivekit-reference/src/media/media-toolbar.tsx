import {
  Camera,
  CameraOff,
  Circle,
  GalleryVerticalEnd,
  Grid2X2,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Presentation,
  Settings2,
  Square
} from 'lucide-react';

import type { MediaLayout, MediaLocalState } from './media-reducer.js';

export function MediaToolbar(props: {
  local: MediaLocalState;
  layout: MediaLayout;
  recording: boolean;
  disabled: boolean;
  devicesDisabled?: boolean;
  recordingDisabled?: boolean;
  recordingControlMode?: 'recording' | 'panel';
  onMicrophone(enabled: boolean): void | Promise<void>;
  onCamera(enabled: boolean): void | Promise<void>;
  onScreenShare(enabled: boolean, options?: { audio?: boolean }): void | Promise<void>;
  onLayout(layout: MediaLayout): void;
  onDevices(): void;
  onRecording(recording: boolean): void | Promise<void>;
  onHangup(): void | Promise<void>;
}) {
  return (
    <div className="media-toolbar" aria-label="Call controls">
      <button className={props.local.microphone ? 'active' : ''} title={props.local.microphone ? 'Turn off microphone' : 'Turn on microphone'} aria-pressed={props.local.microphone} disabled={props.disabled} onClick={() => void props.onMicrophone(!props.local.microphone)}>
        {props.local.microphone ? <Mic size={18} /> : <MicOff size={18} />}
      </button>
      <button className={props.local.camera ? 'active' : ''} title={props.local.camera ? 'Turn off camera' : 'Turn on camera'} aria-pressed={props.local.camera} disabled={props.disabled} onClick={() => void props.onCamera(!props.local.camera)}>
        {props.local.camera ? <Camera size={18} /> : <CameraOff size={18} />}
      </button>
      <button className={props.local.screen ? 'active' : ''} title={props.local.screen ? 'Stop sharing' : 'Share screen'} aria-pressed={props.local.screen} disabled={props.disabled} onClick={() => void props.onScreenShare(!props.local.screen, { audio: !props.local.screen })}>
        <MonitorUp size={18} />
      </button>
      <div className="layout-switch" role="group" aria-label="Call layout">
        <button title="Grid layout" aria-pressed={props.layout === 'grid'} disabled={props.disabled} onClick={() => props.onLayout('grid')}><Grid2X2 size={17} /></button>
        <button title="Speaker layout" aria-pressed={props.layout === 'speaker'} disabled={props.disabled} onClick={() => props.onLayout('speaker')}><GalleryVerticalEnd size={17} /></button>
        <button title="Screen share layout" aria-pressed={props.layout === 'screen_share'} disabled={props.disabled} onClick={() => props.onLayout('screen_share')}><Presentation size={17} /></button>
      </div>
      <button title="Choose devices" disabled={props.disabled || props.devicesDisabled} onClick={props.onDevices}><Settings2 size={18} /></button>
      <button className={props.recording ? 'recording' : ''} title={props.recordingControlMode === 'panel' ? (props.recording ? 'Close recordings' : 'Open recordings') : (props.recording ? 'Stop recording' : 'Start recording')} aria-pressed={props.recording} disabled={props.recordingDisabled || (props.disabled && props.recordingControlMode !== 'panel')} onClick={() => void props.onRecording(!props.recording)}>
        {props.recording ? <Square size={16} /> : <Circle size={18} />}
      </button>
      <button className="hangup" title="Hang up" disabled={props.disabled} onClick={() => void props.onHangup()}><PhoneOff size={18} /></button>
    </div>
  );
}
