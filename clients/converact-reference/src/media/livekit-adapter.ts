import { Room, RoomEvent } from 'livekit-client';

import type { ConveractFabricMediaJoinPlan } from '@converact/sdk';
import type {
  LiveKitRoomAdapter,
  MediaAdapterConnectionState,
  MediaAdapterEvent,
  MediaTrackHandle,
  MediaTrackKind,
  MediaTrackSource
} from './types.js';

export interface LiveKitParticipantLike {
  readonly identity: string;
  readonly name?: string;
}

export interface LiveKitTrackLike {
  readonly kind?: string;
  attach(element: HTMLMediaElement): HTMLMediaElement;
  detach(element?: HTMLMediaElement): unknown;
}

export interface LiveKitTrackPublicationLike {
  readonly trackSid?: string;
  readonly source?: string;
  readonly isMuted?: boolean;
}

export interface LiveKitLocalParticipantLike {
  setMicrophoneEnabled(enabled: boolean): Promise<unknown>;
  setCameraEnabled(enabled: boolean): Promise<unknown>;
  setScreenShareEnabled(enabled: boolean, options?: { audio?: boolean }): Promise<unknown>;
}

export interface LiveKitRoomLike {
  readonly localParticipant: LiveKitLocalParticipantLike;
  canPlaybackAudio: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  connect(url: string, token: string, options?: Record<string, unknown>): Promise<void>;
  disconnect(stopTracks?: boolean): Promise<void>;
  switchActiveDevice(kind: MediaDeviceKind, deviceId: string, exact?: boolean): Promise<boolean>;
  startAudio(): Promise<void>;
}

export interface LiveKitClientAdapterInput {
  roomFactory?: () => LiveKitRoomLike;
  onEvent?: (event: MediaAdapterEvent) => void;
}

declare global {
  interface Window {
    __CONVERACT_FABRIC_DEV_LIVEKIT_ROOM_FACTORY__?: () => LiveKitRoomLike;
  }
}

interface ActiveTrack {
  readonly raw: LiveKitTrackLike;
  readonly handle: MediaTrackHandle;
}

const events = {
  participantConnected: RoomEvent.ParticipantConnected,
  participantDisconnected: RoomEvent.ParticipantDisconnected,
  trackSubscribed: RoomEvent.TrackSubscribed,
  trackUnsubscribed: RoomEvent.TrackUnsubscribed,
  trackMuted: RoomEvent.TrackMuted,
  trackUnmuted: RoomEvent.TrackUnmuted,
  activeSpeakersChanged: RoomEvent.ActiveSpeakersChanged,
  connectionQualityChanged: RoomEvent.ConnectionQualityChanged,
  reconnecting: RoomEvent.Reconnecting,
  reconnected: RoomEvent.Reconnected,
  audioPlaybackChanged: RoomEvent.AudioPlaybackStatusChanged,
  localTrackPublished: RoomEvent.LocalTrackPublished,
  localTrackUnpublished: RoomEvent.LocalTrackUnpublished,
  disconnected: RoomEvent.Disconnected
} as const;

export class LiveKitClientAdapter implements LiveKitRoomAdapter {
  private room: LiveKitRoomLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectKey: string | null = null;
  private generation = 0;
  private state: MediaAdapterConnectionState = 'idle';
  private disposed = false;
  private fallbackTrackSequence = 0;
  private readonly handlersByRoom = new WeakMap<LiveKitRoomLike, Map<string, (...args: unknown[]) => void>>();
  private readonly tracks = new Map<string, ActiveTrack>();

  constructor(private readonly input: LiveKitClientAdapterInput = {}) {}

