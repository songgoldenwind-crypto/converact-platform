import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import { VoiceError } from '../errors.js';
import type { VoiceRecordingRepository } from '../ports.js';
import type {
  VoiceListInput,
  VoiceLiveKitBridge,
  VoicePage,
  VoiceRecording
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

export class PostgresVoiceRecordingStore implements VoiceRecordingRepository {
  constructor(private readonly pg: PgQueryable) {}

  getRecording(tenantId: string, id: string): Promise<VoiceRecording | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT recording.* FROM ivekit_voice_recordings recording
         WHERE recording.tenant_id = $1 AND recording.id = $2`,
        [tenantId, id]
      );
      return result.rows[0] ? decodeRecording(result.rows[0]) : null;
    });
  }

  insertRecording(input: VoiceRecording): Promise<VoiceRecording> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_recordings
          (id, tenant_id, call_id, profile_id, provider_recording_id, status,
           recording_mode, consent_id, object_ref, evidence_ref, checksum, duration_ms,
           retention_until, captured_at, deleted_at, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16::jsonb, $17, $18)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        recordingParams(input)
      );
      if (result.rows[0]) return decodeRecording(result.rows[0]);
      const replay = await pg.query<VoicePgRow>(
        `SELECT recording.* FROM ivekit_voice_recordings recording
         WHERE recording.tenant_id = $1
           AND (recording.id = $2
             OR ($3::text <> '' AND recording.profile_id = $4
               AND recording.provider_recording_id = $3))
         ORDER BY recording.created_at DESC, recording.id DESC LIMIT 1`,
        [input.tenant_id, input.id, input.provider_recording_id, input.profile_id]
      );
      const found = decodeRecording(requiredRow(replay.rows[0], 'idempotency_conflict'));
      if (found.call_id !== input.call_id || found.profile_id !== input.profile_id) {
        throw new VoiceError({ code: 'idempotency_conflict', status: 409 });
      }
      return found;
    });
  }

  updateRecording(input: VoiceRecording): Promise<VoiceRecording> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `UPDATE ivekit_voice_recordings
         SET provider_recording_id = $3, status = $4, recording_mode = $5,
             consent_id = $6, object_ref = $7, evidence_ref = $8, checksum = $9,
             duration_ms = $10, retention_until = $11, captured_at = $12,
             deleted_at = $13, metadata = $14::jsonb, updated_at = $15
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          input.tenant_id, input.id, input.provider_recording_id, input.status,
          input.recording_mode, input.consent_id, input.object_ref, input.evidence_ref,
          input.checksum, input.duration_ms, input.retention_until, input.captured_at,
          input.deleted_at, JSON.stringify(input.metadata), input.updated_at
        ]
      );
      return decodeRecording(requiredRow(result.rows[0]));
    });
  }

  listRecordings(input: VoiceListInput & {
    call_id?: string;
    status?: VoiceRecording['status'];
  }): Promise<VoicePage<VoiceRecording>> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = boundedLimit(input.limit);
      const [cursorAt, cursorId] = cursorTuple(input.cursor);
      const result = await pg.query<VoicePgRow>(
        `SELECT recording.* FROM ivekit_voice_recordings recording
         WHERE recording.tenant_id = $1
           AND (recording.created_at, recording.id) < ($2::timestamptz, $3)
           AND ($4::text IS NULL OR recording.call_id = $4)
           AND ($5::text IS NULL OR recording.status = $5)
         ORDER BY recording.created_at DESC, recording.id DESC LIMIT $6`,
        [input.tenant_id, cursorAt, cursorId, input.call_id ?? null, input.status ?? null, limit + 1]
      );
      return pageFromRows(result.rows.map(decodeRecording), limit);
    });
  }

  getBridge(tenantId: string, id: string): Promise<VoiceLiveKitBridge | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT bridge.* FROM ivekit_voice_livekit_bridges bridge
         WHERE bridge.tenant_id = $1 AND bridge.id = $2`,
        [tenantId, id]
      );
      return result.rows[0] ? decodeBridge(result.rows[0]) : null;
    });
  }

  findBridgeByIdempotencyKey(tenantId: string, key: string): Promise<VoiceLiveKitBridge | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT bridge.* FROM ivekit_voice_livekit_bridges bridge
         WHERE bridge.tenant_id = $1 AND bridge.idempotency_key = $2`,
        [tenantId, key]
      );
      return result.rows[0] ? decodeBridge(result.rows[0]) : null;
    });
  }

  insertBridge(input: VoiceLiveKitBridge): Promise<VoiceLiveKitBridge> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_livekit_bridges
          (id, tenant_id, call_id, media_call_id, sip_participant_id, room_name,
           provider_bridge_id, status, idempotency_key, metadata, created_at,
           updated_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          input.id, input.tenant_id, input.call_id, input.media_call_id,
          input.sip_participant_id, input.room_name, input.provider_bridge_id,
          input.status, input.idempotency_key, JSON.stringify(input.metadata),
          input.created_at, input.updated_at, input.ended_at
        ]
      );
      if (result.rows[0]) return decodeBridge(result.rows[0]);
      const replay = await pg.query<VoicePgRow>(
        `SELECT bridge.* FROM ivekit_voice_livekit_bridges bridge
         WHERE bridge.tenant_id = $1 AND bridge.idempotency_key = $2`,
        [input.tenant_id, input.idempotency_key]
      );
      const found = decodeBridge(requiredRow(replay.rows[0], 'idempotency_conflict'));
      if (found.call_id !== input.call_id || found.media_call_id !== input.media_call_id) {
        throw new VoiceError({ code: 'idempotency_conflict', status: 409 });
      }
      return found;
    });
  }

  updateBridge(input: VoiceLiveKitBridge): Promise<VoiceLiveKitBridge> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `UPDATE ivekit_voice_livekit_bridges
         SET sip_participant_id = $3, provider_bridge_id = $4, status = $5,
             metadata = $6::jsonb, updated_at = $7, ended_at = $8
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          input.tenant_id, input.id, input.sip_participant_id,
          input.provider_bridge_id, input.status, JSON.stringify(input.metadata),
          input.updated_at, input.ended_at
        ]
      );
      return decodeBridge(requiredRow(result.rows[0]));
    });
  }

  listBridgesForCall(tenantId: string, callId: string): Promise<VoiceLiveKitBridge[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT bridge.* FROM ivekit_voice_livekit_bridges bridge
         WHERE bridge.tenant_id = $1 AND bridge.call_id = $2
         ORDER BY bridge.created_at ASC, bridge.id ASC`,
        [tenantId, callId]
      );
      return result.rows.map(decodeBridge);
    });
  }
}

