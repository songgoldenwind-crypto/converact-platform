import WebSocket, { type RawData } from 'ws';

import { canonicalVoicePayloadHash, safeVoiceProviderPayload } from '../canonical.js';
import { VoiceError } from '../errors.js';
import type { VoiceSecretResolver } from '../ports.js';
import type { VoiceCommandKind } from '../types.js';

export interface RustPbxRwiClientOptions {
  url: string;
  token_ref: string;
  secret_resolver: VoiceSecretResolver;
  contexts?: string[];
  production?: boolean;
  internal_service?: boolean;
  connect_timeout_ms?: number;
  command_timeout_ms?: number;
  heartbeat_timeout_ms?: number;
  max_message_bytes?: number;
  reconnect_initial_ms?: number;
  reconnect_max_ms?: number;
  reconnect_jitter_ratio?: number;
  random?: () => number;
}

export interface RustPbxRwiCommandInput {
  command_id: string;
  kind: VoiceCommandKind;
  call_id: string;
  payload: Record<string, unknown>;
}

export interface RustPbxRwiEnvelope {
  action: string;
  action_id: string;
  params: Record<string, unknown>;
}

export type RustPbxRwiCommandResult =
  | { state: 'succeeded'; action_id: string; result: Record<string, unknown> }
  | { state: 'failed'; action_id: string; error_code: string }
  | { state: 'uncertain'; action_id: string; error_code: string };

export interface RustPbxRwiSafeEvent {
  event_type: string;
  action_id?: string;
  safe_payload: Record<string, unknown>;
}

const RUSTPBX_RWI_PROTOCOL_CAPABILITIES_VALUE = {
  baseline_image_tag: '0.4.11-6c49ee7-community',
  dtmf_receive: true,
  dtmf_send: true,
  park: false,
  pickup: false,
  conference: { create: true, add: true, remove: true, destroy: true, mute: true, unmute: true },
  supervisor: { listen: true, whisper: true, barge: true, takeover: true }
} as const;

const RUSTPBX_RWI_EFFECTIVE_CAPABILITIES_VALUE = {
  ...RUSTPBX_RWI_PROTOCOL_CAPABILITIES_VALUE,
  conference: { create: true, add: true, remove: true, destroy: true, mute: false, unmute: false },
  supervisor: { listen: false, whisper: false, barge: false, takeover: false }
} as const;

export const RUSTPBX_RWI_PROTOCOL_CAPABILITIES = deepFreeze(RUSTPBX_RWI_PROTOCOL_CAPABILITIES_VALUE);
export const RUSTPBX_RWI_EFFECTIVE_CAPABILITIES = deepFreeze(RUSTPBX_RWI_EFFECTIVE_CAPABILITIES_VALUE);

export interface RustPbxRwiPreflightResult {
  ready: boolean;
  protocol: 'rwi-v1';
  commands: string[];
  capability_source: 'pinned_baseline';
  runtime_version_verified: false;
  protocol_capabilities: typeof RUSTPBX_RWI_PROTOCOL_CAPABILITIES;
  effective_capabilities: typeof RUSTPBX_RWI_EFFECTIVE_CAPABILITIES;
  limitations: string[];
}

interface PendingAction {
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: RustPbxRwiCommandResult) => void;
  reject: (error: VoiceError) => void;
}

const TOKEN_PURPOSE = 'rwi';

export class RustPbxRwiClient {
  readonly #url: URL;
  readonly #tokenRef: string;
  readonly #secretResolver: VoiceSecretResolver;
  readonly #contexts: string[];
  readonly #connectTimeoutMs: number;
  readonly #commandTimeoutMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #reconnectInitialMs: number;
  readonly #reconnectMaxMs: number;
  readonly #reconnectJitterRatio: number;
  readonly #random: () => number;
  readonly #handlers = new Set<(event: RustPbxRwiSafeEvent) => void>();
  readonly #pending = new Map<string, PendingAction>();

  #socket: WebSocket | null = null;
  #connectPromise: Promise<void> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #lastActivityAt = 0;
  #reconnectDelayMs: number;
  #subscriptionRevision = 0;
  #preflightRevision = 0;
  #shutdown = false;

