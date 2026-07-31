import { MicOff, Signal } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { IveKitMediaCallParticipant } from '@opc/ivekit-sdk';
import type { MediaTrackHandle } from './types.js';

export function MediaTile(props: {
  participant: IveKitMediaCallParticipant;
  camera?: MediaTrackHandle;
  microphone?: MediaTrackHandle;
  speaking: boolean;
  networkQuality?: string;
  compact?: boolean;
}) {
  const displayName = props.participant.display_name || props.participant.identity;
  const microphoneMuted = !props.microphone || props.microphone.muted;
  return (
    <article
      className={`media-tile${props.compact ? ' compact' : ''}`}
      data-participant={props.participant.identity}
      data-speaking={props.speaking ? 'true' : 'false'}
    >
      {props.camera && !props.camera.muted
        ? <AttachedTrack track={props.camera} label={`${displayName} camera`} />
        : <div className="media-avatar" aria-label={`${displayName} camera off`}><span>{initials(displayName)}</span></div>}
      {props.microphone && <AttachedTrack track={props.microphone} label={`${displayName} audio`} />}
      <footer>
        <strong title={displayName}>{displayName}</strong>
        {microphoneMuted && <span title="Microphone muted"><MicOff size={13} /></span>}
        <span title={`Network quality: ${props.networkQuality || 'unknown'}`}><Signal size={13} /></span>
      </footer>
    </article>
  );
}

export function AttachedTrack(props: { track: MediaTrackHandle; label: string }) {
  const element = useRef<HTMLMediaElement>(null);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    try { props.track.attach(target); } catch { return; }
    return () => {
      try { props.track.detach(target); } catch { /* adapter already invalidated the track */ }
    };
  }, [props.track]);
  return props.track.kind === 'audio'
    ? <audio ref={element as React.RefObject<HTMLAudioElement>} autoPlay aria-label={props.label} />
    : <video ref={element as React.RefObject<HTMLVideoElement>} autoPlay playsInline aria-label={props.label} />;
}

function initials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0]?.slice(0, 2) || '?').toUpperCase();
}
