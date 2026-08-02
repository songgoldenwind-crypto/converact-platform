import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import { VoiceError } from '../errors.js';
import type { VoiceCallRepository } from '../ports.js';
import type {
  VoiceCall,
  VoiceListInput,
  VoicePage,
  VoiceParticipant,
  VoiceProtectedAddress
} from '../types.js';
import {
  boundedLimit,
  cursorTuple,
  jsonRecord,
  nullableTimestamp,
  numberValue,
  pageFromRows,
  requiredRow,
  timestamp,
  type VoicePgRow
} from './row-utils.js';

const CALL_COLUMNS = `
  call.id, call.tenant_id, call.business_ref_type, call.business_ref_id,
  call.provider_profile_id, call.provider_call_id, call.provider_dialog_id,
  call.media_call_id, call.direction, call.state,
  call.from_address_kind, call.from_address_redacted,
  call.to_address_kind, call.to_address_redacted,
  call.idempotency_key, call.initiated_by, call.metadata,
  call.ringing_at, call.answered_at, call.ended_at, call.termination_reason,
  call.revision, call.created_at, call.updated_at`;

const POSTGRES_VOICE_CALL_STORE_INSTANCES =
  new WeakSet<PostgresVoiceCallStore>();

export class PostgresVoiceCallStore implements VoiceCallRepository {
  readonly #pg: PgQueryable;

  constructor(pg: PgQueryable) {
    this.#pg = pg;
    POSTGRES_VOICE_CALL_STORE_INSTANCES.add(this);
  }

