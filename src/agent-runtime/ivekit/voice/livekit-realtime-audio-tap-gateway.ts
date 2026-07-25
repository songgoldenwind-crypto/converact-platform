import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import {
  WebSocket,
  WebSocketServer,
  type RawData
} from 'ws';

import type {
  LiveKitRealtimeAudioTapTokenCodec,
  VerifiedLiveKitRealtimeAudioTapTokenClaims
} from './livekit-realtime-audio-tap-token.js';
import {
  InMemoryRealtimeAudioTapNonceStore,
  type RealtimeAudioTapNonceStore
} from './rustpbx-realtime-audio-tap-gateway.js';
import type { PolicyRealtimeSpeechRouter } from './realtime-speech-routing.js';
import type {
  RealtimeAudioFrame,
  RealtimeSpeechTranslationEvent,
  RealtimeSpeechTranslationSession
} from './realtime-speech-translation.js';

export const LIVEKIT_AUDIO_TAP_PROTOCOL = 'ivekit.livekit-audio-tap.v1';

export type LiveKitRealtimeAudioTapGatewayEventType =
  | 'tap.connection.accepted'
  | 'tap.connection.rejected'
  | 'tap.audio.dropped'
  | 'tap.session.started'
  | 'tap.session.failed'
  | 'tap.session.ended'
  | 'tap.provider_event.dropped'
  | 'tap.projection.failed'
  | 'tap.gateway.error';

export interface LiveKitRealtimeAudioTapGatewayEvent {
  type: LiveKitRealtimeAudioTapGatewayEventType;
  occurred_at: string;
  connection_id: string;
  tenant_id?: string;
  media_session_id?: string;
  participant_id?: string;
  track_id?: string;
  reason?: string;
  dropped_duration_ms?: number;
  selected_profile_id?: string;
}

export interface LiveKitRealtimeSpeechEventContext {
  tenant_id: string;
  interaction_id: string;
  media_session_id: string;
  media_source: 'livekit';
  participant_id: string;
  track_id: string;
  purpose: 'live_captions' | 'live_translation';
  consent_ref: string;
  provider_profile_id: string;
  provider: string;
  provider_version: string;
  audience_user_ids: string[];
}

export interface LiveKitRealtimeAudioTapGatewayOptions {
  listen_host: string;
  listen_port: number;
  path: string;
  token_codec: LiveKitRealtimeAudioTapTokenCodec;
  router: PolicyRealtimeSpeechRouter;
  nonce_store?: RealtimeAudioTapNonceStore;
  max_connections?: number;
  max_prestart_audio_ms?: number;
  max_payload_bytes?: number;
  idle_timeout_ms?: number;
  start_timeout_ms?: number;
  shutdown_timeout_ms?: number;
  on_event?: (
    event: LiveKitRealtimeAudioTapGatewayEvent
  ) => void | Promise<void>;
  on_translation_event?: (
    context: LiveKitRealtimeSpeechEventContext,
    event: RealtimeSpeechTranslationEvent
  ) => void | Promise<void>;
  now?: () => Date;
}

interface NormalizedOptions {
  listen_host: string;
  listen_port: number;
  path: string;
  token_codec: LiveKitRealtimeAudioTapTokenCodec;
  router: PolicyRealtimeSpeechRouter;
  nonce_store: RealtimeAudioTapNonceStore;
  max_connections: number;
  max_prestart_audio_ms: number;
  max_payload_bytes: number;
  idle_timeout_ms: number;
  start_timeout_ms: number;
  shutdown_timeout_ms: number;
  on_event?: (
    event: LiveKitRealtimeAudioTapGatewayEvent
  ) => void | Promise<void>;
  on_translation_event: (
    context: LiveKitRealtimeSpeechEventContext,
    event: RealtimeSpeechTranslationEvent
  ) => void | Promise<void>;
  now: () => Date;
}

interface StartMessage {
  authorization: string;
  media_session_id: string;
  participant_id: string;
  track_id: string;
}

