import { useCallback, useEffect, useReducer, useRef } from 'react';

import type {
  IveKitHttpSdk,
  IveKitMediaCallAction,
  IveKitMediaCallSnapshot,
  IveKitMediaConnectionEventType,
  IveKitMediaJoinInput,
  IveKitMediaJoinPlan,
  IveKitMediaModerationResult
} from '@converact/sdk';
import { LiveKitClientAdapter } from './livekit-adapter.js';
import { MediaRejoinController, type MediaRejoinScheduler } from './media-rejoin-controller.js';
import {
  initialMediaCallState,
  isTerminalStatus,
  mediaCallReducer,
  type MediaCallState,
  type MediaLayout,
  type MediaLocalState
} from './media-reducer.js';
import type { LiveKitRoomAdapter, MediaAdapterEvent } from './types.js';
import { openAuthenticatedWebSocket } from '../websocket-auth.js';

export type MediaAdapterFactory = (onEvent: (event: MediaAdapterEvent) => void) => LiveKitRoomAdapter;

export interface UseMediaCallInput {
  client: IveKitHttpSdk | null;
  callId: string;
  identity: string;
  displayName?: string;
  adapterFactory?: MediaAdapterFactory;
  randomId?: () => string;
  websocketUrl?: string;
  accessToken?: string;
  rejoinDelaysMs?: readonly number[];
  rejoinScheduler?: MediaRejoinScheduler;
}

export interface MediaCallCommands {
  state: MediaCallState;
  refresh(): Promise<void>;
  transition(action: IveKitMediaCallAction, reason?: string): Promise<IveKitMediaCallSnapshot>;
  retry(command: IveKitMediaCallAction): Promise<IveKitMediaCallSnapshot>;
  setMicrophone(enabled: boolean): Promise<void>;
  setCamera(enabled: boolean): Promise<void>;
  setScreenShare(enabled: boolean, options?: { audio?: boolean }): Promise<void>;
  switchDevice(kind: 'audioinput' | 'videoinput' | 'audiooutput', deviceId: string): Promise<void>;
  startAudio(): Promise<void>;
  muteParticipant(identity: string, track: import('./types.js').MediaTrackHandle): Promise<IveKitMediaModerationResult>;
  removeParticipant(identity: string, reason?: string): Promise<IveKitMediaModerationResult>;
  setLayout(layout: MediaLayout): void;
  dismissScreenShareRecovery(): void;
}

