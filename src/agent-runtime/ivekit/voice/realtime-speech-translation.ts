import { isIP } from 'node:net';

import { safeVoiceProviderPayload } from './canonical.js';
import { VoiceError } from './errors.js';

export type RealtimeSpeechProviderMode = 'self_hosted' | 'third_party';
export type RealtimeSpeechTransport = 'websocket' | 'grpc';
export type RealtimeSpeechMediaSource = 'rustpbx' | 'livekit';
export type RealtimeSpeechPurpose = 'live_captions' | 'live_translation';
export type RealtimeSpeechAudioEncoding = 'pcm_s16le' | 'pcmu' | 'pcma' | 'opus';
export type RealtimeSpeechCapability =
  | 'streaming_asr'
  | 'streaming_translation'
  | 'language_detection'
  | 'speaker_diarization'
  | 'word_timestamps';

export const REALTIME_SPEECH_CAPABILITIES: readonly RealtimeSpeechCapability[] = [
  'streaming_asr',
  'streaming_translation',
  'language_detection',
  'speaker_diarization',
  'word_timestamps'
];

export interface RealtimeSpeechProviderLimits {
  connect_timeout_ms: number;
  idle_timeout_ms: number;
  max_buffered_audio_ms: number;
  max_session_seconds: number;
}

export interface RealtimeSpeechProviderProfile {
  id: string;
  tenant_id: string;
  name: string;
  provider: string;
  mode: RealtimeSpeechProviderMode;
  transport: RealtimeSpeechTransport;
  status: 'disabled' | 'enabled' | 'degraded' | 'archived';
  endpoint: string;
  provider_version: string;
  data_region: string;
  secret_refs: Record<string, string>;
  limits: RealtimeSpeechProviderLimits;
  config: Record<string, unknown>;
  revision: number;
}

export interface RealtimeSpeechAudioFormat {
  encoding: RealtimeSpeechAudioEncoding;
  sample_rate_hz: 8000 | 16000 | 24000 | 48000;
  channels: 1 | 2;
}

export interface StartRealtimeSpeechTranslationInput {
  tenant_id: string;
  interaction_id: string;
  media_session_id: string;
  media_source: RealtimeSpeechMediaSource;
  participant_id: string;
  track_id: string;
  purpose: RealtimeSpeechPurpose;
  source_language: string;
  target_languages: string[];
  features: RealtimeSpeechCapability[];
  audio_format: RealtimeSpeechAudioFormat;
  consent_ref: string;
  idempotency_key: string;
}

export interface RealtimeSpeechProviderCapabilities {
  provider: string;
  provider_version: string;
  checked_at: string;
  capabilities: Readonly<Record<RealtimeSpeechCapability, boolean>>;
}

export interface RealtimeSpeechTranslationSessionPlan {
  provider_session_id: string;
  provider: string;
  provider_version: string;
  max_buffered_audio_ms: number;
  capabilities: Readonly<Record<RealtimeSpeechCapability, boolean>>;
}

export interface RealtimeAudioFrame {
  sequence: number;
  captured_at: string;
  duration_ms: number;
  audio: Uint8Array;
}

export type RealtimeAudioWriteResult = 'accepted' | 'dropped_overflow' | 'closed';

export interface EndRealtimeSpeechTranslationInput {
  reason: string;
  idempotency_key: string;
}

export interface RealtimeSpeechTranslationSession {
  readonly plan: RealtimeSpeechTranslationSessionPlan;
  /**
   * This method must never wait on provider I/O. Implementations own a bounded
   * queue and report overflow so media forwarding can continue independently.
   */
  tryWriteAudio(frame: RealtimeAudioFrame): RealtimeAudioWriteResult;
  end(input: EndRealtimeSpeechTranslationInput): Promise<void>;
  close(): Promise<void>;
}

export type RealtimeSpeechTranslationEventType =
  | 'session.started'
  | 'session.ended'
  | 'transcript.partial'
  | 'transcript.final'
  | 'translation.partial'
  | 'translation.final'
  | 'provider.degraded';

export interface RealtimeSpeechTranslationEvent {
  event_id: string;
  type: RealtimeSpeechTranslationEventType;
  provider_session_id: string;
  sequence: number;
  occurred_at: string;
  segment_id: string;
  speaker_id: string;
  source_language: string;
  target_language: string;
  source_text: string;
  translated_text: string;
  confidence?: number;
  start_ms?: number;
  end_ms?: number;
  provider_request_id: string;
  latency_ms: Record<string, number>;
  safe_metadata: Record<string, unknown>;
  final: boolean;
}