export class LiveKitRealtimeAudioTapGateway {
  readonly #options: NormalizedOptions;
  readonly #connections = new Set<LiveKitRealtimeAudioTapConnection>();
  #server: WebSocketServer | null = null;
  #startPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(options: LiveKitRealtimeAudioTapGatewayOptions) {
    this.#options = normalizeOptions(options);
  }

  start(): Promise<void> {
    if (this.#closePromise) return Promise.reject(new Error('livekit_audio_tap_gateway_closed'));
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  address(): AddressInfo | null {
    const address = this.#server?.address();
    return address && typeof address !== 'string' ? address : null;
  }

  url(): string {
    const address = this.address();
    if (!address) throw new Error('livekit_audio_tap_gateway_not_started');
    const host = this.#options.listen_host === '0.0.0.0'
      ? '127.0.0.1'
      : this.#options.listen_host;
    return `ws://${host}:${address.port}${this.#options.path}`;
  }

  async #start(): Promise<void> {
    const server = new WebSocketServer({
      host: this.#options.listen_host,
      port: this.#options.listen_port,
      path: this.#options.path,
      maxPayload: this.#options.max_payload_bytes,
      perMessageDeflate: false,
      clientTracking: true,
      handleProtocols: (protocols) =>
        protocols.has(LIVEKIT_AUDIO_TAP_PROTOCOL)
          ? LIVEKIT_AUDIO_TAP_PROTOCOL
          : false
    });
    this.#server = server;
    server.on('connection', (socket) => {
      if (this.#connections.size >= this.#options.max_connections) {
        emitGatewayEvent(this.#options, {
          type: 'tap.connection.rejected',
          occurred_at: this.#options.now().toISOString(),
          connection_id: randomUUID(),
          reason: 'connection_capacity_exhausted'
        });
        socket.close(4008, 'connection_capacity_exhausted');
        return;
      }
      const connection = new LiveKitRealtimeAudioTapConnection(
        socket,
        this.#options,
        (closed) => this.#connections.delete(closed)
      );
      this.#connections.add(connection);
      connection.start();
    });
    server.on('error', (error) => {
      emitGatewayEvent(this.#options, {
        type: 'tap.gateway.error',
        occurred_at: this.#options.now().toISOString(),
        connection_id: '',
        reason: safeReason(error)
      });
    });
    await onceListening(server);
  }

  async #close(): Promise<void> {
    await this.#startPromise?.catch(() => undefined);
    const server = this.#server;
    this.#server = null;
    await Promise.allSettled(
      [...this.#connections].map((connection) =>
        connection.close('gateway_shutdown')
      )
    );
    if (!server) return;
    await settleWithin(new Promise<void>((resolve) => {
      server.close(() => resolve());
    }), this.#options.shutdown_timeout_ms);
  }
}

