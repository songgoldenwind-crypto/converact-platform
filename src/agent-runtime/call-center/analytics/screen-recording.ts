import { all, id, run } from '../../../db.js';

export interface ScreenRecording {
  id: string;
  tenant_id: string;
  call_session_id: string | null;
  seat_id: string | null;
  storage_url: string;
  duration_sec: number;
  status: string;
  created_at: string;
}

export class ScreenRecordingStore {
  constructor(private readonly db: unknown) {}

  create(input: {
    tenant_id: string;
    call_session_id?: string;
    seat_id?: string;
    storage_url: string;
    duration_sec?: number;
  }): ScreenRecording {
    const recId = id('scrn');
    run(
      this.db,
      `INSERT INTO screen_recordings (id, tenant_id, call_session_id, seat_id, storage_url, duration_sec)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        recId,
        input.tenant_id,
        input.call_session_id || null,
        input.seat_id || null,
        input.storage_url,
        input.duration_sec ?? 0
      ]
    );
    return {
      id: recId,
      tenant_id: input.tenant_id,
      call_session_id: input.call_session_id || null,
      seat_id: input.seat_id || null,
      storage_url: input.storage_url,
      duration_sec: input.duration_sec ?? 0,
      status: 'completed',
      created_at: new Date().toISOString()
    };
  }

  list(tenantId: string, limit = 50): ScreenRecording[] {
    return all(
      this.db,
      'SELECT * FROM screen_recordings WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
      [tenantId, limit]
    ).map((row) => ({
      id: String((row as { id: string }).id),
      tenant_id: String((row as { tenant_id: string }).tenant_id),
      call_session_id: (row as { call_session_id: string | null }).call_session_id
        ? String((row as { call_session_id: string }).call_session_id)
        : null,
      seat_id: (row as { seat_id: string | null }).seat_id
        ? String((row as { seat_id: string }).seat_id)
        : null,
      storage_url: String((row as { storage_url: string }).storage_url),
      duration_sec: Number((row as { duration_sec: number }).duration_sec),
      status: String((row as { status: string }).status),
      created_at: String((row as { created_at: string }).created_at)
    }));
  }
}
