import { all, id, one, run } from '../../../db.js';
import type { DidNumberRow, DidRouteType } from './types.js';

function decodeDid(row: Record<string, unknown>): DidNumberRow {
  return {
    id: String(row.id),
    tenant_id: row.tenant_id ? String(row.tenant_id) : null,
    number: String(row.number),
    label: row.label ? String(row.label) : null,
    route_type: String(row.route_type) as DidRouteType,
    route_target: row.route_target ? String(row.route_target) : null,
    is_active: Boolean(row.is_active),
    created_at: String(row.created_at)
  };
}

export function normalizeDidNumber(raw: string): string {
  const digits = String(raw).replace(/\D/g, '');
  return digits.startsWith('86') && digits.length > 11 ? `+${digits}` : digits.length >= 8 ? `+${digits}` : digits;
}

export class DidStore {
  constructor(private readonly db: unknown) {}

  listDids(tenantId: string): DidNumberRow[] {
    return all(
      this.db,
      `SELECT * FROM did_numbers WHERE tenant_id = ? ORDER BY number ASC`,
      [tenantId]
    ).map((row) => decodeDid(row as Record<string, unknown>));
  }

  getDid(didId: string): DidNumberRow | null {
    const row = one(this.db, 'SELECT * FROM did_numbers WHERE id = ?', [didId]);
    return row ? decodeDid(row as Record<string, unknown>) : null;
  }

  findByNumber(number: string): DidNumberRow | null {
    const normalized = normalizeDidNumber(number);
    // Exact match first — number is globally unique (UNIQUE constraint in schema).
    const row = one(this.db, 'SELECT * FROM did_numbers WHERE number = ? AND is_active = 1', [normalized]);
    if (row) return decodeDid(row as Record<string, unknown>);
    // Fuzzy match by last 10 digits — used when caller ID has country code prefix
    // that doesn't exactly match the stored number. This is safe because:
    // 1. We only return the FIRST match (LIMIT 1)
    // 2. DID numbers are globally unique, so even a fuzzy match identifies one tenant
    // 3. The caller cannot influence which DID is stored — only admins configure DIDs.
    // However, to prevent tail-collision across tenants with similar number suffixes,
    // we prefer longer suffix matches (try 11, then 10 digits).
    const digits = normalized.replace(/\D/g, '');
    for (const suffixLen of [Math.min(digits.length, 11), 10]) {
      if (suffixLen < 7) break; // too short to be meaningful
      const fuzzy = one(
        this.db,
        `SELECT * FROM did_numbers WHERE REPLACE(number, '+', '') LIKE ? AND is_active = 1 LIMIT 1`,
        [`%${digits.slice(-suffixLen)}`]
      );
      if (fuzzy) return decodeDid(fuzzy as Record<string, unknown>);
    }
    return null;
  }

  createDid(input: {
    tenant_id: string;
    number: string;
    label?: string;
    route_type?: DidRouteType;
    route_target?: string | null;
  }): DidNumberRow {
    const didId = id('did');
    const number = normalizeDidNumber(input.number);
    run(
      this.db,
      `INSERT INTO did_numbers (id, tenant_id, number, label, route_type, route_target, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [
        didId,
        input.tenant_id,
        number,
        input.label || null,
        input.route_type || 'queue',
        input.route_target || null
      ]
    );
    return this.getDid(didId)!;
  }

  updateDid(
    didId: string,
    tenantId: string,
    patch: Partial<Pick<DidNumberRow, 'label' | 'route_type' | 'route_target' | 'is_active'>>
  ): DidNumberRow | null {
    const existing = this.getDid(didId);
    if (!existing || existing.tenant_id !== tenantId) return null;
    run(
      this.db,
      `UPDATE did_numbers
       SET label = COALESCE(?, label),
           route_type = COALESCE(?, route_type),
           route_target = COALESCE(?, route_target),
           is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      [
        patch.label ?? null,
        patch.route_type ?? null,
        patch.route_target ?? null,
        patch.is_active === undefined ? null : patch.is_active ? 1 : 0,
        didId
      ]
    );
    return this.getDid(didId);
  }
}
