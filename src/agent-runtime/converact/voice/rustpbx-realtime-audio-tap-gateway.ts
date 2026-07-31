import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute } from 'node:path';

import type {
  RealtimeAudioTapTokenCodec,
  RealtimeAudioTapTokenTrack,
  VerifiedRealtimeAudioTapTokenClaims
} from './realtime-audio-tap-token.js';
import type { PolicyRealtimeSpeechRouter } from './realtime-speech-routing.js';
import type {
  RealtimeAudioFrame,
  RealtimeSpeechTranslationEvent,
  RealtimeSpeechTranslationSession
} from './realtime-speech-translation.js';
import {
  RustPbxAudioTapFrameDecoder,
  type RustPbxAudioTapMessage,
  type RustPbxAudioTapPcm
} from './rustpbx-audio-tap-protocol.js';

export type RustPbxRealtimeAudioTapGatewayEventType =
  | 'tap.connection.accepted'
  | 'tap.connection.rejected'
  | 'tap.audio.dropped'
  | 'tap.session.started'
  | 'tap.session.failed'
  | 'tap.session.ended'
  | 'tap.provider_event.dropped'
  | 'tap.projection.failed'
  | 'tap.gateway.error';

export interface RustPbxRealtimeAudioTapGatewayEvent {
  type: RustPbxRealtimeAudioTapGatewayEventType;
  occurred_at: string;
  connection_id: string;
  tenant_id?: string;
  media_session_id?: string;
  leg?: 'caller' | 'callee';
  reason?: string;
  dropped_duration_ms?: number;
  selected_profile_id?: string;
}

export interface RealtimeAudioTapNonceStore {
  claim(nonce: string, retainUntilEpochSeconds: number): boolean;
}

export interface RustPbxRealtimeSpeechEventContext {
  tenant_id: string;
  interaction_id: string;
  media_session_id: string;
  media_source: 'rustpbx';
  participant_id: string;
  track_id: string;
  purpose: 'live_captions' | 'live_translation';
  consent_ref: string;
  provider_profile_id: string;
  provider: string;
  provider_version: string;
  audience_user_ids: string[];
}

export interface RustPbxRealtimeAudioTapGatewayOptions {
  socket_path: string;
  token_codec: RealtimeAudioTapTokenCodec;
  router: PolicyRealtimeSpeechRouter;
  nonce_store?: RealtimeAudioTapNonceStore;
  max_connections?: number;
  max_prestart_audio_ms?: number;
  idle_timeout_ms?: number;
  shutdown_timeout_ms?: number;
  on_event?: (event: RustPbxRealtimeAudioTapGatewayEvent) => void | Promise<void>;
  on_translation_event?: (
    context: RustPbxRealtimeSpeechEventContext,
    event: RealtimeSpeechTranslationEvent
  ) => void | Promise<void>;
  now?: () => Date;
}

interface NormalizedGatewayOptions {
  socket_path: string;
  token_codec: RealtimeAudioTapTokenCodec;
  router: PolicyRealtimeSpeechRouter;
  nonce_store: RealtimeAudioTapNonceStore;
  max_connections: number;
  max_prestart_audio_ms: number;
  idle_timeout_ms: number;
  shutdown_timeout_ms: number;
  on_event?: (event: RustPbxRealtimeAudioTapGatewayEvent) => void | Promise<void>;
  on_translation_event: (
    context: RustPbxRealtimeSpeechEventContext,
    event: RealtimeSpeechTranslationEvent
  ) => void | Promise<void>;
  now: () => Date;
}

interface LegState {
  readonly track: RealtimeAudioTapTokenTrack;
  readonly pending: RealtimeAudioFrame[];
  pending_duration_ms: number;
  last_sequence: number;
  starting: boolean;
  failed: boolean;
  ended: boolean;
  session_shutdown: boolean;
  provider_events: RealtimeSpeechTranslationEvent[];
  start_promise?: Promise<void>;
  session?: RealtimeSpeechTranslationSession;
  event_context?: RustPbxRealtimeSpeechEventContext;
}

export class InMemoryRealtimeAudioTapNonceStore implements RealtimeAudioTapNonceStore {
  readonly #claims = new Map<string, number>();

