import { randomUUID } from 'node:crypto';

import WebSocket, { type RawData } from 'ws';

import { VoiceError } from '../errors.js';
import { EnvVoiceSecretResolver } from '../secret-resolver.js';
import {
  REALTIME_SPEECH_CAPABILITIES,
  type EndRealtimeSpeechTranslationInput,
  type RealtimeAudioFrame,
  type RealtimeAudioWriteResult,
  type RealtimeSpeechAudioEncoding,
  type RealtimeSpeechAudioFormat,
  type RealtimeSpeechCapability,
  type RealtimeSpeechProviderCapabilities,
  type RealtimeSpeechProviderPort,
  type RealtimeSpeechProviderProfile,
  type RealtimeSpeechTranslationFactory,
  type RealtimeSpeechTranslationSession,
  type RealtimeSpeechTranslationSessionPlan,
  type StartRealtimeSpeechTranslationInput
} from '../realtime-speech-translation.js';

const PROTOCOL = 'ivekit-realtime-speech-v1';
const AUDIO_MAGIC = 'IVAF';
const AUDIO_HEADER_BYTES = 24;
const MAX_PROVIDER_MESSAGE_BYTES = 1_048_576;
const CLOSE_GRACE_MS = 250;

const ENCODING_CODES: Readonly<Record<RealtimeSpeechAudioEncoding, number>> = {
  pcm_s16le: 1,
  pcmu: 2,
  pcma: 3,
  opus: 4
};

const CODE_ENCODINGS = new Map<number, RealtimeSpeechAudioEncoding>(
  Object.entries(ENCODING_CODES).map(([encoding, code]) => [
    code,
    encoding as RealtimeSpeechAudioEncoding
  ])
);

export interface ExternalRealtimeSpeechFactoryOptions {
  env?: Readonly<Record<string, string | undefined>>;
}

export interface DecodedRealtimeAudioEnvelope extends RealtimeAudioFrame {
  audio_format: RealtimeSpeechAudioFormat;
  audio: Buffer;
}

export function createExternalRealtimeSpeechFactory(
  options: ExternalRealtimeSpeechFactoryOptions = {}
): RealtimeSpeechTranslationFactory {
  return {
    async create(profile) {
      if (profile.transport !== 'websocket') {
        throw new VoiceError({ code: 'capability_unavailable', status: 501 });
      }
      const authorizationRef = profile.secret_refs.authorization;
      const envName = envNameFromRef(authorizationRef);
      const resolver = new EnvVoiceSecretResolver({
        env: options.env,
        allowlist: { realtime_speech_authorization: [envName] }
      });
      const token = await resolver.resolve(
        authorizationRef,
        'realtime_speech_authorization'
      );
      return new ExternalRealtimeSpeechPort(profile, token);
    }
  };
}

export function encodeRealtimeAudioEnvelope(
  frame: RealtimeAudioFrame,
  format: RealtimeSpeechAudioFormat
): Buffer {
  const capturedAt = Date.parse(frame.captured_at);
  const encoding = ENCODING_CODES[format.encoding];
  if (!Number.isInteger(frame.sequence) || frame.sequence < 0 || frame.sequence > 0xffff_ffff
    || !Number.isInteger(frame.duration_ms) || frame.duration_ms < 1 || frame.duration_ms > 0xffff
    || !Number.isFinite(capturedAt) || capturedAt < 0
    || !encoding || ![8_000, 16_000, 24_000, 48_000].includes(format.sample_rate_hz)
    || ![1, 2].includes(format.channels)
    || !(frame.audio instanceof Uint8Array) || frame.audio.byteLength < 1) {
    throw validationError();
  }
  const output = Buffer.allocUnsafe(AUDIO_HEADER_BYTES + frame.audio.byteLength);
  output.write(AUDIO_MAGIC, 0, 4, 'ascii');
  output.writeUInt8(1, 4);
  output.writeUInt8(encoding, 5);
  output.writeUInt8(format.channels, 6);
  output.writeUInt8(AUDIO_HEADER_BYTES, 7);
  output.writeUInt32BE(frame.sequence, 8);
  output.writeUInt16BE(frame.duration_ms, 12);
  output.writeUInt16BE(format.sample_rate_hz, 14);
  output.writeBigUInt64BE(BigInt(capturedAt), 16);
  Buffer.from(frame.audio.buffer, frame.audio.byteOffset, frame.audio.byteLength).copy(
    output,
    AUDIO_HEADER_BYTES
  );
  return output;
}

