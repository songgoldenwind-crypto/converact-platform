import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type RealtimeAudioTapPurpose = 'live_captions' | 'live_translation';
export type RealtimeAudioTapTrackLeg = 'caller' | 'callee';
export type RealtimeAudioTapFeature =
  | 'streaming_asr'
  | 'streaming_translation'
  | 'language_detection'
  | 'speaker_diarization'
  | 'word_timestamps';

export interface RealtimeAudioTapTokenTrack {
  leg: RealtimeAudioTapTrackLeg;
  participant_id: string;
  track_id: string;
}

export interface RealtimeAudioTapTokenClaims {
  tenant_id: string;
  interaction_id: string;
  media_session_id: string;
  purpose: RealtimeAudioTapPurpose;
  consent_ref: string;
  source_language: string;
  target_languages: string[];
  features: RealtimeAudioTapFeature[];
  tracks: RealtimeAudioTapTokenTrack[];
}

export interface VerifiedRealtimeAudioTapTokenClaims
  extends RealtimeAudioTapTokenClaims {
  issuer: 'converact';
  audience: 'rustpbx-audio-tap';
  version: 1;
  issued_at: number;
  expires_at: number;
  nonce: string;
}

export interface RealtimeAudioTapTokenCodec {
  issue(
    claims: RealtimeAudioTapTokenClaims,
    options?: { expires_at_epoch_seconds?: number }
  ): string;
  verify(
    token: string,
    options?: { expected_media_session_id?: string }
  ): VerifiedRealtimeAudioTapTokenClaims;
}

interface TokenCodecOptions {
  secret: Uint8Array;
  now?: () => Date;
  nonce?: () => string;
  ttl_seconds?: number;
}

const TOKEN_HEADER = Object.freeze({ alg: 'HS256', typ: 'IAT', v: 1 });
const TOKEN_HEADER_KEYS = ['alg', 'typ', 'v'] as const;
const TOKEN_PAYLOAD_KEYS = [
  'issuer',
  'audience',
  'version',
  'tenant_id',
  'interaction_id',
  'media_session_id',
  'purpose',
  'consent_ref',
  'source_language',
  'target_languages',
  'features',
  'tracks',
  'issued_at',
  'expires_at',
  'nonce'
] as const;
const TOKEN_TRACK_KEYS = ['leg', 'participant_id', 'track_id'] as const;
const FEATURE_VALUES = new Set<RealtimeAudioTapFeature>([
  'streaming_asr',
  'streaming_translation',
  'language_detection',
  'speaker_diarization',
  'word_timestamps'
]);
const MAX_TOKEN_BYTES = 2_048;

export function createRealtimeAudioTapTokenCodec(
  options: TokenCodecOptions
): RealtimeAudioTapTokenCodec {
  const secret = Buffer.from(options.secret);
  if (secret.length < 32 || secret.length > 128) throw tokenError('token_secret_invalid');
  const now = options.now ?? (() => new Date());
  const nonce = options.nonce ?? (() => randomBytes(18).toString('base64url'));
  const ttlSeconds = integer(options.ttl_seconds ?? 60, 10, 300, 'token_ttl_invalid');

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
        issuer: 'converact',
        audience: 'rustpbx-audio-tap',
        version: 1,
        issued_at: issuedAt,
        expires_at: Math.min(issuedAt + ttlSeconds, requestedExpiry),
        nonce: boundedText(nonce(), 16, 128)
      });
      const header = encodeJson(TOKEN_HEADER);
      const body = encodeJson(payload);
      const signingInput = `${header}.${body}`;
      const signature = sign(signingInput, secret);
      const token = `${signingInput}.${signature}`;
      if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw tokenError('token_too_large');
      return token;
    },

    verify(input, verifyOptions = {}) {
      const token = String(input || '');
      if (token.length === 0 || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
        throw tokenError('token_invalid');
      }
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
        throw tokenError('token_invalid');
      }
      const signingInput = `${parts[0]}.${parts[1]}`;
      const supplied = decodeBase64Url(parts[2], 64);
      const expected = Buffer.from(sign(signingInput, secret), 'base64url');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw tokenError('token_signature_invalid');
      }
      const header = decodeJson(parts[0], 256);
      assertExactKeys(header, TOKEN_HEADER_KEYS);
      if (header.alg !== 'HS256' || header.typ !== 'IAT' || header.v !== 1) {
        throw tokenError('token_header_invalid');
      }
      const payload = normalizeClaims(decodeJson(parts[1], MAX_TOKEN_BYTES));
      const current = epochSeconds(now());
      if (payload.expires_at <= current) throw tokenError('token_expired');
      if (payload.issued_at > current + 5) throw tokenError('token_not_yet_valid');
      if (payload.expires_at - payload.issued_at > 300) throw tokenError('token_lifetime_invalid');
      const expectedSession = verifyOptions.expected_media_session_id;
      if (expectedSession && payload.media_session_id !== expectedSession) {
        throw tokenError('token_session_mismatch');
      }
      return payload;
    }
  };
}

