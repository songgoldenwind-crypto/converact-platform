import { randomUUID } from 'node:crypto';
import { id, one, all, run, json, parseJson } from '../../../db.js';

export interface WebhookSubscription {
  id: string;
  tenant_id: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
}

interface DatabaseLike {
  exec: (sql: string) => void;
}

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webhook_tenant ON webhook_subscriptions(tenant_id);
`;

export class WebhookStore {
  constructor(private readonly db: unknown) {
    (db as DatabaseLike).exec(MIGRATION_SQL);
  }

  create(input: { tenant_id: string; url: string; events: string[]; secret?: string }): WebhookSubscription {
    const subId = id('whk');
    const secret = input.secret || randomUUID();
    run(this.db,
      `INSERT INTO webhook_subscriptions (id, tenant_id, url, events, secret) VALUES (?, ?, ?, ?, ?)`,
      [subId, input.tenant_id, input.url, json(input.events), secret]
    );
    return this.get(subId)!;
  }

  get(subId: string): WebhookSubscription | null {
    const row = one(this.db, `SELECT * FROM webhook_subscriptions WHERE id = ?`, [subId]);
    return row ? this.toSubscription(row) : null;
  }

  list(tenantId: string): WebhookSubscription[] {
    const rows = all(this.db, `SELECT * FROM webhook_subscriptions WHERE tenant_id = ? ORDER BY created_at DESC`, [tenantId]);
    return rows.map(r => this.toSubscription(r));
  }

  update(subId: string, update: { url?: string; events?: string[]; active?: boolean }, tenantId?: string): WebhookSubscription | null {
    const existing = this.get(subId);
    if (!existing) return null;
    // Tenant isolation: reject if subscription belongs to another tenant.
    if (tenantId && existing.tenant_id !== tenantId) return null;

    const sets: string[] = [];
    const params: (string | number)[] = [];

    if (update.url !== undefined) { sets.push('url = ?'); params.push(update.url); }
    if (update.events !== undefined) { sets.push('events = ?'); params.push(json(update.events)); }
    if (update.active !== undefined) { sets.push('active = ?'); params.push(update.active ? 1 : 0); }

    if (sets.length === 0) return existing;

    sets.push("updated_at = CURRENT_TIMESTAMP");
    params.push(subId);
    run(this.db, `UPDATE webhook_subscriptions SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.get(subId)!;
  }

  delete(subId: string, tenantId?: string): void {
    // Tenant isolation: only delete if subscription belongs to tenant.
    if (tenantId) {
      run(this.db, 'DELETE FROM webhook_subscriptions WHERE id = ? AND tenant_id = ?', [subId, tenantId]);
    } else {
      run(this.db, 'DELETE FROM webhook_subscriptions WHERE id = ?', [subId]);
    }
    run(this.db, `DELETE FROM webhook_subscriptions WHERE id = ?`, [subId]);
  }

  getSubscribersForEvent(tenantId: string, event: string): WebhookSubscription[] {
    const rows = all(this.db, `SELECT * FROM webhook_subscriptions WHERE tenant_id = ? AND active = 1`, [tenantId]);
    return rows
      .map(r => this.toSubscription(r))
      .filter(sub => sub.events.includes(event) || sub.events.includes('*'));
  }

  private toSubscription(row: any): WebhookSubscription {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      url: row.url,
      events: parseJson<string[]>(row.events, []),
      secret: row.secret,
      active: row.active === 1
    };
  }
}
