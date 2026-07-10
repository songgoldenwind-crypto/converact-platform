import { all, id, json, one, parseJson, run } from '../../../db.js';

export interface AuditLogEntry {
  id: string;
  tenant_id: string;
  actor_id: string;
  action: string;
  object_type: string;
  object_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export class ComplianceAuditStore {
  constructor(private readonly db: unknown) {}

  record(input: {
    tenant_id: string;
    actor_id: string;
    action: string;
    object_type: string;
    object_id: string;
    metadata?: Record<string, unknown>;
  }): AuditLogEntry {
    const auditId = id('audit');
    run(
      this.db,
      `INSERT INTO audit_logs (id, tenant_id, actor_id, action, object_type, object_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        auditId,
        input.tenant_id,
        input.actor_id,
        input.action,
        input.object_type,
        input.object_id,
        json(input.metadata || {})
      ]
    );
    return this.get(auditId)!;
  }

  get(auditId: string): AuditLogEntry | null {
    const row = one(this.db, 'SELECT * FROM audit_logs WHERE id = ?', [auditId]);
    return row ? decode(row) : null;
  }

  list(
    tenantId: string,
    opts: { actor_id?: string | null; action_prefix?: string | null; limit?: number } = {}
  ): AuditLogEntry[] {
    const conditions = ['tenant_id = ?'];
    const params: (string | number)[] = [tenantId];
    if (opts.actor_id) {
      conditions.push('actor_id = ?');
      params.push(opts.actor_id);
    }
    if (opts.action_prefix) {
      conditions.push('action LIKE ?');
      params.push(`${opts.action_prefix}%`);
    }
    params.push(opts.limit || 100);
    return all(
      this.db,
      `SELECT * FROM audit_logs WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params
    ).map(decode);
  }

  purgeOlderThan(tenantId: string, beforeIso: string): number {
    const result = run(
      this.db,
      `DELETE FROM audit_logs WHERE tenant_id = ? AND datetime(created_at) < datetime(?)`,
      [tenantId, beforeIso]
    );
    return Number(result?.changes || 0);
  }
}

export function listActivityStream(
  db: unknown,
  tenantId: string,
  limit = 50
): Array<{
  id: string;
  type: string;
  actor_id: string;
  summary: string;
  object_type: string;
  object_id: string;
  occurred_at: string;
}> {
  const rows = all(
    db,
    `SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
    [tenantId, limit]
  );
  return rows.map((row) => {
    const action = String((row as { action: string }).action);
    const objectType = String((row as { object_type: string }).object_type);
    const objectId = String((row as { object_id: string }).object_id);
    return {
      id: String((row as { id: string }).id),
      type: action,
      actor_id: String((row as { actor_id: string }).actor_id),
      summary: `${action} · ${objectType}/${objectId}`,
      object_type: objectType,
      object_id: objectId,
      occurred_at: String((row as { created_at: string }).created_at)
    };
  });
}

function decode(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    actor_id: String(row.actor_id),
    action: String(row.action),
    object_type: String(row.object_type),
    object_id: String(row.object_id),
    metadata: parseJson(String(row.metadata || '{}'), {}),
    created_at: String(row.created_at)
  };
}
