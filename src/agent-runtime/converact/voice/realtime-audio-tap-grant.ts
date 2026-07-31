import { createHash, randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import type { RealtimeAudioTapRouteAuthorizer } from './http.js';
import type {
  LiveKitRealtimeAudioTapTokenCodec
} from './livekit-realtime-audio-tap-token.js';
import type {
  RealtimeAudioTapFeature,
  RealtimeAudioTapPurpose,
  RealtimeAudioTapTokenCodec,
  RealtimeAudioTapTokenTrack
} from './realtime-audio-tap-token.js';

export type RealtimeAudioTapGrantStatus = 'active' | 'revoked';

export interface LiveKitRealtimeAudioTapGrantTrack {
  media_source: 'livekit';
  participant_id: string;
  track_id: string;
}

export type RealtimeAudioTapGrantTrack =
  | RealtimeAudioTapTokenTrack
  | LiveKitRealtimeAudioTapGrantTrack;

export interface RealtimeAudioTapGrant {
  id: string;
  tenant_id: string;
  interaction_id: string;
  media_session_id: string;
  purpose: RealtimeAudioTapPurpose;
  consent_ref: string;
  source_language: string;
  target_languages: string[];
  features: RealtimeAudioTapFeature[];
  tracks: RealtimeAudioTapGrantTrack[];
  status: RealtimeAudioTapGrantStatus;
  expires_at: string;
  request_hash: string;
  idempotency_key: string;
  created_by: string;
  revoked_by: string;
  revocation_reason: string;
  revision: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface CreateRealtimeAudioTapGrantInput {
  tenant_id: string;
  interaction_id: string;
  media_session_id: string;
  purpose: RealtimeAudioTapPurpose;
  consent_ref: string;
  source_language: string;
  target_languages: readonly string[];
  features: readonly RealtimeAudioTapFeature[];
  tracks: readonly RealtimeAudioTapGrantTrack[];
  expires_at: string;
  actor: string;
  idempotency_key: string;
}

export interface RealtimeAudioTapGrantRepository {
  replaceActive(grant: RealtimeAudioTapGrant): Promise<{
    grant: RealtimeAudioTapGrant;
    replayed: boolean;
  }>;
  findActive(input: {
    tenant_id: string;
    interaction_id: string;
    media_session_id: string;
    now: string;
  }): Promise<RealtimeAudioTapGrant | null>;
  list(input: {
    tenant_id: string;
    interaction_id: string;
    limit: number;
    cursor: string;
  }): Promise<{ items: RealtimeAudioTapGrant[]; next_cursor: string | null }>;
  revoke(input: {
    tenant_id: string;
    interaction_id: string;
    grant_id: string;
    expected_revision: number;
    actor: string;
    reason: string;
    now: string;
  }): Promise<RealtimeAudioTapGrant | null>;
}

export class RealtimeAudioTapGrantService {
  readonly #repository: RealtimeAudioTapGrantRepository;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(options: {
    repository: RealtimeAudioTapGrantRepository;
    now?: () => Date;
    id?: () => string;
  }) {
    if (!options?.repository) throw grantError('audio_tap_grant_invalid', 422);
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? (() => `ratg_${randomUUID().replaceAll('-', '')}`);
  }

  async grant(input: CreateRealtimeAudioTapGrantInput): Promise<{
    grant: RealtimeAudioTapGrant;
    replayed: boolean;
  }> {
    const now = validDate(this.#now(), 'audio_tap_grant_clock_invalid');
    const value = normalizeGrantInput(input, now);
    const requestHash = sha256({
      tenant_id: value.tenant_id,
      interaction_id: value.interaction_id,
      media_session_id: value.media_session_id,
      purpose: value.purpose,
      consent_ref: value.consent_ref,
      source_language: value.source_language,
      target_languages: value.target_languages,
      features: value.features,
      tracks: value.tracks,
      expires_at: value.expires_at,
      created_by: value.actor
    });
    const result = await this.#repository.replaceActive({
      id: identifier(this.#id(), 128),
      tenant_id: value.tenant_id,
      interaction_id: value.interaction_id,
      media_session_id: value.media_session_id,
      purpose: value.purpose,
      consent_ref: value.consent_ref,
      source_language: value.source_language,
      target_languages: value.target_languages,
      features: value.features,
      tracks: value.tracks,
      status: 'active',
      expires_at: value.expires_at,
      request_hash: requestHash,
      idempotency_key: value.idempotency_key,
      created_by: value.actor,
      revoked_by: '',
      revocation_reason: '',
      revision: 1,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      revoked_at: null
    });
    if (result.replayed && result.grant.request_hash !== requestHash) {
      throw grantError('audio_tap_grant_idempotency_conflict', 409);
    }
    return result;
  }

  async revoke(input: {
    tenant_id: string;
    interaction_id: string;
    grant_id: string;
    expected_revision: number;
    actor: string;
    reason: string;
  }): Promise<RealtimeAudioTapGrant> {
    const grant = await this.#repository.revoke({
      tenant_id: identifier(input.tenant_id, 128),
      interaction_id: identifier(input.interaction_id, 256),
      grant_id: identifier(input.grant_id, 128),
      expected_revision: integer(input.expected_revision, 1, Number.MAX_SAFE_INTEGER),
      actor: identifier(input.actor, 128),
      reason: boundedText(input.reason, 1, 128),
      now: validDate(this.#now(), 'audio_tap_grant_clock_invalid').toISOString()
    });
    if (!grant) throw grantError('audio_tap_grant_not_found', 404);
    return grant;
  }

  list(input: {
    tenant_id: string;
    interaction_id: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: RealtimeAudioTapGrant[]; next_cursor: string | null }> {
    return this.#repository.list({
      tenant_id: identifier(input.tenant_id, 128),
      interaction_id: identifier(input.interaction_id, 256),
      limit: integer(input.limit ?? 50, 1, 200),
      cursor: input.cursor ? identifier(input.cursor, 128) : ''
    });
  }
}