export function decodeRealtimeAudioEnvelope(input: Uint8Array): DecodedRealtimeAudioEnvelope {
  const value = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (value.byteLength <= AUDIO_HEADER_BYTES
    || value.subarray(0, 4).toString('ascii') !== AUDIO_MAGIC
    || value.readUInt8(4) !== 1
    || value.readUInt8(7) !== AUDIO_HEADER_BYTES) {
    throw protocolMismatch();
  }
  const encoding = CODE_ENCODINGS.get(value.readUInt8(5));
  const channels = value.readUInt8(6);
  const durationMs = value.readUInt16BE(12);
  const sampleRate = value.readUInt16BE(14);
  const capturedAt = Number(value.readBigUInt64BE(16));
  if (!encoding || ![1, 2].includes(channels) || durationMs < 1
    || ![8_000, 16_000, 24_000, 48_000].includes(sampleRate)
    || !Number.isSafeInteger(capturedAt)) {
    throw protocolMismatch();
  }
  return {
    sequence: value.readUInt32BE(8),
    captured_at: new Date(capturedAt).toISOString(),
    duration_ms: durationMs,
    audio_format: {
      encoding,
      sample_rate_hz: sampleRate as RealtimeSpeechAudioFormat['sample_rate_hz'],
      channels: channels as RealtimeSpeechAudioFormat['channels']
    },
    audio: Buffer.from(value.subarray(AUDIO_HEADER_BYTES))
  };
}

class ExternalRealtimeSpeechPort implements RealtimeSpeechProviderPort {
  #session: ExternalRealtimeSpeechSession | null = null;
  #closed = false;

  constructor(
    private readonly profile: RealtimeSpeechProviderProfile,
    private readonly token: string
  ) {}

  async preflight(): Promise<RealtimeSpeechProviderCapabilities> {
    this.#assertOpen();
    const socket = this.#createSocket();
    try {
      const response = await requestResponse(
        socket,
        { type: 'capabilities.get' },
        'capabilities',
        this.profile.limits.connect_timeout_ms
      );
      return {
        provider: this.profile.provider,
        provider_version: requiredText(response.provider_version),
        checked_at: requiredTimestamp(response.checked_at),
        capabilities: capabilities(response.capabilities)
      };
    } finally {
      await closeSocket(socket);
    }
  }

  async startSession(
    input: StartRealtimeSpeechTranslationInput,
    emit: (event: unknown) => void
  ): Promise<RealtimeSpeechTranslationSession> {
    this.#assertOpen();
    if (this.#session) throw validationError();
    const socket = this.#createSocket();
    try {
      const accepted = await requestResponse(
        socket,
        {
          type: 'session.start',
          ...input,
          max_buffered_audio_ms: this.profile.limits.max_buffered_audio_ms
        },
        'session.accepted',
        this.profile.limits.connect_timeout_ms
      );
      const session = new ExternalRealtimeSpeechSession({
        socket,
        profile: this.profile,
        input,
        emit,
        accepted
      });
      this.#session = session;
      return session;
    } catch (error) {
      await closeSocket(socket);
      throw providerError(error);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#session?.close();
  }

  #createSocket(): WebSocket {
    return new WebSocket(this.profile.endpoint, PROTOCOL, {
      headers: { Authorization: `Bearer ${this.token}` },
      followRedirects: false,
      handshakeTimeout: this.profile.limits.connect_timeout_ms,
      maxPayload: MAX_PROVIDER_MESSAGE_BYTES,
      perMessageDeflate: false
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 });
  }
}

class ExternalRealtimeSpeechSession implements RealtimeSpeechTranslationSession {
  readonly plan: RealtimeSpeechTranslationSessionPlan;
  readonly #queue: Array<{ payload: Buffer; duration_ms: number }> = [];
  readonly #socketBufferLimit: number;
  readonly #idleTimer: NodeJS.Timeout;
  readonly #sessionTimer: NodeJS.Timeout;
  #queuedDurationMs = 0;
  #queuedBytes = 0;
  #flushScheduled = false;
  #ended = false;
  #closed = false;
  #expectedClose = false;
  #degraded = false;
  #lastSequence = 0;