function normalizeClaims(input: unknown): VerifiedRealtimeAudioTapTokenClaims {
  if (!isRecord(input)) throw tokenError('token_claim_invalid');
  assertExactKeys(input, TOKEN_PAYLOAD_KEYS);
  if (input.issuer !== 'converact' || input.audience !== 'rustpbx-audio-tap' || input.version !== 1) {
    throw tokenError('token_claim_invalid');
  }
  const purpose = input.purpose;
  if (purpose !== 'live_captions' && purpose !== 'live_translation') {
    throw tokenError('token_claim_invalid');
  }
  const sourceLanguage = language(input.source_language, true);
  const targetLanguages = uniqueArray(input.target_languages, language);
  const features = uniqueArray(input.features, feature);
  if (!features.includes('streaming_asr')) throw tokenError('token_claim_invalid');
  if (purpose === 'live_translation') {
    if (!features.includes('streaming_translation') || targetLanguages.length === 0) {
      throw tokenError('token_claim_invalid');
    }
  } else if (targetLanguages.length > 0 || features.includes('streaming_translation')) {
    throw tokenError('token_claim_invalid');
  }
  if (!Array.isArray(input.tracks) || input.tracks.length < 1 || input.tracks.length > 2) {
    throw tokenError('token_claim_invalid');
  }
  const legs = new Set<string>();
  const tracks = input.tracks.map((value) => {
    if (!isRecord(value)) throw tokenError('token_claim_invalid');
    assertExactKeys(value, TOKEN_TRACK_KEYS);
    if (value.leg !== 'caller' && value.leg !== 'callee') {
      throw tokenError('token_claim_invalid');
    }
    if (legs.has(value.leg)) throw tokenError('token_claim_invalid');
    legs.add(value.leg);
    return {
      leg: value.leg as RealtimeAudioTapTrackLeg,
      participant_id: boundedText(value.participant_id, 1, 128),
      track_id: boundedText(value.track_id, 1, 256)
    };
  });
  return {
    issuer: 'converact',
    audience: 'rustpbx-audio-tap',
    version: 1,
    tenant_id: boundedText(input.tenant_id, 1, 128),
    interaction_id: boundedText(input.interaction_id, 1, 128),
    media_session_id: boundedText(input.media_session_id, 1, 256),
    purpose,
    consent_ref: boundedText(input.consent_ref, 1, 256),
    source_language: sourceLanguage,
    target_languages: targetLanguages,
    features,
    tracks,
    issued_at: integer(input.issued_at, 0, Number.MAX_SAFE_INTEGER, 'token_claim_invalid'),
    expires_at: integer(input.expires_at, 1, Number.MAX_SAFE_INTEGER, 'token_claim_invalid'),
    nonce: boundedText(input.nonce, 16, 128)
  };
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
    if (!isRecord(parsed)) throw new Error('not an object');
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

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): void {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw tokenError('token_claim_invalid');
  }
}

function uniqueArray<T>(
  value: unknown,
  normalize: (item: unknown, allowAuto?: boolean) => T
): T[] {
  if (!Array.isArray(value) || value.length > 16) throw tokenError('token_claim_invalid');
  const normalized = value.map((item) => normalize(item, false));
  if (new Set(normalized).size !== normalized.length) throw tokenError('token_claim_invalid');
  return normalized;
}

function feature(value: unknown): RealtimeAudioTapFeature {
  if (typeof value !== 'string' || !FEATURE_VALUES.has(value as RealtimeAudioTapFeature)) {
    throw tokenError('token_claim_invalid');
  }
  return value as RealtimeAudioTapFeature;
}

function language(value: unknown, allowAuto = false): string {
  const normalized = String(value || '').trim();
  if (allowAuto && (normalized === '' || normalized === 'auto')) return 'auto';
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(normalized)) {
    throw tokenError('token_claim_invalid');
  }
  return normalized;
}

function boundedText(value: unknown, min: number, max: number): string {
  const text = String(value || '').trim();
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw tokenError('token_claim_invalid');
  }
  return text;
}

function integer(
  value: unknown,
  min: number,
  max: number,
  code: string
): number {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tokenError(code: string): Error {
  return new Error(code);
}