  constructor(
    private readonly options: {
      now?: () => Date;
      max_entries?: number;
    } = {}
  ) {}

  claim(nonce: string, retainUntilEpochSeconds: number): boolean {
    const now = Math.floor((this.options.now?.() ?? new Date()).getTime() / 1_000);
    for (const [key, expiresAt] of this.#claims) {
      if (expiresAt <= now) this.#claims.delete(key);
    }
    if (this.#claims.has(nonce)) return false;
    const maxEntries = boundedInteger(
      this.options.max_entries ?? 262_144,
      1,
      2_000_000,
      'audio_tap_nonce_capacity_invalid'
    );
    if (this.#claims.size >= maxEntries) return false;
    this.#claims.set(nonce, Math.max(retainUntilEpochSeconds, now + 300));
    return true;
  }
}

export class RustPbxRealtimeAudioTapGateway {
  readonly #options: NormalizedGatewayOptions;
  readonly #connections = new Set<RustPbxRealtimeAudioTapConnection>();
  #server: Server | null = null;
  #startPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(options: RustPbxRealtimeAudioTapGatewayOptions) {
    this.#options = normalizeOptions(options);
  }

  start(): Promise<void> {
    if (this.#closePromise) return Promise.reject(new Error('audio_tap_gateway_closed'));
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #start(): Promise<void> {
    await mkdir(dirname(this.#options.socket_path), {
      recursive: true,
      mode: 0o750
    });
    await removeStaleSocket(this.#options.socket_path);
    const server = createServer((socket) => {
      if (this.#connections.size >= this.#options.max_connections) {
        emitGatewayEvent(this.#options, {
          type: 'tap.connection.rejected',
          occurred_at: this.#options.now().toISOString(),
          connection_id: randomUUID(),
          reason: 'connection_capacity_exhausted'
        });
        socket.destroy();
        return;
      }
      const connection = new RustPbxRealtimeAudioTapConnection(
        socket,
        this.#options,
        (closed) => this.#connections.delete(closed)
      );
      this.#connections.add(connection);
      connection.start();
    });
    server.maxConnections = this.#options.max_connections;
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.#options.socket_path);
    });
    server.on('error', (error) => {
      emitGatewayEvent(this.#options, {
        type: 'tap.gateway.error',
        occurred_at: this.#options.now().toISOString(),
        connection_id: '',
        reason: safeReason(error)
      });
    });
    await chmod(this.#options.socket_path, 0o660);
  }

  async #close(): Promise<void> {
    await this.#startPromise?.catch(() => undefined);
    const server = this.#server;
    this.#server = null;
    const serverClosed = server
      ? new Promise<void>((resolve) => server.close(() => resolve()))
      : Promise.resolve();
    const closing = [...this.#connections].map((connection) =>
      connection.close('gateway_shutdown')
    );
    await Promise.allSettled(closing);
    await settleWithin(serverClosed, this.#options.shutdown_timeout_ms);
    await removeStaleSocket(this.#options.socket_path);
  }
}

class RustPbxRealtimeAudioTapConnection {
  readonly #connectionId = randomUUID();
  readonly #decoder = new RustPbxAudioTapFrameDecoder();
  readonly #legs = new Map<'caller' | 'callee', LegState>();
  #claims: VerifiedRealtimeAudioTapTokenClaims | null = null;
  #sessionKey: Buffer | null = null;
  #ending = false;
  #finishPromise: Promise<void> | null = null;

  constructor(
    private readonly socket: Socket,
    private readonly options: NormalizedGatewayOptions,
    private readonly onClosed: (connection: RustPbxRealtimeAudioTapConnection) => void
  ) {}

