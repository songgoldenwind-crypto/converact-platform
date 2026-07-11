import type {
  IveKitMediaCall,
  IveKitMediaCallParticipant,
  IveKitMediaCallSnapshot,
  IveKitMediaCallStatus
} from '@opc/ivekit-sdk';
import type {
  MediaAdapterConnectionState,
  MediaAdapterEvent,
  MediaTrackHandle
} from './types.js';

export type MediaConnectionState =
  | 'idle'
  | 'preparing'
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'ended'
  | 'fatal';

export type MediaLayout = 'grid' | 'speaker' | 'screen_share';

export interface MediaLocalState {
  readonly microphone: boolean;
  readonly camera: boolean;
  readonly screen: boolean;
  readonly screenAudio: boolean;
}

export interface MediaCommandState {
  readonly pending: boolean;
  readonly error: string;
}

export interface MediaCallState {
  readonly requestId: number;
  readonly selectedCallId: string;
  readonly adapterGeneration: number;
  readonly call: IveKitMediaCall | null;
  readonly participants: readonly IveKitMediaCallParticipant[];
  readonly tracks: Readonly<Record<string, MediaTrackHandle>>;
  readonly presentIdentities: readonly string[];
  readonly activeSpeakerIdentities: readonly string[];
  readonly networkQuality: Readonly<Record<string, string>>;
  readonly connection: MediaConnectionState;
  readonly layout: MediaLayout;
  readonly local: MediaLocalState;
  readonly commands: Readonly<Record<string, MediaCommandState>>;
  readonly autoplayBlocked: boolean;
  readonly fatalReason: string;
  readonly revokedReason: string;
}

export type MediaAction =
  | { type: 'call_selected'; requestId: number; callId: string }
  | { type: 'snapshot_loaded'; requestId: number; snapshot: IveKitMediaCallSnapshot }
  | { type: 'call_updated'; requestId: number; call: IveKitMediaCall }
  | { type: 'adapter_event'; generation: number; event: MediaAdapterEvent }
  | { type: 'command_started'; command: string }
  | { type: 'command_failed'; command: string; error: string }
  | { type: 'command_succeeded'; command: string }
  | { type: 'local_changed'; local: Partial<MediaLocalState> }
  | { type: 'layout_changed'; layout: MediaLayout }
  | { type: 'revoked'; reason: string };

const localOff: MediaLocalState = Object.freeze({
  microphone: false,
  camera: false,
  screen: false,
  screenAudio: false
});

export function initialMediaCallState(): MediaCallState {
  return {
    requestId: 0,
    selectedCallId: '',
    adapterGeneration: 0,
    call: null,
    participants: [],
    tracks: {},
    presentIdentities: [],
    activeSpeakerIdentities: [],
    networkQuality: {},
    connection: 'idle',
    layout: 'grid',
    local: localOff,
    commands: {},
    autoplayBlocked: false,
    fatalReason: '',
    revokedReason: ''
  };
}

export function mediaCallReducer(state: MediaCallState, action: MediaAction): MediaCallState {
  switch (action.type) {
    case 'call_selected':
      if (action.requestId < state.requestId) return state;
      return {
        ...initialMediaCallState(),
        requestId: action.requestId,
        selectedCallId: action.callId,
        connection: action.callId ? 'preparing' : 'idle'
      };
    case 'snapshot_loaded':
      if (!matchesRequest(state, action.requestId, action.snapshot.call.id)) return state;
      return applySnapshot(state, action.snapshot);
    case 'call_updated':
      if (!matchesRequest(state, action.requestId, action.call.id)) return state;
      return applyCall(state, action.call);
    case 'adapter_event':
      if (action.generation !== action.event.generation || action.generation < state.adapterGeneration) return state;
      return applyAdapterEvent(
        action.generation > state.adapterGeneration ? resetProviderProjection(state, action.generation) : state,
        action.event
      );
    case 'command_started':
      return updateCommand(state, action.command, { pending: true, error: '' });
    case 'command_failed':
      return updateCommand(state, action.command, { pending: false, error: action.error });
    case 'command_succeeded':
      return updateCommand(state, action.command, { pending: false, error: '' });
    case 'local_changed':
      return { ...state, local: Object.freeze({ ...state.local, ...action.local }) };
    case 'layout_changed':
      return { ...state, layout: action.layout };
    case 'revoked':
      return {
        ...clearProviderProjection(state),
        connection: 'ended',
        local: localOff,
        revokedReason: action.reason
      };
  }
}

function applySnapshot(state: MediaCallState, snapshot: IveKitMediaCallSnapshot): MediaCallState {
  return applyCall({ ...state, participants: Object.freeze([...snapshot.participants]) }, snapshot.call);
}

