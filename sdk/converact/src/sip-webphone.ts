import {
  Invitation,
  Inviter,
  Registerer,
  RegistererState,
  type Session,
  SessionState,
  UserAgent,
  UserAgentState,
  Web
} from 'sip.js';

import {
  parseConveractFabricVoiceExtensionSessionPlan,
  type ConveractFabricVoiceExtensionSessionPlan
} from './voice-types.js';

export { parseConveractFabricVoiceExtensionSessionPlan } from './voice-types.js';

export type ConveractFabricSipRegistrationState =
  'idle' | 'connecting' | 'registered' | 'disconnected' | 'failed' | 'stopped';
export type ConveractFabricSipCallState =
  'idle' | 'incoming' | 'outgoing' | 'ringing' | 'active' | 'held' | 'ending';

export interface ConveractFabricSipWebPhoneState {
  registration: ConveractFabricSipRegistrationState;
  call: ConveractFabricSipCallState;
  remote_identity: string;
  muted: boolean;
  input_device_id: string;
  output_device_id: string;
  error: string | null;
}

export interface ConveractFabricSipAudioDevice {
  device_id: string;
  kind: 'audioinput' | 'audiooutput';
  label: string;
}

export interface ConveractFabricSipAudioElement {
  autoplay: boolean;
  srcObject: unknown;
  play(): Promise<void>;
  setSinkId?(deviceId: string): Promise<void>;
}

export interface ConveractFabricSipWebPhoneEngineEvents {
  registration(state: ConveractFabricSipRegistrationState, error?: Error): void;
  call(state: ConveractFabricSipCallState, remoteIdentity?: string): void;
  error(error: Error): void;
}

export interface ConveractFabricSipWebPhoneEngine {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  dial(target: string): Promise<void>;
  answer(): Promise<void>;
  reject(): Promise<void>;
  hangup(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setHeld(held: boolean): Promise<void>;
  sendDtmf(tones: string): Promise<void>;
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;
  listAudioDevices(): Promise<ConveractFabricSipAudioDevice[]>;
  attachRemoteAudio(element: ConveractFabricSipAudioElement): void;
}

export interface ConveractFabricSipWebPhoneEngineFactoryInput {
  plan: ConveractFabricVoiceExtensionSessionPlan;
  events: ConveractFabricSipWebPhoneEngineEvents;
}

export interface ConveractFabricSipWebPhone {
  getSnapshot(): Readonly<ConveractFabricSipWebPhoneState>;
  subscribe(listener: (state: Readonly<ConveractFabricSipWebPhoneState>) => void): () => void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  dial(target: string): Promise<void>;
  answer(): Promise<void>;
  reject(): Promise<void>;
  hangup(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setHeld(held: boolean): Promise<void>;
  sendDtmf(tones: string): Promise<void>;
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;
  listAudioDevices(): Promise<ConveractFabricSipAudioDevice[]>;
  attachRemoteAudio(element: ConveractFabricSipAudioElement): void;
  dispose(): Promise<void>;
}

export function createConveractFabricSipWebPhone(input: {
  plan: unknown;
  now?: () => number;
  engineFactory?: (input: ConveractFabricSipWebPhoneEngineFactoryInput) => ConveractFabricSipWebPhoneEngine;
  timer?: {
    set(callback: () => void, delayMs: number): unknown;
    clear(handle: unknown): void;
  };
}): ConveractFabricSipWebPhone {
  return new SipWebPhone(input);
}

class SipWebPhone implements ConveractFabricSipWebPhone {
  readonly #plan: ConveractFabricVoiceExtensionSessionPlan;
  readonly #now: () => number;
  readonly #engine: ConveractFabricSipWebPhoneEngine;
  readonly #timer: { set(callback: () => void, delayMs: number): unknown; clear(handle: unknown): void };
  readonly #listeners = new Set<(state: Readonly<ConveractFabricSipWebPhoneState>) => void>();
  #state: Readonly<ConveractFabricSipWebPhoneState> = Object.freeze({
    registration: 'idle', call: 'idle', remote_identity: '', muted: false,
    input_device_id: '', output_device_id: '', error: null
  });
  #disposed = false;
  #expiryTimer: unknown = null;

