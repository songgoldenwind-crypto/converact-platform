import { MemoryPg, pgId, withPgTransaction, type PgQueryable } from '../../db-pg.js';
import type {
  IveKitMediaCall,
  IveKitMediaCallAction,
  IveKitMediaCallParticipant,
  IveKitMediaCallSnapshot,
  MediaBusinessRef
} from './types.js';

export class MediaCallStore {
  constructor(readonly pg: PgQueryable) {}

  transaction<T>(fn: (store: MediaCallStore) => Promise<T>): Promise<T> {
    return withPgTransaction(this.pg, (transactionPg) => fn(new MediaCallStore(transactionPg)));
  }

  async insertCall(input: {
    tenant_id: string;
    room_name?: string;
    media: 'voice' | 'video';
    initiated_by: string;
    business_ref: MediaBusinessRef;
    title: string;
    metadata: Record<string, unknown>;
    ring_timeout_seconds: number;
  }): Promise<IveKitMediaCall> {
    const callId = pgId('mcall');
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
        input.room_name || `ivekit-${callId}`,
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
    role: IveKitMediaCallParticipant['role'];
    status: IveKitMediaCallParticipant['status'];
    display_name?: string;
    metadata?: Record<string, unknown>;
  }): Promise<IveKitMediaCallParticipant> {
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
  ): Promise<IveKitMediaCall | null> {
    const result = await this.pg.query(
      `SELECT * FROM ivekit_media_calls
       WHERE tenant_id = $1 AND id = $2${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, callId]
    );
    return result.rows[0] ? decodeCall(result.rows[0]) : null;
  }

  async listParticipants(tenantId: string, callId: string): Promise<IveKitMediaCallParticipant[]> {
    const result = await this.pg.query(
      `SELECT * FROM ivekit_media_call_participants
       WHERE tenant_id = $1 AND call_id = $2
       ORDER BY invited_at ASC, id ASC`,
      [tenantId, callId]
    );
    return result.rows.map(decodeParticipant);
  }

  async snapshot(tenantId: string, callId: string): Promise<IveKitMediaCallSnapshot | null> {
    const call = await this.getCall(tenantId, callId);
    if (!call) return null;
    return { call, participants: await this.listParticipants(tenantId, callId) };
  }

  async updateCall(call: IveKitMediaCall): Promise<IveKitMediaCall> {
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

  async updateParticipant(participant: IveKitMediaCallParticipant): Promise<IveKitMediaCallParticipant> {
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
    result_snapshot: IveKitMediaCallSnapshot;
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
      result_snapshot: jsonValue<IveKitMediaCallSnapshot>(result.rows[0].result_snapshot)
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
    action: IveKitMediaCallAction;
    actor_identity: string;
    reason: string;
    metadata: Record<string, unknown>;
    from_status: IveKitMediaCall['status'];
    to_status: IveKitMediaCall['status'];
    result_snapshot: IveKitMediaCallSnapshot;
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
}

function decodeCall(row: Record<string, unknown>): IveKitMediaCall {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    room_name: String(row.room_name),
    media: String(row.media) as IveKitMediaCall['media'],
    status: String(row.status) as IveKitMediaCall['status'],
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
    ring_expires_at: nullableString(row.ring_expires_at),
    accepted_at: nullableString(row.accepted_at),
    started_at: nullableString(row.started_at),
    ended_at: nullableString(row.ended_at),
    end_reason: String(row.end_reason || ''),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function decodeParticipant(row: Record<string, unknown>): IveKitMediaCallParticipant {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    call_id: String(row.call_id),
    identity: String(row.identity),
    role: String(row.role) as IveKitMediaCallParticipant['role'],
    status: String(row.status) as IveKitMediaCallParticipant['status'],
    display_name: String(row.display_name || ''),
    metadata: jsonObject(row.metadata),
    invited_at: String(row.invited_at),
    accepted_at: nullableString(row.accepted_at),
    joined_at: nullableString(row.joined_at),
    left_at: nullableString(row.left_at),
    updated_at: String(row.updated_at)
  };
}

function nullableString(value: unknown): string | null {
  return value == null || value === '' ? null : String(value);
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