  constructor(options: RustPbxRwiClientOptions) {
    this.#url = validatedRwiUrl(options.url, options.production === true, options.internal_service === true);
    this.#tokenRef = boundedString(options.token_ref, 512);
    this.#secretResolver = options.secret_resolver;
    this.#contexts = normalizedContexts(options.contexts ?? []);
    this.#connectTimeoutMs = boundedInteger(options.connect_timeout_ms, 5_000, 10, 120_000);
    this.#commandTimeoutMs = boundedInteger(options.command_timeout_ms, 10_000, 10, 300_000);
    this.#heartbeatTimeoutMs = boundedInteger(options.heartbeat_timeout_ms, 30_000, 50, 300_000);
    this.#maxMessageBytes = boundedInteger(options.max_message_bytes, 256 * 1024, 64, 4 * 1024 * 1024);
    this.#reconnectInitialMs = boundedInteger(options.reconnect_initial_ms, 1_000, 10, 60_000);
    this.#reconnectMaxMs = boundedInteger(options.reconnect_max_ms, 30_000, this.#reconnectInitialMs, 300_000);
    this.#reconnectJitterRatio = boundedNumber(options.reconnect_jitter_ratio, 0.2, 0, 1);
    this.#random = options.random ?? Math.random;
    this.#reconnectDelayMs = this.#reconnectInitialMs;
  }

