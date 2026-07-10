import { all, id, one, run } from '../../../db.js';

export interface VoicemailRow {
  id: string;
  tenant_id: string;
  call_session_id: string | null;
  from_number: string;
  mailbox: string;
  recording_url: string;
  transcript: string | null;
  duration_sec: number | null;
  status: 'new' | 'read' | 'archived';
  created_at: string;
}

function decodeVoicemail(row: Record<string, unknown>): VoicemailRow {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    call_session_id: row.call_session_id ? String(row.call_session_id) : null,
    from_number: String(row.from_number || ''),
    mailbox: String(row.mailbox || 'default'),
    recording_url: String(row.recording_url || ''),
    transcript: row.transcript ? String(row.transcript) : null,
    duration_sec: row.duration_sec != null ? Number(row.duration_sec) : null,
    status: String(row.status) as VoicemailRow['status'],
    created_at: String(row.created_at)
  };
}

export class VoicemailStore {
  constructor(private readonly db: unknown) {}

  createVoicemail(input: {
    tenant_id: string;
    call_session_id?: string | null;
    from_number: string;
    mailbox?: string;
    recording_url?: string;
    transcript?: string | null;
    duration_sec?: number | null;
  }): VoicemailRow {
    const vmId = id('vm');
    run(
      this.db,
      `INSERT INTO voicemails
        (id, tenant_id, call_session_id, from_number, mailbox, recording_url, transcript, duration_sec, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
      [
        vmId,
        input.tenant_id,
        input.call_session_id || null,
        input.from_number,
        input.mailbox || 'default',
        input.recording_url || '',
        input.transcript || null,
        input.duration_sec ?? null
      ]
    );
    const row = one(this.db, 'SELECT * FROM voicemails WHERE id = ?', [vmId]);
    return decodeVoicemail(row as Record<string, unknown>);
  }

  listVoicemails(
    tenantId: string,
    status: VoicemailRow['status'] | null = null,
    limit = 50,
    offset = 0
  ): VoicemailRow[] {
    const params: (string | number)[] = [tenantId];
    let sql = 'SELECT * FROM voicemails WHERE tenant_id = ?';
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return all(this.db, sql, params).map((row) => decodeVoicemail(row as Record<string, unknown>));
  }

  markRead(voicemailId: string, tenantId: string): VoicemailRow | null {
    run(this.db, `UPDATE voicemails SET status = 'read' WHERE id = ? AND tenant_id = ?`, [
      voicemailId,
      tenantId
    ]);
    const row = one(this.db, 'SELECT * FROM voicemails WHERE id = ? AND tenant_id = ?', [
      voicemailId,
      tenantId
    ]);
    return row ? decodeVoicemail(row as Record<string, unknown>) : null;
  }
}
