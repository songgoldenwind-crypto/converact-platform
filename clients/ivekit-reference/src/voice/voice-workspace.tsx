import {
  createIveKitVoiceController,
  type IveKitClient,
  type IveKitVoiceAddressKind,
  type IveKitVoiceCallState,
  type IveKitVoiceController,
  type IveKitVoiceControllerState
} from '@opc/ivekit-sdk';
import {
  CircleParking,
  Ellipsis,
  Grid3X3,
  Headset,
  Pause,
  PhoneForwarded,
  PhoneIncoming,
  PhoneOff,
  PhoneOutgoing,
  Play,
  RadioTower,
  RefreshCw,
  Search,
  Users,
  X
} from 'lucide-react';
import React, { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

type VoicePanel = 'keypad' | 'transfer' | 'more' | null;
type VoiceAction = 'answer' | 'hangup' | 'dtmf' | 'hold' | 'resume' | 'transfer' |
  'conference' | 'park' | 'pickup' | 'recording' | 'bridge';

const EMPTY_STATE: IveKitVoiceControllerState = {
  phase: 'idle',
  call: null,
  command: null,
  capabilities: null,
  extension_session: null,
  pending_action: null,
  error: null
};

export function VoiceWorkspace(props: {
  client: IveKitClient | null;
  callId: string;
  onCallIdChange(callId: string): void;
  refreshVersion: number;
  businessRef?: { type: string; id: string };
}) {
  const [state, setState] = useState<IveKitVoiceControllerState>(EMPTY_STATE);
  const [mode, setMode] = useState<'dial' | 'open'>('dial');
  const [draftCallId, setDraftCallId] = useState(props.callId);
  const [profileId, setProfileId] = useState('');
  const [fromKind, setFromKind] = useState<IveKitVoiceAddressKind>('extension');
  const [from, setFrom] = useState('');
  const [toKind, setToKind] = useState<IveKitVoiceAddressKind>('e164');
  const [to, setTo] = useState('');
  const [businessType, setBusinessType] = useState(props.businessRef?.type || 'service_order');
  const [businessId, setBusinessId] = useState(props.businessRef?.id || '');
  const [extensionId, setExtensionId] = useState('');
  const [panel, setPanel] = useState<VoicePanel>(null);
  const [transferKind, setTransferKind] = useState<'blind' | 'warm'>('blind');
  const [transferAddressKind, setTransferAddressKind] = useState<IveKitVoiceAddressKind>('extension');
  const [transferTarget, setTransferTarget] = useState('');
  const [conferenceId, setConferenceId] = useState('');
  const [parkSlot, setParkSlot] = useState('');
  const [sipTrunkId, setSipTrunkId] = useState('');
  const [localError, setLocalError] = useState('');
  const selectedRequest = useRef<{ controller: IveKitVoiceController | null; key: string }>({ controller: null, key: '' });

  const controller = useMemo(() => props.client
    ? createIveKitVoiceController({ client: props.client.voice })
    : null, [props.callId, props.client]);

  useEffect(() => setDraftCallId(props.callId), [props.callId]);
  useEffect(() => {
    if (!props.businessRef) return;
    setBusinessType(props.businessRef.type);
    setBusinessId(props.businessRef.id);
  }, [props.businessRef?.id, props.businessRef?.type]);
  useEffect(() => {
    if (!controller) {
      setState(EMPTY_STATE);
      return;
    }
    const unsubscribe = controller.subscribe((snapshot) => setState(snapshot as IveKitVoiceControllerState));
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);
  useEffect(() => {
    if (!controller) {
      selectedRequest.current = { controller: null, key: '' };
      return;
    }
    if (selectedRequest.current.controller !== controller) {
      selectedRequest.current = { controller, key: '' };
    }
    if (!props.callId) {
      selectedRequest.current.key = '';
      return;
    }
    const requestKey = `${props.callId}:${props.refreshVersion}`;
    if (controller.getSnapshot().phase === 'loading' || controller.getSnapshot().phase === 'submitting') return;
    if (selectedRequest.current.key === requestKey) return;
    selectedRequest.current.key = requestKey;
    void controller.selectCall(props.callId).catch((cause) => setLocalError(errorMessage(cause)));
  }, [controller, props.callId, props.refreshVersion, state.phase]);

  const run = async (command: (controller: IveKitVoiceController) => Promise<unknown>) => {
    if (!controller) return;
    setLocalError('');
    try {
      await command(controller);
    } catch (cause) {
      setLocalError(errorMessage(cause));
    }
  };
  const busy = state.phase === 'loading' || state.phase === 'submitting';
  const call = state.call;
  const allowed = (action: VoiceAction) => Boolean(
    call && !busy && ACTION_STATES[action].includes(call.state)
  );

  const openCall = (event: FormEvent) => {
    event.preventDefault();
    const value = draftCallId.trim();
    if (value) props.onCallIdChange(value);
  };
  const dial = (event: FormEvent) => {
    event.preventDefault();
    void run(async (voice) => {
      const result = await voice.dial({
        profile_id: profileId.trim(),
        from: { kind: fromKind, value: from.trim() },
        to: { kind: toKind, value: to.trim() },
        business_ref: { type: businessType.trim(), id: businessId.trim() },
        metadata: { source: 'ivekit-reference-webphone' }
      });
      props.onCallIdChange(result.call.id);
    });
  };
  const togglePanel = (next: Exclude<VoicePanel, null>) => setPanel((current) => current === next ? null : next);

  return <section className="voice-workspace-pane">
    <header className="voice-header">
      <div>
        <Headset size={18} />
        <span><strong>Voice</strong><small>{call?.id || 'No call selected'}</small></span>
      </div>
      <span className={`voice-phase phase-${state.phase}`}>{state.phase}</span>
      <button title="Refresh voice call" disabled={!controller || !call || busy} onClick={() => void run((voice) => voice.refresh())}><RefreshCw className={state.phase === 'loading' ? 'spin' : ''} size={16} /></button>
      {call && <button title="Close voice call" disabled={busy} onClick={() => props.onCallIdChange('')}><X size={17} /></button>}
    </header>

    <div className="voice-layout">
      <aside className="voice-sidebar">
        <div className="voice-mode" role="group" aria-label="Voice setup mode">
          <button aria-pressed={mode === 'dial'} onClick={() => setMode('dial')}><PhoneOutgoing size={15} />Dial</button>
          <button aria-pressed={mode === 'open'} onClick={() => setMode('open')}><Search size={15} />Open</button>
        </div>

        {mode === 'dial' ? <form className="voice-form" onSubmit={dial}>
          <label><span>Profile</span><input aria-label="Profile" value={profileId} onChange={(event) => setProfileId(event.target.value)} /></label>
          <div className="voice-address-row">
            <label><span>From type</span><select aria-label="From type" value={fromKind} onChange={(event) => setFromKind(event.target.value as IveKitVoiceAddressKind)}>{addressOptions()}</select></label>
            <label><span>From</span><input aria-label="From" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          </div>
          <div className="voice-address-row">
            <label><span>To type</span><select aria-label="To type" value={toKind} onChange={(event) => setToKind(event.target.value as IveKitVoiceAddressKind)}>{addressOptions()}</select></label>
            <label><span>To</span><input aria-label="To" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          </div>
          <div className="voice-business-row">
            <label><span>Reference type</span><input aria-label="Reference type" value={businessType} onChange={(event) => setBusinessType(event.target.value)} /></label>
            <label><span>Reference ID</span><input aria-label="Reference ID" value={businessId} onChange={(event) => setBusinessId(event.target.value)} /></label>
          </div>
          <button className="voice-primary" title="Dial outbound call" disabled={!controller || busy || !profileId.trim() || !from.trim() || !to.trim() || !businessType.trim() || !businessId.trim()}><PhoneOutgoing size={16} />Dial</button>
        </form> : <form className="voice-form" onSubmit={openCall}>
          <label><span>Voice call ID</span><input aria-label="Voice call ID" value={draftCallId} onChange={(event) => setDraftCallId(event.target.value)} /></label>
          <button className="voice-primary" disabled={!draftCallId.trim() || busy}><Search size={16} />Open call</button>
        </form>}

        <section className="voice-extension">
          <header><RadioTower size={15} /><strong>Extension session</strong></header>
          <label><span>Extension ID</span><input aria-label="Extension ID" value={extensionId} onChange={(event) => setExtensionId(event.target.value)} /></label>
          <button title="Prepare extension session" disabled={!controller || busy || !extensionId.trim()} onClick={() => void run((voice) => voice.prepareExtensionSession(extensionId))}><RadioTower size={15} />Prepare</button>
          <output className={state.extension_session ? 'ready' : ''}>{state.extension_session ? 'Session ready' : state.capabilities?.capabilities.extension_sessions === false ? 'Unavailable' : 'Not prepared'}</output>
        </section>
      </aside>

      <div className="voice-main">
        {!call ? <div className="voice-empty"><Headset size={32} /><strong>No voice call selected</strong></div> : <>
          <div className="voice-call-band">
            <div className="voice-address"><span>{call.from.redacted}</span><PhoneForwarded size={16} /><strong>{call.to.redacted}</strong></div>
            <span className={`voice-call-state state-${call.state}`}>{call.state}</span>
          </div>
          <div className="voice-facts">
            <div><span>Direction</span><strong>{call.direction}</strong></div>
            <div><span>Profile</span><strong>{call.provider_profile_id}</strong></div>
            <div><span>Business</span><strong>{call.business_ref.id}</strong></div>
            <div><span>Revision</span><strong>{call.revision}</strong></div>
          </div>
          <div className="voice-stage">
            <Headset size={38} />
            <strong>{call.state}</strong>
            <span>{call.direction} · {call.from.kind} to {call.to.kind}</span>
            {state.command && <div className="voice-command"><span>{state.command.kind}</span><strong>{state.command.id}</strong><small>{state.command.state}</small></div>}
          </div>

          {panel === 'keypad' && <div className="voice-action-panel voice-keypad" aria-label="DTMF keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((digit) => <button key={digit} disabled={!allowed('dtmf')} onClick={() => void run((voice) => voice.sendDtmf(digit))}>{digit}</button>)}
          </div>}
          {panel === 'transfer' && <div className="voice-action-panel voice-transfer-panel">
            <div className="voice-mode" role="group" aria-label="Transfer mode"><button aria-pressed={transferKind === 'blind'} onClick={() => setTransferKind('blind')}>Blind</button><button aria-pressed={transferKind === 'warm'} onClick={() => setTransferKind('warm')}>Warm</button></div>
            <select aria-label="Transfer address type" value={transferAddressKind} onChange={(event) => setTransferAddressKind(event.target.value as IveKitVoiceAddressKind)}>{addressOptions()}</select>
            <input aria-label="Transfer target" value={transferTarget} onChange={(event) => setTransferTarget(event.target.value)} />
            <button title="Transfer call" disabled={!allowed('transfer') || !transferTarget.trim()} onClick={() => void run((voice) => transferKind === 'blind' ? voice.blindTransfer({ kind: transferAddressKind, value: transferTarget }) : voice.warmTransfer({ kind: transferAddressKind, value: transferTarget }))}><PhoneForwarded size={16} /></button>
          </div>}
          {panel === 'more' && <div className="voice-action-panel voice-more-panel">
            <label><span>Conference</span><input aria-label="Conference ID" value={conferenceId} onChange={(event) => setConferenceId(event.target.value)} /><button title="Add to conference" disabled={!allowed('conference') || !conferenceId.trim()} onClick={() => void run((voice) => voice.conference(conferenceId))}><Users size={15} /></button></label>
            <label><span>Park slot</span><input aria-label="Park slot" value={parkSlot} onChange={(event) => setParkSlot(event.target.value)} /><button title="Park call" disabled={!allowed('park') || !parkSlot.trim()} onClick={() => void run((voice) => voice.park(parkSlot))}><CircleParking size={15} /></button><button title="Pickup call" disabled={!allowed('pickup') || !parkSlot.trim()} onClick={() => void run((voice) => voice.pickup(parkSlot))}><PhoneIncoming size={15} /></button></label>
            <label><span>SIP trunk</span><input aria-label="SIP trunk ID" value={sipTrunkId} onChange={(event) => setSipTrunkId(event.target.value)} /><button title="Create LiveKit bridge" disabled={!allowed('bridge') || !sipTrunkId.trim()} onClick={() => void run((voice) => voice.createLiveKitBridge(sipTrunkId))}><RadioTower size={15} /></button></label>
            <div className="voice-recording-actions"><button title="Start recording" disabled={!allowed('recording')} onClick={() => void run((voice) => voice.startRecording())}>Start</button><button title="Pause recording" disabled={!allowed('recording')} onClick={() => void run((voice) => voice.pauseRecording())}>Pause</button><button title="Resume recording" disabled={!allowed('recording')} onClick={() => void run((voice) => voice.resumeRecording())}>Resume</button><button title="Stop recording" disabled={!allowed('recording')} onClick={() => void run((voice) => voice.stopRecording())}>Stop</button></div>
          </div>}

          <div className="voice-toolbar">
            <button title="Answer call" disabled={!allowed('answer')} onClick={() => void run((voice) => voice.answer())}><PhoneIncoming size={18} /></button>
            <button title="Hold call" disabled={!allowed('hold')} onClick={() => void run((voice) => voice.hold())}><Pause size={18} /></button>
            <button title="Resume call" disabled={!allowed('resume')} onClick={() => void run((voice) => voice.resume())}><Play size={18} /></button>
            <button title="Open DTMF keypad" aria-pressed={panel === 'keypad'} disabled={!call || busy} onClick={() => togglePanel('keypad')}><Grid3X3 size={18} /></button>
            <button title="Open transfer controls" aria-pressed={panel === 'transfer'} disabled={!call || busy} onClick={() => togglePanel('transfer')}><PhoneForwarded size={18} /></button>
            <button title="Open more voice controls" aria-pressed={panel === 'more'} disabled={!call || busy} onClick={() => togglePanel('more')}><Ellipsis size={18} /></button>
            <button className="hangup" title="Hang up call" disabled={!allowed('hangup')} onClick={() => void run((voice) => voice.hangup())}><PhoneOff size={18} /></button>
          </div>
        </>}
      </div>
    </div>
    {localError && <div className="voice-error" role="alert">{localError}<button title="Dismiss voice error" onClick={() => setLocalError('')}><X size={14} /></button></div>}
  </section>;
}

const ACTION_STATES: Record<VoiceAction, readonly IveKitVoiceCallState[]> = {
  answer: ['dialing', 'ringing'],
  hangup: ['planned', 'queued', 'dialing', 'ringing', 'active', 'held', 'transferring'],
  dtmf: ['active'],
  hold: ['active'],
  resume: ['held'],
  transfer: ['active', 'held'],
  conference: ['active', 'held'],
  park: ['active', 'held'],
  pickup: ['active', 'held'],
  recording: ['active', 'held'],
  bridge: ['active', 'held']
};

function addressOptions() {
  return <><option value="extension">Extension</option><option value="e164">E.164</option><option value="sip_uri">SIP URI</option></>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