export class RealtimeAudioTapGrantAuthorizer implements RealtimeAudioTapRouteAuthorizer {
  readonly #now: () => Date;

  constructor(private readonly options: {
    repository: Pick<RealtimeAudioTapGrantRepository, 'findActive'>;
    token_codec: RealtimeAudioTapTokenCodec;
    now?: () => Date;
  }) {
    if (!options?.repository || !options.token_codec) {
      throw grantError('audio_tap_grant_invalid', 422);
    }
    this.#now = options.now ?? (() => new Date());
  }

  async authorize(input: {
    tenant_id: string;
    interaction_id: string;
    media_session_id: string;
  }): Promise<string | null> {
    const now = validDate(this.#now(), 'audio_tap_grant_clock_invalid');
    const grant = await this.options.repository.findActive({
      tenant_id: identifier(input.tenant_id, 128),
      interaction_id: identifier(input.interaction_id, 256),
      media_session_id: identifier(input.media_session_id, 256),
      now: now.toISOString()
    });
    if (!grant) return null;
    const rustPbxTracks = grant.tracks.filter(isRustPbxGrantTrack);
    if (rustPbxTracks.length === 0) return null;
    const expiresAt = Math.floor(new Date(grant.expires_at).getTime() / 1_000);
    return this.options.token_codec.issue({
      tenant_id: grant.tenant_id,
      interaction_id: grant.interaction_id,
      media_session_id: grant.media_session_id,
      purpose: grant.purpose,
      consent_ref: grant.consent_ref,
      source_language: grant.source_language,
      target_languages: [...grant.target_languages],
      features: [...grant.features],
      tracks: rustPbxTracks.map((track) => ({ ...track }))
    }, {
      expires_at_epoch_seconds: expiresAt
    });
  }
}

export class LiveKitRealtimeAudioTapGrantAuthorizer {
  readonly #now: () => Date;

  constructor(private readonly options: {
    repository: Pick<RealtimeAudioTapGrantRepository, 'findActive'>;
    token_codec: LiveKitRealtimeAudioTapTokenCodec;
    now?: () => Date;
  }) {
    if (!options?.repository || !options.token_codec) {
      throw grantError('audio_tap_grant_invalid', 422);
    }
    this.#now = options.now ?? (() => new Date());
  }