  constructor(private readonly options: {
    socket: WebSocket;
    profile: RealtimeSpeechProviderProfile;
    input: StartRealtimeSpeechTranslationInput;
    emit: (event: unknown) => void;
    accepted: Record<string, unknown>;
  }) {
    const acceptedLimit = positiveInteger(options.accepted.max_buffered_audio_ms);
    if (acceptedLimit < 100 || acceptedLimit > options.profile.limits.max_buffered_audio_ms) {
      throw protocolMismatch();
    }
    this.plan = {
      provider_session_id: requiredIdentifier(options.accepted.provider_session_id),
      provider: options.profile.provider,
      provider_version: requiredText(options.accepted.provider_version),
      max_buffered_audio_ms: acceptedLimit,
      capabilities: capabilities(options.accepted.capabilities)
    };
    this.#socketBufferLimit = socketBufferLimit(inputFormat(options.input), acceptedLimit);
    this.#idleTimer = setTimeout(
      () => this.#degradeAndTerminate('provider_idle_timeout'),
      options.profile.limits.idle_timeout_ms
    );
    this.#sessionTimer = setTimeout(
      () => this.#degradeAndTerminate('provider_session_limit'),
      options.profile.limits.max_session_seconds * 1_000
    );
    this.#idleTimer.unref();
    this.#sessionTimer.unref();
    options.socket.on('message', this.#onMessage);
    options.socket.on('close', this.#onClose);
    options.socket.on('error', this.#onError);
  }

  tryWriteAudio(frame: RealtimeAudioFrame): RealtimeAudioWriteResult {
    if (this.#ended || this.#closed || this.options.socket.readyState !== WebSocket.OPEN) {
      return 'closed';
    }
    const payload = encodeRealtimeAudioEnvelope(frame, this.options.input.audio_format);
    if (this.#queuedDurationMs + frame.duration_ms > this.plan.max_buffered_audio_ms
      || this.#queuedBytes + this.options.socket.bufferedAmount + payload.byteLength
        > this.#socketBufferLimit) {
      return 'dropped_overflow';
    }
    this.#lastSequence = frame.sequence;
    this.#queue.push({ payload, duration_ms: frame.duration_ms });
    this.#queuedDurationMs += frame.duration_ms;
    this.#queuedBytes += payload.byteLength;
    this.#touchIdleTimer();
    if (!this.#flushScheduled) {
      this.#flushScheduled = true;
      queueMicrotask(this.#flush);
    }
    return 'accepted';
  }

  async end(input: EndRealtimeSpeechTranslationInput): Promise<void> {
    if (this.#ended || this.#closed) return;
    this.#ended = true;
    if (this.options.socket.readyState !== WebSocket.OPEN) return;
    await sendJson(this.options.socket, {
      type: 'session.end',
      provider_session_id: this.plan.provider_session_id,
      reason: input.reason,
      idempotency_key: input.idempotency_key
    }).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#expectedClose = true;
    this.#clearTimersAndQueue();
    this.options.socket.off('message', this.#onMessage);
    this.options.socket.off('close', this.#onClose);
    this.options.socket.off('error', this.#onError);
    await closeSocket(this.options.socket);
  }

  readonly #flush = (): void => {
    this.#flushScheduled = false;
    if (this.#closed || this.#ended || this.options.socket.readyState !== WebSocket.OPEN) {
      this.#dropQueue();
      return;
    }
    while (this.#queue.length > 0) {
      const next = this.#queue[0];
      if (this.options.socket.bufferedAmount + next.payload.byteLength > this.#socketBufferLimit) {
        this.#degradeAndTerminate('provider_backpressure');
        return;
      }
      this.#queue.shift();
      this.#queuedDurationMs -= next.duration_ms;
      this.#queuedBytes -= next.payload.byteLength;
      this.options.socket.send(next.payload, { binary: true, compress: false }, (error) => {
        if (error) this.#degradeAndTerminate('socket_write_failed');
      });
    }
  };

  readonly #onMessage = (data: RawData, isBinary: boolean): void => {
    this.#touchIdleTimer();
    if (isBinary) {
      this.#degradeAndTerminate('protocol_mismatch');
      return;
    }
    try {
      const message = parseProviderMessage(data);
      if (message.type !== 'event' || !isRecord(message.event)) throw protocolMismatch();
      this.options.emit(message.event);
    } catch {
      this.#degradeAndTerminate('protocol_mismatch');
    }
  };

  readonly #onClose = (): void => {
    this.#clearTimersAndQueue();
    this.#closed = true;
    if (!this.#expectedClose && !this.#ended) this.#emitDegraded('socket_closed');
  };

  readonly #onError = (): void => {
    if (!this.#expectedClose && !this.#ended) this.#degradeAndTerminate('socket_error');
  };

  #touchIdleTimer(): void {
    if (this.#closed) return;
    this.#idleTimer.refresh();
  }

  #degradeAndTerminate(reason: string): void {
    if (this.#closed) return;
    this.#emitDegraded(reason);
    this.#closed = true;
    this.#clearTimersAndQueue();
    this.options.socket.terminate();
  }

  #emitDegraded(reason: string): void {
    if (this.#degraded) return;
    this.#degraded = true;
    this.options.emit({
      event_id: `degraded-${randomUUID()}`,
      type: 'provider.degraded',
      provider_session_id: this.plan.provider_session_id,
      sequence: this.#lastSequence,
      occurred_at: new Date().toISOString(),
      segment_id: '',
      speaker_id: '',
      source_language: this.options.input.source_language,
      target_language: '',
      source_text: '',
      translated_text: '',
      provider_request_id: '',
      latency_ms: {},
      metadata: { reason }
    });
  }

  #clearTimersAndQueue(): void {
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#sessionTimer);
    this.#dropQueue();
  }

  #dropQueue(): void {
    this.#queue.length = 0;
    this.#queuedDurationMs = 0;
    this.#queuedBytes = 0;
  }
}

async function requestResponse(
  socket: WebSocket,
  request: Record<string, unknown>,
  expectedType: string,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  await waitForOpen(socket, timeoutMs);
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => finish(new VoiceError({
      code: 'provider_timeout', retryable: true, status: 504
    })), timeoutMs);
    timer.unref();
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) return finish(protocolMismatch());
      try {
        const message = parseProviderMessage(data);
        if (message.type === 'error') return finish(providerProtocolError(message));
        if (message.type !== expectedType) return;
        finish(undefined, message);
      } catch (error) {
        finish(error);
      }
    };
    const onClose = () => finish(new VoiceError({
      code: 'provider_unavailable', retryable: true, status: 503
    }));
    const onError = () => finish(new VoiceError({
      code: 'provider_unavailable', retryable: true, status: 503
    }));
    const finish = (error?: unknown, value?: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve(value!);
    };
    socket.on('message', onMessage);
    socket.once('close', onClose);
    socket.once('error', onError);
    sendJson(socket, request).catch(finish);
  });
}