  connect(plan: ConveractFabricMediaJoinPlan): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('LiveKit adapter is disposed'));
    const credentials = webRtcCredentials(plan);
    const key = `${credentials.url}\n${credentials.roomName}\n${credentials.token}`;
    if (this.connectKey === key && this.connectPromise) return this.connectPromise;
    if (this.connectKey === key && this.state === 'connected' && this.room) return Promise.resolve();

    const generation = ++this.generation;
    const previousRoom = this.room;
    this.room = null;
    this.connectKey = key;
    this.invalidateTracks();
    this.unbindRoom(previousRoom);
    this.setState('connecting', generation);

    const pending = this.connectGeneration(credentials, generation, previousRoom);
    const tracked = pending.finally(() => {
      if (this.connectPromise === tracked) this.connectPromise = null;
    });
    this.connectPromise = tracked;
    return tracked;
  }

  async disconnect(): Promise<void> {
    const generation = ++this.generation;
    const room = this.room;
    this.room = null;
    this.connectPromise = null;
    this.connectKey = null;
    this.invalidateTracks();
    this.unbindRoom(room);
    if (room) await room.disconnect(true).catch(() => undefined);
    this.setState('disconnected', generation);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.disconnect();
    this.setState('disposed', this.generation);
  }

  async setMicrophone(enabled: boolean): Promise<void> {
    await this.requireRoom().localParticipant.setMicrophoneEnabled(enabled);
  }

  async setCamera(enabled: boolean): Promise<void> {
    await this.requireRoom().localParticipant.setCameraEnabled(enabled);
  }

  async setScreenShare(enabled: boolean, options?: { audio?: boolean }): Promise<void> {
    await this.requireRoom().localParticipant.setScreenShareEnabled(enabled, options);
  }

  async switchDevice(
    kind: 'audioinput' | 'videoinput' | 'audiooutput',
    deviceId: string
  ): Promise<void> {
    if (!deviceId.trim()) throw new Error('LiveKit deviceId is required');
    const switched = await this.requireRoom().switchActiveDevice(kind, deviceId, true);
    if (!switched) throw new Error(`LiveKit failed to switch ${kind} device`);
  }

  async startAudio(): Promise<void> {
    const room = this.requireRoom();
    try {
      await room.startAudio();
    } catch (cause) {
      this.emit({
        type: 'autoplay_blocked',
        generation: this.generation,
        message: asError(cause).message
      });
      throw cause;
    }
  }

  private async connectGeneration(
    credentials: WebRtcCredentials,
    generation: number,
    previousRoom: LiveKitRoomLike | null
  ): Promise<void> {
    if (previousRoom) await previousRoom.disconnect(true).catch(() => undefined);
    this.assertCurrent(generation);
    const room = this.input.roomFactory?.() || defaultRoomFactory();
    this.room = room;
    this.bindRoom(room, generation);
    try {
      await room.connect(credentials.url, credentials.token, { autoSubscribe: true });
      this.assertCurrent(generation, room);
      this.setState('connected', generation);
      if (!room.canPlaybackAudio) this.emitAutoplayBlocked(generation);
    } catch (cause) {
      this.unbindRoom(room);
      await room.disconnect(true).catch(() => undefined);
      if (this.isCurrent(generation, room)) {
        this.room = null;
        this.connectKey = null;
        this.setState('fatal', generation);
      }
      if (!this.isGenerationCurrent(generation)) throw new Error('LiveKit connection cancelled');
      throw cause;
    }
  }

  private bindRoom(room: LiveKitRoomLike, generation: number): void {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    this.handlersByRoom.set(room, handlers);
    const bind = (event: string, listener: (...args: unknown[]) => void) => {
      const guarded = (...args: unknown[]) => {
        if (this.isCurrent(generation, room)) listener(...args);
      };
      handlers.set(event, guarded);
      room.on(event, guarded);
    };

    bind(events.participantConnected, (value) => {
      const participant = asParticipant(value);
      if (!participant) return;
      this.emit({
        type: 'participant_joined',
        generation,
        identity: participant.identity,
        display_name: participant.name || participant.identity
      });
    });
    bind(events.participantDisconnected, (value) => {
      const participant = asParticipant(value);
      if (participant) this.emit({ type: 'participant_left', generation, identity: participant.identity });
    });
    bind(events.trackSubscribed, (rawTrack, rawPublication, rawParticipant) => {
      const track = asTrack(rawTrack);
      const publication = asPublication(rawPublication);
      const participant = asParticipant(rawParticipant);
      if (!track || !publication || !participant) return;
      const id = publication.trackSid || `${participant.identity}:${normalizeSource(publication.source)}:${++this.fallbackTrackSequence}`;
      const existing = this.tracks.get(id);
      if (existing?.raw === track) return;
      if (existing) this.invalidateTrack(id);
      const handle = this.createTrackHandle(id, participant.identity, track, publication);
      this.tracks.set(id, { raw: track, handle });
      this.emit({ type: 'track_subscribed', generation, track: handle });
    });
    bind(events.trackUnsubscribed, (_rawTrack, rawPublication, rawParticipant) => {
      const publication = asPublication(rawPublication);
      const participant = asParticipant(rawParticipant);
      if (!publication || !participant) return;
      const id = publication.trackSid || this.findTrackId(participant.identity, _rawTrack);
      if (!id) return;
      this.invalidateTrack(id);
      this.emit({
        type: 'track_unsubscribed',
        generation,
        track_id: id,
        participant_identity: participant.identity
      });
    });
    const emitMute = (rawPublication: unknown, muted: boolean) => {
      const publication = asPublication(rawPublication);
      if (publication?.trackSid) this.emit({ type: 'track_mute_changed', generation, track_id: publication.trackSid, muted });
    };
    bind(events.trackMuted, (rawPublication) => emitMute(rawPublication, true));
    bind(events.trackUnmuted, (rawPublication) => emitMute(rawPublication, false));
    bind(events.activeSpeakersChanged, (value) => {
      if (!Array.isArray(value)) return;
      const identities = Object.freeze(value.map(asParticipant).filter(isParticipant).map((item) => item.identity));
      this.emit({ type: 'active_speakers', generation, identities });
    });
    bind(events.connectionQualityChanged, (quality, value) => {
      const participant = asParticipant(value);
      if (!participant) return;
      this.emit({
        type: 'network_quality',
        generation,
        identity: participant.identity,
        quality: String(quality)
      });
    });
    bind(events.reconnecting, () => {
      this.setState('reconnecting', generation);
      this.emit({ type: 'native_reconnect', generation, phase: 'started' });
    });
    bind(events.reconnected, () => {
      this.setState('connected', generation);
      this.emit({ type: 'native_reconnect', generation, phase: 'succeeded' });
    });
    bind(events.audioPlaybackChanged, () => {
      if (!room.canPlaybackAudio) this.emitAutoplayBlocked(generation);
    });
    bind(events.localTrackPublished, (rawPublication) => this.emitLocalTrack(rawPublication, generation, true));
    bind(events.localTrackUnpublished, (rawPublication) => this.emitLocalTrack(rawPublication, generation, false));
    bind(events.disconnected, (reason) => this.handleUnexpectedDisconnect(room, generation, reason));
  }

  private handleUnexpectedDisconnect(room: LiveKitRoomLike, generation: number, reason: unknown): void {
    if (!this.isCurrent(generation, room)) return;
    this.room = null;
    this.connectPromise = null;
    this.connectKey = null;
    this.invalidateTracks();
    this.unbindRoom(room);
    this.setState('disconnected', generation);
    this.emit({
      type: 'terminal_disconnect',
      generation,
      reason_code: boundedReasonCode(reason)
    });
  }

  private emitLocalTrack(rawPublication: unknown, generation: number, enabled: boolean): void {
    const publication = asPublication(rawPublication);
    if (!publication) return;
    const source = normalizeSource(publication.source);
    if (source === 'unknown') return;
    this.emit({ type: 'local_track_changed', generation, source, enabled });
  }

  private createTrackHandle(
    id: string,
    participantIdentity: string,
    raw: LiveKitTrackLike,
    publication: LiveKitTrackPublicationLike
  ): MediaTrackHandle {
    const assertActive = () => {
      if (this.tracks.get(id)?.raw !== raw) throw new Error('LiveKit track is no longer active');
    };
    return Object.freeze({
      id,
      participantIdentity,
      kind: normalizeKind(raw.kind),
      source: normalizeSource(publication.source),
      muted: Boolean(publication.isMuted),
      attach: (element: HTMLMediaElement) => {
        assertActive();
        return raw.attach(element);
      },
      detach: (element?: HTMLMediaElement) => {
        assertActive();
        raw.detach(element);
      }
    });
  }

  private findTrackId(participantIdentity: string, rawTrack: unknown): string | undefined {
    for (const [id, active] of this.tracks) {
      if (active.raw === rawTrack && active.handle.participantIdentity === participantIdentity) return id;
    }
    return undefined;
  }

  private invalidateTrack(id: string): void {
    const active = this.tracks.get(id);
    this.tracks.delete(id);
    if (active) active.raw.detach();
  }

  private invalidateTracks(): void {
    for (const id of [...this.tracks.keys()]) this.invalidateTrack(id);
  }

  private unbindRoom(room: LiveKitRoomLike | null): void {
    if (!room) return;
    const handlers = this.handlersByRoom.get(room);
    if (!handlers) return;
    for (const [event, listener] of handlers) room.off(event, listener);
    this.handlersByRoom.delete(room);
  }

  private requireRoom(): LiveKitRoomLike {
    if (this.disposed) throw new Error('LiveKit adapter is disposed');
    if (this.state !== 'connected' || !this.room) throw new Error('LiveKit room is not connected');
    return this.room;
  }

  private assertCurrent(generation: number, room?: LiveKitRoomLike): void {
    if (!this.isGenerationCurrent(generation) || (room && this.room !== room)) {
      throw new Error('LiveKit connection cancelled');
    }
  }

  private isGenerationCurrent(generation: number): boolean {
    return this.generation === generation && !this.disposed;
  }

  private isCurrent(generation: number, room: LiveKitRoomLike): boolean {
    return this.isGenerationCurrent(generation) && this.room === room;
  }

  private setState(state: MediaAdapterConnectionState, generation: number): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: 'state', generation, state });
  }

  private emitAutoplayBlocked(generation: number): void {
    this.emit({
      type: 'autoplay_blocked',
      generation,
      message: 'Browser blocked audio playback until a user gesture starts audio'
    });
  }

  private emit(event: MediaAdapterEvent): void {
    this.input.onEvent?.(Object.freeze(event));
  }
}