  async connect(): Promise<void> {
    if (this.#shutdown) throw new VoiceError({ code: 'provider_unavailable', status: 503 });
    if (this.isConnected()) return;
    if (this.#connectPromise) return this.#connectPromise;
    this.#clearReconnect();
    this.#connectPromise = this.#open();
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = null;
    }
  }

  isConnected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  onEvent(handler: (event: RustPbxRwiSafeEvent) => void): void {
    this.#handlers.add(handler);
  }

  offEvent(handler: (event: RustPbxRwiSafeEvent) => void): void {
    this.#handlers.delete(handler);
  }

  async preflight(): Promise<RustPbxRwiPreflightResult> {
    const result = await this.#sendEnvelope({
      action: 'session.list_calls',
      action_id: `preflight:${++this.#preflightRevision}`,
      params: {}
    });
    if (result.state !== 'succeeded') {
      throw new VoiceError({
        code: result.state === 'uncertain' ? 'provider_timeout' : 'provider_unavailable',
        retryable: result.state === 'uncertain',
        status: result.state === 'uncertain' ? 504 : 503
      });
    }
    return {
      ready: true,
      protocol: 'rwi-v1',
      commands: [...SUPPORTED_ACTIONS],
      capability_source: 'pinned_baseline',
      runtime_version_verified: false,
      protocol_capabilities: RUSTPBX_RWI_PROTOCOL_CAPABILITIES,
      effective_capabilities: RUSTPBX_RWI_EFFECTIVE_CAPABILITIES,
      limitations: [
        'park_action_unavailable',
        'pickup_action_unavailable',
        'conference_mute_audio_unavailable',
        'supervisor_audio_mixing_unavailable',
        'runtime_version_not_negotiated_by_rwi_v1'
      ]
    };
  }

  execute(input: RustPbxRwiCommandInput): Promise<RustPbxRwiCommandResult> {
    return this.#sendEnvelope(mapRustPbxRwiCommand(input));
  }

  async close(): Promise<void> {
    if (this.#shutdown && !this.#socket) return;
    this.#shutdown = true;
    this.#clearReconnect();
    this.#stopHeartbeat();
    for (const [actionId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new VoiceError({ code: 'provider_unavailable', status: 503 }));
      this.#pending.delete(actionId);
    }
    const socket = this.#socket;
    this.#socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 100);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000, 'client shutdown');
    });
  }

  async #open(): Promise<void> {
    const token = await this.#secretResolver.resolve(this.#tokenRef, TOKEN_PURPOSE);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.#url, 'rwi-v1', {
        headers: { authorization: `Bearer ${token}` },
        maxPayload: Math.max(this.#maxMessageBytes, (4 * 1024 * 1024) + 1),
        handshakeTimeout: this.#connectTimeoutMs
      });
      this.#socket = socket;
      let opened = false;
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new VoiceError({ code: 'provider_timeout', retryable: true, status: 504 }));
      }, this.#connectTimeoutMs);

      socket.on('message', (data) => this.#handleMessage(socket, data));
      socket.on('pong', () => { this.#lastActivityAt = Date.now(); });
      socket.once('open', () => {
        opened = true;
        clearTimeout(timeout);
        this.#lastActivityAt = Date.now();
        this.#reconnectDelayMs = this.#reconnectInitialMs;
        this.#startHeartbeat(socket);
        this.#sendSubscription(socket);
        resolve();
      });
      socket.once('error', () => {
        if (opened) return;
        clearTimeout(timeout);
        reject(new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 }));
      });
      socket.once('close', () => {
        clearTimeout(timeout);
        this.#handleClose(socket, opened);
      });
    });
  }

  #sendEnvelope(envelope: RustPbxRwiEnvelope): Promise<RustPbxRwiCommandResult> {
    if (!this.isConnected() || !this.#socket) {
      return Promise.reject(new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 }));
    }
    if (this.#pending.has(envelope.action_id)) {
      return Promise.reject(new VoiceError({ code: 'idempotency_conflict', status: 409 }));
    }
    const encoded = JSON.stringify(envelope);
    if (Buffer.byteLength(encoded, 'utf8') > this.#maxMessageBytes) {
      return Promise.reject(new VoiceError({ code: 'provider_payload_invalid', status: 422 }));
    }
    return new Promise<RustPbxRwiCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(envelope.action_id);
        resolve({ state: 'uncertain', action_id: envelope.action_id, error_code: 'provider_timeout' });
      }, this.#commandTimeoutMs);
      this.#pending.set(envelope.action_id, { timer, resolve, reject });
      try {
        this.#socket!.send(encoded);
      } catch {
        clearTimeout(timer);
        this.#pending.delete(envelope.action_id);
        resolve({ state: 'uncertain', action_id: envelope.action_id, error_code: 'provider_unavailable' });
      }
    });
  }

  #sendSubscription(socket: WebSocket): void {
    if (this.#contexts.length === 0 || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      action: 'session.subscribe',
      action_id: `subscription:${++this.#subscriptionRevision}`,
      params: { contexts: this.#contexts }
    }));
  }

  #handleMessage(socket: WebSocket, raw: RawData): void {
    if (socket !== this.#socket) return;
    this.#lastActivityAt = Date.now();
    const bytes = rawDataBytes(raw);
    if (bytes > this.#maxMessageBytes) {
      this.#protocolViolation(socket, 'message_too_large', 1009);
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(rawDataText(raw)) as unknown;
    } catch {
      this.#protocolViolation(socket, 'invalid_json', 1007);
      return;
    }
    if (!isRecord(message)) {
      this.#protocolViolation(socket, 'invalid_envelope', 1007);
      return;
    }
    const completionType = typeof message.type === 'string' ? message.type : message.event;
    if (completionType === 'command_completed' || completionType === 'command_failed') {
      this.#handleCompletion({ ...message, event: completionType });
      return;
    }
    if (typeof message.event !== 'string') {
      this.#protocolViolation(socket, 'invalid_envelope', 1007);
      return;
    }
    this.#emit({
      event_type: boundedEventType(message.event),
      ...(typeof message.action_id === 'string' ? { action_id: message.action_id.slice(0, 256) } : {}),
      safe_payload: safeVoiceProviderPayload(message)
    });
  }

  #handleCompletion(message: Record<string, unknown>): void {
    const actionId = typeof message.action_id === 'string' ? message.action_id : '';
    const pending = actionId ? this.#pending.get(actionId) : undefined;
    if (!pending) {
      this.#emit({
        event_type: 'orphan_completion',
        ...(actionId ? { action_id: actionId.slice(0, 256) } : {}),
        safe_payload: safeVoiceProviderPayload({ event: message.event, action_id: actionId })
      });
      return;
    }
    this.#pending.delete(actionId);
    clearTimeout(pending.timer);
    if (message.event === 'command_completed') {
      const data = isRecord(message.data)
        ? message.data
        : isRecord(message.result) ? message.result : {};
      pending.resolve({
        state: 'succeeded',
        action_id: actionId,
        result: safeVoiceProviderPayload(data)
      });
      return;
    }
    pending.resolve({
      state: 'failed',
      action_id: actionId,
      error_code: classifiedProviderErrorCode(message.error_code, message.error)
    });
  }

  #protocolViolation(socket: WebSocket, reason: string, closeCode: number): void {
    this.#emit({ event_type: 'protocol_violation', safe_payload: { reason } });
    socket.close(closeCode, 'protocol violation');
  }

  #emit(event: RustPbxRwiSafeEvent): void {
    for (const handler of this.#handlers) handler(event);
  }

  #handleClose(socket: WebSocket, opened: boolean): void {
    if (socket !== this.#socket) return;
    this.#socket = null;
    this.#stopHeartbeat();
    if (opened) {
      for (const [actionId, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.resolve({ state: 'uncertain', action_id: actionId, error_code: 'provider_unavailable' });
        this.#pending.delete(actionId);
      }
    }
    if (!this.#shutdown) this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer || this.#shutdown) return;
    const jitter = this.#reconnectDelayMs * this.#reconnectJitterRatio * ((this.#random() * 2) - 1);
    const delay = Math.max(0, Math.round(this.#reconnectDelayMs + jitter));
    this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, this.#reconnectMaxMs);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#shutdown) return;
      void this.#open().catch(() => this.#scheduleReconnect());
    }, delay);
  }

  #clearReconnect(): void {
    if (!this.#reconnectTimer) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #startHeartbeat(socket: WebSocket): void {
    this.#stopHeartbeat();
    const interval = Math.max(25, Math.floor(this.#heartbeatTimeoutMs / 2));
    this.#heartbeatTimer = setInterval(() => {
      if (socket !== this.#socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.#lastActivityAt >= this.#heartbeatTimeoutMs) {
        socket.terminate();
        return;
      }
      socket.ping();
    }, interval);
  }

  #stopHeartbeat(): void {
    if (!this.#heartbeatTimer) return;
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }
}

const SUPPORTED_ACTIONS = [
  'call.originate',
  'call.answer',
  'call.hangup',
  'call.hold',
  'call.unhold',
  'call.send_dtmf',
  'call.transfer',
  'call.transfer.attended',
  'conference.create',
  'conference.add',
  'conference.remove',
  'conference.destroy',
  'record.start',
  'record.pause',
  'record.resume',
  'record.stop'
] as const;

export function mapRustPbxRwiCommand(input: RustPbxRwiCommandInput): RustPbxRwiEnvelope {
  if (!isRecord(input) || !isRecord(input.payload)) throw validationError();
  const actionId = boundedString(input.command_id, 256);
  const callId = boundedString(input.call_id, 256);
  const payload = validatedCommandPayload(input.payload);
  const params: Record<string, unknown> = { ...payload, call_id: callId };
  let action: string;
  switch (input.kind) {
    case 'originate': action = 'call.originate'; break;
    case 'answer': action = 'call.answer'; break;
    case 'hangup': action = 'call.hangup'; break;
    case 'hold': action = 'call.hold'; break;
    case 'resume': action = 'call.unhold'; break;
    case 'dtmf': return mapDtmfCommand(actionId, callId, payload);
    case 'blind_transfer': action = 'call.transfer'; break;
    case 'warm_transfer': action = 'call.transfer.attended'; break;
    case 'conference': return mapConferenceCommand(actionId, callId, payload);
    case 'recording_start': action = 'record.start'; break;
    case 'recording_pause': action = 'record.pause'; break;
    case 'recording_resume': action = 'record.resume'; break;
    case 'recording_stop': action = 'record.stop'; break;
    case 'park':
    case 'pickup':
    case 'livekit_bridge_create':
      throw new VoiceError({ code: 'capability_unavailable', status: 501, details: { command: input.kind } });
    default:
      throw new VoiceError({ code: 'capability_unavailable', status: 501 });
  }
  return { action, action_id: actionId, params };
}

function mapDtmfCommand(
  actionId: string,
  callId: string,
  payload: Record<string, unknown>
): RustPbxRwiEnvelope {
  const allowed = new Set(['digits', 'leg_id']);
  if (Object.keys(payload).some((key) => !allowed.has(key))) throw validationError();
  const digits = boundedString(payload.digits, 32).toUpperCase();
  if (!/^[0-9A-D*#]+$/.test(digits)) throw validationError();
  const params: Record<string, unknown> = { call_id: callId, digits };
  if (payload.leg_id !== undefined) params.leg_id = boundedString(payload.leg_id, 256);
  return { action: 'call.send_dtmf', action_id: actionId, params };
}

function validatedRwiUrl(value: unknown, production: boolean, internalService: boolean): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw validationError();
  }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.pathname !== '/rwi/v1'
    || url.username || url.password || url.search || url.hash) throw validationError();
  if (production && url.protocol !== 'wss:' && !internalService) throw validationError();
  return url;
}