async function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new VoiceError({
      code: 'provider_timeout', retryable: true, status: 504
    })), timeoutMs);
    timer.unref();
    const onOpen = () => finish();
    const onClose = () => finish(new VoiceError({
      code: 'provider_unavailable', retryable: true, status: 503
    }));
    const onError = () => finish(new VoiceError({
      code: 'provider_unavailable', retryable: true, status: 503
    }));
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    socket.once('open', onOpen);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function sendJson(socket: WebSocket, value: Record<string, unknown>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(value), { binary: false, compress: false }, (error) => {
      if (error) reject(providerError(error));
      else resolve();
    });
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('close', finish);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.terminate();
      finish();
    }, CLOSE_GRACE_MS);
    timer.unref();
    socket.once('close', finish);
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close(1000, 'converact session closed');
  });
}

function parseProviderMessage(data: RawData): Record<string, unknown> {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer);
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_PROVIDER_MESSAGE_BYTES) {
    throw protocolMismatch();
  }
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw protocolMismatch(); }
  if (!isRecord(value) || typeof value.type !== 'string') throw protocolMismatch();
  return value;
}

function providerProtocolError(message: Record<string, unknown>): VoiceError {
  const code = String(message.code || '').trim().toLowerCase();
  if (code === 'unauthorized' || code === 'forbidden') {
    return new VoiceError({ code: 'provider_auth_failed', status: 502 });
  }
  if (code === 'rate_limited' || code === 'quota_exhausted' || code === 'provider_http_429') {
    return new VoiceError({
      code: 'provider_rate_limited',
      retryable: true,
      status: 429
    });
  }
  if (code === 'transient_failure' || /^provider_http_5\d\d$/.test(code)) {
    return new VoiceError({
      code: 'provider_transient_failure',
      retryable: true,
      status: 503
    });
  }
  if (message.retryable === false) {
    return new VoiceError({ code: 'provider_rejected', status: 422 });
  }
  return new VoiceError({
    code: 'provider_unavailable',
    retryable: true,
    status: 503
  });
}