export type RealtimeSpeechTranslationEventSink = (
  event: RealtimeSpeechTranslationEvent
) => void;

export interface RealtimeSpeechProviderPort {
  preflight(): Promise<RealtimeSpeechProviderCapabilities>;
  startSession(
    input: StartRealtimeSpeechTranslationInput,
    emit: (event: unknown) => void
  ): Promise<RealtimeSpeechTranslationSession>;
  close(): Promise<void>;
}

export interface RealtimeSpeechTranslationFactory {
  create(profile: RealtimeSpeechProviderProfile): Promise<RealtimeSpeechProviderPort>;
}

export interface RealtimeAudioTapInput {
  tenant_id: string;
  interaction_id: string;
  media_session_id: string;
  media_source: RealtimeSpeechMediaSource;
  participant_id: string;
  track_id: string;
  desired_format: RealtimeSpeechAudioFormat;
}

export interface RealtimeAudioTapSubscription {
  close(): Promise<void>;
}

export interface RealtimeAudioTapPort {
  subscribe(
    input: RealtimeAudioTapInput,
    onAudio: (frame: RealtimeAudioFrame) => RealtimeAudioWriteResult,
    onEnded: (reason: string) => void
  ): Promise<RealtimeAudioTapSubscription>;
}

type RegistryPurpose = 'preflight' | 'execute';

export class RealtimeSpeechTranslationRegistry {
  readonly #factories = new Map<string, RealtimeSpeechTranslationFactory>();

  constructor(factories: Record<string, RealtimeSpeechTranslationFactory> = {}) {
    for (const [provider, factory] of Object.entries(factories)) this.register(provider, factory);
  }

  register(provider: string, factory: RealtimeSpeechTranslationFactory): void {
    const id = providerId(provider);
    if (!factory || this.#factories.has(id)) throw validationError();
    this.#factories.set(id, factory);
  }

  async create(
    profile: RealtimeSpeechProviderProfile,
    options: { purpose?: RegistryPurpose } = {}
  ): Promise<RealtimeSpeechProviderPort> {
    validateProfile(profile);
    const purpose = options.purpose ?? 'execute';
    if (profile.status === 'archived' || (purpose === 'execute' && profile.status === 'disabled')) {
      throw new VoiceError({ code: 'capability_unavailable', status: 409 });
    }
    const factory = this.#factories.get(profile.provider);
    if (!factory) throw new VoiceError({ code: 'capability_unavailable', status: 501 });
    return factory.create(structuredClone(profile));
  }
}

export class RealtimeSpeechTranslationService {
  constructor(private readonly options: { registry: RealtimeSpeechTranslationRegistry }) {}

  async preflight(profile: RealtimeSpeechProviderProfile): Promise<RealtimeSpeechProviderCapabilities> {
    const port = await this.options.registry.create(profile, { purpose: 'preflight' });
    try {
      return normalizeCapabilities(await port.preflight(), profile.provider);
    } finally {
      await port.close().catch(() => undefined);
    }
  }

  async startSession(
    profile: RealtimeSpeechProviderProfile,
    input: StartRealtimeSpeechTranslationInput,
    emit: RealtimeSpeechTranslationEventSink
  ): Promise<RealtimeSpeechTranslationSession> {
    if (typeof emit !== 'function') throw validationError();
    const normalized = normalizeStartInput(profile, input);
    const port = await this.options.registry.create(profile, { purpose: 'execute' });
    try {
      const session = await port.startSession(
        normalized,
        (event) => emit(normalizeRealtimeSpeechTranslationEvent(event))
      );
      const plan = normalizePlan(session.plan, profile);
      return new ValidatedRealtimeSpeechSession(session, port, plan);
    } catch (error) {
      await port.close().catch(() => undefined);
      throw error;
    }
  }
}

class ValidatedRealtimeSpeechSession implements RealtimeSpeechTranslationSession {
  readonly plan: RealtimeSpeechTranslationSessionPlan;
  #lastSequence = -1;
  #ended = false;
  #closed = false;

  constructor(
    private readonly inner: RealtimeSpeechTranslationSession,
    private readonly port: RealtimeSpeechProviderPort,
    plan: RealtimeSpeechTranslationSessionPlan
  ) {
    this.plan = structuredClone(plan);
  }