interface WebRtcCredentials {
  readonly url: string;
  readonly token: string;
  readonly roomName: string;
}

function webRtcCredentials(plan: ConveractFabricMediaJoinPlan): WebRtcCredentials {
  if (plan.mode !== 'webrtc') throw new Error('LiveKit adapter requires a WebRTC join plan');
  const url = plan.token.livekit_url.trim();
  const token = plan.token.token.trim();
  const roomName = plan.token.room_name.trim() || plan.roomName.trim();
  if (!url || !token || !roomName || !plan.token.configured) {
    throw new Error('LiveKit join plan is not configured');
  }
  return { url, token, roomName };
}

function defaultRoomFactory(): LiveKitRoomLike {
  const development = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV;
  const injected = development && typeof window !== 'undefined'
    ? window.__CONVERACT_FABRIC_DEV_LIVEKIT_ROOM_FACTORY__
    : undefined;
  if (injected) return injected();
  return new Room({ adaptiveStream: true, dynacast: true }) as unknown as LiveKitRoomLike;
}

function asParticipant(value: unknown): LiveKitParticipantLike | null {
  if (!value || typeof value !== 'object') return null;
  const participant = value as Partial<LiveKitParticipantLike>;
  return typeof participant.identity === 'string' && participant.identity
    ? { identity: participant.identity, name: typeof participant.name === 'string' ? participant.name : undefined }
    : null;
}

