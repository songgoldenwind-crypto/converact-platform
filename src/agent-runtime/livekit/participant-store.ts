import { all, id, json, one, parseJson, run } from '../../db.js';
import type {
  LiveKitMediaParticipantRole,
  LiveKitParticipantRow,
  LiveKitParticipantService
} from './types.js';

export class LiveKitParticipantStore implements LiveKitParticipantService {
  constructor(private readonly db: unknown) {}

  upsertJoined(input: {
    tenant_id: string;
    room_name: string;
    identity: string;
    role?: LiveKitMediaParticipantRole;
    metadata?: Record<string, unknown>;
  }): LiveKitParticipantRow {
    const existing = this.getParticipant(input.room_name, input.identity);
    if (existing) {
      const metadata = hasMetadata(input.metadata) ? input.metadata! : existing.metadata;
      run(
        this.db,
        `UPDATE livekit_participants
         SET tenant_id = ?, role = ?, status = 'joined', metadata = ?, left_at = NULL
         WHERE room_name = ? AND identity = ?`,
        [
          input.tenant_id,
          participantRole(input.role, existing.role),
          json(metadata),
          input.room_name,
          input.identity
        ]
      );
      return this.getParticipant(input.room_name, input.identity)!;
    }

    run(
      this.db,
      `INSERT INTO livekit_participants
        (id, tenant_id, room_name, identity, role, status, metadata)
       VALUES (?, ?, ?, ?, ?, 'joined', ?)`,
      [
        id('lkpart'),
        input.tenant_id,
        input.room_name,
        input.identity,
        input.role || 'unknown',
        json(input.metadata || {})
      ]
    );
    return this.getParticipant(input.room_name, input.identity)!;
  }

  markLeft(roomName: string, identity: string): LiveKitParticipantRow | null {
    run(
      this.db,
      `UPDATE livekit_participants
       SET status = 'left', left_at = CURRENT_TIMESTAMP
       WHERE room_name = ? AND identity = ?`,
      [roomName, identity]
    );
    return this.getParticipant(roomName, identity);
  }

  upsertLeft(input: {
    tenant_id: string;
    room_name: string;
    identity: string;
    role?: LiveKitMediaParticipantRole;
    metadata?: Record<string, unknown>;
  }): LiveKitParticipantRow {
    const existing = this.getParticipant(input.room_name, input.identity);
    if (existing) {
      const metadata = hasMetadata(input.metadata) ? input.metadata! : existing.metadata;
      run(
        this.db,
        `UPDATE livekit_participants
         SET tenant_id = ?, role = ?, status = 'left', metadata = ?, left_at = CURRENT_TIMESTAMP
         WHERE room_name = ? AND identity = ?`,
        [
          input.tenant_id,
          participantRole(input.role, existing.role),
          json(metadata),
          input.room_name,
          input.identity
        ]
      );
      return this.getParticipant(input.room_name, input.identity)!;
    }

    run(
      this.db,
      `INSERT INTO livekit_participants
        (id, tenant_id, room_name, identity, role, status, metadata, left_at)
       VALUES (?, ?, ?, ?, ?, 'left', ?, CURRENT_TIMESTAMP)`,
      [
        id('lkpart'),
        input.tenant_id,
        input.room_name,
        input.identity,
        input.role || 'unknown',
        json(input.metadata || {})
      ]
    );
    return this.getParticipant(input.room_name, input.identity)!;
  }

  markRoomLeft(roomName: string): number {
    const result = run(
      this.db,
      `UPDATE livekit_participants
       SET status = 'left', left_at = CURRENT_TIMESTAMP
       WHERE room_name = ? AND status = 'joined'`,
      [roomName]
    );
    return Number(result?.changes || 0);
  }

  getParticipant(roomName: string, identity: string): LiveKitParticipantRow | null {
    const row = one(
      this.db,
      'SELECT * FROM livekit_participants WHERE room_name = ? AND identity = ?',
      [roomName, identity]
    );
    return row ? decodeParticipant(row) : null;
  }

  listByRoom(roomName: string, opts: { includeLeft?: boolean; limit?: number } = {}): LiveKitParticipantRow[] {
    const limit = opts.limit || 100;
    const rows = opts.includeLeft
      ? all(
          this.db,
          'SELECT * FROM livekit_participants WHERE room_name = ? ORDER BY joined_at ASC LIMIT ?',
          [roomName, limit]
        )
      : all(
          this.db,
          "SELECT * FROM livekit_participants WHERE room_name = ? AND status = 'joined' ORDER BY joined_at ASC LIMIT ?",
          [roomName, limit]
        );
    return rows.map(decodeParticipant);
  }
}

function decodeParticipant(row: Record<string, unknown>): LiveKitParticipantRow {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    room_name: String(row.room_name),
    identity: String(row.identity),
    role: String(row.role || 'unknown') as LiveKitMediaParticipantRole,
    status: String(row.status || 'joined') as LiveKitParticipantRow['status'],
    metadata: parseJson(String(row.metadata || '{}'), {}),
    joined_at: String(row.joined_at),
    left_at: row.left_at ? String(row.left_at) : null
  };
}

function hasMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return Boolean(metadata && Object.keys(metadata).length > 0);
}

function participantRole(
  candidate: LiveKitMediaParticipantRole | undefined,
  existing: LiveKitMediaParticipantRole | undefined
): LiveKitMediaParticipantRole {
  if (candidate && candidate !== 'unknown') return candidate;
  return existing || 'unknown';
}
