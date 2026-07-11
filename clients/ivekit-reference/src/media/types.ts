export type MediaAdapterConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'fatal'
  | 'disposed';

export type MediaTrackKind = 'audio' | 'video' | 'unknown';

export type MediaTrackSource =
  | 'camera'
  | 'microphone'
  | 'screen_share'
  | 'screen_share_audio'
  | 'unknown';

export interface MediaTrackHandle {
  readonly id: string;
  readonly participantIdentity: string;
  readonly kind: MediaTrackKind;
  readonly source: MediaTrackSource;
  readonly muted: boolean;
  attach(element: HTMLMediaElement): HTMLMediaElement;
  detach(element?: HTMLMediaElement): void;
}

export type MediaAdapterEvent =
  | Readonly<{
      type: 'state';
      generation: number;
      state: MediaAdapterConnectionState;
    }>
  | Readonly<{
      type: 'participant_joined';
      generation: number;
      identity: string;
      display_name: string;
    }>
  | Readonly<{
      type: 'participant_left';
      generation: number;
      identity: string;
    }>
  | Readonly<{
      type: 'track_subscribed';
      generation: number;
      track: MediaTrackHandle;
    }>
  | Readonly<{
      type: 'track_unsubscribed';
      generation: number;
      track_id: string;
      participant_identity: string;
    }>
  | Readonly<{
      type: 'track_mute_changed';
      generation: number;
      track_id: string;
      muted: boolean;
    }>
  | Readonly<{
      type: 'active_speakers';
      generation: number;
      identities: readonly string[];
    }>
  | Readonly<{
      type: 'network_quality';
      generation: number;
      identity: string;
      quality: string;
    }>
  | Readonly<{
      type: 'local_track_changed';
      generation: number;
      source: Exclude<MediaTrackSource, 'unknown'>;
      enabled: boolean;
    }>
  | Readonly<{
      type: 'autoplay_blocked';
      generation: number;
      message: string;
    }>
  | Readonly<{
      type: 'fatal';
      generation: number;
      reason: string;
    }>;

export interface LiveKitRoomAdapter {
  connect(plan: import('@opc/ivekit-sdk').IveKitMediaJoinPlan): Promise<void>;
  disconnect(): Promise<void>;
  setMicrophone(enabled: boolean): Promise<void>;
  setCamera(enabled: boolean): Promise<void>;
  setScreenShare(enabled: boolean, options?: { audio?: boolean }): Promise<void>;
  switchDevice(kind: 'audioinput' | 'videoinput' | 'audiooutput', deviceId: string): Promise<void>;
  startAudio(): Promise<void>;
  dispose(): Promise<void>;
}