function isParticipant(value: LiveKitParticipantLike | null): value is LiveKitParticipantLike {
  return value !== null;
}

function asTrack(value: unknown): LiveKitTrackLike | null {
  if (!value || typeof value !== 'object') return null;
  const track = value as Partial<LiveKitTrackLike>;
  return typeof track.attach === 'function' && typeof track.detach === 'function'
    ? track as LiveKitTrackLike
    : null;
}

function asPublication(value: unknown): LiveKitTrackPublicationLike | null {
  return value && typeof value === 'object' ? value as LiveKitTrackPublicationLike : null;
}

function normalizeKind(value: string | undefined): MediaTrackKind {
  return value === 'audio' || value === 'video' ? value : 'unknown';
}

function normalizeSource(value: string | undefined): MediaTrackSource {
  switch (value) {
    case 'camera':
    case 'microphone':
    case 'screen_share':
    case 'screen_share_audio':
      return value;
    default:
      return 'unknown';
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function boundedReasonCode(value: unknown): string {
  const reasonCodes = [
    'unknown_reason',
    'client_initiated',
    'duplicate_identity',
    'server_shutdown',
    'participant_removed',
    'room_deleted',
    'state_mismatch',
    'join_failure',
    'migration',
    'signal_close',
    'room_closed',
    'user_unavailable',
    'user_rejected',
    'sip_trunk_failure',
    'connection_timeout',
    'media_failure',
    'agent_error'
  ] as const;
  if (typeof value === 'number' && Number.isInteger(value)) {
    return reasonCodes[value] || 'provider_disconnect';
  }
  const normalized = String(value ?? '').trim().toLowerCase();
  return reasonCodes.includes(normalized as (typeof reasonCodes)[number])
    ? normalized
    : 'provider_disconnect';
}
