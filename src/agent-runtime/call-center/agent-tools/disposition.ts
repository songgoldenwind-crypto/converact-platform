import { all, id, one, run } from '../../../db.js';

export interface DispositionCodeRow {
  id: string;
  tenant_id: string;
  code: string;
  label: string;
  category: string | null;
  is_active: boolean;
}

export interface CallDispositionRow {
  call_session_id: string;
  disposition_code: string;
  notes: string | null;
  created_at: string;
}

const DEFAULT_CODES: Array<{ code: string; label: string; category: string }> = [
  { code: 'completed', label: '已完成', category: 'success' },
  { code: 'callback', label: '需回呼', category: 'follow_up' },
  { code: 'no_answer', label: '未接通', category: 'failure' },
  { code: 'not_interested', label: '无意向', category: 'failure' },
  { code: 'wrong_number', label: '错号', category: 'failure' },
  { code: 'escalated', label: '已升级', category: 'transfer' }
];

function decodeCode(row: Record<string, unknown>): DispositionCodeRow {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    code: String(row.code),
    label: String(row.label),
    category: row.category ? String(row.category) : null,
    is_active: Boolean(row.is_active)
  };
}

export class DispositionStore {
  constructor(private readonly db: unknown) {}

  seedDefaults(tenantId: string): void {
    for (const item of DEFAULT_CODES) {
      const existing = one(this.db, 'SELECT id FROM disposition_codes WHERE tenant_id = ? AND code = ?', [
        tenantId,
        item.code
      ]);
      if (existing) continue;
      run(
        this.db,
        `INSERT INTO disposition_codes (id, tenant_id, code, label, category, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [id('dcode'), tenantId, item.code, item.label, item.category]
      );
    }
  }

  listCodes(tenantId: string): DispositionCodeRow[] {
    return all(
      this.db,
      `SELECT * FROM disposition_codes WHERE tenant_id = ? AND is_active = 1 ORDER BY code ASC`,
      [tenantId]
    ).map((row) => decodeCode(row as Record<string, unknown>));
  }

  createCode(input: {
    tenant_id: string;
    code: string;
    label: string;
    category?: string | null;
  }): DispositionCodeRow {
    const codeId = id('dcode');
    run(
      this.db,
      `INSERT INTO disposition_codes (id, tenant_id, code, label, category, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [codeId, input.tenant_id, input.code, input.label, input.category || null]
    );
    const row = one(this.db, 'SELECT * FROM disposition_codes WHERE id = ?', [codeId]);
    return decodeCode(row as Record<string, unknown>);
  }

  setCallDisposition(callSessionId: string, dispositionCode: string, notes: string | null = null): CallDispositionRow {
    run(
      this.db,
      `INSERT INTO call_dispositions (call_session_id, disposition_code, notes)
       VALUES (?, ?, ?)
       ON CONFLICT(call_session_id) DO UPDATE SET
         disposition_code = excluded.disposition_code,
         notes = excluded.notes,
         created_at = CURRENT_TIMESTAMP`,
      [callSessionId, dispositionCode, notes]
    );
    const row = one(this.db, 'SELECT * FROM call_dispositions WHERE call_session_id = ?', [callSessionId]);
    return {
      call_session_id: String(row.call_session_id),
      disposition_code: String(row.disposition_code),
      notes: row.notes ? String(row.notes) : null,
      created_at: String(row.created_at)
    };
  }

  getCallDisposition(callSessionId: string): CallDispositionRow | null {
    const row = one(this.db, 'SELECT * FROM call_dispositions WHERE call_session_id = ?', [callSessionId]);
    if (!row) return null;
    return {
      call_session_id: String(row.call_session_id),
      disposition_code: String(row.disposition_code),
      notes: row.notes ? String(row.notes) : null,
      created_at: String(row.created_at)
    };
  }
}
