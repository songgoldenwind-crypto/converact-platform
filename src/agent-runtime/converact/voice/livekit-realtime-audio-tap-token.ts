import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type {
  RealtimeAudioTapFeature,
  RealtimeAudioTapPurpose
} from './realtime-audio-tap-token.js';

export interface LiveKitRealtimeAudioTapTokenClaims {
  tenant_id: string;
  interaction_id: string;
  media_session_id: string;
  participant_id: string;
  track_id: string;
  purpose: RealtimeAudioTapPurpose;
  consent_ref: string;
  source_language: string;
  target_languages: string[];
  features: RealtimeAudioTapFeature[];
  audience_user_ids: string[];
}

export interface VerifiedLiveKitRealtimeAudioTapTokenClaims
extends LiveKitRealtimeAudioTapTokenClaims {
  issuer: 'ivekit';
  audience: 'livekit-audio-tap';
  version: 1;
  issued_at: number;
  expires_at: number;
  nonce: string;
}

export interface LiveKitRealtimeAudioTapTokenCodec {
  issue(
    claims: LiveKitRealtimeAudioTapTokenClaims,
    options?: { expires_at_epoch_seconds?: number }
  ): string;
  verify(
    token: string,
    options?: {
      expected_media_session_id?: string;
      expected_participant_id?: string;
      expected_track_id?: string;
    }
  ): VerifiedLiveKitRealtimeAudioTapTokenClaims;
}

interface CodecOptions {
  secret: Uint8Array;
  now?: () => Date;
  nonce?: () => string;
  ttl_seconds?: number;
}

const HEADER = Object.freeze({ alg: 'HS256', typ: 'LAT', v: 1 });
const HEADER_KEYS = ['alg', 'typ', 'v'] as const;
const PAYLOAD_KEYS = [
  'issuer',
  'audience',
  'version',
  'tenant_id',
  'interaction_id',
  'media_session_id',
  'participant_id',
  'track_id',
  'purpose',
  'consent_ref',
  'source_language',
  'target_languages',
  'features',
  'audience_user_ids',
  'issued_at',
  'expires_at',
  'nonce'
] as const;
const FEATURES = new Set<RealtimeAudioTapFeature>([
  'streaming_asr',
  'streaming_translation',
  'language_detection',
  'speaker_diarization',
  'word_timestamps'
]);
const MAX_TOKEN_BYTES = 8_192;

export function createLiveKitRealtimeAudioTapTokenCodec(
  options: CodecOptions
): LiveKitRealtimeAudioTapTokenCodec {
  const secret = Buffer.from(options.secret);
  if (secret.length < 32 || secret.length > 128) throw tokenError('token_secret_invalid');
  const now = options.now ?? (() => new Date());
  const nonce = options.nonce ?? (() => randomBytes(18).toString('base64url'));
  const ttlSeconds = integer(options.ttl_seconds ?? 45, 10, 300, 'token_ttl_invalid');

  return {
    issue(input, issueOptions = {}) {
      const issuedAt = epochSeconds(now());
      const requestedExpiry = issueOptions.expires_at_epoch_seconds === undefined
        ? issuedAt + ttlSeconds
        : integer(
            issueOptions.expires_at_epoch_seconds,
            issuedAt + 1,
            Number.MAX_SAFE_INTEGER,
            'token_expiry_invalid'
          );
      const payload = normalizeClaims({
        ...input,
        issuer: 'ivekit',
        audience: 'livekit-audio-tap',
        version: 1,
        issued_at: issuedAt,
        expires_at: Math.min(issuedAt + ttlSeconds, requestedExpiry),
        nonce: boundedText(nonce(), 16, 128)
      });
      const header = encodeJson(HEADER);
      const body = encodeJson(payload);
      const signingInput = `${header}.${body}`;
      const token = `${signingInput}.${sign(signingInput, secret)}`;
      if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw tokenError('token_too_large');
      return token;
    },

    verify(input, expected = {}) {
      const token = String(input || '');
      if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
        throw tokenError('token_invalid');
      }
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
        throw tokenError('token_invalid');
      }
      const signingInput = `${parts[0]}.${parts[1]}`;
      const supplied = decodeBase64Url(parts[2], 64);
      const signature = Buffer.from(sign(signingInput, secret), 'base64url');
      if (supplied.length !== signature.length || !timingSafeEqual(supplied, signature)) {
        throw tokenError('token_signature_invalid');
      }
      const header = decodeJson(parts[0], 256);
      exactKeys(header, HEADER_KEYS);
      if (header.alg !== 'HS256' || header.typ !== 'LAT' || header.v !== 1) {
        throw tokenError('token_header_invalid');
      }
      const payload = normalizeClaims(decodeJson(parts[1], MAX_TOKEN_BYTES));
      const current = epochSeconds(now());
      if (payload.expires_at <= current) throw tokenError('token_expired');
      if (payload.issued_at > current + 5) throw tokenError('token_not_yet_valid');
      if (payload.expires_at - payload.issued_at > 300) {
        throw tokenError('token_lifetime_invalid');
      }
      if (expected.expected_media_session_id &&
          payload.media_session_id !== expected.expected_media_session_id) {
        throw tokenError('token_session_mismatch');
      }
      if (expected.expected_participant_id &&
          payload.participant_id !== expected.expected_participant_id) {
        throw tokenError('token_participant_mismatch');
      }
      if (expected.expected_track_id && payload.track_id !== expected.expected_track_id) {
        throw tokenError('token_track_mismatch');
      }
      return payload;
    }
  };
}