interface PendingLifecycleCommand {
  readonly callId: string;
  readonly action: IveKitMediaCallAction;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

interface JoinOperation {
  readonly requestId: number;
  readonly promise: Promise<void>;
}

export function useMediaCall(input: UseMediaCallInput): MediaCallCommands {
  const [state, dispatch] = useReducer(mediaCallReducer, undefined, initialMediaCallState);
  const requestId = useRef(0);
  const adapter = useRef<LiveKitRoomAdapter | null>(null);
  const snapshot = useRef<IveKitMediaCallSnapshot | null>(null);
  const pending = useRef(new Map<string, PendingLifecycleCommand>());
  const inFlight = useRef(new Map<string, Promise<IveKitMediaCallSnapshot>>());
  const moderationKeys = useRef(new Map<string, string>());
  const moderationInFlight = useRef(new Map<string, Promise<IveKitMediaModerationResult>>());
  const joinOperation = useRef<JoinOperation | null>(null);
  const joinedRequest = useRef(0);
  const lastPlacement = useRef<IveKitMediaJoinInput['recovery'] | null>(null);
  const rejoinController = useRef<MediaRejoinController | null>(null);
  const desiredLocal = useRef<MediaLocalState>({ microphone: false, camera: false, screen: false, screenAudio: false });
  const disposedAdapters = useRef(new WeakSet<object>());
  const adapterFactory = useRef<MediaAdapterFactory>(input.adapterFactory || defaultAdapterFactory);
  const randomId = useRef(input.randomId || defaultRandomId);
  const rejoinDelaysMs = useRef(input.rejoinDelaysMs);
  const rejoinScheduler = useRef(input.rejoinScheduler);
  const connectSnapshot = useRef<(value: IveKitMediaCallSnapshot, operationId: number, room: LiveKitRoomAdapter) => Promise<void>>(async () => undefined);
  const connectionEstablished = useRef<(operationId: number, room: LiveKitRoomAdapter) => void>(() => undefined);
  const transitionCurrent = useRef<(action: IveKitMediaCallAction, reason?: string) => Promise<IveKitMediaCallSnapshot>>(async () => { throw new Error('Media call is not ready'); });
  adapterFactory.current = input.adapterFactory || defaultAdapterFactory;
  randomId.current = input.randomId || defaultRandomId;
  rejoinDelaysMs.current = input.rejoinDelaysMs;
  rejoinScheduler.current = input.rejoinScheduler;

  const disposeAdapter = useCallback(async (room: LiveKitRoomAdapter | null): Promise<void> => {
    if (!room || disposedAdapters.current.has(room as object)) return;
    disposedAdapters.current.add(room as object);
    await room.dispose().catch(() => undefined);
  }, []);

  const revoke = useCallback(async (
    reason: string,
    operationId: number,
    room: LiveKitRoomAdapter | null
  ): Promise<void> => {
    rejoinController.current?.reset();
    if (adapter.current === room) adapter.current = null;
    await disposeAdapter(room);
    if (requestId.current !== operationId) return;
    snapshot.current = null;
    dispatch({ type: 'revoked', reason });
  }, [disposeAdapter]);

  const connect = useCallback(async (
    value: IveKitMediaCallSnapshot,
    operationId: number,
    room: LiveKitRoomAdapter
  ): Promise<void> => {
    if (!input.client || !['accepted', 'active'].includes(value.call.status)) return;
    if (joinedRequest.current === operationId) return;
    if (joinOperation.current?.requestId === operationId) return joinOperation.current.promise;
    dispatch({ type: 'command_started', command: 'join' });
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const plan = await input.client!.media.createCallJoinPlan(value.call.id, {
          identity: input.identity,
          ...(input.displayName ? { display_name: input.displayName } : {})
        });
        lastPlacement.current = placementRecoveryIdentity(plan);
        if (!isCurrent(operationId, room, requestId, adapter)) return;
        await room.connect(plan);
        if (isCurrent(operationId, room, requestId, adapter)) {
          joinedRequest.current = operationId;
          dispatch({ type: 'command_succeeded', command: 'join' });
          connectionEstablished.current(operationId, room);
        }
      } catch (cause) {
        if (!isCurrent(operationId, room, requestId, adapter)) return;
        const error = asError(cause);
        if (isAuthorizationLoss(cause)) await revoke(error.message, operationId, room);
        else dispatch({ type: 'command_failed', command: 'join', error: error.message });
      } finally {
        if (joinOperation.current?.promise === promise) joinOperation.current = null;
      }
    })();
    joinOperation.current = { requestId: operationId, promise };
    return promise;
  }, [input.client, input.identity, input.displayName, revoke]);
  connectSnapshot.current = connect;

  const transition = useCallback((
    action: IveKitMediaCallAction,
    reason?: string
  ): Promise<IveKitMediaCallSnapshot> => {
    if (!input.client || !input.callId) return Promise.reject(new Error('Media call is not selected'));
    const operationId = requestId.current;
    const commandKey = `${input.callId}:${action}`;
    const existingFlight = inFlight.current.get(commandKey);
    if (existingFlight) return existingFlight;
    let command = pending.current.get(commandKey);
    if (!command) {
      command = {
        callId: input.callId,
        action,
        ...(reason ? { reason } : {}),
        idempotencyKey: randomId.current()
      };
      pending.current.set(commandKey, command);
    }
    dispatch({ type: 'command_started', command: action });
    let operation!: Promise<IveKitMediaCallSnapshot>;
    operation = (async () => {
      try {
        const result = await input.client!.media.transitionCall(
          command!.callId,
          { action: command!.action, ...(command!.reason ? { reason: command!.reason } : {}) },
          { idempotencyKey: command!.idempotencyKey }
        );
        if (requestId.current !== operationId || input.callId !== command!.callId) return result;
        if (isTerminalStatus(result.call.status)) {
          rejoinController.current?.reset();
          await disposeAdapter(adapter.current);
        }
        if (requestId.current !== operationId) return result;
        snapshot.current = result;
        dispatch({ type: 'snapshot_loaded', requestId: operationId, snapshot: result });
        dispatch({ type: 'command_succeeded', command: action });
        pending.current.delete(commandKey);
        if (action === 'accept' && adapter.current) {
          await connectSnapshot.current(result, operationId, adapter.current);
        }
        return result;
      } catch (cause) {
        if (requestId.current === operationId && input.callId === command!.callId) {
          const error = asError(cause);
          if (isAuthorizationLoss(cause)) await revoke(error.message, operationId, adapter.current);
          else dispatch({ type: 'command_failed', command: action, error: error.message });
        }
        throw cause;
      } finally {
        if (inFlight.current.get(commandKey) === operation) inFlight.current.delete(commandKey);
      }
    })();
    inFlight.current.set(commandKey, operation);
    return operation;
  }, [input.client, input.callId, disposeAdapter, revoke]);
  transitionCurrent.current = transition;

  const refresh = useCallback(async (): Promise<void> => {
    if (!input.client || !input.callId) return;
    const operationId = requestId.current;
    try {
      const value = await input.client.media.getCall(input.callId);
      if (requestId.current !== operationId) return;
      if (isTerminalStatus(value.call.status)) {
        rejoinController.current?.reset();
        await disposeAdapter(adapter.current);
      }
      if (requestId.current !== operationId) return;
      snapshot.current = value;
      dispatch({ type: 'snapshot_loaded', requestId: operationId, snapshot: value });
      if (adapter.current) await connectSnapshot.current(value, operationId, adapter.current);
    } catch (cause) {
      if (requestId.current !== operationId) return;
      const error = asError(cause);
      if (isAuthorizationLoss(cause)) await revoke(error.message, operationId, adapter.current);
      else dispatch({ type: 'command_failed', command: 'load', error: error.message });
    }
  }, [input.client, input.callId, disposeAdapter, revoke]);

  useEffect(() => {
    const operationId = ++requestId.current;
    rejoinController.current?.dispose();
    rejoinController.current = null;
    snapshot.current = null;
    desiredLocal.current = Object.freeze({ microphone: false, camera: false, screen: false, screenAudio: false });
    pending.current.clear();
    inFlight.current.clear();
    moderationKeys.current.clear();
    moderationInFlight.current.clear();
    joinOperation.current = null;
    joinedRequest.current = 0;
    lastPlacement.current = null;
    dispatch({ type: 'call_selected', requestId: operationId, callId: input.callId });
    if (!input.client || !input.callId || !input.identity) return;
    let active = true;
    let adapterEpoch = 0;
    let connectionRevision = 1;
    let connectionEventSequence = 0;
    let reportQueue: Promise<void> = Promise.resolve();
    let controller!: MediaRejoinController;

    const reportConnection = (
      eventType: IveKitMediaConnectionEventType,
      revision: number,
      reasonCode = ''
    ): void => {
      const reporter = input.client!.media.reportCallConnectionEvent;
      if (typeof reporter !== 'function') return;
      let seed: string;
      try { seed = randomId.current(); } catch { seed = `event-${Date.now()}`; }
      const eventId = `${seed.slice(0, 112)}.${++connectionEventSequence}`.slice(0, 128);
      const event = {
        participant_identity: input.identity,
        event_id: eventId,
        connection_revision: revision,
        event_type: eventType,
        ...(reasonCode ? { reason_code: reasonCode } : {}),
        occurred_at: new Date().toISOString()
      };
      reportQueue = reportQueue
        .then(async () => {
          if (!active || requestId.current !== operationId) return;
          await reporter(input.callId, event);
        })
        .catch(() => undefined);
    };

    const syncConnectionRevision = (value: IveKitMediaCallSnapshot): void => {
      const participant = value.participants.find((item) => item.identity === input.identity);
      const stored = Number(participant?.connection_revision || 1);
      if (Number.isSafeInteger(stored) && stored > connectionRevision) connectionRevision = stored;
    };

    const createRoom = (): LiveKitRoomAdapter => {
      const epoch = ++adapterEpoch;
      let terminalHandled = false;
      let room!: LiveKitRoomAdapter;
      room = adapterFactory.current((rawEvent) => {
        if (!active || !isCurrent(operationId, room, requestId, adapter)) return;
        const event = withAdapterGeneration(rawEvent, epoch);
        dispatch({ type: 'adapter_event', generation: epoch, event });
        if (event.type === 'native_reconnect') {
          reportConnection(
            event.phase === 'started' ? 'reconnecting' : 'reconnected',
            connectionRevision,
            'native_transport'
          );
        } else if (event.type === 'terminal_disconnect' && !terminalHandled) {
          terminalHandled = true;
          desiredLocal.current = Object.freeze({
            ...desiredLocal.current,
            screen: false,
            screenAudio: false
          });
          reportConnection('disconnected', connectionRevision, event.reason_code);
          controller.request();
        }
        if (event.type === 'state' && event.state === 'connected' &&
            snapshot.current?.call.status === 'accepted' &&
            snapshot.current.participants.some((participant) =>
              participant.identity === input.identity && participant.role === 'host' && participant.status !== 'removed'
            )) {
          void transitionCurrent.current('activate').catch(() => undefined);
        }
      });
      adapter.current = room;
      return room;
    };

    const rejoin = async (): Promise<'succeeded' | 'retry' | 'stopped'> => {
      if (!active || requestId.current !== operationId) return 'stopped';
      const previousRoom = adapter.current;
      let attemptRevision: number | null = null;
      try {
        const value = await input.client!.media.getCall(input.callId);
        if (!active || requestId.current !== operationId || adapter.current !== previousRoom) return 'stopped';
        syncConnectionRevision(value);
        if (isTerminalStatus(value.call.status)) {
          snapshot.current = value;
          dispatch({ type: 'snapshot_loaded', requestId: operationId, snapshot: value });
          if (adapter.current === previousRoom) adapter.current = null;
          await disposeAdapter(previousRoom);
          return 'stopped';
        }
        snapshot.current = value;
        dispatch({ type: 'snapshot_loaded', requestId: operationId, snapshot: value });
        attemptRevision = ++connectionRevision;
        dispatch({ type: 'rejoin_started' });
        reportConnection('rejoining', attemptRevision, 'terminal_rejoin');

        if (adapter.current !== previousRoom) return 'stopped';
        adapter.current = null;
        await disposeAdapter(previousRoom);
        if (!active || requestId.current !== operationId || adapter.current !== null) return 'stopped';
        const nextRoom = createRoom();
        const plan = await input.client!.media.createCallJoinPlan(input.callId, {
          identity: input.identity,
          ...(input.displayName ? { display_name: input.displayName } : {}),
          ...(lastPlacement.current
            ? { recovery: lastPlacement.current }
            : {})
        });
        lastPlacement.current = placementRecoveryIdentity(plan);
        if (!active || !isCurrent(operationId, nextRoom, requestId, adapter)) {
          await disposeAdapter(nextRoom);
          return 'stopped';
        }
        await nextRoom.connect(plan);
        if (!active || !isCurrent(operationId, nextRoom, requestId, adapter)) {
          await disposeAdapter(nextRoom);
          return 'stopped';
        }
        joinedRequest.current = operationId;
        await restoreDesiredLocalMedia(nextRoom, desiredLocal, dispatch);
        reportConnection('rejoined', attemptRevision, 'fresh_join_plan');
        dispatch({ type: 'command_succeeded', command: 'join' });
        return 'succeeded';
      } catch (cause) {
        if (!active || requestId.current !== operationId) return 'stopped';
        const error = asError(cause);
        if (attemptRevision !== null) reportConnection('failed', attemptRevision, 'rejoin_failed');
        if (isAuthorizationLoss(cause)) {
          await revoke(error.message, operationId, adapter.current);
          return 'stopped';
        }
        const failedRoom = adapter.current;
        if (adapter.current === failedRoom) adapter.current = null;
        await disposeAdapter(failedRoom);
        dispatch({ type: 'rejoin_retry' });
        return 'retry';
      }
    };

    controller = new MediaRejoinController({
      run: rejoin,
      onExhausted: () => {
        if (active && requestId.current === operationId) {
          dispatch({ type: 'rejoin_exhausted', reason: 'Media connection could not be restored' });
        }
      },
      ...(rejoinDelaysMs.current ? { delaysMs: rejoinDelaysMs.current } : {}),
      ...(rejoinScheduler.current ? { scheduler: rejoinScheduler.current } : {})
    });
    controller.setOnline(typeof navigator === 'undefined' || navigator.onLine !== false);
    controller.setVisible(typeof document === 'undefined' || document.visibilityState !== 'hidden');
    rejoinController.current = controller;
    connectionEstablished.current = (connectedOperationId, connectedRoom) => {
      if (active && isCurrent(connectedOperationId, connectedRoom, requestId, adapter)) {
        reportConnection('connected', connectionRevision, 'initial_join');
      }
    };
    const room = createRoom();

    void (async () => {
      try {
        const value = await input.client!.media.getCall(input.callId);
        if (!active || !isCurrent(operationId, room, requestId, adapter)) return;
        syncConnectionRevision(value);
        if (isTerminalStatus(value.call.status)) {
          controller.reset();
          if (adapter.current === room) adapter.current = null;
          await disposeAdapter(room);
        }
        if (!active || requestId.current !== operationId) return;
        snapshot.current = value;
        dispatch({ type: 'snapshot_loaded', requestId: operationId, snapshot: value });
        await connectSnapshot.current(value, operationId, room);
      } catch (cause) {
        if (!active || requestId.current !== operationId) return;
        const error = asError(cause);
        if (isAuthorizationLoss(cause)) await revoke(error.message, operationId, room);
        else dispatch({ type: 'command_failed', command: 'load', error: error.message });
      }
    })();

    return () => {
      active = false;
      controller.dispose();
      if (rejoinController.current === controller) rejoinController.current = null;
      connectionEstablished.current = () => undefined;
      if (requestId.current === operationId) requestId.current += 1;
      if (adapter.current === room) adapter.current = null;
      void disposeAdapter(room);
    };
  }, [input.client, input.callId, input.identity, disposeAdapter, revoke]);

  useEffect(() => {
    if (!input.callId) return;
    const offline = () => {
      rejoinController.current?.setOnline(false);
      dispatch({ type: 'network_changed', online: false });
    };
    const online = () => {
      rejoinController.current?.setOnline(true);
      dispatch({ type: 'network_changed', online: true });
      void refresh();
    };
    const visibility = () => {
      rejoinController.current?.setVisible(document.visibilityState !== 'hidden');
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [input.callId, refresh]);

  useEffect(() => {
    if (!input.websocketUrl || !input.accessToken || !input.callId) return;
    const operationId = requestId.current;
    const socket = openAuthenticatedWebSocket(input.websocketUrl, input.accessToken);
    socket.onmessage = (message) => {
      if (requestId.current !== operationId) return;
      try {
        const envelope = JSON.parse(String(message.data)) as { type?: string; data?: { call_id?: string } };
        if (envelope.data?.call_id !== input.callId) return;
        if (envelope.type?.startsWith('ivekit.media.recording.')) dispatch({ type: 'recording_invalidated' });
        else if (envelope.type?.startsWith('ivekit.media.')) void refresh();
      } catch { /* malformed event */ }
    };
    return () => socket.close();
  }, [input.websocketUrl, input.accessToken, input.callId, refresh]);

  const retry = useCallback((command: IveKitMediaCallAction) => {
    const saved = pending.current.get(`${input.callId}:${command}`);
    if (!saved) return Promise.reject(new Error(`Media command ${command} has no retryable attempt`));
    return transition(saved.action, saved.reason);
  }, [input.callId, transition]);

  const adapterCommand = useCallback(async (
    command: string,
    execute: (room: LiveKitRoomAdapter) => Promise<void>,
    local?: Partial<MediaLocalState>
  ): Promise<void> => {
    const room = adapter.current;
    if (!room) throw new Error('LiveKit room is not ready');
    const operationId = requestId.current;
    dispatch({ type: 'command_started', command });
    try {
      await execute(room);
      if (requestId.current !== operationId || adapter.current !== room) return;
      if (local) {
        desiredLocal.current = Object.freeze({ ...desiredLocal.current, ...local });
        dispatch({ type: 'local_changed', local });
      }
      dispatch({ type: 'command_succeeded', command });
    } catch (cause) {
      if (requestId.current === operationId && adapter.current === room) {
        dispatch({ type: 'command_failed', command, error: asError(cause).message });
      }
      throw cause;
    }
  }, []);

  const moderate = useCallback((
    action: 'mute' | 'remove',
    identity: string,
    track?: import('./types.js').MediaTrackHandle,
    reason?: string
  ): Promise<IveKitMediaModerationResult> => {
    const call = snapshot.current?.call;
    if (!input.client || !call || call.id !== input.callId) return Promise.reject(new Error('Media call is not ready'));
    const me = snapshot.current?.participants.find((participant) => participant.identity === input.identity);
    if (me?.role !== 'host') return Promise.reject(new Error('Host role is required'));
    if (action === 'mute' && (!track || track.source === 'unknown')) return Promise.reject(new Error('Published media track is required'));
    const command = `${action}:${identity}:${track?.id || ''}`;
    const operationKey = `${call.id}:${command}`;
    const existing = moderationInFlight.current.get(operationKey);
    if (existing) return existing;
    const key = moderationKeys.current.get(operationKey) || randomId.current();
    moderationKeys.current.set(operationKey, key);
    const operationId = requestId.current;
    dispatch({ type: 'command_started', command });
    let operation!: Promise<IveKitMediaModerationResult>;
    operation = (async () => {
      try {
        const result = action === 'mute'
          ? await input.client!.media.muteParticipant(call.room_name, identity, {
              track_sid: track!.id,
              source: track!.source as 'camera' | 'microphone' | 'screen_share' | 'screen_share_audio',
              muted: true
            }, { idempotencyKey: key })
          : await input.client!.media.removeParticipant(call.room_name, identity, { ...(reason ? { reason } : {}) }, { idempotencyKey: key });
        if (requestId.current !== operationId || snapshot.current?.call.id !== call.id) return result;
        moderationKeys.current.delete(operationKey);
        if (action === 'mute' && track) dispatch({ type: 'track_mute_confirmed', trackId: track.id, muted: true });
        dispatch({ type: 'command_succeeded', command });
        await refresh();
        return result;
      } catch (cause) {
        if (requestId.current === operationId && snapshot.current?.call.id === call.id) {
          const error = asError(cause);
          if (isSessionRevocation(cause)) await revoke(error.message, operationId, adapter.current);
          else dispatch({ type: 'command_failed', command, error: error.message });
        }
        throw cause;
      } finally {
        if (moderationInFlight.current.get(operationKey) === operation) moderationInFlight.current.delete(operationKey);
      }
    })();
    moderationInFlight.current.set(operationKey, operation);
    return operation;
  }, [input.client, input.callId, input.identity, refresh, revoke]);

  return {
    state,
    refresh,
    transition,
    retry,
    setMicrophone: (enabled) => adapterCommand('microphone', (room) => room.setMicrophone(enabled), { microphone: enabled }),
    setCamera: (enabled) => adapterCommand('camera', (room) => room.setCamera(enabled), { camera: enabled }),
    setScreenShare: (enabled, options) => adapterCommand(
      'screen',
      (room) => room.setScreenShare(enabled, options),
      { screen: enabled, screenAudio: enabled && Boolean(options?.audio) }
    ),
    switchDevice: (kind, deviceId) => adapterCommand(`device:${kind}`, (room) => room.switchDevice(kind, deviceId)),
    startAudio: async () => {
      await adapterCommand('start_audio', (room) => room.startAudio());
      dispatch({ type: 'audio_started' });
    },
    muteParticipant: (identity, track) => moderate('mute', identity, track),
    removeParticipant: (identity, reason) => moderate('remove', identity, undefined, reason),
    setLayout: (layout) => dispatch({ type: 'layout_changed', layout }),
    dismissScreenShareRecovery: () => dispatch({ type: 'screen_share_recovery_cleared' })
  };
}

function placementRecoveryIdentity(
  plan: IveKitMediaJoinPlan
): IveKitMediaJoinInput['recovery'] | null {
  if (plan.mode !== 'webrtc') return null;
  const placement = plan.token.placement;
  if (!placement ||
      !/^(?:0|[1-9][0-9]{0,19})$/.test(placement.owner_epoch) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(placement.reservation_id)) {
    return null;
  }
  return Object.freeze({
    previous_owner_epoch: placement.owner_epoch,
    previous_reservation_id: placement.reservation_id
  });
}

function defaultAdapterFactory(onEvent: (event: MediaAdapterEvent) => void): LiveKitRoomAdapter {
  return new LiveKitClientAdapter({ onEvent });
}

function defaultRandomId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return `ivekit-${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  }
  throw new Error('Web Crypto is required for media command idempotency');
}

function isCurrent(
  operationId: number,
  room: LiveKitRoomAdapter,
  requestId: { current: number },
  adapter: { current: LiveKitRoomAdapter | null }
): boolean {
  return requestId.current === operationId && adapter.current === room;
}

function withAdapterGeneration(event: MediaAdapterEvent, generation: number): MediaAdapterEvent {
  return Object.freeze({ ...event, generation }) as MediaAdapterEvent;
}

async function restoreDesiredLocalMedia(
  room: LiveKitRoomAdapter,
  desired: { current: MediaLocalState },
  dispatch: (action: import('./media-reducer.js').MediaAction) => void
): Promise<void> {
  const restore = desired.current;
  if (restore.microphone) {
    try {
      await room.setMicrophone(true);
    } catch (cause) {
      desired.current = Object.freeze({ ...desired.current, microphone: false });
      dispatch({ type: 'local_changed', local: { microphone: false } });
      dispatch({ type: 'command_failed', command: 'microphone', error: asError(cause).message });
    }
  }
  if (restore.camera) {
    try {
      await room.setCamera(true);
    } catch (cause) {
      desired.current = Object.freeze({ ...desired.current, camera: false });
      dispatch({ type: 'local_changed', local: { camera: false } });
      dispatch({ type: 'command_failed', command: 'camera', error: asError(cause).message });
    }
  }
}

function isAuthorizationLoss(cause: unknown): boolean {
  const status = Number((cause as { status?: unknown })?.status || 0);
  return status === 401 || status === 403 || status === 404;
}

function isSessionRevocation(cause: unknown): boolean {
  const status = Number((cause as { status?: unknown })?.status || 0);
  return status === 401 || status === 404;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
