import { MonitorOff, PhoneOff, UserMinus, VideoOff, VolumeX } from 'lucide-react';
import type { IveKitMediaCallParticipant } from '@converact/sdk';
import type { MediaTrackHandle } from './types.js';

export function HostControls(props: {
  role: 'host' | 'participant' | 'observer';
  participants: readonly IveKitMediaCallParticipant[];
  tracks: Readonly<Record<string, MediaTrackHandle>>;
  disabled: boolean;
  onMute(identity: string, track: MediaTrackHandle): Promise<void>;
  onRemove(identity: string): Promise<void>;
  onClose(): Promise<void>;
}) {
  if (props.role !== 'host') return null;
  const participants = props.participants.filter((item) => item.role !== 'host' && !['left', 'removed'].includes(item.status));
  return <aside className="host-controls" aria-label="Host controls">
    {participants.map((participant) => {
      const name = participant.display_name || participant.identity;
      const publications = Object.values(props.tracks).filter((track) => track.participantIdentity === participant.identity && !track.muted);
      const microphone = publications.find((track) => track.source === 'microphone');
      const camera = publications.find((track) => track.source === 'camera');
      const screen = publications.find((track) => track.source === 'screen_share');
      return <div key={participant.identity}><strong title={name}>{name}</strong><span className="host-media-actions"><button title={`Mute ${name}`} disabled={props.disabled || !microphone} onClick={() => microphone && window.confirm(`Mute ${name}?`) && void props.onMute(participant.identity, microphone)}><VolumeX size={15} /></button>{camera && <button title={`Stop ${name} camera`} disabled={props.disabled} onClick={() => window.confirm(`Stop ${name} camera?`) && void props.onMute(participant.identity, camera)}><VideoOff size={15} /></button>}{screen && <button title={`Stop ${name} screen share`} disabled={props.disabled} onClick={() => window.confirm(`Stop ${name} screen share?`) && void props.onMute(participant.identity, screen)}><MonitorOff size={15} /></button>}</span><button title={`Remove ${name}`} disabled={props.disabled} onClick={() => window.confirm(`Remove ${name}?`) && void props.onRemove(participant.identity)}><UserMinus size={15} /></button></div>;
    })}
    <button className="close-for-all" title="Close call for everyone" disabled={props.disabled} onClick={() => window.confirm('Close this call for everyone?') && void props.onClose()}><PhoneOff size={15} />Close for all</button>
  </aside>;
}