function recordingParams(input: VoiceRecording): unknown[] {
  return [
    input.id, input.tenant_id, input.call_id, input.profile_id,
    input.provider_recording_id, input.status, input.recording_mode, input.consent_id,
    input.object_ref, input.evidence_ref, input.checksum, input.duration_ms,
    input.retention_until, input.captured_at, input.deleted_at, JSON.stringify(input.metadata),
    input.created_at, input.updated_at
  ];
}

function decodeRecording(row: VoicePgRow): VoiceRecording {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), call_id: String(row.call_id),
    profile_id: String(row.profile_id), provider_recording_id: String(row.provider_recording_id ?? ''),
    status: row.status as VoiceRecording['status'], recording_mode: row.recording_mode as VoiceRecording['recording_mode'],
    consent_id: row.consent_id == null ? null : String(row.consent_id), object_ref: String(row.object_ref ?? ''),
    evidence_ref: String(row.evidence_ref ?? ''), checksum: String(row.checksum ?? ''),
    duration_ms: row.duration_ms == null ? null : numberValue(row.duration_ms),
    retention_until: nullableTimestamp(row.retention_until), captured_at: nullableTimestamp(row.captured_at),
    deleted_at: nullableTimestamp(row.deleted_at), metadata: jsonRecord(row.metadata),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}

function decodeBridge(row: VoicePgRow): VoiceLiveKitBridge {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), call_id: String(row.call_id),
    media_call_id: String(row.media_call_id), sip_participant_id: String(row.sip_participant_id ?? ''),
    room_name: String(row.room_name), provider_bridge_id: String(row.provider_bridge_id ?? ''),
    status: row.status as VoiceLiveKitBridge['status'], idempotency_key: String(row.idempotency_key),
    metadata: jsonRecord(row.metadata), created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at), ended_at: nullableTimestamp(row.ended_at)
  };
}
