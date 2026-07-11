import type { FormEvent } from 'react';
import { PhoneCall, PhoneOff, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { IveKitClient, IveKitMediaCallAction } from '@opc/ivekit-sdk';
import { CallHeader } from './call-header.js';
import { HostControls } from './host-controls.js';
import { isTerminalStatus } from './media-reducer.js';
import { MediaToolbar } from './media-toolbar.js';
import { NetworkStatus } from './network-status.js';
import { ParticipantGrid } from './participant-grid.js';
import { useMediaCall } from './use-media-call.js';

export function MediaWorkspace(props: {
  client: IveKitClient | null;
  identity: string;
  callId: string;
  onCallIdChange(callId: string): void;
}) {
  const [draftCallId, setDraftCallId] = useState(props.callId);
  const [error, setError] = useState('');
  const media = useMediaCall({ client: props.client, callId: props.callId, identity: props.identity });
  useEffect(() => setDraftCallId(props.callId), [props.callId]);

  const openCall = (event: FormEvent) => {
    event.preventDefault();
    const callId = draftCallId.trim();
    if (callId) props.onCallIdChange(callId);
  };
  const run = async (command: () => Promise<unknown>) => {
    setError('');
    try { await command(); } catch (cause) { setError(errorMessage(cause)); }
  };
  const command = (action: IveKitMediaCallAction, reason?: string) => run(() => media.transition(action, reason));
  const call = media.state.call;
  const me = media.state.participants.find((participant) => participant.identity === props.identity);
  const isHost = me?.role === 'host';
  const pending = Object.values(media.state.commands).some((value) => value.pending);
  const terminal = call ? isTerminalStatus(call.status) : false;
  const toolbarDisabled = pending || terminal || media.state.connection !== 'online';
  const commandError = Object.values(media.state.commands).find((value) => value.error)?.error || '';

  return (
    <section className="media-workspace-pane">
      {!props.callId ? (
        <form className="call-locator" onSubmit={openCall}>
          <label htmlFor="ivekit-call-id">Call ID</label>
          <div><input id="ivekit-call-id" value={draftCallId} onChange={(event) => setDraftCallId(event.target.value)} /><button title="Open call" disabled={!draftCallId.trim()}><Search size={17} /></button></div>
          <span>No call selected</span>
        </form>
      ) : (
        <>
          <CallHeader state={media.state} />
          <NetworkStatus connection={media.state.connection} autoplayBlocked={media.state.autoplayBlocked} fatalReason={media.state.fatalReason} onStartAudio={() => run(() => media.startAudio())} />
          {call && ['accepted', 'active'].includes(call.status) ? <ParticipantGrid
            participants={media.state.participants}
            tracks={media.state.tracks}
            activeSpeakerIdentities={media.state.activeSpeakerIdentities}
            networkQuality={media.state.networkQuality}
            layout={media.state.layout}
          /> : <div className="media-stage-placeholder">
            <PhoneCall size={30} />
            <strong>{connectionLabel(media.state.connection)}</strong>
            {call && <span>{call.room_name}</span>}
            <div className="call-lifecycle-actions">
              {call?.status === 'created' && isHost && <><button disabled={pending} onClick={() => void command('ring')}>Ring</button><button disabled={pending} onClick={() => void command('cancel', 'host cancelled')}>Cancel</button></>}
              {call?.status === 'ringing' && isHost && <button disabled={pending} onClick={() => void command('cancel', 'host cancelled')}>Cancel</button>}
              {call?.status === 'ringing' && !isHost && <><button disabled={pending} onClick={() => void command('accept')}>Accept</button><button disabled={pending} onClick={() => void command('reject', 'participant rejected')}>Reject</button></>}
            </div>
          </div>}
          <HostControls
            role={me?.role || 'participant'}
            participants={media.state.participants}
            tracks={media.state.tracks}
            disabled={pending || terminal}
            onMute={(identity, track) => run(() => media.muteParticipant(identity, track))}
            onRemove={(identity) => run(() => media.removeParticipant(identity, 'removed by host'))}
            onClose={() => run(() => media.transition('end', 'closed by host'))}
          />
          <MediaToolbar
            local={media.state.local}
            layout={media.state.layout}
            recording={false}
            disabled={toolbarDisabled}
            devicesDisabled
            recordingDisabled
            onMicrophone={(enabled) => run(() => media.setMicrophone(enabled))}
            onCamera={(enabled) => run(() => media.setCamera(enabled))}
            onScreenShare={(enabled, options) => run(() => media.setScreenShare(enabled, options))}
            onLayout={media.setLayout}
            onDevices={() => undefined}
            onRecording={() => undefined}
            onHangup={() => command('end', 'user hangup')}
          />
          <button className="close-media-call" title="Close call workspace" onClick={() => props.onCallIdChange('')}><X size={16} /></button>
        </>
      )}
      {(error || commandError || media.state.revokedReason || media.state.fatalReason) && (
        <div className="media-command-error" role="alert">{error || commandError || media.state.revokedReason || media.state.fatalReason}</div>
      )}
    </section>
  );
}

function connectionLabel(connection: string): string {
  return connection.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