  get(tenantId: string, callId: string, options: { for_update?: boolean } = {}): Promise<VoiceCall | null> {
    return withPgTenant(this.#pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT ${CALL_COLUMNS}
         FROM ivekit_voice_calls call
         WHERE call.tenant_id = $1 AND call.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, callId]
      );
      return result.rows[0] ? decodeCall(result.rows[0]) : null;
    });
  }

  findByIdempotencyKey(tenantId: string, key: string): Promise<VoiceCall | null> {
    return withPgTenant(this.#pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT ${CALL_COLUMNS}
         FROM ivekit_voice_calls call
         WHERE call.tenant_id = $1 AND call.idempotency_key = $2`,
        [tenantId, key]
      );
      return result.rows[0] ? decodeCall(result.rows[0]) : null;
    });
  }

  findByProviderCallId(
    tenantId: string,
    profileId: string,
    providerCallId: string,
    options: { for_update?: boolean } = {}
  ): Promise<VoiceCall | null> {
    return withPgTenant(this.#pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT ${CALL_COLUMNS}
         FROM ivekit_voice_calls call
         WHERE call.tenant_id = $1 AND call.provider_profile_id = $2
           AND call.provider_call_id = $3
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, profileId, providerCallId]
      );
      return result.rows[0] ? decodeCall(result.rows[0]) : null;
    });
  }

  getProtectedAddress(
    tenantId: string,
    callId: string,
    side: 'from' | 'to'
  ): Promise<VoiceProtectedAddress | null> {
    const prefix = side === 'from' ? 'from' : 'to';
    return withPgTenant(this.#pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT ${prefix}_address_kind AS kind,
                ${prefix}_address_ciphertext AS ciphertext,
                ${prefix}_address_hmac AS hmac,
                ${prefix}_address_redacted AS redacted
         FROM ivekit_voice_calls
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, callId]
      );
      const row = result.rows[0];
      return row ? {
        kind: row.kind as VoiceProtectedAddress['kind'],
        ciphertext: String(row.ciphertext),
        hmac: String(row.hmac),
        redacted: String(row.redacted)
      } : null;
    });
  }

  list(input: VoiceListInput & {
    state?: VoiceCall['state'];
    business_ref?: { type: string; id: string };
  }): Promise<VoicePage<VoiceCall>> {
    return withPgTenant(this.#pg, input.tenant_id, async (pg) => {
      const limit = boundedLimit(input.limit);
      const [cursorAt, cursorId] = cursorTuple(input.cursor);
      const result = await pg.query<VoicePgRow>(
        `SELECT ${CALL_COLUMNS}
         FROM ivekit_voice_calls call
         WHERE call.tenant_id = $1
           AND (call.created_at, call.id) < ($2::timestamptz, $3)
           AND ($4::text IS NULL OR call.state = $4)
           AND ($5::text IS NULL OR call.business_ref_type = $5)
           AND ($6::text IS NULL OR call.business_ref_id = $6)
         ORDER BY call.created_at DESC, call.id DESC LIMIT $7`,
        [
          input.tenant_id, cursorAt, cursorId, input.state ?? null,
          input.business_ref?.type ?? null, input.business_ref?.id ?? null, limit + 1
        ]
      );
      return pageFromRows(result.rows.map(decodeCall), limit);
    });
  }

  insert(call: VoiceCall, from: VoiceProtectedAddress, to: VoiceProtectedAddress): Promise<VoiceCall> {
    return withPgTenant(this.#pg, call.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_calls
          (id, tenant_id, business_ref_type, business_ref_id, provider_profile_id,
           provider_call_id, provider_dialog_id, media_call_id, direction, state,
           from_address_kind, from_address_ciphertext, from_address_hmac, from_address_redacted,
           to_address_kind, to_address_ciphertext, to_address_hmac, to_address_redacted,
           idempotency_key, initiated_by, metadata, ringing_at, answered_at, ended_at,
           termination_reason, revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13, $14, $15, $16, $17, $18,
                 $19, $20, $21::jsonb, $22, $23, $24, $25, $26, $27, $28)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id, tenant_id, business_ref_type, business_ref_id,
                   provider_profile_id, provider_call_id, provider_dialog_id, media_call_id,
                   direction, state, from_address_kind, from_address_redacted,
                   to_address_kind, to_address_redacted, idempotency_key, initiated_by,
                   metadata, ringing_at, answered_at, ended_at, termination_reason,
                   revision, created_at, updated_at`,
        [
          call.id, call.tenant_id, call.business_ref.type, call.business_ref.id,
          call.provider_profile_id, call.provider_call_id, call.provider_dialog_id,
          call.media_call_id, call.direction, call.state,
          from.kind, from.ciphertext, from.hmac, from.redacted,
          to.kind, to.ciphertext, to.hmac, to.redacted,
          call.idempotency_key, call.initiated_by, JSON.stringify(call.metadata),
          call.ringing_at, call.answered_at, call.ended_at, call.termination_reason,
          call.revision, call.created_at, call.updated_at
        ]
      );
      if (result.rows[0]) return decodeCall(result.rows[0]);
      const replay = await pg.query<VoicePgRow>(
        `SELECT ${CALL_COLUMNS}
         FROM ivekit_voice_calls call
         WHERE call.tenant_id = $1 AND call.idempotency_key = $2`,
        [call.tenant_id, call.idempotency_key]
      );
      const found = decodeCall(requiredRow(replay.rows[0], 'idempotency_conflict'));
      if (
        found.business_ref.type !== call.business_ref.type
        || found.business_ref.id !== call.business_ref.id
        || found.provider_profile_id !== call.provider_profile_id
        || found.direction !== call.direction
        || found.from.kind !== from.kind
        || found.from.redacted !== from.redacted
        || found.to.kind !== to.kind
        || found.to.redacted !== to.redacted
      ) throw new VoiceError({ code: 'idempotency_conflict', status: 409 });
      return found;
    });
  }

  update(call: VoiceCall, expectedRevision: number): Promise<VoiceCall> {
    return withPgTenant(this.#pg, call.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `UPDATE ivekit_voice_calls
         SET provider_call_id = $3, provider_dialog_id = $4, media_call_id = $5,
             state = $6, metadata = $7::jsonb, ringing_at = $8, answered_at = $9,
             ended_at = $10, termination_reason = $11, updated_at = $12,
             revision = revision + 1
         WHERE tenant_id = $1 AND id = $2 AND revision = $13
         RETURNING id, tenant_id, business_ref_type, business_ref_id,
                   provider_profile_id, provider_call_id, provider_dialog_id, media_call_id,
                   direction, state, from_address_kind, from_address_redacted,
                   to_address_kind, to_address_redacted, idempotency_key, initiated_by,
                   metadata, ringing_at, answered_at, ended_at, termination_reason,
                   revision, created_at, updated_at`,
        [
          call.tenant_id, call.id, call.provider_call_id, call.provider_dialog_id,
          call.media_call_id, call.state, JSON.stringify(call.metadata), call.ringing_at,
          call.answered_at, call.ended_at, call.termination_reason, call.updated_at,
          expectedRevision
        ]
      );
      return decodeCall(requiredRow(result.rows[0], 'revision_conflict'));
    });
  }

  insertParticipant(input: VoiceParticipant): Promise<VoiceParticipant> {
    return withPgTenant(this.#pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_call_participants
          (id, tenant_id, call_id, identity, participant_kind, role, state,
           provider_participant_id, metadata, joined_at, left_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
         ON CONFLICT (tenant_id, call_id, identity) DO NOTHING
         RETURNING *`,
        [
          input.id, input.tenant_id, input.call_id, input.identity, input.participant_kind,
          input.role, input.state, input.provider_participant_id, JSON.stringify(input.metadata),
          input.joined_at, input.left_at, input.created_at, input.updated_at
        ]
      );
      if (result.rows[0]) return decodeParticipant(result.rows[0]);
      const replay = await pg.query<VoicePgRow>(
        `SELECT * FROM ivekit_voice_call_participants
         WHERE tenant_id = $1 AND call_id = $2 AND identity = $3`,
        [input.tenant_id, input.call_id, input.identity]
      );
      const found = decodeParticipant(requiredRow(replay.rows[0], 'idempotency_conflict'));
      if (found.participant_kind !== input.participant_kind || found.role !== input.role) {
        throw new VoiceError({ code: 'idempotency_conflict', status: 409 });
      }
      return found;
    });
  }

  updateParticipant(input: VoiceParticipant): Promise<VoiceParticipant> {
    return withPgTenant(this.#pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `UPDATE ivekit_voice_call_participants
         SET state = $3, provider_participant_id = $4, metadata = $5::jsonb,
             joined_at = $6, left_at = $7, updated_at = $8
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          input.tenant_id, input.id, input.state, input.provider_participant_id,
          JSON.stringify(input.metadata), input.joined_at, input.left_at, input.updated_at
        ]
      );
      return decodeParticipant(requiredRow(result.rows[0]));
    });
  }

  listParticipants(tenantId: string, callId: string): Promise<VoiceParticipant[]> {
    return withPgTenant(this.#pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT * FROM ivekit_voice_call_participants
         WHERE tenant_id = $1 AND call_id = $2 ORDER BY created_at ASC, id ASC`,
        [tenantId, callId]
      );
      return result.rows.map(decodeParticipant);
    });
  }
}

const TRUSTED_POSTGRES_VOICE_CALL_GET = PostgresVoiceCallStore.prototype.get;

export function isTrustedPostgresVoiceCallStore(
  value: unknown
): value is PostgresVoiceCallStore {
  return typeof value === 'object' &&
    value !== null &&
    POSTGRES_VOICE_CALL_STORE_INSTANCES.has(value as PostgresVoiceCallStore) &&
    Object.getPrototypeOf(value) === PostgresVoiceCallStore.prototype;
}

export function getTrustedExistingVoiceCall(
  store: PostgresVoiceCallStore,
  tenantId: string,
  callId: string
): Promise<VoiceCall | null> {
  if (!isTrustedPostgresVoiceCallStore(store)) {
    throw new TypeError('untrusted_postgres_voice_call_store');
  }
  return TRUSTED_POSTGRES_VOICE_CALL_GET.call(store, tenantId, callId);
}

function decodeCall(row: VoicePgRow): VoiceCall {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id),
    business_ref: { type: String(row.business_ref_type), id: String(row.business_ref_id) },
    provider_profile_id: String(row.provider_profile_id), provider_call_id: String(row.provider_call_id ?? ''),
    provider_dialog_id: String(row.provider_dialog_id ?? ''), media_call_id: row.media_call_id == null ? null : String(row.media_call_id),
    direction: row.direction as VoiceCall['direction'], state: row.state as VoiceCall['state'],
    from: { kind: row.from_address_kind as VoiceCall['from']['kind'], redacted: String(row.from_address_redacted) },
    to: { kind: row.to_address_kind as VoiceCall['to']['kind'], redacted: String(row.to_address_redacted) },
    idempotency_key: String(row.idempotency_key), initiated_by: String(row.initiated_by ?? ''), metadata: jsonRecord(row.metadata),
    ringing_at: nullableTimestamp(row.ringing_at), answered_at: nullableTimestamp(row.answered_at),
    ended_at: nullableTimestamp(row.ended_at), termination_reason: String(row.termination_reason ?? ''),
    revision: numberValue(row.revision), created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}

function decodeParticipant(row: VoicePgRow): VoiceParticipant {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), call_id: String(row.call_id), identity: String(row.identity),
    participant_kind: row.participant_kind as VoiceParticipant['participant_kind'], role: row.role as VoiceParticipant['role'],
    state: row.state as VoiceParticipant['state'], provider_participant_id: String(row.provider_participant_id ?? ''),
    metadata: jsonRecord(row.metadata), joined_at: nullableTimestamp(row.joined_at), left_at: nullableTimestamp(row.left_at),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}