class LiveKitRealtimeAudioTapConnection {
  readonly #connectionId = randomUUID();
  readonly #pending: RealtimeAudioFrame[] = [];
  readonly #providerEvents: RealtimeSpeechTranslationEvent[] = [];
  #pendingDurationMs = 0;
  #lastSequence = -1;
  #claims: VerifiedLiveKitRealtimeAudioTapTokenClaims | null = null;
  #session: RealtimeSpeechTranslationSession | null = null;
  #eventContext: LiveKitRealtimeSpeechEventContext | null = null;
  #startPromise: Promise<void> | null = null;
  #startTimer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #ending = false;
  #failed = false;
  #sessionShutdown = false;
  #finishPromise: Promise<void> | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly options: NormalizedOptions,
    private readonly onClosed: (
      connection: LiveKitRealtimeAudioTapConnection
    ) => void
  ) {}

  start(): void {
    this.#startTimer = setTimeout(() => {
      this.#reject('protocol_start_timeout', 4002);
    }, this.options.start_timeout_ms);
    this.#startTimer.unref?.();
    this.#resetIdleTimer();
    this.socket.on('message', (data, isBinary) => {
      this.#resetIdleTimer();
      this.#message(data, isBinary);
    });
    this.socket.on('error', () => {
      void this.#finish('transport_error');
    });
    this.socket.on('close', (_code, reason) => {
      void this.#finish(safeReason(reason.toString() || 'transport_closed'));
    });
  }

  close(reason: string): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1001, safeReason(reason));
    }
    return this.#finish(reason);
  }

  #message(data: RawData, isBinary: boolean): void {
    if (this.#ending) return;
    try {
      if (!this.#claims) {
        if (isBinary) throw new Error('protocol_start_required');
        this.#startSession(decodeStartMessage(data));
        return;
      }
      if (!isBinary) {
        const reason = decodeEndMessage(data);
        this.socket.close(1000, safeReason(reason));
        void this.#finish(reason);
        return;
      }
      this.#audio(decodePcmFrame(data));
    } catch (error) {
      const reason = safeReason(error);
      const unauthorized = reason.startsWith('token_');
      this.#reject(reason, unauthorized ? 4001 : 4002);
    }
  }

  #startSession(message: StartMessage): void {
    const claims = this.options.token_codec.verify(message.authorization, {
      expected_media_session_id: message.media_session_id,
      expected_participant_id: message.participant_id,
      expected_track_id: message.track_id
    });
    if (!this.options.nonce_store.claim(claims.nonce, claims.expires_at)) {
      throw new Error('token_replayed');
    }
    this.#claims = claims;
    if (this.#startTimer) clearTimeout(this.#startTimer);
    this.#startTimer = null;
    this.#emit('tap.connection.accepted');
  }

  #audio(frame: RealtimeAudioFrame): void {
    if (this.#ending || this.#failed) return;
    if (frame.sequence <= this.#lastSequence) {
      throw new Error('audio_sequence_conflict');
    }
    this.#lastSequence = frame.sequence;
    if (this.#session) {
      this.#dispatch(frame);
      return;
    }
    this.#pending.push(frame);
    this.#pendingDurationMs += frame.duration_ms;
    while (this.#pendingDurationMs > this.options.max_prestart_audio_ms) {
      const dropped = this.#pending.shift();
      if (!dropped) break;
      this.#pendingDurationMs -= dropped.duration_ms;
      this.#emit('tap.audio.dropped', {
        reason: 'provider_start_buffer_overflow',
        dropped_duration_ms: dropped.duration_ms
      });
    }
    if (!this.#startPromise) this.#startPromise = this.#startProviderSession();
  }

  async #startProviderSession(): Promise<void> {
    const claims = this.#claims;
    if (!claims) return;
    try {
      const route = await this.options.router.startSession({
        tenant_id: claims.tenant_id,
        interaction_id: claims.interaction_id,
        media_session_id: claims.media_session_id,
        media_source: 'livekit',
        participant_id: claims.participant_id,
        track_id: claims.track_id,
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
        idempotency_key: `tap:${claims.nonce}:start`
      }, (event) => this.#translationEvent(event));
      this.#session = route.session;
      this.#eventContext = {
        tenant_id: claims.tenant_id,
        interaction_id: claims.interaction_id,
        media_session_id: claims.media_session_id,
        media_source: 'livekit',
        participant_id: claims.participant_id,
        track_id: claims.track_id,
        purpose: claims.purpose,
        consent_ref: claims.consent_ref,
        provider_profile_id: route.selected_profile_id,
        provider: route.session.plan.provider,
        provider_version: route.session.plan.provider_version,
        audience_user_ids: [...claims.audience_user_ids]
      };
      for (const event of this.#providerEvents.splice(0)) {
        this.#publishTranslationEvent(event);
      }
      this.#emit('tap.session.started', {
        selected_profile_id: route.selected_profile_id
      });
      if (this.#ending) {
        await this.#shutdownSession('source_closed');
        return;
      }
      for (const frame of this.#pending.splice(0)) this.#dispatch(frame);
      this.#pendingDurationMs = 0;
    } catch (error) {
      this.#failed = true;
      this.#pending.length = 0;
      this.#pendingDurationMs = 0;
      this.#providerEvents.length = 0;
      this.#emit('tap.session.failed', { reason: safeReason(error) });
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.close(1011, 'provider_session_failed');
      }
      void this.#finish('provider_session_failed');
    }
  }

  #dispatch(frame: RealtimeAudioFrame): void {
    if (!this.#session || this.#failed || this.#ending) return;
    try {
      const result = this.#session.tryWriteAudio(frame);
      if (result === 'accepted') return;
      this.#emit('tap.audio.dropped', {
        reason: result === 'closed'
          ? 'provider_session_closed'
          : 'provider_queue_overflow',
        dropped_duration_ms: frame.duration_ms
      });
      if (result === 'closed') {
        this.#failed = true;
        if (this.socket.readyState === WebSocket.OPEN) {
          this.socket.close(1011, 'provider_session_closed');
        }
      }
    } catch (error) {
      this.#failed = true;
      this.#emit('tap.session.failed', { reason: safeReason(error) });
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.close(1011, 'provider_write_failed');
      }
      void this.#finish('provider_write_failed');
    }
  }

  #translationEvent(event: RealtimeSpeechTranslationEvent): void {
    if (!this.#eventContext) {
      if (this.#providerEvents.length >= 256) {
        this.#providerEvents.shift();
        this.#emit('tap.provider_event.dropped', {
          reason: 'provider_start_event_overflow'
        });
      }
      this.#providerEvents.push(event);
      return;
    }
    this.#publishTranslationEvent(event);
  }

  #publishTranslationEvent(event: RealtimeSpeechTranslationEvent): void {
    const context = this.#eventContext;
    if (!context) return;
    try {
      const result = this.options.on_translation_event(context, event);
      if (result && typeof result.then === 'function') {
        void result.catch((error) => this.#emit('tap.projection.failed', {
          reason: safeReason(error)
        }));
      }
    } catch (error) {
      this.#emit('tap.projection.failed', { reason: safeReason(error) });
    }
  }

  #reject(reason: string, code: number): void {
    if (this.#ending) return;
    this.#emit('tap.connection.rejected', { reason });
    if (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(code, reason);
    }
    void this.#finish(reason);
  }

  #finish(reason: string): Promise<void> {
    if (this.#finishPromise) return this.#finishPromise;
    this.#ending = true;
    this.#clearTimers();
    this.#pending.length = 0;
    this.#pendingDurationMs = 0;
    this.#providerEvents.length = 0;
    this.#finishPromise = (async () => {
      if (this.#startPromise) {
        await settleWithin(
          this.#startPromise,
          this.options.shutdown_timeout_ms
        );
      }
      await this.#shutdownSession(reason);
      this.#emit('tap.session.ended', { reason });
      this.onClosed(this);
    })();
    return this.#finishPromise;
  }

  async #shutdownSession(reason: string): Promise<void> {
    if (!this.#session || this.#sessionShutdown) return;
    this.#sessionShutdown = true;
    await settleWithin(this.#session.end({
      reason,
      idempotency_key: `tap:${this.#claims?.nonce || 'unknown'}:end`
    }), this.options.shutdown_timeout_ms);
    await settleWithin(
      this.#session.close(),
      this.options.shutdown_timeout_ms
    );
  }

  #resetIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#reject('connection_idle_timeout', 4002);
    }, this.options.idle_timeout_ms);
    this.#idleTimer.unref?.();
  }

  #clearTimers(): void {
    if (this.#startTimer) clearTimeout(this.#startTimer);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#startTimer = null;
    this.#idleTimer = null;
  }

  #emit(
    type: LiveKitRealtimeAudioTapGatewayEventType,
    detail: Partial<LiveKitRealtimeAudioTapGatewayEvent> = {}
  ): void {
    emitGatewayEvent(this.options, {
      type,
      occurred_at: this.options.now().toISOString(),
      connection_id: this.#connectionId,
      ...(this.#claims ? {
        tenant_id: this.#claims.tenant_id,
        media_session_id: this.#claims.media_session_id,
        participant_id: this.#claims.participant_id,
        track_id: this.#claims.track_id
      } : {}),
      ...detail
    });
  }
}