function applyCall(state: MediaCallState, call: IveKitMediaCall): MediaCallState {
  if (isTerminalStatus(call.status)) {
    return {
      ...clearProviderProjection(state),
      call,
      connection: 'ended',
      local: localOff
    };
  }
  const connection = call.status === 'active' && ['idle', 'preparing'].includes(state.connection)
    ? 'online'
    : state.connection === 'preparing' ? 'idle' : state.connection;
  return { ...state, call, connection };
}

function applyAdapterEvent(state: MediaCallState, event: MediaAdapterEvent): MediaCallState {
  switch (event.type) {
    case 'state':
      return { ...state, connection: connectionFromAdapter(event.state, state.call?.status) };
    case 'participant_joined':
      return { ...state, presentIdentities: addIdentity(state.presentIdentities, event.identity) };
    case 'participant_left':
      return {
        ...state,
        presentIdentities: state.presentIdentities.filter((identity) => identity !== event.identity),
        activeSpeakerIdentities: state.activeSpeakerIdentities.filter((identity) => identity !== event.identity),
        tracks: tracksWithoutParticipant(state.tracks, event.identity),
        networkQuality: recordWithoutKey(state.networkQuality, event.identity)
      };
    case 'track_subscribed':
      return { ...state, tracks: { ...state.tracks, [event.track.id]: event.track } };
    case 'track_unsubscribed': {
      const tracks = { ...state.tracks };
      delete tracks[event.track_id];
      return { ...state, tracks };
    }
    case 'active_speakers':
      return { ...state, activeSpeakerIdentities: Object.freeze([...event.identities]) };
    case 'network_quality':
      return { ...state, networkQuality: { ...state.networkQuality, [event.identity]: event.quality } };
    case 'local_track_changed':
      return { ...state, local: localFromTrackEvent(state.local, event.source, event.enabled) };
    case 'autoplay_blocked':
      return { ...state, autoplayBlocked: true };
    case 'fatal':
      return {
        ...clearProviderProjection(state),
        connection: 'fatal',
        fatalReason: event.reason,
        local: localOff
      };
  }
}

function resetProviderProjection(state: MediaCallState, generation: number): MediaCallState {
  return {
    ...clearProviderProjection(state),
    adapterGeneration: generation,
    autoplayBlocked: false,
    fatalReason: ''
  };
}

function clearProviderProjection(state: MediaCallState): MediaCallState {
  return {
    ...state,
    tracks: {},
    presentIdentities: [],
    activeSpeakerIdentities: [],
    networkQuality: {}
  };
}

function updateCommand(
  state: MediaCallState,
  command: string,
  commandState: MediaCommandState
): MediaCallState {
  return { ...state, commands: { ...state.commands, [command]: Object.freeze(commandState) } };
}

function localFromTrackEvent(
  local: MediaLocalState,
  source: 'camera' | 'microphone' | 'screen_share' | 'screen_share_audio',
  enabled: boolean
): MediaLocalState {
  if (source === 'camera') return Object.freeze({ ...local, camera: enabled });
  if (source === 'microphone') return Object.freeze({ ...local, microphone: enabled });
  if (source === 'screen_share_audio') return Object.freeze({ ...local, screenAudio: enabled });
  return Object.freeze({ ...local, screen: enabled, ...(!enabled ? { screenAudio: false } : {}) });
}

function matchesRequest(state: MediaCallState, requestId: number, callId: string): boolean {
  return requestId === state.requestId && callId === state.selectedCallId;
}

function addIdentity(identities: readonly string[], identity: string): readonly string[] {
  return identities.includes(identity) ? identities : Object.freeze([...identities, identity]);
}

function tracksWithoutParticipant(
  tracks: Readonly<Record<string, MediaTrackHandle>>,
  identity: string
): Record<string, MediaTrackHandle> {
  return Object.fromEntries(Object.entries(tracks).filter(([, track]) => track.participantIdentity !== identity));
}

function recordWithoutKey(record: Readonly<Record<string, string>>, key: string): Record<string, string> {
  const next = { ...record };
  delete next[key];
  return next;
}

function connectionFromAdapter(
  adapter: MediaAdapterConnectionState,
  callStatus: IveKitMediaCallStatus | undefined
): MediaConnectionState {
  if (callStatus && isTerminalStatus(callStatus)) return 'ended';
  switch (adapter) {
    case 'connecting': return 'connecting';
    case 'connected': return 'online';
    case 'reconnecting': return 'reconnecting';
    case 'disconnected': return 'offline';
    case 'fatal': return 'fatal';
    case 'disposed': return 'idle';
    default: return 'idle';
  }
}

export function isTerminalStatus(status: IveKitMediaCallStatus): boolean {
  return ['rejected', 'cancelled', 'timed_out', 'ended', 'failed'].includes(status);
}