  start(): void {
    this.socket.setNoDelay(true);
    this.socket.setTimeout(this.options.idle_timeout_ms);
    this.socket.on('data', (chunk) => this.#consume(chunk));
    this.socket.on('timeout', () => this.#reject('connection_idle_timeout'));
    this.socket.on('error', () => {
      void this.#finish('transport_error');
    });
    this.socket.on('end', () => {
      void this.#finish('transport_closed');
    });
    this.socket.on('close', () => {
      void this.#finish('transport_closed');
    });
  }

  close(reason: string): Promise<void> {
    this.socket.destroy();
    return this.#finish(reason);
  }

  #consume(chunk: Buffer): void {
    if (this.#ending) return;
    try {
      for (const message of this.#decoder.push(chunk)) this.#message(message);
    } catch (error) {
      this.#reject(safeReason(error));
    }
  }

  #message(message: RustPbxAudioTapMessage): void {
    if (message.type === 'start') {
      if (this.#claims) throw new Error('protocol_start_repeated');
      const claims = this.options.token_codec.verify(message.authorization, {
        expected_media_session_id: message.session_id
      });
      if (!this.options.nonce_store.claim(claims.nonce, claims.expires_at)) {
        throw new Error('token_replayed');
      }
      this.#claims = claims;
      this.#sessionKey = Buffer.from(message.session_key);
      this.#emit('tap.connection.accepted');
      return;
    }
    if (!this.#claims || !this.#sessionKey) throw new Error('protocol_start_required');
    if (!this.#sessionKey.equals(Buffer.from(message.session_key))) {
      throw new Error('session_key_mismatch');
    }
    if (message.type === 'pcm') {
      this.#audio(message);
      return;
    }
    if (message.session_id !== this.#claims.media_session_id) {
      throw new Error('token_session_mismatch');
    }
    this.socket.end();
    void this.#finish(message.reason);
  }

  #audio(message: RustPbxAudioTapPcm): void {
    if (this.#ending || !this.#claims) return;
    const track = this.#claims.tracks.find((candidate) => candidate.leg === message.leg);
    if (!track) {
      this.#emit('tap.audio.dropped', {
        leg: message.leg,
        reason: 'leg_not_authorized',
        dropped_duration_ms: message.duration_ms
      });
      return;
    }
    let state = this.#legs.get(message.leg);
    if (!state) {
      state = {
        track,
        pending: [],
        pending_duration_ms: 0,
        last_sequence: -1,
        starting: false,
        failed: false,
        ended: false,
        session_shutdown: false,
        provider_events: []
      };
      this.#legs.set(message.leg, state);
    }
    if (message.sequence <= state.last_sequence) throw new Error('audio_sequence_conflict');
    state.last_sequence = message.sequence;
    const frame = realtimeFrame(message);
    if (!frame) {
      this.#emit('tap.audio.dropped', {
        leg: message.leg,
        reason: 'audio_duration_invalid',
        dropped_duration_ms: message.duration_ms
      });
      return;
    }
    if (state.session) {
      this.#dispatch(state, frame);
      return;
    }
    if (state.failed || state.ended) {
      this.#emit('tap.audio.dropped', {
        leg: message.leg,
        reason: state.failed ? 'provider_session_failed' : 'provider_session_closed',
        dropped_duration_ms: frame.duration_ms
      });
      return;
    }
    this.#enqueue(state, frame);
    if (!state.starting) {
      state.starting = true;
      state.start_promise = this.#startProviderSession(message.leg, state);
    }
  }

  #enqueue(state: LegState, frame: RealtimeAudioFrame): void {
    state.pending.push(frame);
    state.pending_duration_ms += frame.duration_ms;
    while (state.pending_duration_ms > this.options.max_prestart_audio_ms) {
      const dropped = state.pending.shift();
      if (!dropped) break;
      state.pending_duration_ms -= dropped.duration_ms;
      this.#emit('tap.audio.dropped', {
        leg: state.track.leg,
        reason: 'provider_start_buffer_overflow',
        dropped_duration_ms: dropped.duration_ms
      });
    }
  }

  async #startProviderSession(
    leg: 'caller' | 'callee',
    state: LegState
  ): Promise<void> {
    const claims = this.#claims;
    if (!claims) return;
    try {
      const route = await this.options.router.startSession({
        tenant_id: claims.tenant_id,
        interaction_id: claims.interaction_id,
        media_session_id: claims.media_session_id,
        media_source: 'rustpbx',
        participant_id: state.track.participant_id,
        track_id: state.track.track_id,
        purpose: claims.purpose,
        source_language: claims.source_language,
        target_languages: [...claims.target_languages],
        features: [...claims.features],
        audio_format: {
          encoding: 'pcm_s16le',
          sample_rate_hz: 16_000,
          channels: 1
        },
        consent_ref: claims.consent_ref,
        idempotency_key: `tap:${claims.nonce}:${leg}:start`
      }, (event) => this.#translationEvent(state, event));
      state.session = route.session;
      state.event_context = {
        tenant_id: claims.tenant_id,
        interaction_id: claims.interaction_id,
        media_session_id: claims.media_session_id,
        media_source: 'rustpbx',
        participant_id: state.track.participant_id,
        track_id: state.track.track_id,
        purpose: claims.purpose,
        consent_ref: claims.consent_ref,
        provider_profile_id: route.selected_profile_id,
        provider: route.session.plan.provider,
        provider_version: route.session.plan.provider_version,
        audience_user_ids: claims.tracks.map((track) => track.participant_id)
      };
      for (const event of state.provider_events.splice(0)) {
        this.#publishTranslationEvent(state, event);
      }
      this.#emit('tap.session.started', {
        leg,
        selected_profile_id: route.selected_profile_id
      });
      if (this.#ending || state.ended) {
        await this.#shutdownSession(state, 'source_closed');
        return;
      }
      for (const frame of state.pending.splice(0)) this.#dispatch(state, frame);
      state.pending_duration_ms = 0;
    } catch (error) {
      state.failed = true;
      state.pending.length = 0;
      state.pending_duration_ms = 0;
      state.provider_events.length = 0;
      this.#emit('tap.session.failed', {
        leg,
        reason: safeReason(error)
      });
    }
  }

  #dispatch(state: LegState, frame: RealtimeAudioFrame): void {
    if (!state.session || state.failed || state.ended) return;
    try {
      const result = state.session.tryWriteAudio(frame);
      if (result === 'accepted') return;
      this.#emit('tap.audio.dropped', {
        leg: state.track.leg,
        reason: result === 'closed' ? 'provider_session_closed' : 'provider_queue_overflow',
        dropped_duration_ms: frame.duration_ms
      });
      if (result === 'closed') state.ended = true;
    } catch (error) {
      state.failed = true;
      this.#emit('tap.session.failed', {
        leg: state.track.leg,
        reason: safeReason(error)
      });
      void this.#shutdownSession(state, 'provider_write_failed');
    }
  }

  #translationEvent(state: LegState, event: RealtimeSpeechTranslationEvent): void {
    if (!state.event_context) {
      if (state.provider_events.length >= 256) {
        state.provider_events.shift();
        this.#emit('tap.provider_event.dropped', {
          leg: state.track.leg,
          reason: 'provider_start_event_overflow'
        });
      }
      state.provider_events.push(event);
      return;
    }
    this.#publishTranslationEvent(state, event);
  }

  #publishTranslationEvent(
    state: LegState,
    event: RealtimeSpeechTranslationEvent
  ): void {
    if (!state.event_context) return;
    try {
      const result = this.options.on_translation_event(state.event_context, event);
      if (result && typeof result.then === 'function') {
        void result.catch((error) => this.#emit('tap.projection.failed', {
          leg: state.track.leg,
          reason: safeReason(error)
        }));
      }
    } catch (error) {
      this.#emit('tap.projection.failed', {
        leg: state.track.leg,
        reason: safeReason(error)
      });
    }
  }

  #reject(reason: string): void {
    if (this.#ending) return;
    this.#emit('tap.connection.rejected', { reason });
    this.socket.destroy();
    void this.#finish(reason);
  }

  #finish(reason: string): Promise<void> {
    if (this.#finishPromise) return this.#finishPromise;
    this.#ending = true;
    this.#finishPromise = Promise.allSettled(
      [...this.#legs.values()].map((state) => this.#closeLeg(state, reason))
    ).then(() => {
      this.#emit('tap.session.ended', { reason });
      this.onClosed(this);
    });
    return this.#finishPromise;
  }

  async #closeLeg(state: LegState, reason: string): Promise<void> {
    state.ended = true;
    state.pending.length = 0;
    state.pending_duration_ms = 0;
    state.provider_events.length = 0;
    if (state.start_promise) {
      await settleWithin(state.start_promise, this.options.shutdown_timeout_ms);
    }
    await this.#shutdownSession(state, reason);
  }

  async #shutdownSession(state: LegState, reason: string): Promise<void> {
    if (!state.session || state.session_shutdown) return;
    state.session_shutdown = true;
    await settleWithin(
      state.session.end({
        reason,
        idempotency_key: `tap:${this.#claims?.nonce || 'unknown'}:${state.track.leg}:end`
      }),
      this.options.shutdown_timeout_ms
    );
    await settleWithin(state.session.close(), this.options.shutdown_timeout_ms);
  }

  #emit(
    type: RustPbxRealtimeAudioTapGatewayEventType,
    detail: Partial<RustPbxRealtimeAudioTapGatewayEvent> = {}
  ): void {
    emitGatewayEvent(this.options, {
      type,
      occurred_at: this.options.now().toISOString(),
      connection_id: this.#connectionId,
      ...(this.#claims ? {
        tenant_id: this.#claims.tenant_id,
        media_session_id: this.#claims.media_session_id
      } : {}),
      ...detail
    });
  }
}