  tryWriteAudio(frame: RealtimeAudioFrame): RealtimeAudioWriteResult {
    if (this.#ended || this.#closed) return 'closed';
    const normalized = normalizeAudioFrame(frame);
    if (normalized.sequence <= this.#lastSequence) {
      throw new VoiceError({ code: 'event_sequence_conflict', status: 409 });
    }
    const result = this.inner.tryWriteAudio(normalized);
    if (!['accepted', 'dropped_overflow', 'closed'].includes(result)) {
      throw new VoiceError({ code: 'protocol_mismatch', status: 502 });
    }
    this.#lastSequence = normalized.sequence;
    if (result === 'closed') this.#ended = true;
    return result;
  }

  async end(input: EndRealtimeSpeechTranslationInput): Promise<void> {
    if (this.#ended || this.#closed) return;
    await this.inner.end({
      reason: boundedText(input.reason, 128),
      idempotency_key: idempotencyKey(input.idempotency_key)
    });
    this.#ended = true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.inner.close();
    } finally {
      await this.port.close().catch(() => undefined);
    }
  }
}

export function normalizeRealtimeSpeechTranslationEvent(
  input: unknown
): RealtimeSpeechTranslationEvent {
  if (!isRecord(input)) throw protocolMismatch();
  const type = eventType(input.type);
  const transcript = type === 'transcript.partial' || type === 'transcript.final';
  const translation = type === 'translation.partial' || type === 'translation.final';
  const sourceText = optionalText(input.source_text, 65_536);
  const translatedText = optionalText(input.translated_text, 65_536);
  const sourceLanguage = optionalLanguage(input.source_language);
  const targetLanguage = optionalLanguage(input.target_language);
  if (transcript && !sourceText) throw protocolMismatch();
  if (translation && (!translatedText || !targetLanguage)) throw protocolMismatch();
  const startMs = optionalInteger(input.start_ms, 0, 86_400_000);
  const endMs = optionalInteger(input.end_ms, 0, 86_400_000);
  if (startMs !== undefined && endMs !== undefined && endMs < startMs) throw protocolMismatch();
  return {
    event_id: identifier(input.event_id),
    type,
    provider_session_id: identifier(input.provider_session_id),
    sequence: integer(input.sequence, 0, Number.MAX_SAFE_INTEGER),
    occurred_at: timestamp(input.occurred_at),
    segment_id: optionalIdentifier(input.segment_id),
    speaker_id: optionalIdentifier(input.speaker_id),
    source_language: sourceLanguage,
    target_language: targetLanguage,
    source_text: sourceText,
    translated_text: translatedText,
    ...(optionalConfidence(input.confidence) !== undefined
      ? { confidence: optionalConfidence(input.confidence) }
      : {}),
    ...(startMs !== undefined ? { start_ms: startMs } : {}),
    ...(endMs !== undefined ? { end_ms: endMs } : {}),
    provider_request_id: optionalIdentifier(input.provider_request_id),
    latency_ms: normalizeLatencies(input.latency_ms),
    safe_metadata: sanitizeMetadata(input.metadata),
    final: type.endsWith('.final') || type === 'session.ended'
  };
}

function normalizeStartInput(
  profile: RealtimeSpeechProviderProfile,
  input: StartRealtimeSpeechTranslationInput
): StartRealtimeSpeechTranslationInput {
  if (!isRecord(input)) throw validationError();
  if (identifier(input.tenant_id) !== profile.tenant_id) {
    throw new VoiceError({ code: 'not_found', status: 404 });
  }
  if (!['rustpbx', 'livekit'].includes(input.media_source)) throw validationError();
  if (!['live_captions', 'live_translation'].includes(input.purpose)) throw validationError();
  const features = uniqueCapabilities(input.features);
  if (!features.includes('streaming_asr')) throw validationError();
  const targetLanguages = uniqueLanguages(input.target_languages, false);
  if (input.purpose === 'live_translation' && (
    !features.includes('streaming_translation') || targetLanguages.length === 0
  )) throw validationError();
  if (input.purpose === 'live_captions' && targetLanguages.length > 0) throw validationError();
  return {
    tenant_id: profile.tenant_id,
    interaction_id: identifier(input.interaction_id),
    media_session_id: identifier(input.media_session_id),
    media_source: input.media_source,
    participant_id: identifier(input.participant_id),
    track_id: identifier(input.track_id),
    purpose: input.purpose,
    source_language: normalizeLanguage(input.source_language, true),
    target_languages: targetLanguages,
    features,
    audio_format: normalizeAudioFormat(input.audio_format),
    consent_ref: identifier(input.consent_ref),
    idempotency_key: idempotencyKey(input.idempotency_key)
  };
}

function normalizeAudioFrame(frame: RealtimeAudioFrame): RealtimeAudioFrame {
  if (!isRecord(frame) || !(frame.audio instanceof Uint8Array)) throw validationError();
  if (frame.audio.byteLength < 1 || frame.audio.byteLength > 1_048_576) throw validationError();
  return {
    sequence: integer(frame.sequence, 0, Number.MAX_SAFE_INTEGER),
    captured_at: timestamp(frame.captured_at),
    duration_ms: integer(frame.duration_ms, 10, 1_000),
    audio: frame.audio
  };
}

function normalizePlan(
  value: RealtimeSpeechTranslationSessionPlan,
  profile: RealtimeSpeechProviderProfile
): RealtimeSpeechTranslationSessionPlan {
  if (!isRecord(value) || providerId(value.provider) !== profile.provider) throw protocolMismatch();
  const buffered = integer(value.max_buffered_audio_ms, 100, profile.limits.max_buffered_audio_ms);
  return {
    provider_session_id: identifier(value.provider_session_id),
    provider: profile.provider,
    provider_version: boundedText(value.provider_version, 64),
    max_buffered_audio_ms: buffered,
    capabilities: capabilityRecord(value.capabilities)
  };
}

function normalizeCapabilities(
  value: RealtimeSpeechProviderCapabilities,
  provider: string
): RealtimeSpeechProviderCapabilities {
  if (!isRecord(value) || providerId(value.provider) !== provider) throw protocolMismatch();
  return {
    provider,
    provider_version: boundedText(value.provider_version, 64),
    checked_at: timestamp(value.checked_at),
    capabilities: capabilityRecord(value.capabilities)
  };
}

function validateProfile(profile: RealtimeSpeechProviderProfile): void {
  if (!isRecord(profile)) throw validationError();
  identifier(profile.id);
  identifier(profile.tenant_id);
  boundedText(profile.name, 128);
  providerId(profile.provider);
  boundedText(profile.provider_version, 64);
  boundedText(profile.data_region, 64);
  if (!['self_hosted', 'third_party'].includes(profile.mode)
    || !['websocket', 'grpc'].includes(profile.transport)
    || !['disabled', 'enabled', 'degraded', 'archived'].includes(profile.status)) {
    throw validationError();
  }
  if (!Number.isInteger(profile.revision) || profile.revision < 1) throw validationError();
  validateEndpoint(profile);
  validateLimits(profile.limits);
  validateSecretRefs(profile.secret_refs);
  assertSecretFreeConfig(profile.config, new Set());
}

function validateEndpoint(profile: RealtimeSpeechProviderProfile): void {
  let endpoint: URL;
  try { endpoint = new URL(profile.endpoint); } catch { throw validationError(); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw validationError();
  const protocols = profile.transport === 'websocket' ? ['ws:', 'wss:'] : ['http:', 'https:'];
  if (!protocols.includes(endpoint.protocol)) throw validationError();
  if (profile.mode === 'third_party'
    && !['wss:', 'https:'].includes(endpoint.protocol)) throw validationError();
  if (profile.mode === 'self_hosted'
    && ['ws:', 'http:'].includes(endpoint.protocol)
    && !isPrivateOrContainerHost(endpoint.hostname)) throw validationError();
}

function validateLimits(value: RealtimeSpeechProviderLimits): void {
  if (!isRecord(value)) throw validationError();
  integer(value.connect_timeout_ms, 250, 30_000);
  integer(value.idle_timeout_ms, 1_000, 300_000);
  integer(value.max_buffered_audio_ms, 100, 5_000);
  integer(value.max_session_seconds, 30, 28_800);
}

function validateSecretRefs(value: Record<string, string>): void {
  if (!isRecord(value) || Object.keys(value).length > 16) throw validationError();
  for (const [key, ref] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)
      || typeof ref !== 'string'
      || !/^env:\/\/[A-Z][A-Z0-9_]{1,127}$/.test(ref)) {
      throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
    }
  }
}

function assertSecretFreeConfig(value: unknown, ancestors: Set<object>): void {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || ancestors.has(value)) {
    throw validationError();
  }
  ancestors.add(value);
  try {
    for (const [key, item] of Object.entries(value)) {
      if (/secret|token|password|credential|authorization|apikey/i.test(key)) {
        throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
      }
      assertSecretFreeConfig(item, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function capabilityRecord(value: unknown): Readonly<Record<RealtimeSpeechCapability, boolean>> {
  if (!isRecord(value)) throw protocolMismatch();
  return Object.fromEntries(REALTIME_SPEECH_CAPABILITIES.map((capability) => [
    capability,
    value[capability] === true
  ])) as Record<RealtimeSpeechCapability, boolean>;
}

function uniqueCapabilities(value: unknown): RealtimeSpeechCapability[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > REALTIME_SPEECH_CAPABILITIES.length) {
    throw validationError();
  }
  const capabilities = value.map((item) => String(item) as RealtimeSpeechCapability);
  if (capabilities.some((item) => !REALTIME_SPEECH_CAPABILITIES.includes(item))) throw validationError();
  return [...new Set(capabilities)];
}

function normalizeAudioFormat(value: RealtimeSpeechAudioFormat): RealtimeSpeechAudioFormat {
  if (!isRecord(value) || !['pcm_s16le', 'pcmu', 'pcma', 'opus'].includes(value.encoding)
    || ![8_000, 16_000, 24_000, 48_000].includes(value.sample_rate_hz)
    || ![1, 2].includes(value.channels)) throw validationError();
  return {
    encoding: value.encoding,
    sample_rate_hz: value.sample_rate_hz,
    channels: value.channels
  };
}

function uniqueLanguages(value: unknown, allowAuto: boolean): string[] {
  if (!Array.isArray(value) || value.length > 8) throw validationError();
  return [...new Set(value.map((item) => normalizeLanguage(item, allowAuto)))];
}

function normalizeLanguage(value: unknown, allowAuto: boolean): string {
  const language = String(value || '').trim();
  if (allowAuto && language.toLowerCase() === 'auto') return 'auto';
  if (!language || language.length > 35) throw validationError();
  try {
    const canonical = Intl.getCanonicalLocales(language)[0];
    if (!canonical) throw new Error('missing language');
    return canonical;
  } catch {
    throw validationError();
  }
}

function optionalLanguage(value: unknown): string {
  if (value == null || value === '') return '';
  try { return normalizeLanguage(value, false); } catch { throw protocolMismatch(); }
}

function normalizeLatencies(value: unknown): Record<string, number> {
  if (value == null) return {};
  if (!isRecord(value)) throw protocolMismatch();
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(value).slice(0, 16)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key)
      || typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 3_600_000) {
      throw protocolMismatch();
    }
    output[key] = item;
  }
  return output;
}

