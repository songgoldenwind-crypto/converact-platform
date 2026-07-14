import type { IveKitVoiceExtensionSessionPlan } from '@opc/ivekit-sdk';
import {
  createIveKitSipWebPhone,
  type IveKitSipAudioDevice,
  type IveKitSipWebPhone,
  type IveKitSipWebPhoneState
} from '@opc/ivekit-sdk/sip-webphone';
import {
  Grid3X3,
  Mic,
  MicOff,
  Pause,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  Play,
  RefreshCw,
  Wifi,
  WifiOff,
  X
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

declare global {
  interface Window {
    __IVEKIT_DEV_SIP_WEBPHONE_FACTORY__?: (
      plan: IveKitVoiceExtensionSessionPlan
    ) => IveKitSipWebPhone;
  }
}

export function SipPhonePanel(props: {
  plan: IveKitVoiceExtensionSessionPlan;
  createPhone?: (plan: IveKitVoiceExtensionSessionPlan) => IveKitSipWebPhone;
}) {
  const phone = useMemo(
    () => (props.createPhone ?? window.__IVEKIT_DEV_SIP_WEBPHONE_FACTORY__)
      ? (props.createPhone ?? window.__IVEKIT_DEV_SIP_WEBPHONE_FACTORY__)!(props.plan)
      : createIveKitSipWebPhone({ plan: props.plan }),
    [props.createPhone, props.plan]
  );
  const [state, setState] = useState<Readonly<IveKitSipWebPhoneState>>(phone.getSnapshot());
  const [destination, setDestination] = useState('');
  const [devices, setDevices] = useState<IveKitSipAudioDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingDispose = useRef<{ phone: IveKitSipWebPhone; timer: number } | null>(null);

  useEffect(() => {
    if (pendingDispose.current?.phone === phone) {
      window.clearTimeout(pendingDispose.current.timer);
      pendingDispose.current = null;
    }
    const unsubscribe = phone.subscribe(setState);
    if (audioRef.current) phone.attachRemoteAudio(audioRef.current);
    return () => {
      unsubscribe();
      const timer = window.setTimeout(() => {
        if (pendingDispose.current?.phone === phone) pendingDispose.current = null;
        void phone.dispose().catch(() => undefined);
      }, 0);
      pendingDispose.current = { phone, timer };
    };
  }, [phone]);

  const run = async (operation: () => Promise<void>, refreshDevices = false) => {
    if (busy) return;
    setBusy(true);
    setLocalError('');
    try {
      await operation();
      if (refreshDevices) setDevices(await phone.listAudioDevices());
    } catch (cause) {
      setLocalError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const connected = state.registration === 'registered';
  const active = state.call === 'active' || state.call === 'held';
  const canDial = connected && state.call === 'idle' && Boolean(destination.trim());
  const inputs = devices.filter((device) => device.kind === 'audioinput');
  const outputs = devices.filter((device) => device.kind === 'audiooutput');

  return <section className="sip-phone" aria-label="SIP WebPhone">
    <header className="sip-phone-header">
      <span><Wifi size={14} /><strong>WebPhone</strong></span>
      <output className={`sip-registration registration-${state.registration}`}>{state.registration}</output>
      {connected
        ? <button title="Unregister SIP phone" disabled={busy} onClick={() => void run(() => phone.disconnect())}><WifiOff size={14} /></button>
        : <button title="Register SIP phone" disabled={busy || state.registration === 'connecting'} onClick={() => void run(() => phone.connect(), true)}><Wifi size={14} /></button>}
    </header>

    <div className="sip-dial-row">
      <input aria-label="SIP destination" value={destination} placeholder="Extension or SIP URI" onChange={(event) => setDestination(event.target.value)} />
      <button title="Dial SIP call" disabled={busy || !canDial} onClick={() => void run(() => phone.dial(destination.trim()))}><PhoneCall size={15} /></button>
    </div>

    {state.call !== 'idle' && <div className={`sip-call-state call-${state.call}`}>
      <span>{state.remote_identity || 'SIP call'}</span>
      <strong>{state.call}</strong>
    </div>}

    {state.call === 'incoming' && <div className="sip-incoming-actions">
      <button title="Answer incoming call" disabled={busy} onClick={() => void run(() => phone.answer())}><PhoneIncoming size={15} />Answer</button>
      <button title="Reject incoming call" disabled={busy} onClick={() => void run(() => phone.reject())}><X size={15} />Reject</button>
    </div>}

    {(active || state.call === 'outgoing' || state.call === 'ringing' || state.call === 'ending') && <div className="sip-call-actions">
      {active && <button title={state.muted ? 'Unmute microphone' : 'Mute microphone'} disabled={busy} onClick={() => void run(() => phone.setMuted(!state.muted))}>{state.muted ? <Mic size={15} /> : <MicOff size={15} />}</button>}
      {active && <button title={state.call === 'held' ? 'Resume SIP call' : 'Hold SIP call'} disabled={busy} onClick={() => void run(() => phone.setHeld(state.call !== 'held'))}>{state.call === 'held' ? <Play size={15} /> : <Pause size={15} />}</button>}
      <button className="sip-hangup" title="Hang up SIP call" disabled={busy || state.call === 'ending'} onClick={() => void run(() => phone.hangup())}><PhoneOff size={15} /></button>
    </div>}

    {active && props.plan.capabilities.dtmf && <div className="sip-keypad" aria-label="SIP DTMF keypad">
      <span><Grid3X3 size={13} />DTMF</span>
      <div>{['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((tone) => <button key={tone} title={`Send DTMF ${tone}`} disabled={busy} onClick={() => void run(() => phone.sendDtmf(tone))}>{tone}</button>)}</div>
    </div>}

    <div className="sip-devices">
      <label><span>Input</span><select aria-label="Audio input" value={state.input_device_id} disabled={busy || !connected || !props.plan.capabilities.audio_input} onChange={(event) => void run(() => phone.setInputDevice(event.target.value))}><option value="">System default</option>{inputs.map((device) => <option key={device.device_id} value={device.device_id}>{device.label}</option>)}</select></label>
      <label><span>Output</span><select aria-label="Audio output" value={state.output_device_id} disabled={busy || !connected || !props.plan.capabilities.audio_output || !outputs.length} onChange={(event) => void run(() => phone.setOutputDevice(event.target.value))}><option value="">System default</option>{outputs.map((device) => <option key={device.device_id} value={device.device_id}>{device.label}</option>)}</select></label>
      <button title="Refresh audio devices" disabled={busy || !connected} onClick={() => void run(async () => undefined, true)}><RefreshCw size={14} /></button>
    </div>

    {(localError || state.error) && <div className="sip-phone-error" role="alert">{localError || state.error}</div>}
    <audio ref={audioRef} autoPlay aria-hidden="true" />
  </section>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : 'SIP operation failed';
}