function validatedCommandPayload(value: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(value).length > 50 || containsSensitiveKey(value, 0)) throw validationError();
  canonicalVoicePayloadHash(value);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw validationError();
  }
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw validationError();
  return { ...value };
}

function mapConferenceCommand(
  actionId: string,
  callId: string,
  payload: Record<string, unknown>
): RustPbxRwiEnvelope {
  const operation = boundedString(payload.operation ?? 'add', 16);
  if (!['create', 'add', 'remove', 'destroy'].includes(operation)) throw validationError();
  const conferenceId = boundedString(payload.conference_id, 256);
  const allowed = operation === 'create'
    ? new Set(['operation', 'conference_id', 'backend', 'max_members', 'record'])
    : new Set(['operation', 'conference_id']);
  if (Object.keys(payload).some((key) => !allowed.has(key))) throw validationError();
  if (operation === 'create') {
    const params: Record<string, unknown> = { conf_id: conferenceId };
    if (payload.backend !== undefined) {
      if (payload.backend !== 'internal' && payload.backend !== 'external') throw validationError();
      params.backend = payload.backend;
    }
    if (payload.max_members !== undefined) {
      if (!Number.isInteger(payload.max_members) || Number(payload.max_members) < 2
        || Number(payload.max_members) > 1_000) throw validationError();
      params.max_members = payload.max_members;
    }
    if (payload.record !== undefined) {
      if (typeof payload.record !== 'boolean') throw validationError();
      params.record = payload.record;
    }
    return { action: 'conference.create', action_id: actionId, params };
  }
  if (operation === 'destroy') {
    return {
      action: 'conference.destroy', action_id: actionId,
      params: { conference_id: conferenceId }
    };
  }
  return {
    action: `conference.${operation}`, action_id: actionId,
    params: { conference_id: conferenceId, call_id: callId }
  };
}

