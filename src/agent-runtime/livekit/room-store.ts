import { id, json, one, parseJson, run } from '../../db.js';
import type { LiveKitConfig } from './config.js';
import type { CreateMediaRoomInput, LiveKitRoomRow, MediaRoomPurpose } from './types.js';
import { createLiveKitRoomClient } from './token-service.js';

export type CreateLiveKitRoomInput = CreateMediaRoomInput;
export type { LiveKitRoomRow };

export class LiveKitRoomStore {
  constructor(
    readonly db: unknown,
    private readonly config?: LiveKitConfig
  ) {}

  async createRoom(input: CreateLiveKitRoomInput): Promise<LiveKitRoomRow> {
    const roomName = input.room_name || buildRoomName(input.tenant_id, input.purpose);
    const roomId = id('lroom');
    const metadata = {
      ...(input.metadata || {}),
      tenant_id: input.tenant_id,
      purpose: input.purpose
    };

    let roomSid = '';
    const client = createLiveKitRoomClient(this.config);
    if (client) {
      const created = await client.createRoom({
        name: roomName,
        emptyTimeout: 300,
        metadata: JSON.stringify(metadata)
      });
      roomSid = created.sid;
    }

    run(
      this.db,
      `INSERT INTO livekit_rooms
        (id, tenant_id, room_name, room_sid, purpose, status, call_session_id, metadata)
       VALUES (?, ?, ?, ?, ?, 'created', ?, ?)`,
      [roomId, input.tenant_id, roomName, roomSid, input.purpose, input.call_session_id || null, json(metadata)]
    );

    if (input.call_session_id) {
      run(
        this.db,
        `UPDATE voice_call_sessions
         SET livekit_room_name = ?, livekit_room_sid = ?, media_type = ?, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ? AND id = ?`,
        [
          roomName,
          roomSid,
          input.purpose === 'pstn_bridge' ? 'audio' : 'video',
          input.tenant_id,
          input.call_session_id
        ]
      );
    }

    return this.getRoomByName(roomName)!;
  }

  getRoomByName(roomName: string): LiveKitRoomRow | null {
    const row = one(this.db, 'SELECT * FROM livekit_rooms WHERE room_name = ?', [roomName]);
    return row ? decodeRoom(row) : null;
  }

  getRoomByCallSession(callSessionId: string): LiveKitRoomRow | null {
    const row = one(
      this.db,
      `SELECT * FROM livekit_rooms WHERE call_session_id = ? ORDER BY created_at DESC LIMIT 1`,
      [callSessionId]
    );
    return row ? decodeRoom(row) : null;
  }

  markRoomActive(roomName: string, roomSid = ''): LiveKitRoomRow | null {
    run(
      this.db,
      `UPDATE livekit_rooms
       SET status = 'active', room_sid = CASE WHEN ? != '' THEN ? ELSE room_sid END
       WHERE room_name = ? AND status != 'closed'`,
      [roomSid, roomSid, roomName]
    );
    return this.getRoomByName(roomName);
  }

  closeRoom(roomName: string): LiveKitRoomRow | null {
    run(
      this.db,
      `UPDATE livekit_rooms SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE room_name = ?`,
      [roomName]
    );
    void this.deleteRemoteRoom(roomName).catch((error) => {
      console.warn('[livekit] deleteRemoteRoom failed:', error instanceof Error ? error.message : error);
    });
    return this.getRoomByName(roomName);
  }

  private async deleteRemoteRoom(roomName: string): Promise<void> {
    const client = createLiveKitRoomClient(this.config);
    if (!client) return;
    try {
      await client.deleteRoom(roomName);
    } catch {
      // room may already be gone on LiveKit side
    }
  }
}

function buildRoomName(tenantId: string, purpose: MediaRoomPurpose): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${tenantId}-${purpose}-${suffix}`;
}

function decodeRoom(row: Record<string, unknown>): LiveKitRoomRow {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    room_name: String(row.room_name),
    room_sid: String(row.room_sid || ''),
    purpose: String(row.purpose) as MediaRoomPurpose,
    status: String(row.status) as LiveKitRoomRow['status'],
    call_session_id: row.call_session_id ? String(row.call_session_id) : null,
    metadata: parseJson(String(row.metadata), {})
  };
}
