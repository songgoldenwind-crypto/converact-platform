import { createHash } from 'node:crypto';

import { pgId, type PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import type {
  RealtimeSpeechMediaSource,
  RealtimeSpeechPurpose
} from './realtime-speech-translation.js';

export type RealtimeSpeechSegmentKind = 'transcript' | 'translation';

export interface RealtimeSpeechFinalSegmentInput {
  tenant_id: string;
  interaction_id: string;
  media_session_id: string;
  media_source: RealtimeSpeechMediaSource;
  participant_id: string;
  track_id: string;
  purpose: RealtimeSpeechPurpose;
  consent_ref: string;
  provider_profile_id: string;
  provider: string;
  provider_version: string;
  source_event_id: string;
  provider_session_id: string;
  sequence: number;
  kind: RealtimeSpeechSegmentKind;
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
  occurred_at: string;
  retention_until: string;
}

export interface RealtimeSpeechFinalSegment extends RealtimeSpeechFinalSegmentInput {
  id: string;
  created_at: string;
}

export interface RealtimeSpeechSegmentPage {
  items: RealtimeSpeechFinalSegment[];
  next_cursor: string;
  has_more: boolean;
}

export interface RealtimeSpeechStorePort {
  upsertFinal(input: RealtimeSpeechFinalSegmentInput): Promise<{
    segment: RealtimeSpeechFinalSegment;
    replayed: boolean;
  }>;
  list(input: {
    tenant_id: string;
    interaction_id: string;
    limit?: number;
    cursor?: string;
  }): Promise<RealtimeSpeechSegmentPage>;
  deleteByInteraction(input: { tenant_id: string; interaction_id: string }): Promise<number>;
}

export class RealtimeSpeechStore implements RealtimeSpeechStorePort {
  constructor(private readonly pg: PgQueryable) {}

  async upsertFinal(input: RealtimeSpeechFinalSegmentInput): Promise<{
    segment: RealtimeSpeechFinalSegment;
    replayed: boolean;
  }> {
    const value = normalizeFinal(input);
    const sourceHash = payloadHash(value);
    return withPgTenant(this.pg, value.tenant_id, async (pg) => {
      const inserted = await pg.query(
        `INSERT INTO ivekit_realtime_speech_segments
          (id, tenant_id, interaction_id, media_session_id, media_source,
           participant_id, track_id, purpose, consent_ref, provider_profile_id,
           provider, provider_version, source_event_id, provider_session_id,
           sequence, kind, segment_id, speaker_id, source_language, target_language,
           source_text, translated_text, confidence, start_ms, end_ms,
           provider_request_id, latency_ms, safe_metadata, source_hash,
           occurred_at, retention_until)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
           $21, $22, $23, $24, $25, $26, $27::JSONB, $28::JSONB, $29,
           $30::TIMESTAMPTZ, $31::TIMESTAMPTZ)
         ON CONFLICT (
           tenant_id, interaction_id, provider_session_id, segment_id, kind, target_language
         ) DO NOTHING
         RETURNING *`,
        [
          pgId('rtsg'), value.tenant_id, value.interaction_id, value.media_session_id,
          value.media_source, value.participant_id, value.track_id, value.purpose,
          value.consent_ref, value.provider_profile_id, value.provider,
          value.provider_version, value.source_event_id, value.provider_session_id,
          value.sequence, value.kind, value.segment_id, value.speaker_id,
          value.source_language, value.target_language, value.source_text,
          value.translated_text, value.confidence ?? null, value.start_ms ?? null,
          value.end_ms ?? null, value.provider_request_id,
          JSON.stringify(value.latency_ms), JSON.stringify(value.safe_metadata), sourceHash,
          value.occurred_at, value.retention_until
        ]
      );
      if (inserted.rows[0]) return { segment: decodeSegment(inserted.rows[0]), replayed: false };
      const existing = await pg.query(
        `SELECT * FROM ivekit_realtime_speech_segments
         WHERE tenant_id = $1 AND interaction_id = $2 AND provider_session_id = $3
           AND segment_id = $4 AND kind = $5 AND target_language = $6`,
        [
          value.tenant_id, value.interaction_id, value.provider_session_id,
          value.segment_id, value.kind, value.target_language
        ]
      );
      if (!existing.rows[0] || String(existing.rows[0].source_hash) !== sourceHash) {
        throw conflict('realtime speech final segment identity conflict');
      }
      return { segment: decodeSegment(existing.rows[0]), replayed: true };
    });
  }

  async list(input: {
    tenant_id: string;
    interaction_id: string;
    limit?: number;
    cursor?: string;
  }): Promise<RealtimeSpeechSegmentPage> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const interactionId = identifier(input.interaction_id, 'interaction_id');
    const limit = boundedInteger(input.limit ?? 100, 1, 500, 'limit');
    const cursor = decodeCursor(input.cursor || '');
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM ivekit_realtime_speech_segments
         WHERE tenant_id = $1 AND interaction_id = $2
           AND ($3::TIMESTAMPTZ IS NULL OR (occurred_at, id) > ($3::TIMESTAMPTZ, $4))
         ORDER BY occurred_at, id
         LIMIT $5`,
        [tenantId, interactionId, cursor.occurred_at, cursor.id, limit + 1]
      );
      const hasMore = result.rows.length > limit;
      const items = result.rows.slice(0, limit).map(decodeSegment);
      const last = items.at(-1);
      return {
        items,
        next_cursor: last ? encodeCursor(last.occurred_at, last.id) : '',
        has_more: hasMore
      };
    });
  }

  async deleteByInteraction(input: { tenant_id: string; interaction_id: string }): Promise<number> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const interactionId = identifier(input.interaction_id, 'interaction_id');
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query(
        `DELETE FROM ivekit_realtime_speech_segments
         WHERE tenant_id = $1 AND interaction_id = $2
         RETURNING id`,
        [tenantId, interactionId]
      );
      return result.rowCount ?? result.rows.length;
    });
  }
}

function normalizeFinal(input: RealtimeSpeechFinalSegmentInput): RealtimeSpeechFinalSegmentInput {
  if (!input || typeof input !== 'object') throw validationError('final segment is required');
  const kind = String(input.kind || '') as RealtimeSpeechSegmentKind;
  if (kind !== 'transcript' && kind !== 'translation') throw validationError('kind is invalid');
  const sourceText = boundedText(input.source_text, 65_536, 'source_text', kind === 'translation');
  const translatedText = boundedText(input.translated_text, 65_536, 'translated_text', kind === 'transcript');
  if (kind === 'translation' && (!sourceText || !translatedText || !input.target_language)) {
    throw validationError('translation final content is incomplete');
  }
  if (kind === 'transcript' && !sourceText) throw validationError('transcript final content is incomplete');
  const startMs = optionalInteger(input.start_ms, 0, 86_400_000, 'start_ms');
  const endMs = optionalInteger(input.end_ms, 0, 86_400_000, 'end_ms');
  if (startMs !== undefined && endMs !== undefined && endMs < startMs) {
    throw validationError('segment timeline is invalid');
  }
  return {
    tenant_id: identifier(input.tenant_id, 'tenant_id'),
    interaction_id: identifier(input.interaction_id, 'interaction_id'),
    media_session_id: identifier(input.media_session_id, 'media_session_id'),
    media_source: mediaSource(input.media_source),
    participant_id: identifier(input.participant_id, 'participant_id'),
    track_id: identifier(input.track_id, 'track_id'),
    purpose: purpose(input.purpose),
    consent_ref: identifier(input.consent_ref, 'consent_ref'),
    provider_profile_id: providerId(input.provider_profile_id, 'provider_profile_id'),
    provider: providerId(input.provider, 'provider'),
    provider_version: boundedText(input.provider_version, 64, 'provider_version'),
    source_event_id: identifier(input.source_event_id, 'source_event_id'),
    provider_session_id: identifier(input.provider_session_id, 'provider_session_id'),
    sequence: boundedInteger(input.sequence, 0, Number.MAX_SAFE_INTEGER, 'sequence'),
    kind,
    segment_id: identifier(input.segment_id, 'segment_id'),
    speaker_id: optionalIdentifier(input.speaker_id, 'speaker_id'),
    source_language: language(input.source_language, false),
    target_language: language(input.target_language, kind === 'transcript'),
    source_text: sourceText,
    translated_text: translatedText,
    ...(input.confidence === undefined ? {} : { confidence: confidence(input.confidence) }),
    ...(startMs === undefined ? {} : { start_ms: startMs }),
    ...(endMs === undefined ? {} : { end_ms: endMs }),
    provider_request_id: optionalIdentifier(input.provider_request_id, 'provider_request_id'),
    latency_ms: numericRecord(input.latency_ms),
    safe_metadata: jsonRecord(input.safe_metadata),
    occurred_at: timestamp(input.occurred_at, 'occurred_at'),
    retention_until: timestamp(input.retention_until, 'retention_until')
  };
}

function payloadHash(value: RealtimeSpeechFinalSegmentInput): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function decodeSegment(row: Record<string, unknown>): RealtimeSpeechFinalSegment {
  const normalized = normalizeFinal({
    tenant_id: String(row.tenant_id), interaction_id: String(row.interaction_id),
    media_session_id: String(row.media_session_id), media_source: String(row.media_source) as RealtimeSpeechMediaSource,
    participant_id: String(row.participant_id), track_id: String(row.track_id),
    purpose: String(row.purpose) as RealtimeSpeechPurpose, consent_ref: String(row.consent_ref),
    provider_profile_id: String(row.provider_profile_id), provider: String(row.provider),
    provider_version: String(row.provider_version), source_event_id: String(row.source_event_id),
    provider_session_id: String(row.provider_session_id), sequence: Number(row.sequence),
    kind: String(row.kind) as RealtimeSpeechSegmentKind, segment_id: String(row.segment_id),
    speaker_id: String(row.speaker_id || ''), source_language: String(row.source_language || ''),
    target_language: String(row.target_language || ''), source_text: String(row.source_text || ''),
    translated_text: String(row.translated_text || ''),
    ...(row.confidence == null ? {} : { confidence: Number(row.confidence) }),
    ...(row.start_ms == null ? {} : { start_ms: Number(row.start_ms) }),
    ...(row.end_ms == null ? {} : { end_ms: Number(row.end_ms) }),
    provider_request_id: String(row.provider_request_id || ''),
    latency_ms: jsonRecord(row.latency_ms) as Record<string, number>,
    safe_metadata: jsonRecord(row.safe_metadata),
    occurred_at: timestamp(row.occurred_at, 'occurred_at'),
    retention_until: timestamp(row.retention_until, 'retention_until')
  });
  return {
    id: identifier(row.id, 'id'),
    ...normalized,
    created_at: timestamp(row.created_at, 'created_at')
  };
}

function encodeCursor(occurredAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ occurred_at: occurredAt, id }), 'utf8').toString('base64url');
}

function decodeCursor(value: string): { occurred_at: string | null; id: string } {
  if (!value) return { occurred_at: null, id: '' };
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    return {
      occurred_at: timestamp(parsed.occurred_at, 'cursor'),
      id: identifier(parsed.id, 'cursor')
    };
  } catch {
    throw validationError('cursor is invalid');
  }
}

function identifier(value: unknown, field: string): string {
  const text = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(text)) throw validationError(`${field} is invalid`);
  return text;
}

function optionalIdentifier(value: unknown, field: string): string {
  return value == null || value === '' ? '' : identifier(value, field);
}

function providerId(value: unknown, field: string): string {
  const text = String(value || '');
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(text)) throw validationError(`${field} is invalid`);
  return text;
}

function boundedText(value: unknown, max: number, field: string, optional = false): string {
  const text = String(value || '').trim();
  if ((!optional && !text) || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw validationError(`${field} is invalid`);
  }
  return text;
}

function language(value: unknown, optional: boolean): string {
  const text = String(value || '');
  if (optional && !text) return '';
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(text)) throw validationError('language is invalid');
  return text;
}

function mediaSource(value: unknown): RealtimeSpeechMediaSource {
  if (value !== 'rustpbx' && value !== 'livekit') throw validationError('media_source is invalid');
  return value;
}

function purpose(value: unknown): RealtimeSpeechPurpose {
  if (value !== 'live_captions' && value !== 'live_translation') throw validationError('purpose is invalid');
  return value;
}

function confidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw validationError('confidence is invalid');
  return parsed;
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw validationError(`${field} is invalid`);
  }
  return Number(value);
}

function optionalInteger(value: unknown, min: number, max: number, field: string): number | undefined {
  return value == null ? undefined : boundedInteger(value, min, max, field);
}

function numericRecord(value: unknown): Record<string, number> {
  const record = jsonRecord(value);
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key)
      || typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 3_600_000) {
      throw validationError('latency_ms is invalid');
    }
    output[key] = item;
  }
  return output;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const parsed = JSON.parse(JSON.stringify(value)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw validationError('metadata is invalid');
  }
}

function timestamp(value: unknown, field: string): string {
  const date = new Date(String(value || ''));
  if (!Number.isFinite(date.getTime())) throw validationError(`${field} is invalid`);
  return date.toISOString();
}

function validationError(message: string): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status: 422, code: 'validation_failed' });
}

function conflict(message: string): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status: 409, code: 'event_sequence_conflict' });
}