function decodeStartMessage(data: RawData): StartMessage {
  const input = jsonRecord(data);
  exactKeys(input, [
    'protocol',
    'event',
    'authorization',
    'media_session_id',
    'participant_id',
    'track_id',
    'audio'
  ]);
  if (input.protocol !== LIVEKIT_AUDIO_TAP_PROTOCOL ||
      input.event !== 'start') {
    throw new Error('protocol_start_invalid');
  }
  const audio = record(input.audio);
  exactKeys(audio, [
    'encoding',
    'sample_rate_hz',
    'channels'
  ]);
  if (audio.encoding !== 'pcm_s16le' ||
      audio.sample_rate_hz !== 16_000 ||
      audio.channels !== 1) {
    throw new Error('audio_format_invalid');
  }
  return {
    authorization: boundedString(input.authorization, 8_192),
    media_session_id: boundedString(input.media_session_id, 256),
    participant_id: boundedString(input.participant_id, 128),
    track_id: boundedString(input.track_id, 256)
  };
}

function decodeEndMessage(data: RawData): string {
  const input = jsonRecord(data);
  exactKeys(input, ['protocol', 'event', 'reason']);
  if (input.protocol !== LIVEKIT_AUDIO_TAP_PROTOCOL || input.event !== 'end') {
    throw new Error('protocol_end_invalid');
  }
  return boundedString(input.reason, 128);
}

