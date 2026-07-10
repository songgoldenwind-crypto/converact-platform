import { id, one, run } from '../../../db.js';

export interface WhiteLabelConfig {
  id: string;
  tenant_id: string;
  brand_name: string;
  logo_url: string;
  primary_color: string;
  custom_domain: string | null;
  email_from_name: string;
  email_from_address: string;
}

interface DatabaseLike {
  exec: (sql: string) => void;
}

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS white_label_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE,
  brand_name TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  primary_color TEXT NOT NULL DEFAULT '#3b82f6',
  custom_domain TEXT UNIQUE,
  email_from_name TEXT NOT NULL DEFAULT '',
  email_from_address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

export class WhiteLabelStore {
  constructor(private readonly db: unknown) {
    (db as DatabaseLike).exec(MIGRATION_SQL);
  }

  resolveByDomain(domain: string): WhiteLabelConfig | null {
    const normalized = domain.trim().toLowerCase();
    const row = one(this.db, `SELECT * FROM white_label_configs WHERE LOWER(custom_domain) = ?`, [normalized]);
    return row ? this.toConfig(row) : null;
  }

  getConfig(tenantId: string): WhiteLabelConfig | null {
    const row = one(this.db, `SELECT * FROM white_label_configs WHERE tenant_id = ?`, [tenantId]);
    return row ? this.toConfig(row) : null;
  }

  upsertConfig(tenantId: string, config: Partial<Omit<WhiteLabelConfig, 'id' | 'tenant_id'>>): WhiteLabelConfig {
    const existing = this.getConfig(tenantId);

    if (existing) {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];

      if (config.brand_name !== undefined) { sets.push('brand_name = ?'); params.push(config.brand_name); }
      if (config.logo_url !== undefined) { sets.push('logo_url = ?'); params.push(config.logo_url); }
      if (config.primary_color !== undefined) { sets.push('primary_color = ?'); params.push(config.primary_color); }
      if (config.custom_domain !== undefined) { sets.push('custom_domain = ?'); params.push(config.custom_domain); }
      if (config.email_from_name !== undefined) { sets.push('email_from_name = ?'); params.push(config.email_from_name); }
      if (config.email_from_address !== undefined) { sets.push('email_from_address = ?'); params.push(config.email_from_address); }

      if (sets.length > 0) {
        sets.push("updated_at = CURRENT_TIMESTAMP");
        params.push(existing.id);
        run(this.db, `UPDATE white_label_configs SET ${sets.join(', ')} WHERE id = ?`, params);
      }
      return this.getConfig(tenantId)!;
    }

    const newId = id('wl');
    run(this.db,
      `INSERT INTO white_label_configs (id, tenant_id, brand_name, logo_url, primary_color, custom_domain, email_from_name, email_from_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId,
        tenantId,
        config.brand_name || '',
        config.logo_url || '',
        config.primary_color || '#3b82f6',
        config.custom_domain ?? null,
        config.email_from_name || '',
        config.email_from_address || ''
      ]
    );
    return this.getConfig(tenantId)!;
  }

  private toConfig(row: any): WhiteLabelConfig {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      brand_name: row.brand_name,
      logo_url: row.logo_url,
      primary_color: row.primary_color,
      custom_domain: row.custom_domain || null,
      email_from_name: row.email_from_name,
      email_from_address: row.email_from_address
    };
  }
}
