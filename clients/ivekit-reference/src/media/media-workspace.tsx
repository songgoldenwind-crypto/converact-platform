import type { FormEvent } from 'react';
import { PhoneCall, PhoneOff, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { IveKitHttpSdk, IveKitMediaCallAction } from '@opc/ivekit-sdk';
import { CallHeader } from './call-header.js';
import { BrowserDeviceController, type DeviceControllerSnapshot } from './device-controller.js';
import { HostControls } from './host-controls.js';
import { isTerminalStatus } from './media-reducer.js';
import { MediaToolbar } from './media-toolbar.js';
import { NetworkStatus } from './network-status.js';
import { ParticipantGrid } from './participant-grid.js';
import { PrejoinPanel } from './prejoin-panel.js';
import { RecordingPanel } from './recording-panel.js';
import { useMediaCall } from './use-media-call.js';

export function MediaWorkspace(props: {
  client: IveKitHttpSdk | null;
  identity: string;
  callId: string;
  onCallIdChange(callId: string): void;
  websocketUrl?: string;
  accessToken?: string;
}) {
  const [draftCallId, setDraftCallId] = useState(props.callId);
  const [error, setError] = useState('');
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const [setup, setSetup] = useState<{ mode: 'accept' | 'devices'; controller: BrowserDeviceController } | null>(null);
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const media = useMediaCall({ client: props.client, callId: props.callId, identity: props.identity, websocketUrl: props.websocketUrl, accessToken: props.accessToken });
  useEffect(() => setDraftCallId(props.callId), [props.callId]);
  useEffect(() => {
    setRecordingsOpen(false);
    setSetup((current) => {
      if (current) void current.controller.dispose();
      return null;
    });
  }, [props.callId]);
  useEffect(() => () => { if (setupRef.current) void setupRef.current.controller.dispose(); }, []);

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
  const openSetup = (mode: 'accept' | 'devices') => {
    if (!call) return;
    const controller = new BrowserDeviceController();
    controller.setMode(call.media);
    setSetup({ mode, controller });
    void controller.requestAccess({ mode: call.media }).catch(() => undefined);
  };
  const closeSetup = async () => {
    const current = setup;
    setSetup(null);
    await current?.controller.dispose();
  };
  const applySetup = async (snapshot: DeviceControllerSnapshot) => {
    const current = setup;
    if (!current) return;
    if (current.mode === 'accept') {
      await media.transition('accept');
      setSetup({ mode: 'devices', controller: current.controller });
    }
    const selected = snapshot.selected;
    if (selected.audioinput) await media.switchDevice('audioinput', selected.audioinput);
    if (selected.videoinput && snapshot.mode === 'video') await media.switchDevice('videoinput', selected.videoinput);
    if (selected.audiooutput && snapshot.outputSelectionSupported) await media.switchDevice('audiooutput', selected.audiooutput);
    await media.setMicrophone(snapshot.microphoneEnabled);
    await media.setCamera(snapshot.mode === 'video' && snapshot.cameraEnabled);
    await closeSetup();
  };

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
          <NetworkStatus
            connection={media.state.connection}
            autoplayBlocked={media.state.autoplayBlocked}
            fatalReason={media.state.fatalReason}
            screenShareRecoveryRequired={media.state.screenShareRecoveryRequired}
            onStartAudio={() => run(() => media.startAudio())}
            onResumeScreenShare={() => run(() => media.setScreenShare(true, { audio: media.state.screenShareRecoveryAudio }))}
            onDismissScreenShareRecovery={media.dismissScreenShareRecovery}
          />
          {setup && <div className="media-setup-overlay">
            <button className="close-media-setup" title="Close call setup" onClick={() => void closeSetup()}><X size={16} /></button>
            <PrejoinPanel
              controller={setup.controller}
              title={setup.mode === 'accept' ? 'Ready to accept' : 'Devices'}
              commandLabel={setup.mode === 'accept' ? 'Accept' : 'Apply'}
              pending={pending}
              onJoin={applySetup}
            />
          </div>}
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
              {call?.status === 'ringing' && !isHost && <><button disabled={pending} onClick={() => openSetup('accept')}>Accept</button><button disabled={pending} onClick={() => void command('reject', 'participant rejected')}>Reject</button></>}
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
          {recordingsOpen && props.client && call && <RecordingPanel client={props.client} call={call} role={me?.role || 'participant'} invalidationKey={media.state.recordingRevision} />}
          <MediaToolbar
            local={media.state.local}
            layout={media.state.layout}
            recording={recordingsOpen}
            recordingControlMode="panel"
            disabled={toolbarDisabled}
            devicesDisabled={!call || !['accepted', 'active'].includes(call.status)}
            recordingDisabled={!props.client || !call}
            onMicrophone={(enabled) => run(() => media.setMicrophone(enabled))}
            onCamera={(enabled) => run(() => media.setCamera(enabled))}
            onScreenShare={(enabled, options) => run(() => media.setScreenShare(enabled, options))}
            onLayout={media.setLayout}
            onDevices={() => openSetup('devices')}
            onRecording={setRecordingsOpen}
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