function sanitizeMetadata(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  const safe = safeVoiceProviderPayload(value, {
    max_depth: 4,
    max_string_length: 256,
    max_array_length: 16,
    max_object_entries: 40
  });
  return dropContentFields(safe) as Record<string, unknown>;
}

function dropContentFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropContentFields);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/raw|audio|pcm|frame|payload|transcript|translation|message|content|prompt/.test(normalized)) continue;
    output[key] = dropContentFields(item);
  }
  return output;
}

function eventType(value: unknown): RealtimeSpeechTranslationEventType {
  const allowed = new Set<RealtimeSpeechTranslationEventType>([
    'session.started', 'session.ended', 'transcript.partial', 'transcript.final',
    'translation.partial', 'translation.final', 'provider.degraded'
  ]);
  if (typeof value !== 'string' || !allowed.has(value as RealtimeSpeechTranslationEventType)) {
    throw protocolMismatch();
  }
  return value as RealtimeSpeechTranslationEventType;
}

function providerId(value: unknown): string {
  const provider = String(value || '');
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) throw validationError();
  return provider;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value)) {
    throw validationError();
  }
  return value;
}

function optionalIdentifier(value: unknown): string {
  if (value == null || value === '') return '';
  try { return identifier(value); } catch { throw protocolMismatch(); }
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/.test(value)) throw validationError();
  return value;
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw validationError();
  return value.trim();
}

function optionalText(value: unknown, maxLength: number): string {
  if (value == null || value === '') return '';
  try { return boundedText(value, maxLength); } catch { throw protocolMismatch(); }
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw validationError();
  return new Date(value).toISOString();
}

function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw validationError();
  return Number(value);
}

function optionalInteger(value: unknown, min: number, max: number): number | undefined {
  if (value == null || value === '') return undefined;
  try { return integer(value, min, max); } catch { throw protocolMismatch(); }
}

function optionalConfidence(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw protocolMismatch();
  return confidence;
}

function isPrivateOrContainerHost(rawHostname: string): boolean {
  const hostname = rawHostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  const version = isIP(hostname);
  if (version === 4) {
    const [a, b] = hostname.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) {
    return hostname === '::1' || hostname.startsWith('fc')
      || hostname.startsWith('fd') || hostname.startsWith('fe80:');
  }
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(hostname);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}

function protocolMismatch(): VoiceError {
  return new VoiceError({ code: 'protocol_mismatch', status: 502 });
}