function capabilities(input: unknown): Readonly<Record<RealtimeSpeechCapability, boolean>> {
  if (!isRecord(input)) throw protocolMismatch();
  return Object.fromEntries(REALTIME_SPEECH_CAPABILITIES.map((capability) => [
    capability,
    input[capability] === true
  ])) as Record<RealtimeSpeechCapability, boolean>;
}

function socketBufferLimit(format: RealtimeSpeechAudioFormat, maxBufferedMs: number): number {
  const bytesPerSecond = format.encoding === 'pcm_s16le'
    ? format.sample_rate_hz * format.channels * 2
    : format.encoding === 'pcmu' || format.encoding === 'pcma'
      ? format.sample_rate_hz * format.channels
      : 128_000;
  const mediaBytes = Math.ceil(bytesPerSecond * maxBufferedMs / 1_000);
  const headerBytes = Math.ceil(maxBufferedMs / 10) * AUDIO_HEADER_BYTES;
  return Math.max(65_536, mediaBytes + headerBytes);
}

function inputFormat(input: StartRealtimeSpeechTranslationInput): RealtimeSpeechAudioFormat {
  return input.audio_format;
}

function requiredIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value)) {
    throw protocolMismatch();
  }
  return value;
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 64
    || /[\u0000-\u001f\u007f]/.test(value)) throw protocolMismatch();
  return value.trim();
}

function requiredTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw protocolMismatch();
  return new Date(value).toISOString();
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw protocolMismatch();
  return Number(value);
}

function envNameFromRef(ref: unknown): string {
  const match = typeof ref === 'string' ? ref.match(/^env:\/\/([A-Z][A-Z0-9_]*)$/) : null;
  if (!match) throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
  return match[1];
}

function providerError(error: unknown): VoiceError {
  if (error instanceof VoiceError) return error;
  return new VoiceError({
    code: 'provider_unavailable', retryable: true, status: 503,
    details: { reason: error instanceof Error ? error.name : 'unknown' }
  });
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}

function protocolMismatch(): VoiceError {
  return new VoiceError({ code: 'protocol_mismatch', status: 502 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
