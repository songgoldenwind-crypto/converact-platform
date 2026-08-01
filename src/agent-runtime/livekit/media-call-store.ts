import { MemoryPg, pgId, withPgTransaction, type PgQueryable } from '../../db-pg.js';
import type {
  ConveractFabricMediaCall,
  ConveractFabricMediaCallAction,
  ConveractFabricMediaModerationActionRecord,
  ConveractFabricMediaModerationCommandRecord,
  ConveractFabricMediaCallParticipant,
  ConveractFabricMediaCallSnapshot,
  ConveractFabricMediaTrackSource,
  MediaBusinessRef
} from './types.js';

export class MediaCallStore {
  constructor(readonly pg: PgQueryable) {}

  transaction<T>(fn: (store: MediaCallStore) => Promise<T>): Promise<T> {
    return withPgTransaction(this.pg, (transactionPg) => fn(new MediaCallStore(transactionPg)));
  }

  async insertCall(input: {
    id?: string;
    tenant_id: string;
    room_name?: string;
    media: 'voice' | 'video';
    initiated_by: string;
    business_ref: MediaBusinessRef;
    title: string;
    metadata: Record<string, unknown>;
    ring_timeout_seconds: number;
  }): Promise<ConveractFabricMediaCall> {
    const callId = input.id || pgId('mcall');
    const result = await this.pg.query(
      `INSERT INTO ivekit_media_calls
        (id, tenant_id, room_name, media, status, initiated_by,
         business_ref_type, business_ref_id, business_ref_display_name, business_ref_metadata,
         title, metadata, ring_timeout_seconds)
       VALUES ($1, $2, $3, $4, 'created', $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        callId,
        input.tenant_id,
        input.room_name || `converact-${callId}`,
        input.media,
        input.initiated_by,
        input.business_ref.type,
        input.business_ref.id,
        input.business_ref.display_name || '',
        JSON.stringify(input.business_ref.metadata || {}),
        input.title,
        JSON.stringify(input.metadata),
        input.ring_timeout_seconds
      ]
    );
    return decodeCall(result.rows[0]);
  }

  async insertParticipant(input: {
    tenant_id: string;
    call_id: string;
    identity: string;
    role: ConveractFabricMediaCallParticipant['role'];
    status: ConveractFabricMediaCallParticipant['status'];
    display_name?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ConveractFabricMediaCallParticipant> {
    const joinedAt = input.status === 'joined' ? new Date().toISOString() : null;
    const result = await this.pg.query(
      `INSERT INTO ivekit_media_call_participants
        (id, tenant_id, call_id, identity, role, status, display_name, metadata, joined_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        pgId('mcp'),
        input.tenant_id,
        input.call_id,
        input.identity,
        input.role,
        input.status,
        input.display_name || '',
        JSON.stringify(input.metadata || {}),
        joinedAt
      ]
    );
    return decodeParticipant(result.rows[0]);
  }

  async getCall(
    tenantId: string,
    callId: string,
    options: { forUpdate?: boolean } = {}
  ): Promise<ConveractFabricMediaCall | null> {
    const result = await this.pg.query(
      `SELECT * FROM ivekit_media_calls
       WHERE tenant_id = $1 AND id = $2${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, callId]
    );
    return result.rows[0] ? decodeCall(result.rows[0]) : null;
  }

  async getCallByRoom(
    tenantId: string,
    roomName: string,
    options: { forUpdate?: boolean } = {}
  ): Promise<ConveractFabricMediaCall | null> {
    const result = await this.pg.query(
      `SELECT * FROM ivekit_media_calls
       WHERE tenant_id = $1 AND room_name = $2${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, roomName]
    );
    return result.rows[0] ? decodeCall(result.rows[0]) : null;
  }

