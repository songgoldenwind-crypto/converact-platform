import { one, run } from '../../../db.js';

export interface FacebookChannelConfig {
  tenant_id: string;
  page_id: string;
  page_access_token: string;
  updated_at: string;
}

export class FacebookChannelConfigStore {
  constructor(private readonly db: unknown) {}

  getPageAccessToken(tenantId: string): string {
    const row = one(
      this.db,
      'SELECT page_access_token FROM facebook_channel_configs WHERE tenant_id = ?',
      [tenantId]
    );
    if (row) return String((row as { page_access_token: string }).page_access_token);
    return process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '';
  }

  upsert(tenantId: string, input: { page_id?: string; page_access_token: string }): FacebookChannelConfig {
    const existing = one(this.db, 'SELECT tenant_id FROM facebook_channel_configs WHERE tenant_id = ?', [
      tenantId
    ]);
    if (existing) {
      run(
        this.db,
        `UPDATE facebook_channel_configs
         SET page_id = COALESCE(?, page_id), page_access_token = ?, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ?`,
        [input.page_id || null, input.page_access_token, tenantId]
      );
    } else {
      run(
        this.db,
        `INSERT INTO facebook_channel_configs (tenant_id, page_id, page_access_token)
         VALUES (?, ?, ?)`,
        [tenantId, input.page_id || '', input.page_access_token]
      );
    }
    return this.get(tenantId)!;
  }

  get(tenantId: string): FacebookChannelConfig | null {
    const row = one(this.db, 'SELECT * FROM facebook_channel_configs WHERE tenant_id = ?', [tenantId]);
    if (!row) return null;
    return {
      tenant_id: String((row as { tenant_id: string }).tenant_id),
      page_id: String((row as { page_id: string }).page_id),
      page_access_token: String((row as { page_access_token: string }).page_access_token),
      updated_at: String((row as { updated_at: string }).updated_at)
    };
  }
}