function containsSensitiveKey(value: unknown, depth: number): boolean {
  if (depth > 6) return true;
  if (Array.isArray(value)) return value.some((child) => containsSensitiveKey(child, depth + 1));
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:authorization|cookie|credential|password|secret|token|api[-_]?key)/i.test(key)) return true;
    if (typeof child === 'object' && child !== null && containsSensitiveKey(child, depth + 1)) return true;
  }
  return false;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizedContexts(values: unknown[]): string[] {
  if (!Array.isArray(values) || values.length > 32) throw validationError();
  return [...new Set(values.map((value) => boundedString(value, 128)))];
}

function rawDataBytes(value: RawData): number {
  if (Array.isArray(value)) return value.reduce((total, item) => total + item.byteLength, 0);
  return value.byteLength;
}

function rawDataText(value: RawData): string {
  if (Array.isArray(value)) return Buffer.concat(value).toString('utf8');
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return Buffer.from(value as ArrayBuffer).toString('utf8');
}

function classifiedProviderErrorCode(code: unknown, message: unknown): string {
  const value = `${typeof code === 'string' ? code : ''} ${typeof message === 'string' ? message : ''}`
    .trim()
    .toLowerCase();
  if (/unknown_action|not implemented|unsupported|capability/.test(value)) return 'capability_unavailable';
  if (/call not found|not_found|not found/.test(value)) return 'provider_call_not_found';
  if (/invalid state|invalid_state|state conflict/.test(value)) return 'invalid_call_transition';
  if (/already owned|ownership|owner conflict/.test(value)) return 'call_control_conflict';
  if (/unauthor|forbidden|permission|auth_failed/.test(value)) return 'provider_auth_failed';
  if (/timeout|timed out/.test(value)) return 'provider_timeout';
  return 'provider_command_failed';
}

function boundedEventType(value: string): string {
  return /^[a-z0-9_.-]{1,128}$/i.test(value) ? value : 'provider_event';
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw validationError();
  const output = value.trim();
  if (!output || output.length > maxLength || /[\u0000-\u001f\u007f]/.test(output)) throw validationError();
  return output;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) throw validationError();
  return resolved;
}

function boundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < min || resolved > max) throw validationError();
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}