function decodePcmFrame(data: RawData): RealtimeAudioFrame {
  const frame = rawDataBuffer(data);
  if (frame.length < 32 ||
      frame.toString('ascii', 0, 4) !== 'LAT1' ||
      frame[4] !== 1 ||
      frame[5] !== 1 ||
      frame[6] !== 1 ||
      frame[7] !== 0) {
    throw new Error('audio_frame_invalid');
  }
  const sequence = frame.readBigUInt64BE(8);
  const capturedAtMicros = frame.readBigUInt64BE(16);
  const sampleRate = frame.readUInt32BE(24);
  const sampleCount = frame.readUInt32BE(28);
  if (sequence > BigInt(Number.MAX_SAFE_INTEGER) ||
      capturedAtMicros > BigInt(Number.MAX_SAFE_INTEGER) ||
      sampleRate !== 16_000 ||
      sampleCount < 160 ||
      sampleCount > 16_000 ||
      frame.length !== 32 + sampleCount * 2) {
    throw new Error('audio_frame_invalid');
  }
  const durationMs = sampleCount / 16;
  if (!Number.isInteger(durationMs) || durationMs < 10 || durationMs > 1_000) {
    throw new Error('audio_duration_invalid');
  }
  const capturedAt = new Date(Number(capturedAtMicros) / 1_000);
  if (!Number.isFinite(capturedAt.getTime())) {
    throw new Error('audio_timestamp_invalid');
  }
  return {
    sequence: Number(sequence),
    captured_at: capturedAt.toISOString(),
    duration_ms: durationMs,
    audio: frame.subarray(32)
  };
}

function normalizeOptions(
  options: LiveKitRealtimeAudioTapGatewayOptions
): NormalizedOptions {
  if (!options || typeof options !== 'object' ||
      !options.token_codec || !options.router) {
    throw new Error('livekit_audio_tap_options_invalid');
  }
  const host = boundedString(options.listen_host, 255);
  if (!/^[A-Za-z0-9.:[\]_-]+$/.test(host)) {
    throw new Error('livekit_audio_tap_host_invalid');
  }
  const path = boundedString(options.path, 512);
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new Error('livekit_audio_tap_path_invalid');
  }
  return {
    listen_host: host,
    listen_port: boundedInteger(
      options.listen_port,
      0,
      65_535,
      'livekit_audio_tap_port_invalid'
    ),
    path,
    token_codec: options.token_codec,
    router: options.router,
    nonce_store: options.nonce_store ??
      new InMemoryRealtimeAudioTapNonceStore({ now: options.now }),
    max_connections: boundedInteger(
      options.max_connections ?? 4_096,
      1,
      100_000,
      'livekit_audio_tap_connection_limit_invalid'
    ),
    max_prestart_audio_ms: boundedInteger(
      options.max_prestart_audio_ms ?? 1_000,
      20,
      5_000,
      'livekit_audio_tap_prestart_buffer_invalid'
    ),
    max_payload_bytes: boundedInteger(
      options.max_payload_bytes ?? 65_536,
      1_024,
      262_144,
      'livekit_audio_tap_payload_limit_invalid'
    ),
    idle_timeout_ms: boundedInteger(
      options.idle_timeout_ms ?? 60_000,
      1_000,
      300_000,
      'livekit_audio_tap_idle_timeout_invalid'
    ),
    start_timeout_ms: boundedInteger(
      options.start_timeout_ms ?? 5_000,
      100,
      30_000,
      'livekit_audio_tap_start_timeout_invalid'
    ),
    shutdown_timeout_ms: boundedInteger(
      options.shutdown_timeout_ms ?? 1_000,
      100,
      30_000,
      'livekit_audio_tap_shutdown_timeout_invalid'
    ),
    on_event: options.on_event,
    on_translation_event: options.on_translation_event ?? (() => undefined),
    now: options.now ?? (() => new Date())
  };
}

function emitGatewayEvent(
  options: NormalizedOptions,
  event: LiveKitRealtimeAudioTapGatewayEvent
): void {
  try {
    const result = options.on_event?.(Object.freeze({ ...event }));
    if (result && typeof result.then === 'function') {
      void result.catch(() => undefined);
    }
  } catch {
    // Observability failure must never affect media or Provider forwarding.
  }
}

function jsonRecord(data: RawData): Record<string, unknown> {
  const buffer = rawDataBuffer(data);
  if (buffer.length < 2 || buffer.length > 16_384) {
    throw new Error('control_frame_invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('control_frame_invalid');
  }
  return record(value);
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new Error('control_frame_invalid');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_frame_invalid');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length ||
      actual.some((key, index) => key !== allowed[index])) {
    throw new Error('control_frame_invalid');
  }
}

function boundedString(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || !value ||
      Buffer.byteLength(value) > maxBytes ||
      value.includes('\0')) {
    throw new Error('control_frame_invalid');
  }
  return value;
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

function onceListening(server: WebSocketServer): Promise<void> {
  if (server.address()) return Promise.resolve();
  return new Promise((resolve, reject) => {
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
  });
}

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number
): Promise<void> {
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

function safeReason(error: unknown): string {
  const value = error instanceof Error
    ? error.message
    : String(error || 'unknown_error');
  const safe = value.replace(/[^A-Za-z0-9_.:@/-]/g, '_').slice(0, 123);
  return safe || 'unknown_error';
}