  async authorize(input: {
    tenant_id: string;
    interaction_id: string;
    media_session_id: string;
    participant_id: string;
    track_id: string;
  }): Promise<string | null> {
    const now = validDate(this.#now(), 'audio_tap_grant_clock_invalid');
    const tenantId = identifier(input.tenant_id, 128);
    const interactionId = identifier(input.interaction_id, 256);
    const mediaSessionId = identifier(input.media_session_id, 256);
    const participantId = identifier(input.participant_id, 128);
    const trackId = identifier(input.track_id, 256);
    const grant = await this.options.repository.findActive({
      tenant_id: tenantId,
      interaction_id: interactionId,
      media_session_id: mediaSessionId,
      now: now.toISOString()
    });
    if (!grant) return null;
    const liveKitTracks = grant.tracks.filter(isLiveKitGrantTrack);
    const allowed = liveKitTracks.some((track) =>
      track.participant_id === participantId &&
      (track.track_id === '*' || track.track_id === trackId)
    );
    if (!allowed) return null;
    const expiresAt = Math.floor(new Date(grant.expires_at).getTime() / 1_000);
    return this.options.token_codec.issue({
      tenant_id: grant.tenant_id,
      interaction_id: grant.interaction_id,
      media_session_id: grant.media_session_id,
      participant_id: participantId,
      track_id: trackId,
      purpose: grant.purpose,
      consent_ref: grant.consent_ref,
      source_language: grant.source_language,
      target_languages: [...grant.target_languages],
      features: [...grant.features],
      audience_user_ids: [...new Set(
        liveKitTracks.map((track) => track.participant_id)
      )].sort()
    }, {
      expires_at_epoch_seconds: expiresAt
    });
  }
}

export class PostgresRealtimeAudioTapGrantRepository
implements RealtimeAudioTapGrantRepository {
  constructor(private readonly pg: PgQueryable) {}

  replaceActive(grant: RealtimeAudioTapGrant): Promise<{
    grant: RealtimeAudioTapGrant;
    replayed: boolean;
  }> {
    return withPgTenant(this.pg, grant.tenant_id, async (pg) => {
      const replay = await pg.query(
        `SELECT * FROM ivekit_realtime_audio_tap_grants
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [grant.tenant_id, grant.idempotency_key]
      );
      if (replay.rows[0]) return {
        grant: decodeGrant(replay.rows[0]),
        replayed: true
      };
      await pg.query(
        `UPDATE ivekit_realtime_audio_tap_grants
         SET status = 'revoked', revoked_by = $3,
             revocation_reason = 'superseded', revoked_at = $4::TIMESTAMPTZ,
             updated_at = $4::TIMESTAMPTZ, revision = revision + 1
         WHERE tenant_id = $1 AND media_session_id = $2 AND status = 'active'`,
        [grant.tenant_id, grant.media_session_id, grant.created_by, grant.created_at]
      );
      const inserted = await pg.query(
        `INSERT INTO ivekit_realtime_audio_tap_grants
          (id, tenant_id, interaction_id, media_session_id, purpose, consent_ref,
           source_language, target_languages, features, tracks, status, expires_at,
           request_hash, idempotency_key, created_by, revoked_by,
           revocation_reason, revision, created_at, updated_at, revoked_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8::TEXT[], $9::TEXT[], $10::JSONB,
           $11, $12::TIMESTAMPTZ, $13, $14, $15, $16, $17, $18,
           $19::TIMESTAMPTZ, $20::TIMESTAMPTZ, $21::TIMESTAMPTZ)
         RETURNING *`,
        [
          grant.id, grant.tenant_id, grant.interaction_id, grant.media_session_id,
          grant.purpose, grant.consent_ref, grant.source_language,
          grant.target_languages, grant.features, JSON.stringify(grant.tracks),
          grant.status, grant.expires_at, grant.request_hash, grant.idempotency_key,
          grant.created_by, grant.revoked_by, grant.revocation_reason, grant.revision,
          grant.created_at, grant.updated_at, grant.revoked_at
        ]
      );
      if (!inserted.rows[0]) throw grantError('audio_tap_grant_write_failed', 503);
      return { grant: decodeGrant(inserted.rows[0]), replayed: false };
    });
  }

  findActive(input: {
    tenant_id: string;
    interaction_id: string;
    media_session_id: string;
    now: string;
  }): Promise<RealtimeAudioTapGrant | null> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM ivekit_realtime_audio_tap_grants
         WHERE tenant_id = $1 AND interaction_id = $2 AND media_session_id = $3
           AND status = 'active' AND expires_at > $4::TIMESTAMPTZ
         ORDER BY created_at DESC
         LIMIT 1`,
        [input.tenant_id, input.interaction_id, input.media_session_id, input.now]
      );
      return result.rows[0] ? decodeGrant(result.rows[0]) : null;
    });
  }

  list(input: {
    tenant_id: string;
    interaction_id: string;
    limit: number;
    cursor: string;
  }): Promise<{ items: RealtimeAudioTapGrant[]; next_cursor: string | null }> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM ivekit_realtime_audio_tap_grants
         WHERE tenant_id = $1 AND interaction_id = $2
           AND ($3 = '' OR id < $3)
         ORDER BY created_at DESC, id DESC
         LIMIT $4`,
        [input.tenant_id, input.interaction_id, input.cursor, input.limit]
      );
      const items = result.rows.map(decodeGrant);
      return {
        items,
        next_cursor: items.length === input.limit ? items.at(-1)?.id || null : null
      };
    });
  }

  revoke(input: {
    tenant_id: string;
    interaction_id: string;
    grant_id: string;
    expected_revision: number;
    actor: string;
    reason: string;
    now: string;
  }): Promise<RealtimeAudioTapGrant | null> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `UPDATE ivekit_realtime_audio_tap_grants
         SET status = 'revoked', revoked_by = $5, revocation_reason = $6,
             revoked_at = $7::TIMESTAMPTZ, updated_at = $7::TIMESTAMPTZ,
             revision = revision + 1
         WHERE tenant_id = $1 AND interaction_id = $2 AND id = $3
           AND revision = $4 AND status = 'active'
         RETURNING *`,
        [
          input.tenant_id, input.interaction_id, input.grant_id,
          input.expected_revision, input.actor, input.reason, input.now
        ]
      );
      return result.rows[0] ? decodeGrant(result.rows[0]) : null;
    });
  }
}

function normalizeGrantInput(
  input: CreateRealtimeAudioTapGrantInput,
  now: Date
): CreateRealtimeAudioTapGrantInput & {
  target_languages: string[];
  features: RealtimeAudioTapFeature[];
  tracks: RealtimeAudioTapGrantTrack[];
} {
  if (!input || typeof input !== 'object') throw grantError('audio_tap_grant_invalid', 422);
  const purpose = input.purpose;
  if (purpose !== 'live_captions' && purpose !== 'live_translation') {
    throw grantError('audio_tap_grant_invalid', 422);
  }
  const targetLanguages = unique(input.target_languages, language);
  const features = unique(input.features, feature);
  if (!features.includes('streaming_asr')) throw grantError('audio_tap_grant_invalid', 422);
  if (purpose === 'live_translation') {
    if (!features.includes('streaming_translation') || targetLanguages.length === 0) {
      throw grantError('audio_tap_grant_invalid', 422);
    }
  } else if (targetLanguages.length > 0 || features.includes('streaming_translation')) {
    throw grantError('audio_tap_grant_invalid', 422);
  }
  if (!Array.isArray(input.tracks) || input.tracks.length < 1 || input.tracks.length > 64) {
    throw grantError('audio_tap_grant_invalid', 422);
  }
  const legs = new Set<string>();
  const liveKitTracks = new Set<string>();
  let mediaSource: 'rustpbx' | 'livekit' | null = null;
  const tracks = input.tracks.map((track) => {
    if (!track || typeof track !== 'object') {
      throw grantError('audio_tap_grant_invalid', 422);
    }
    if (isLiveKitGrantTrack(track)) {
      if (mediaSource === 'rustpbx') throw grantError('audio_tap_grant_invalid', 422);
      mediaSource = 'livekit';
      const participantId = identifier(track.participant_id, 128);
      const trackId = track.track_id === '*' ? '*' : identifier(track.track_id, 256);
      const key = `${participantId}\u0000${trackId}`;
      if (liveKitTracks.has(key)) throw grantError('audio_tap_grant_invalid', 422);
      liveKitTracks.add(key);
      return {
        media_source: 'livekit' as const,
        participant_id: participantId,
        track_id: trackId
      };
    }
    if (mediaSource === 'livekit' || !isRustPbxGrantTrack(track) ||
        legs.has(track.leg)) {
      throw grantError('audio_tap_grant_invalid', 422);
    }
    mediaSource = 'rustpbx';
    legs.add(track.leg);
    return {
      leg: track.leg,
      participant_id: identifier(track.participant_id, 128),
      track_id: identifier(track.track_id, 256)
    };
  });
  if (mediaSource === 'rustpbx' && tracks.length > 2) {
    throw grantError('audio_tap_grant_invalid', 422);
  }
  const expires = timestamp(input.expires_at);
  const lifetimeMs = new Date(expires).getTime() - now.getTime();
  if (lifetimeMs < 10_000 || lifetimeMs > 28_800_000) {
    throw grantError('audio_tap_grant_invalid', 422);
  }
  return {
    tenant_id: identifier(input.tenant_id, 128),
    interaction_id: identifier(input.interaction_id, 256),
    media_session_id: identifier(input.media_session_id, 256),
    purpose,
    consent_ref: identifier(input.consent_ref, 256),
    source_language: language(input.source_language),
    target_languages: targetLanguages,
    features,
    tracks,
    expires_at: expires,
    actor: identifier(input.actor, 128),
    idempotency_key: idempotencyKey(input.idempotency_key)
  };
}

function decodeGrant(row: Record<string, unknown>): RealtimeAudioTapGrant {
  const tracks = typeof row.tracks === 'string' ? JSON.parse(row.tracks) : row.tracks;
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    interaction_id: String(row.interaction_id),
    media_session_id: String(row.media_session_id),
    purpose: String(row.purpose) as RealtimeAudioTapPurpose,
    consent_ref: String(row.consent_ref),
    source_language: String(row.source_language),
    target_languages: stringArray(row.target_languages),
    features: stringArray(row.features) as RealtimeAudioTapFeature[],
    tracks: Array.isArray(tracks)
      ? tracks.map((track) => ({ ...(track as RealtimeAudioTapGrantTrack) }))
      : [],
    status: String(row.status) as RealtimeAudioTapGrantStatus,
    expires_at: iso(row.expires_at),
    request_hash: String(row.request_hash),
    idempotency_key: String(row.idempotency_key),
    created_by: String(row.created_by),
    revoked_by: String(row.revoked_by || ''),
    revocation_reason: String(row.revocation_reason || ''),
    revision: Number(row.revision),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    revoked_at: row.revoked_at ? iso(row.revoked_at) : null
  };
}

function unique<T>(value: readonly unknown[], normalize: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw grantError('audio_tap_grant_invalid', 422);
  }
  const output = value.map(normalize);
  if (new Set(output).size !== output.length) {
    throw grantError('audio_tap_grant_invalid', 422);
  }
  return output;
}

function feature(value: unknown): RealtimeAudioTapFeature {
  const allowed: RealtimeAudioTapFeature[] = [
    'streaming_asr',
    'streaming_translation',
    'language_detection',
    'speaker_diarization',
    'word_timestamps'
  ];
  if (!allowed.includes(value as RealtimeAudioTapFeature)) {
    throw grantError('audio_tap_grant_invalid', 422);
  }
  return value as RealtimeAudioTapFeature;
}

function language(value: unknown): string {
  const input = String(value || '').trim();
  if (input.toLowerCase() === 'auto') return 'auto';
  try {
    const normalized = Intl.getCanonicalLocales(input)[0];
    if (!normalized || normalized.length > 64) throw new Error('invalid');
    return normalized;
  } catch {
    throw grantError('audio_tap_grant_invalid', 422);
  }
}

function identifier(value: unknown, max: number): string {
  return boundedText(value, 1, max);
}

function boundedText(value: unknown, min: number, max: number): string {
  const text = String(value || '').trim();
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw grantError('audio_tap_grant_invalid', 422);
  }
  return text;
}

function idempotencyKey(value: unknown): string {
  const key = String(value || '');
  if (key.length < 1 || key.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/.test(key)) {
    throw grantError('audio_tap_grant_invalid', 422);
  }
  return key;
}

function timestamp(value: unknown): string {
  return validDate(new Date(String(value || '')), 'audio_tap_grant_invalid').toISOString();
}

function validDate(value: Date, code: string): Date {
  if (!Number.isFinite(value.getTime())) throw grantError(code, 422);
  return value;
}

function integer(value: unknown, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw grantError('audio_tap_grant_invalid', 422);
  }
  return number;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function isLiveKitGrantTrack(
  value: RealtimeAudioTapGrantTrack | Record<string, unknown>
): value is LiveKitRealtimeAudioTapGrantTrack {
  return 'media_source' in value && value.media_source === 'livekit';
}

function isRustPbxGrantTrack(
  value: RealtimeAudioTapGrantTrack | Record<string, unknown>
): value is RealtimeAudioTapTokenTrack {
  return !('media_source' in value) &&
    (value.leg === 'caller' || value.leg === 'callee');
}

function grantError(code: string, status: number): Error {
  return Object.assign(new Error(code), { code, status });
}