  constructor(input: {
    plan: unknown;
    now?: () => number;
    engineFactory?: (input: ConveractFabricSipWebPhoneEngineFactoryInput) => ConveractFabricSipWebPhoneEngine;
    timer?: {
      set(callback: () => void, delayMs: number): unknown;
      clear(handle: unknown): void;
    };
  }) {
    this.#now = input.now ?? Date.now;
    this.#plan = parseConveractFabricVoiceExtensionSessionPlan(input.plan, { now: this.#now });
    this.#timer = input.timer ?? defaultTimer();
    const events: ConveractFabricSipWebPhoneEngineEvents = {
      registration: (registration, error) => this.#patch({
        registration, error: error ? safeError(error) : registration === 'failed' ? 'SIP registration failed' : null
      }),
      call: (call, remoteIdentity) => this.#patch({
        call,
        ...(remoteIdentity === undefined ? {} : { remote_identity: remoteIdentity }),
        ...(call === 'idle' ? { remote_identity: '', muted: false } : {})
      }),
      error: (error) => this.#patch({ error: safeError(error) })
    };
    this.#engine = (input.engineFactory ?? createSipJsEngine)({ plan: this.#plan, events });
  }

  getSnapshot(): Readonly<ConveractFabricSipWebPhoneState> {
    return this.#state;
  }

  subscribe(listener: (state: Readonly<ConveractFabricSipWebPhoneState>) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.#active();
    this.#fresh();
    if (this.#state.registration === 'registered' || this.#state.registration === 'connecting') return;
    this.#patch({ registration: 'connecting', error: null });
    try {
      await this.#engine.connect();
      this.#scheduleExpiry();
    } catch (cause) {
      this.#patch({ registration: 'failed', error: safeError(cause) });
      throw cause;
    }
  }

  async disconnect(): Promise<void> {
    this.#clearExpiry();
    if (this.#state.registration === 'stopped' && this.#state.call === 'idle') return;
    await this.#invoke(() => this.#engine.disconnect());
    this.#patch({ registration: 'stopped', call: 'idle', remote_identity: '', muted: false });
  }

  async dial(targetInput: string): Promise<void> {
    this.#active();
    this.#fresh();
    this.#capability('outgoing', 'outgoing calls are unavailable');
    this.#registered();
    if (this.#state.call !== 'idle') throw new Error('a SIP call is already in progress');
    const target = safeCommandValue(targetInput, 'SIP destination');
    this.#patch({ call: 'outgoing', remote_identity: target, error: null });
    try {
      await this.#engine.dial(target);
    } catch (cause) {
      this.#patch({ call: 'idle', remote_identity: '', error: safeError(cause) });
      throw cause;
    }
  }

  async answer(): Promise<void> {
    this.#active();
    this.#fresh();
    this.#capability('incoming', 'incoming calls are unavailable');
    if (this.#state.call !== 'incoming') throw new Error('there is no incoming SIP call');
    await this.#invoke(() => this.#engine.answer());
  }

  async reject(): Promise<void> {
    this.#active();
    if (this.#state.call !== 'incoming') throw new Error('there is no incoming SIP call');
    await this.#invoke(() => this.#engine.reject());
  }

  async hangup(): Promise<void> {
    this.#active();
    if (this.#state.call === 'idle') throw new Error('there is no SIP call to hang up');
    this.#patch({ call: 'ending' });
    await this.#invoke(() => this.#engine.hangup());
  }

  async setMuted(muted: boolean): Promise<void> {
    this.#capability('audio_input', 'audio input is unavailable');
    this.#activeCall();
    await this.#invoke(() => this.#engine.setMuted(muted));
    this.#patch({ muted });
  }

  async setHeld(held: boolean): Promise<void> {
    this.#capability('hold', 'call hold is unavailable');
    this.#activeCall();
    await this.#invoke(() => this.#engine.setHeld(held));
    this.#patch({ call: held ? 'held' : 'active' });
  }

  async sendDtmf(tonesInput: string): Promise<void> {
    this.#capability('dtmf', 'DTMF is unavailable');
    this.#activeCall();
    const tones = tonesInput.trim().toUpperCase();
    if (!/^[0-9A-D*#]{1,32}$/.test(tones)) throw new Error('invalid DTMF tones');
    await this.#invoke(() => this.#engine.sendDtmf(tones));
  }

  async setInputDevice(deviceIdInput: string): Promise<void> {
    this.#active();
    this.#capability('audio_input', 'audio input is unavailable');
    const deviceId = safeOptionalCommandValue(deviceIdInput, 'audio input device');
    await this.#invoke(() => this.#engine.setInputDevice(deviceId));
    this.#patch({ input_device_id: deviceId });
  }

  async setOutputDevice(deviceIdInput: string): Promise<void> {
    this.#active();
    this.#capability('audio_output', 'audio output is unavailable');
    const deviceId = safeOptionalCommandValue(deviceIdInput, 'audio output device');
    await this.#invoke(() => this.#engine.setOutputDevice(deviceId));
    this.#patch({ output_device_id: deviceId });
  }

  listAudioDevices(): Promise<ConveractFabricSipAudioDevice[]> {
    this.#active();
    return this.#engine.listAudioDevices();
  }

  attachRemoteAudio(element: ConveractFabricSipAudioElement): void {
    this.#active();
    this.#engine.attachRemoteAudio(element);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.disconnect();
    } finally {
      this.#clearExpiry();
      this.#disposed = true;
      this.#listeners.clear();
    }
  }

  async #invoke(operation: () => Promise<void>): Promise<void> {
    this.#patch({ error: null });
    try {
      await operation();
    } catch (cause) {
      this.#patch({ error: safeError(cause) });
      throw cause;
    }
  }

  #active(): void {
    if (this.#disposed) throw new Error('SIP WebPhone is disposed');
  }

  #fresh(): void {
    if (Date.parse(this.#plan.expires_at) <= this.#now()) {
      throw new Error('voice extension session plan has expired');
    }
  }

  #registered(): void {
    if (this.#state.registration !== 'registered') throw new Error('SIP WebPhone is not registered');
  }

  #activeCall(): void {
    this.#active();
    if (this.#state.call !== 'active' && this.#state.call !== 'held') {
      throw new Error('SIP call is not active');
    }
  }

  #capability(
    capability: keyof ConveractFabricVoiceExtensionSessionPlan['capabilities'],
    message: string
  ): void {
    if (!this.#plan.capabilities[capability]) throw new Error(message);
  }

  #patch(patch: Partial<ConveractFabricSipWebPhoneState>): void {
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of this.#listeners) listener(this.#state);
  }

  #scheduleExpiry(): void {
    this.#clearExpiry();
    const remaining = Date.parse(this.#plan.expires_at) - this.#now();
    if (remaining <= 0) {
      void this.#expire();
      return;
    }
    this.#expiryTimer = this.#timer.set(() => {
      this.#expiryTimer = null;
      if (Date.parse(this.#plan.expires_at) > this.#now()) {
        this.#scheduleExpiry();
        return;
      }
      void this.#expire();
    }, Math.min(remaining, 2_147_483_647));
  }

  #clearExpiry(): void {
    if (this.#expiryTimer === null) return;
    this.#timer.clear(this.#expiryTimer);
    this.#expiryTimer = null;
  }

  async #expire(): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.#engine.disconnect();
    } catch {
      // The local credential boundary still closes when provider teardown is unavailable.
    }
    this.#patch({
      registration: 'stopped', call: 'idle', remote_identity: '', muted: false,
      error: 'voice extension session plan has expired'
    });
  }
}