  async listByBusinessRef(input: {
    tenant_id: string;
    business_ref: Pick<MediaBusinessRef, 'type' | 'id'>;
    identity?: string;
    limit?: number;
  }): Promise<ConveractFabricMediaCall[]> {
    const tenantId = String(input.tenant_id || '').trim();
    const type = String(input.business_ref?.type || '').trim();
    const id = String(input.business_ref?.id || '').trim();
    if (!tenantId || !type || !id) {
      throw Object.assign(new Error('tenant_id, business_ref.type and business_ref.id are required'), { status: 400 });
    }
    const identity = String(input.identity || '').trim();
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit || 50)));
    const result = await this.pg.query(
      `SELECT * FROM ivekit_media_calls
       WHERE tenant_id = $1 AND business_ref_type = $2 AND business_ref_id = $3
         AND ($4 = '' OR EXISTS (
           SELECT 1 FROM ivekit_media_call_participants AS visible_participant
           WHERE visible_participant.tenant_id = ivekit_media_calls.tenant_id
             AND visible_participant.call_id = ivekit_media_calls.id
             AND visible_participant.identity = $4
             AND visible_participant.status NOT IN ('declined', 'left', 'missed', 'removed')
         ))
       ORDER BY created_at DESC, id DESC
       LIMIT $5`,
      [tenantId, type, id, identity, limit]
    );
    return result.rows.map(decodeCall);
  }

  async listParticipants(tenantId: string, callId: string): Promise<ConveractFabricMediaCallParticipant[]> {
    const result = await this.pg.query(
      `SELECT * FROM ivekit_media_call_participants
       WHERE tenant_id = $1 AND call_id = $2
       ORDER BY invited_at ASC, id ASC`,
      [tenantId, callId]
    );
    return result.rows.map(decodeParticipant);
  }

  async listExpiredRingingCalls(
    tenantId: string,
    now: Date,
    limit = 25
  ): Promise<ConveractFabricMediaCall[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = await this.pg.query(
      `SELECT * FROM ivekit_media_calls
       WHERE tenant_id = $1 AND status = 'ringing'
         AND ring_expires_at IS NOT NULL AND ring_expires_at <= $2
       ORDER BY ring_expires_at ASC, id ASC
       LIMIT $3`,
      [tenantId, now.toISOString(), boundedLimit]
    );
    return result.rows.map(decodeCall);
  }

  async snapshot(tenantId: string, callId: string): Promise<ConveractFabricMediaCallSnapshot | null> {
    const call = await this.getCall(tenantId, callId);
    if (!call) return null;
    return { call, participants: await this.listParticipants(tenantId, callId) };
  }

  async updateCall(call: ConveractFabricMediaCall): Promise<ConveractFabricMediaCall> {
    const result = await this.pg.query(
      `UPDATE ivekit_media_calls
       SET status = $3, ring_expires_at = $4, accepted_at = $5, started_at = $6,
           ended_at = $7, end_reason = $8, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        call.tenant_id,
        call.id,
        call.status,
        call.ring_expires_at,
        call.accepted_at,
        call.started_at,
        call.ended_at,
        call.end_reason
      ]
    );
    return decodeCall(result.rows[0]);
  }

  async updateParticipant(participant: ConveractFabricMediaCallParticipant): Promise<ConveractFabricMediaCallParticipant> {
    const result = await this.pg.query(
      `UPDATE ivekit_media_call_participants
       SET status = $4, accepted_at = $5, joined_at = $6, left_at = $7,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND call_id = $2 AND identity = $3
       RETURNING *`,
      [
        participant.tenant_id,
        participant.call_id,
        participant.identity,
        participant.status,
        participant.accepted_at,
        participant.joined_at,
        participant.left_at
      ]
    );
    return decodeParticipant(result.rows[0]);
  }

  async getActionByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<{
    call_id: string;
    payload_hash: string;
    result_snapshot: ConveractFabricMediaCallSnapshot;
  } | null> {
    const result = await this.pg.query(
      `SELECT call_id, payload_hash, result_snapshot
       FROM ivekit_media_call_actions
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey]
    );
    if (!result.rows[0]) return null;
    return {
      call_id: String(result.rows[0].call_id),
      payload_hash: String(result.rows[0].payload_hash),
      result_snapshot: jsonValue<ConveractFabricMediaCallSnapshot>(result.rows[0].result_snapshot)
    };
  }

  async tryLockIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<boolean> {
    if (this.pg instanceof MemoryPg) return true;
    const result = await this.pg.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS acquired',
      [tenantId, idempotencyKey]
    );
    return result.rows[0]?.acquired === true;
  }

  async insertAction(input: {
    tenant_id: string;
    call_id: string;
    idempotency_key: string;
    payload_hash: string;
    action: ConveractFabricMediaCallAction;
    actor_identity: string;
    reason: string;
    metadata: Record<string, unknown>;
    from_status: ConveractFabricMediaCall['status'];
    to_status: ConveractFabricMediaCall['status'];
    result_snapshot: ConveractFabricMediaCallSnapshot;
  }): Promise<void> {
    await this.pg.query(
      `INSERT INTO ivekit_media_call_actions
        (id, tenant_id, call_id, idempotency_key, payload_hash, action, actor_identity,
         reason, metadata, from_status, to_status, result_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        pgId('mca'),
        input.tenant_id,
        input.call_id,
        input.idempotency_key,
        input.payload_hash,
        input.action,
        input.actor_identity,
        input.reason,
        JSON.stringify(input.metadata),
        input.from_status,
        input.to_status,
        JSON.stringify(input.result_snapshot)
      ]
    );
  }

  async insertModerationAction(input: {
    tenant_id: string;
    call_id: string;
    room_name: string;
    participant_identity: string;
    action: 'mute' | 'remove';
    actor_identity: string;
    idempotency_key: string;
    payload_hash: string;
    track_sid?: string;
    source?: ConveractFabricMediaTrackSource;
    muted?: boolean;
    reason?: string;
    metadata?: Record<string, unknown>;
    result_snapshot: Record<string, unknown>;
  }): Promise<ConveractFabricMediaModerationActionRecord> {
    const result = await this.pg.query(
      `INSERT INTO ivekit_media_moderation_actions
        (id, tenant_id, call_id, room_name, participant_identity, action, actor_identity,
         idempotency_key, payload_hash, track_sid, source, muted, reason, metadata, result_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        pgId('mma'),
        input.tenant_id,
        input.call_id,
        input.room_name,
        input.participant_identity,
        input.action,
        input.actor_identity,
        input.idempotency_key,
        input.payload_hash,
        input.track_sid || '',
        input.source || '',
        input.muted ?? null,
        input.reason || '',
        JSON.stringify(input.metadata || {}),
        JSON.stringify(input.result_snapshot)
      ]
    );
    return decodeModerationAction(result.rows[0]);
  }

  async getModerationActionByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string
  ): Promise<ConveractFabricMediaModerationActionRecord | null> {
    const result = await this.pg.query(
      `SELECT * FROM ivekit_media_moderation_actions
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey]
    );
    return result.rows[0] ? decodeModerationAction(result.rows[0]) : null;
  }

  async listModerationActions(
    tenantId: string,
    callId: string
  ): Promise<ConveractFabricMediaModerationActionRecord[]> {
    const result = await this.pg.query(
      `SELECT * FROM ivekit_media_moderation_actions
       WHERE tenant_id = $1 AND call_id = $2
       ORDER BY created_at ASC, id ASC`,
      [tenantId, callId]
    );
    return result.rows.map(decodeModerationAction);
  }

  async upsertModerationCommand(input: {
    tenant_id: string;
    call_id: string;
    room_name: string;
    participant_identity: string;
    action: 'mute' | 'remove';
    actor_identity: string;
    actor_is_system: boolean;
    idempotency_key: string;
    payload_hash: string;
    request_payload: Record<string, unknown>;
  }): Promise<ConveractFabricMediaModerationCommandRecord> {
    const inserted = await this.pg.query(
      `INSERT INTO ivekit_media_moderation_commands
        (id, tenant_id, call_id, room_name, participant_identity, action, actor_identity,
         actor_is_system, idempotency_key, payload_hash, request_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        pgId('mmc'),
        input.tenant_id,
        input.call_id,
        input.room_name,
        input.participant_identity,
        input.action,
        input.actor_identity,
        input.actor_is_system,
        input.idempotency_key,
        input.payload_hash,
        JSON.stringify(input.request_payload)
      ]
    );
    if (inserted.rows[0]) return decodeModerationCommand(inserted.rows[0]);
    const existing = await this.getModerationCommandByIdempotencyKey(
      input.tenant_id,
      input.idempotency_key
    );
    if (!existing) throw new Error('media moderation command conflict could not be reloaded');
    return existing;
  }

  async getModerationCommandByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string
  ): Promise<ConveractFabricMediaModerationCommandRecord | null> {
    const result = await this.pg.query(
      `SELECT * FROM ivekit_media_moderation_commands
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey]
    );
    return result.rows[0] ? decodeModerationCommand(result.rows[0]) : null;
  }

  async listPendingModerationCommands(
    tenantId: string,
    limit = 50
  ): Promise<ConveractFabricMediaModerationCommandRecord[]> {
    const result = await this.pg.query(
      `SELECT * FROM ivekit_media_moderation_commands
       WHERE tenant_id = $1 AND status = 'pending'
       ORDER BY created_at ASC, id ASC
       LIMIT $2`,
      [tenantId, Math.max(1, Math.min(100, Math.floor(limit))) ]
    );
    return result.rows.map(decodeModerationCommand);
  }

  async updateModerationCommand(input: {
    tenant_id: string;
    idempotency_key: string;
    status: ConveractFabricMediaModerationCommandRecord['status'];
    result_snapshot?: Record<string, unknown> | null;
    error_code?: string;
    error_message?: string;
  }): Promise<ConveractFabricMediaModerationCommandRecord | null> {
    const result = await this.pg.query(
      `UPDATE ivekit_media_moderation_commands
       SET status = $3, result_snapshot = $4, error_code = $5, error_message = $6,
           completed_at = CASE WHEN $3 = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND idempotency_key = $2
       RETURNING *`,
      [
        input.tenant_id,
        input.idempotency_key,
        input.status,
        input.result_snapshot == null ? null : JSON.stringify(input.result_snapshot),
        input.error_code || '',
        input.error_message || ''
      ]
    );
    return result.rows[0] ? decodeModerationCommand(result.rows[0]) : null;
  }
}

function decodeCall(row: Record<string, unknown>): ConveractFabricMediaCall {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    room_name: String(row.room_name),
    media: String(row.media) as ConveractFabricMediaCall['media'],
    status: String(row.status) as ConveractFabricMediaCall['status'],
    initiated_by: String(row.initiated_by),
    business_ref: {
      tenant_id: String(row.tenant_id),
      type: String(row.business_ref_type),
      id: String(row.business_ref_id),
      display_name: String(row.business_ref_display_name || '') || undefined,
      metadata: jsonObject(row.business_ref_metadata)
    },
    title: String(row.title || ''),
    metadata: jsonObject(row.metadata),
    ring_timeout_seconds: Number(row.ring_timeout_seconds || 30),
    ring_expires_at: nullableTimestamp(row.ring_expires_at),
    accepted_at: nullableTimestamp(row.accepted_at),
    started_at: nullableTimestamp(row.started_at),
    ended_at: nullableTimestamp(row.ended_at),
    end_reason: String(row.end_reason || ''),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
}

function decodeParticipant(row: Record<string, unknown>): ConveractFabricMediaCallParticipant {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    call_id: String(row.call_id),
    identity: String(row.identity),
    role: String(row.role) as ConveractFabricMediaCallParticipant['role'],
    status: String(row.status) as ConveractFabricMediaCallParticipant['status'],
    display_name: String(row.display_name || ''),
    metadata: jsonObject(row.metadata),
    invited_at: timestamp(row.invited_at),
    accepted_at: nullableTimestamp(row.accepted_at),
    joined_at: nullableTimestamp(row.joined_at),
    left_at: nullableTimestamp(row.left_at),
    connection_revision: Number(row.connection_revision || 0),
    connection_state: String(row.connection_state || 'disconnected') as ConveractFabricMediaCallParticipant['connection_state'],
    connection_updated_at: nullableTimestamp(row.connection_updated_at),
    last_disconnected_at: nullableTimestamp(row.last_disconnected_at),
    last_rejoined_at: nullableTimestamp(row.last_rejoined_at),
    quality_state: String(row.quality_state || 'unknown') as ConveractFabricMediaCallParticipant['quality_state'],
    quality_degraded_streak: Number(row.quality_degraded_streak || 0),
    quality_recovered_streak: Number(row.quality_recovered_streak || 0),
    last_quality_level: String(row.last_quality_level || 'unknown') as ConveractFabricMediaCallParticipant['last_quality_level'],
    last_quality_sample_id: String(row.last_quality_sample_id || ''),
    last_qos_at: nullableTimestamp(row.last_qos_at),
    updated_at: timestamp(row.updated_at)
  };
}

function decodeModerationAction(row: Record<string, unknown>): ConveractFabricMediaModerationActionRecord {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    call_id: String(row.call_id),
    room_name: String(row.room_name),
    participant_identity: String(row.participant_identity),
    action: String(row.action) as ConveractFabricMediaModerationActionRecord['action'],
    actor_identity: String(row.actor_identity),
    idempotency_key: String(row.idempotency_key),
    payload_hash: String(row.payload_hash),
    track_sid: String(row.track_sid || ''),
    source: String(row.source || '') as ConveractFabricMediaModerationActionRecord['source'],
    muted: row.muted == null ? null : Boolean(row.muted),
    reason: String(row.reason || ''),
    metadata: jsonObject(row.metadata),
    result_snapshot: jsonObject(row.result_snapshot),
    created_at: timestamp(row.created_at)
  };
}

function decodeModerationCommand(row: Record<string, unknown>): ConveractFabricMediaModerationCommandRecord {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    call_id: String(row.call_id),
    room_name: String(row.room_name),
    participant_identity: String(row.participant_identity),
    action: String(row.action) as ConveractFabricMediaModerationCommandRecord['action'],
    actor_identity: String(row.actor_identity),
    actor_is_system: Boolean(row.actor_is_system),
    idempotency_key: String(row.idempotency_key),
    payload_hash: String(row.payload_hash),
    request_payload: jsonObject(row.request_payload),
    status: String(row.status) as ConveractFabricMediaModerationCommandRecord['status'],
    result_snapshot: row.result_snapshot == null ? null : jsonObject(row.result_snapshot),
    error_code: String(row.error_code || ''),
    error_message: String(row.error_message || ''),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
    completed_at: nullableTimestamp(row.completed_at)
  };
}

function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error('media call database timestamp is invalid');
  }
  return date.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value == null || value === '' ? null : timestamp(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = jsonValue<unknown>(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}