function normalizeOptions(
  options: RustPbxRealtimeAudioTapGatewayOptions
): NormalizedGatewayOptions {
  if (!options || typeof options !== 'object') throw new Error('audio_tap_options_invalid');
  const socketPath = String(options.socket_path || '');
  if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100 || socketPath.includes('\0')) {
    throw new Error('audio_tap_socket_path_invalid');
  }
  if (!options.token_codec || !options.router) throw new Error('audio_tap_options_invalid');
  return {
    socket_path: socketPath,
    token_codec: options.token_codec,
    router: options.router,
    nonce_store: options.nonce_store ?? new InMemoryRealtimeAudioTapNonceStore({
      now: options.now
    }),
    max_connections: boundedInteger(
      options.max_connections ?? 4_096,
      1,
      100_000,
      'audio_tap_connection_limit_invalid'
    ),
    max_prestart_audio_ms: boundedInteger(
      options.max_prestart_audio_ms ?? 1_000,
      20,
      5_000,
      'audio_tap_prestart_buffer_invalid'
    ),
    idle_timeout_ms: boundedInteger(
      options.idle_timeout_ms ?? 60_000,
      1_000,
      300_000,
      'audio_tap_idle_timeout_invalid'
    ),
    shutdown_timeout_ms: boundedInteger(
      options.shutdown_timeout_ms ?? 1_000,
      100,
      30_000,
      'audio_tap_shutdown_timeout_invalid'
    ),
    on_event: options.on_event,
    on_translation_event: options.on_translation_event ?? (() => undefined),
    now: options.now ?? (() => new Date())
  };
}

function realtimeFrame(message: RustPbxAudioTapPcm): RealtimeAudioFrame | null {
  if (!Number.isInteger(message.duration_ms)
    || message.duration_ms < 10
    || message.duration_ms > 1_000) return null;
  const capturedAt = new Date(message.received_at_micros / 1_000);
  if (!Number.isFinite(capturedAt.getTime())) return null;
  return {
    sequence: message.sequence,
    captured_at: capturedAt.toISOString(),
    duration_ms: message.duration_ms,
    audio: message.audio
  };
}

function emitGatewayEvent(
  options: NormalizedGatewayOptions,
  event: RustPbxRealtimeAudioTapGatewayEvent
): void {
  try {
    const result = options.on_event?.(Object.freeze({ ...event }));
    if (result && typeof result.then === 'function') void result.catch(() => undefined);
  } catch {
    // Observability failure must never affect media or Provider forwarding.
  }
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isSocket()) throw new Error('audio_tap_socket_path_occupied');
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  code: string
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(code);
  }
  return number;
}

function safeReason(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error || 'unknown_error');
  const safe = value.replace(/[^A-Za-z0-9_.:@/-]/g, '_').slice(0, 128);
  return safe || 'unknown_error';
}
