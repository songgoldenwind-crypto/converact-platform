import { pgId, withPgTransaction, type PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import type { MediaQualityStorePort } from './media-quality-service.js';
import type {
  IveKitMediaConnectionEvent,
  IveKitMediaConnectionState,
  IveKitMediaQualityParticipantState,
  IveKitMediaQualitySnapshot,
  IveKitMediaQualitySummary
} from './types.js';

export class MediaQualityStore implements MediaQualityStorePort {
  constructor(readonly pg: PgQueryable) {}

  transaction<T>(
    tenantId: string,
    fn: (store: MediaQualityStorePort) => Promise<T>
  ): Promise<T> {
    return withPgTenant(this.pg, tenantId, (tenantPg) =>
      withPgTransaction(tenantPg, (transactionPg) => fn(new MediaQualityStore(transactionPg)))
    );
  }

  async getParticipantForUpdate(input: {
    tenant_id: string;
    call_id: string;
    identity: string;
  }): Promise<IveKitMediaQualityParticipantState | null> {
    const result = await this.pg.query(
      `SELECT tenant_id, call_id, identity, status AS participant_status,
              connection_revision, connection_state, connection_updated_at,
              last_disconnected_at, last_rejoined_at, quality_state,
              quality_degraded_streak, quality_recovered_streak,
              last_quality_level, last_quality_sample_id, last_qos_at
       FROM ivekit_media_call_participants
       WHERE tenant_id = $1 AND call_id = $2 AND identity = $3
       FOR UPDATE`,
      [input.tenant_id, input.call_id, input.identity]
    );
    return result.rows[0] ? decodeParticipantState(result.rows[0]) : null;
  }

  async insertQualitySnapshot(
    input: Parameters<MediaQualityStorePort['insertQualitySnapshot']>[0]
  ): Promise<{ snapshot: IveKitMediaQualitySnapshot; replayed: boolean }> {
    const result = await this.pg.query(
      `INSERT INTO ivekit_media_quality_snapshots
        (id, tenant_id, call_id, participant_identity, connection_revision,
         sample_id, track_source, quality_level, rtt_ms, jitter_ms,
         packet_loss_ratio, bitrate_bps, quality_score, payload_hash,
         metadata, sampled_at, retention_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, '{}'::JSONB, $15, $16)
       ON CONFLICT (
         tenant_id, call_id, participant_identity, connection_revision, sample_id, track_source
       ) DO NOTHING
       RETURNING *`,
      [
        pgId('mqos'),
        input.tenant_id,
        input.call_id,
        input.participant_identity,
        input.connection_revision,
        input.sample_id,
        input.track_source,
        input.quality_level,
        input.rtt_ms,
        input.jitter_ms,
        input.packet_loss_ratio,
        input.bitrate_bps,
        input.quality_score,
        input.payload_hash,
        input.sampled_at,
        input.retention_until
      ]
    );
    if (result.rows[0]) return { snapshot: decodeSnapshot(result.rows[0]), replayed: false };
    const existing = await this.pg.query(
      `SELECT * FROM ivekit_media_quality_snapshots
       WHERE tenant_id = $1 AND call_id = $2 AND participant_identity = $3
         AND connection_revision = $4 AND sample_id = $5 AND track_source = $6`,
      [
        input.tenant_id,
        input.call_id,
        input.participant_identity,
        input.connection_revision,
        input.sample_id,
        input.track_source
      ]
    );
    const row = existing.rows[0];
    if (!row || String(row.payload_hash) !== input.payload_hash) {
      throw conflict('QoS sample payload conflict');
    }
    return { snapshot: decodeSnapshot(row), replayed: true };
  }

  async updateParticipantQuality(
    input: Parameters<MediaQualityStorePort['updateParticipantQuality']>[0]
  ): Promise<IveKitMediaQualityParticipantState> {
    const result = await this.pg.query(
      `UPDATE ivekit_media_call_participants
       SET connection_state = CASE
             WHEN connection_revision < $4 THEN 'disconnected'
             ELSE connection_state
           END,
           connection_updated_at = CASE
             WHEN connection_revision < $4 THEN NULL
             ELSE connection_updated_at
           END,
           connection_revision = GREATEST(connection_revision, $4),
           quality_state = $5,
           quality_degraded_streak = $6,
           quality_recovered_streak = $7,
           last_quality_level = $8,
           last_quality_sample_id = $9,
           last_qos_at = $10,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND call_id = $2 AND identity = $3
       RETURNING tenant_id, call_id, identity, status AS participant_status,
                 connection_revision, connection_state, connection_updated_at,
                 last_disconnected_at, last_rejoined_at, quality_state,
                 quality_degraded_streak, quality_recovered_streak,
                 last_quality_level, last_quality_sample_id, last_qos_at`,
      [
        input.tenant_id,
        input.call_id,
        input.identity,
        input.connection_revision,
        input.quality_state,
        input.quality_degraded_streak,
        input.quality_recovered_streak,
        input.last_quality_level,
        input.last_quality_sample_id,
        input.last_qos_at
      ]
    );
    if (!result.rows[0]) throw notFound('active media call participant not found');
    return decodeParticipantState(result.rows[0]);
  }

  async getConnectionEvent(
    input: Parameters<MediaQualityStorePort['getConnectionEvent']>[0]
  ): Promise<{ value: IveKitMediaConnectionEvent; payloadHash: string } | null> {
    const result = await this.pg.query(
      `SELECT * FROM ivekit_media_connection_events
       WHERE tenant_id = $1 AND call_id = $2 AND participant_identity = $3 AND event_id = $4`,
      [input.tenant_id, input.call_id, input.participant_identity, input.event_id]
    );
    if (!result.rows[0]) return null;
    return {
      value: decodeConnectionEvent(result.rows[0]),
      payloadHash: String(result.rows[0].payload_hash)
    };
  }

  async insertConnectionEvent(
    input: Parameters<MediaQualityStorePort['insertConnectionEvent']>[0]
  ): Promise<IveKitMediaConnectionEvent> {
    const result = await this.pg.query(
      `INSERT INTO ivekit_media_connection_events
        (id, tenant_id, call_id, participant_identity, event_id,
         connection_revision, event_type, reason_code, payload_hash, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        pgId('mconn'),
        input.tenant_id,
        input.call_id,
        input.participant_identity,
        input.event_id,
        input.connection_revision,
        input.event_type,
        input.reason_code,
        input.payload_hash,
        input.occurred_at
      ]
    );
    return decodeConnectionEvent(result.rows[0]);
  }

  async updateParticipantConnection(
    input: Parameters<MediaQualityStorePort['updateParticipantConnection']>[0]
  ): Promise<IveKitMediaQualityParticipantState> {
    const result = await this.pg.query(
      `UPDATE ivekit_media_call_participants
       SET quality_state = CASE WHEN connection_revision < $4 THEN 'unknown' ELSE quality_state END,
           quality_degraded_streak = CASE WHEN connection_revision < $4 THEN 0 ELSE quality_degraded_streak END,
           quality_recovered_streak = CASE WHEN connection_revision < $4 THEN 0 ELSE quality_recovered_streak END,
           last_quality_level = CASE WHEN connection_revision < $4 THEN 'unknown' ELSE last_quality_level END,
           last_quality_sample_id = CASE WHEN connection_revision < $4 THEN '' ELSE last_quality_sample_id END,
           last_qos_at = CASE WHEN connection_revision < $4 THEN NULL ELSE last_qos_at END,
           connection_revision = $4,
           connection_state = $5,
           connection_updated_at = $6,
           last_disconnected_at = $7,
           last_rejoined_at = $8,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND call_id = $2 AND identity = $3
       RETURNING tenant_id, call_id, identity, status AS participant_status,
                 connection_revision, connection_state, connection_updated_at,
                 last_disconnected_at, last_rejoined_at, quality_state,
                 quality_degraded_streak, quality_recovered_streak,
                 last_quality_level, last_quality_sample_id, last_qos_at`,
      [
        input.tenant_id,
        input.call_id,
        input.identity,
        input.connection_revision,
        input.connection_state,
        input.connection_updated_at,
        input.last_disconnected_at,
        input.last_rejoined_at
      ]
    );
    if (!result.rows[0]) throw notFound('active media call participant not found');
    return decodeParticipantState(result.rows[0]);
  }

  async getQualitySummary(
    input: Parameters<MediaQualityStorePort['getQualitySummary']>[0]
  ): Promise<IveKitMediaQualitySummary | null> {
    const call = await this.pg.query(
      'SELECT id FROM ivekit_media_calls WHERE tenant_id = $1 AND id = $2',
      [input.tenant_id, input.call_id]
    );
    if (!call.rows[0]) return null;
    const participants = await this.pg.query(
      `SELECT tenant_id, call_id, identity, status AS participant_status,
              connection_revision, connection_state, connection_updated_at,
              last_disconnected_at, last_rejoined_at, quality_state,
              quality_degraded_streak, quality_recovered_streak,
              last_quality_level, last_quality_sample_id, last_qos_at
       FROM ivekit_media_call_participants
       WHERE tenant_id = $1 AND call_id = $2
       ORDER BY identity`,
      [input.tenant_id, input.call_id]
    );
    const snapshots = await this.pg.query(
      `SELECT * FROM ivekit_media_quality_snapshots
       WHERE tenant_id = $1 AND call_id = $2
       ORDER BY sampled_at DESC, id DESC
       LIMIT $3`,
      [input.tenant_id, input.call_id, input.limit]
    );
    return {
      tenant_id: input.tenant_id,
      call_id: input.call_id,
      generated_at: input.generated_at,
      participants: participants.rows.map(decodeParticipantState),
      recent_snapshots: snapshots.rows.map(decodeSnapshot)
    };
  }

  async pruneQualitySnapshots(
    input: Parameters<MediaQualityStorePort['pruneQualitySnapshots']>[0]
  ): Promise<number> {
    const result = await this.pg.query(
      `WITH candidates AS (
         SELECT id
         FROM ivekit_media_quality_snapshots
         WHERE tenant_id = $1 AND retention_until <= $2
         ORDER BY retention_until, id
         LIMIT $3
       )
       DELETE FROM ivekit_media_quality_snapshots snapshot
       USING candidates
       WHERE snapshot.tenant_id = $1 AND snapshot.id = candidates.id
       RETURNING snapshot.id`,
      [input.tenant_id, input.before, input.limit]
    );
    return result.rowCount ?? result.rows.length;
  }
}

function decodeParticipantState(row: Record<string, unknown>): IveKitMediaQualityParticipantState {
  return {
    tenant_id: String(row.tenant_id),
    call_id: String(row.call_id),
    identity: String(row.identity),
    participant_status: String(row.participant_status) as IveKitMediaQualityParticipantState['participant_status'],
    connection_revision: Number(row.connection_revision || 0),
    connection_state: String(row.connection_state || 'disconnected') as IveKitMediaConnectionState,
    connection_updated_at: nullableTimestamp(row.connection_updated_at),
    last_disconnected_at: nullableTimestamp(row.last_disconnected_at),
    last_rejoined_at: nullableTimestamp(row.last_rejoined_at),
    quality_state: String(row.quality_state || 'unknown') as IveKitMediaQualityParticipantState['quality_state'],
    quality_degraded_streak: Number(row.quality_degraded_streak || 0),
    quality_recovered_streak: Number(row.quality_recovered_streak || 0),
    last_quality_level: String(row.last_quality_level || 'unknown') as IveKitMediaQualityParticipantState['last_quality_level'],
    last_quality_sample_id: String(row.last_quality_sample_id || ''),
    last_qos_at: nullableTimestamp(row.last_qos_at)
  };
}

function decodeSnapshot(row: Record<string, unknown>): IveKitMediaQualitySnapshot {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    call_id: String(row.call_id),
    participant_identity: String(row.participant_identity),
    connection_revision: Number(row.connection_revision),
    sample_id: String(row.sample_id),
    track_source: String(row.track_source) as IveKitMediaQualitySnapshot['track_source'],
    quality_level: String(row.quality_level) as IveKitMediaQualitySnapshot['quality_level'],
    rtt_ms: nullableNumber(row.rtt_ms),
    jitter_ms: nullableNumber(row.jitter_ms),
    packet_loss_ratio: nullableNumber(row.packet_loss_ratio),
    bitrate_bps: nullableNumber(row.bitrate_bps),
    quality_score: nullableNumber(row.quality_score),
    sampled_at: timestamp(row.sampled_at),
    received_at: timestamp(row.received_at)
  };
}

function decodeConnectionEvent(row: Record<string, unknown>): IveKitMediaConnectionEvent {
  const eventType = String(row.event_type) as IveKitMediaConnectionEvent['event_type'];
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    call_id: String(row.call_id),
    participant_identity: String(row.participant_identity),
    event_id: String(row.event_id),
    connection_revision: Number(row.connection_revision),
    event_type: eventType,
    reason_code: String(row.reason_code || ''),
    connection_state: connectionStateForEvent(eventType),
    occurred_at: timestamp(row.occurred_at),
    received_at: timestamp(row.received_at)
  };
}

function connectionStateForEvent(
  eventType: IveKitMediaConnectionEvent['event_type']
): IveKitMediaConnectionState {
  if (eventType === 'connected' || eventType === 'reconnected' || eventType === 'rejoined') {
    return 'connected';
  }
  if (eventType === 'reconnecting') return 'reconnecting';
  if (eventType === 'rejoining') return 'rejoining';
  if (eventType === 'failed') return 'failed';
  return 'disconnected';
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value == null || value === '' ? null : timestamp(value);
}

function nullableNumber(value: unknown): number | null {
  return value == null || value === '' ? null : Number(value);
}

function conflict(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 409 });
}

function notFound(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 404 });
}