class SipJsEngine implements ConveractFabricSipWebPhoneEngine {
  readonly #plan: ConveractFabricVoiceExtensionSessionPlan;
  readonly #events: ConveractFabricSipWebPhoneEngineEvents;
  #userAgent: UserAgent | null = null;
  #registerer: Registerer | null = null;
  #session: Session | null = null;
  #direction: 'incoming' | 'outgoing' | null = null;
  #held = false;
  #muted = false;
  #inputDeviceId = '';
  #outputDeviceId = '';
  #remoteAudio: ConveractFabricSipAudioElement | null = null;

  constructor(input: ConveractFabricSipWebPhoneEngineFactoryInput) {
    this.#plan = input.plan;
    this.#events = input.events;
  }

  async connect(): Promise<void> {
    if (!this.#userAgent || !this.#registerer
      || this.#registerer.state === RegistererState.Terminated) this.#createTransport();
    const userAgent = this.#userAgent;
    const registerer = this.#registerer;
    if (!userAgent || !registerer) throw new Error('SIP transport is unavailable');
    if (!userAgent.isConnected()) {
      if (userAgent.state === UserAgentState.Started) await userAgent.reconnect();
      else await userAgent.start();
    }
    if (registerer.state !== RegistererState.Registered) await registerer.register();
  }

  async disconnect(): Promise<void> {
    const userAgent = this.#userAgent;
    const registerer = this.#registerer;
    if (!userAgent || !registerer) {
      this.#events.registration('stopped');
      return;
    }
    if (this.#session) await this.hangup();
    if (registerer.state === RegistererState.Registered) await registerer.unregister();
    await userAgent.stop();
    if (this.#userAgent === userAgent) {
      this.#userAgent = null;
      this.#registerer = null;
    }
    this.#events.registration('stopped');
  }

  #createTransport(): void {
    const uri = UserAgent.makeURI(this.#plan.address_of_record);
    if (!uri) throw new TypeError('invalid SIP address of record');
    const userAgent = new UserAgent({
      uri,
      authorizationUsername: this.#plan.authorization_username,
      authorizationPassword: this.#plan.authorization_password,
      displayName: this.#plan.display_name || '',
      transportOptions: { server: this.#plan.websocket_url, traceSip: false },
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: { iceServers: rtcIceServers(this.#plan) }
      },
      logBuiltinEnabled: false,
      logConfiguration: false,
      delegate: {
        onConnect: () => {
          if (this.#userAgent === userAgent) this.#events.registration('connecting');
        },
        onDisconnect: (error) => {
          if (this.#userAgent !== userAgent) return;
          this.#events.registration(error ? 'failed' : 'disconnected', error);
          if (this.#session) this.#events.call('idle', '');
        },
        onInvite: (invitation) => this.#receive(invitation)
      }
    });
    const registerer = new Registerer(userAgent, {
      expires: this.#plan.register_expires_seconds,
      refreshFrequency: 80
    });
    this.#userAgent = userAgent;
    this.#registerer = registerer;
    registerer.stateChange.addListener((state) => {
      if (this.#registerer !== registerer) return;
      if (state === RegistererState.Registered) this.#events.registration('registered');
      if (state === RegistererState.Unregistered) this.#events.registration('disconnected');
      if (state === RegistererState.Terminated) this.#events.registration('stopped');
    });
  }

  async dial(targetInput: string): Promise<void> {
    if (this.#session) throw new Error('a SIP call is already in progress');
    const userAgent = this.#userAgent;
    if (!userAgent) throw new Error('SIP WebPhone is not connected');
    const target = UserAgent.makeURI(this.#destination(targetInput));
    if (!target) throw new TypeError('invalid SIP destination');
    const inviter = new Inviter(userAgent, target, {
      sessionDescriptionHandlerOptions: this.#mediaOptions()
    });
    this.#bind(inviter, 'outgoing');
    await inviter.invite();
  }

  async answer(): Promise<void> {
    if (!(this.#session instanceof Invitation)) throw new Error('there is no incoming SIP call');
    await this.#session.accept({ sessionDescriptionHandlerOptions: this.#mediaOptions() });
  }

  async reject(): Promise<void> {
    if (!(this.#session instanceof Invitation)) throw new Error('there is no incoming SIP call');
    await this.#session.reject({ statusCode: 486 });
  }

  async hangup(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    if (session.state === SessionState.Established) {
      await session.bye();
    } else if (session instanceof Inviter && session.state === SessionState.Establishing) {
      await session.cancel();
    } else if (session instanceof Invitation
      && (session.state === SessionState.Initial || session.state === SessionState.Establishing)) {
      await session.reject({ statusCode: 486 });
    } else if (session.state === SessionState.Initial) {
      await session.dispose();
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    const handler = this.#webHandler();
    if (!handler) throw new Error('SIP media is not established');
    this.#muted = muted;
    handler.enableSenderTracks(!muted && !this.#held);
  }

  async setHeld(held: boolean): Promise<void> {
    const session = this.#established();
    await this.#reInvite({ ...this.#mediaOptions(), hold: held });
    this.#held = held;
    const handler = this.#webHandler();
    handler?.enableReceiverTracks(!held);
    handler?.enableSenderTracks(!held && !this.#muted);
    this.#events.call(held ? 'held' : 'active');
  }

  async sendDtmf(tones: string): Promise<void> {
    const handler = this.#webHandler();
    if (!handler?.sendDtmf(tones, { duration: 100, interToneGap: 70 })) {
      throw new Error('SIP media rejected DTMF');
    }
  }

  async setInputDevice(deviceId: string): Promise<void> {
    if (this.#session?.state === SessionState.Established) {
      await this.#reInvite({ ...this.#mediaOptions(deviceId), hold: this.#held });
      this.#inputDeviceId = deviceId;
      this.#webHandler()?.enableSenderTracks(!this.#held && !this.#muted);
      return;
    }
    this.#inputDeviceId = deviceId;
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.#outputDeviceId = deviceId;
    await this.#applyOutputDevice();
  }

  async listAudioDevices(): Promise<ConveractFabricSipAudioDevice[]> {
    const mediaDevices = (globalThis as unknown as {
      navigator?: {
        mediaDevices?: {
          enumerateDevices(): Promise<Array<{
            deviceId: string;
            kind: string;
            label: string;
          }>>;
        };
      };
    }).navigator?.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return [];
    return (await mediaDevices.enumerateDevices())
      .filter((device) => device.kind === 'audioinput' || device.kind === 'audiooutput')
      .map((device) => ({
        device_id: device.deviceId,
        kind: device.kind as 'audioinput' | 'audiooutput',
        label: device.label || (device.kind === 'audioinput' ? 'Microphone' : 'Speaker')
      }));
  }

  attachRemoteAudio(element: ConveractFabricSipAudioElement): void {
    this.#remoteAudio = element;
    element.autoplay = true;
    void this.#applyOutputDevice().catch((error) => this.#events.error(error));
    this.#attachRemoteStream();
  }

  #receive(invitation: Invitation): void {
    if (!this.#plan.capabilities.incoming) {
      void invitation.reject({ statusCode: 403 }).catch((error) => this.#events.error(error));
      return;
    }
    if (this.#session && this.#session.state !== SessionState.Terminated) {
      void invitation.reject({ statusCode: 486 }).catch((error) => this.#events.error(error));
      return;
    }
    this.#bind(invitation, 'incoming');
    this.#events.call('incoming', invitation.remoteIdentity.uri.toString());
  }

  #bind(session: Session, direction: 'incoming' | 'outgoing'): void {
    this.#session = session;
    this.#direction = direction;
    this.#held = false;
    this.#muted = false;
    if (direction === 'outgoing') {
      this.#events.call('outgoing', session.remoteIdentity.uri.toString());
    }
    session.stateChange.addListener((state) => {
      if (state === SessionState.Establishing && this.#direction === 'outgoing') {
        this.#events.call('ringing', session.remoteIdentity.uri.toString());
      }
      if (state === SessionState.Established) {
        this.#events.call('active', session.remoteIdentity.uri.toString());
        this.#attachRemoteStream();
      }
      if (state === SessionState.Terminating) this.#events.call('ending');
      if (state === SessionState.Terminated) {
        if (this.#session === session) {
          this.#session = null;
          this.#direction = null;
          this.#held = false;
          this.#muted = false;
        }
        this.#events.call('idle', '');
      }
    });
  }

  #destination(value: string): string {
    if (/^sips?:/i.test(value)) return value;
    const at = this.#plan.address_of_record.indexOf('@');
    if (at < 0) throw new TypeError('invalid SIP address of record');
    return `sip:${value}@${this.#plan.address_of_record.slice(at + 1)}`;
  }

  #mediaOptions(inputDeviceId = this.#inputDeviceId): {
    constraints: {
      audio: true | { deviceId: { exact: string } };
      video: false;
    };
  } {
    return {
      constraints: {
        audio: inputDeviceId ? { deviceId: { exact: inputDeviceId } } : true,
        video: false
      }
    };
  }

  #established(): Session {
    if (!this.#session || this.#session.state !== SessionState.Established) {
      throw new Error('SIP media is not established');
    }
    return this.#session;
  }

  #webHandler(): Web.SessionDescriptionHandler | null {
    const handler = this.#session?.sessionDescriptionHandler;
    return handler instanceof Web.SessionDescriptionHandler ? handler : null;
  }

  async #reInvite(options: Web.SessionDescriptionHandlerOptions): Promise<void> {
    const session = this.#established();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        operation();
      };
      void session.invite({
        requestDelegate: {
          onAccept: () => finish(resolve),
          onReject: () => finish(() => reject(new Error('SIP re-INVITE was rejected'))),
          onRedirect: () => finish(() => reject(new Error('SIP re-INVITE was redirected')))
        },
        sessionDescriptionHandlerOptions: options
      }).catch((cause) => finish(() => reject(cause)));
    });
  }

  #attachRemoteStream(): void {
    const handler = this.#webHandler();
    if (!this.#remoteAudio || !handler) return;
    this.#remoteAudio.srcObject = handler.remoteMediaStream;
    void this.#remoteAudio.play().catch(() => undefined);
  }

  async #applyOutputDevice(): Promise<void> {
    if (!this.#remoteAudio) return;
    const audio = this.#remoteAudio;
    if (!audio.setSinkId) {
      if (!this.#outputDeviceId) return;
      throw new Error('audio output selection is not supported by this browser');
    }
    await audio.setSinkId(this.#outputDeviceId);
  }
}

function createSipJsEngine(input: ConveractFabricSipWebPhoneEngineFactoryInput): ConveractFabricSipWebPhoneEngine {
  return new SipJsEngine(input);
}

function rtcIceServers(plan: ConveractFabricVoiceExtensionSessionPlan): Array<{
  urls: string | string[];
  username?: string;
  credential?: string;
}> {
  return plan.ice_servers.map((server) => ({
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
    ...(server.username === undefined ? {} : { username: server.username }),
    ...(server.credential === undefined ? {} : { credential: server.credential })
  }));
}

function safeCommandValue(value: string, label: string): string {
  const result = value.trim();
  if (!result || result.length > 1_024 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new TypeError(`invalid ${label}`);
  }
  return result;
}

function safeOptionalCommandValue(value: string, label: string): string {
  const result = value.trim();
  if (result.length > 1_024 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new TypeError(`invalid ${label}`);
  }
  return result;
}

function defaultTimer(): {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
} {
  return {
    set(callback, delayMs) {
      const handle = setTimeout(callback, delayMs);
      (handle as unknown as { unref?: () => void }).unref?.();
      return handle;
    },
    clear(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  };
}

function safeError(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message.slice(0, 512);
  return 'SIP operation failed';
}