function normalizeClaims(input: unknown): VerifiedLiveKitRealtimeAudioTapTokenClaims {
  if (!record(input)) throw tokenError('token_claim_invalid');
  exactKeys(input, PAYLOAD_KEYS);
  if (input.issuer !== 'ivekit' || input.audience !== 'livekit-audio-tap' ||
      input.version !== 1) {
    throw tokenError('token_claim_invalid');
  }
  const purpose = input.purpose;
  if (purpose !== 'live_captions' && purpose !== 'live_translation') {
    throw tokenError('token_claim_invalid');
  }
  const sourceLanguage = language(input.source_language, true);
  const targetLanguages = unique(input.target_languages, language, 16);
  const features = unique(input.features, feature, 16);
  if (!features.includes('streaming_asr')) throw tokenError('token_claim_invalid');
  if (purpose === 'live_translation') {
    if (!features.includes('streaming_translation') || targetLanguages.length === 0) {
      throw tokenError('token_claim_invalid');
    }
  } else if (targetLanguages.length > 0 || features.includes('streaming_translation')) {
    throw tokenError('token_claim_invalid');
  }
  const audienceUserIds = unique(
    input.audience_user_ids,
    (value) => boundedText(value, 1, 128),
    64
  ).sort();
  if (audienceUserIds.length === 0) throw tokenError('token_claim_invalid');
  return {
    issuer: 'ivekit',
    audience: 'livekit-audio-tap',
    version: 1,
    tenant_id: boundedText(input.tenant_id, 1, 128),
    interaction_id: boundedText(input.interaction_id, 1, 256),
    media_session_id: boundedText(input.media_session_id, 1, 256),
    participant_id: boundedText(input.participant_id, 1, 128),
    track_id: boundedText(input.track_id, 1, 256),
    purpose,
    consent_ref: boundedText(input.consent_ref, 1, 256),
    source_language: sourceLanguage,
    target_languages: targetLanguages,
    features,
    audience_user_ids: audienceUserIds,
    issued_at: integer(input.issued_at, 0, Number.MAX_SAFE_INTEGER, 'token_claim_invalid'),
    expires_at: integer(input.expires_at, 1, Number.MAX_SAFE_INTEGER, 'token_claim_invalid'),
    nonce: boundedText(input.nonce, 16, 128)
  };
}

function unique<T>(
  value: unknown,
  normalize: (item: unknown, allowAuto?: boolean) => T,
  max: number
): T[] {
  if (!Array.isArray(value) || value.length > max) throw tokenError('token_claim_invalid');
  const output = value.map((item) => normalize(item, false));
  if (new Set(output).size !== output.length) throw tokenError('token_claim_invalid');
  return output;
}

function feature(value: unknown): RealtimeAudioTapFeature {
  if (typeof value !== 'string' || !FEATURES.has(value as RealtimeAudioTapFeature)) {
    throw tokenError('token_claim_invalid');
  }
  return value as RealtimeAudioTapFeature;
}

function language(value: unknown, allowAuto = false): string {
  const text = String(value || '').trim();
  if (allowAuto && (text === '' || text === 'auto')) return 'auto';
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(text)) {
    throw tokenError('token_claim_invalid');
  }
  return text;
}

function sign(input: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJson(value: string, maxBytes: number): Record<string, unknown> {
  const decoded = decodeBase64Url(value, maxBytes);
  try {
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    if (!record(parsed)) throw new Error('invalid');
    return parsed;
  } catch {
    throw tokenError('token_invalid');
  }
}

function decodeBase64Url(value: string, maxBytes: number): Buffer {
  if (!value || value.length > maxBytes * 2) throw tokenError('token_invalid');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.length > maxBytes) throw tokenError('token_invalid');
  return decoded;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length ||
      actual.some((key, index) => key !== allowed[index])) {
    throw tokenError('token_claim_invalid');
  }
}

function boundedText(value: unknown, min: number, max: number): string {
  const text = String(value || '').trim();
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw tokenError('token_claim_invalid');
  }
  return text;
}

function integer(value: unknown, min: number, max: number, code: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw tokenError(code);
  }
  return number;
}

function epochSeconds(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw tokenError('token_clock_invalid');
  return Math.floor(milliseconds / 1_000);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tokenError(code: string): Error {
  return Object.assign(new Error(code), { code });
}
