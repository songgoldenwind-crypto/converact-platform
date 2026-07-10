import { createHash } from 'node:crypto';
import { all, id, json, one, parseJson, run, type SqliteParams } from '../../../db.js';

export type CampaignDialMode = 'preview' | 'progressive' | 'predictive';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';
export type CampaignContactStatus = 'pending' | 'dialed' | 'completed' | 'skipped' | 'failed';

export interface OutboundCampaign {
  id: string;
  tenant_id: string;
  name: string;
  dial_mode: CampaignDialMode;
  status: CampaignStatus;
  agent_spec_id_a: string;
  agent_spec_id_b: string;
  ab_enabled: boolean;
  timezone: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  stats: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CampaignContact {
  id: string;
  campaign_id: string;
  tenant_id: string;
  phone_number: string;
  display_name: string;
  status: CampaignContactStatus;
  ab_variant: 'A' | 'B';
  disposition: string | null;
  outbound_task_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CampaignStats {
  campaign_id: string;
  total_contacts: number;
  pending: number;
  dialed: number;
  completed: number;
  failed: number;
  skipped: number;
  answer_rate: number;
  conversion_rate: number;
  abandon_rate: number;
  variant_a: { completed: number; total: number };
  variant_b: { completed: number; total: number };
}

export class OutboundCampaignStore {
  constructor(private readonly db: unknown) {}

  createCampaign(input: {
    tenant_id: string;
    name: string;
    dial_mode?: CampaignDialMode;
    agent_spec_id_a: string;
    agent_spec_id_b?: string;
    ab_enabled?: boolean;
    timezone?: string;
    scheduled_start?: string | null;
    scheduled_end?: string | null;
  }): OutboundCampaign {
    const campaignId = id('ocamp');
    const now = new Date().toISOString();
    run(
      this.db,
      `INSERT INTO outbound_campaigns
        (id, tenant_id, name, dial_mode, status, agent_spec_id_a, agent_spec_id_b, ab_enabled, timezone, scheduled_start, scheduled_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        campaignId,
        input.tenant_id,
        input.name,
        input.dial_mode || 'predictive',
        input.agent_spec_id_a,
        input.agent_spec_id_b || '',
        input.ab_enabled ? 1 : 0,
        input.timezone || 'Asia/Shanghai',
        input.scheduled_start || null,
        input.scheduled_end || null,
        now,
        now
      ]
    );
    return this.getCampaign(campaignId)!;
  }

  getCampaign(campaignId: string): OutboundCampaign | null {
    const row = one(this.db, 'SELECT * FROM outbound_campaigns WHERE id = ?', [campaignId]);
    return row ? decodeCampaign(row) : null;
  }

  listCampaigns(tenantId: string, status: CampaignStatus | null = null): OutboundCampaign[] {
    const params: SqliteParams = [tenantId];
    let sql = 'SELECT * FROM outbound_campaigns WHERE tenant_id = ?';
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT 100';
    return all(this.db, sql, params).map(decodeCampaign);
  }

  updateCampaignStatus(campaignId: string, tenantId: string, status: CampaignStatus): OutboundCampaign | null {
    run(
      this.db,
      `UPDATE outbound_campaigns SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?`,
      [status, campaignId, tenantId]
    );
    const row = one(this.db, 'SELECT * FROM outbound_campaigns WHERE id = ? AND tenant_id = ?', [
      campaignId,
      tenantId
    ]);
    return row ? decodeCampaign(row) : null;
  }

  mergeStats(campaignId: string, patch: Record<string, unknown>): void {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) return;
    const stats = { ...campaign.stats, ...patch };
    run(this.db, `UPDATE outbound_campaigns SET stats = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      json(stats),
      campaignId
    ]);
  }

  addContacts(
    campaignId: string,
    tenantId: string,
    contacts: Array<{ phone_number: string; display_name?: string; metadata?: Record<string, unknown> }>
  ): CampaignContact[] {
    const campaign = this.getCampaign(campaignId);
    if (!campaign || campaign.tenant_id !== tenantId) {
      throw Object.assign(new Error('campaign not found'), { status: 404 });
    }

    const created: CampaignContact[] = [];
    for (const contact of contacts) {
      const contactId = id('ocontact');
      const abVariant = campaign.ab_enabled && hashVariant(contact.phone_number) === 1 ? 'B' : 'A';
      run(
        this.db,
        `INSERT INTO outbound_campaign_contacts
          (id, campaign_id, tenant_id, phone_number, display_name, ab_variant, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          contactId,
          campaignId,
          tenantId,
          contact.phone_number.trim(),
          contact.display_name || '',
          abVariant,
          json(contact.metadata || {})
        ]
      );
      const row = one(this.db, 'SELECT * FROM outbound_campaign_contacts WHERE id = ?', [contactId]);
      if (row) created.push(decodeContact(row));
    }
    return created;
  }

  listContacts(campaignId: string, status: CampaignContactStatus | null = null, limit = 200): CampaignContact[] {
    const params: (string | number)[] = [campaignId];
    let sql = 'SELECT * FROM outbound_campaign_contacts WHERE campaign_id = ?';
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at ASC LIMIT ?';
    params.push(limit);
    return all(this.db, sql, params).map(decodeContact);
  }

  pickPendingContacts(campaignId: string, limit: number): CampaignContact[] {
    return all(
      this.db,
      `SELECT * FROM outbound_campaign_contacts
       WHERE campaign_id = ? AND status = 'pending'
       ORDER BY created_at ASC LIMIT ?`,
      [campaignId, limit]
    ).map(decodeContact);
  }

  updateContact(
    contactId: string,
    patch: Partial<{
      status: CampaignContactStatus;
      disposition: string | null;
      outbound_task_id: string | null;
    }>
  ): CampaignContact | null {
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      fields.push('status = ?');
      params.push(patch.status);
    }
    if (patch.disposition !== undefined) {
      fields.push('disposition = ?');
      params.push(patch.disposition);
    }
    if (patch.outbound_task_id !== undefined) {
      fields.push('outbound_task_id = ?');
      params.push(patch.outbound_task_id);
    }
    if (!fields.length) return this.getContact(contactId);
    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(contactId);
    run(this.db, `UPDATE outbound_campaign_contacts SET ${fields.join(', ')} WHERE id = ?`, params);
    return this.getContact(contactId);
  }

  getContact(contactId: string): CampaignContact | null {
    const row = one(this.db, 'SELECT * FROM outbound_campaign_contacts WHERE id = ?', [contactId]);
    return row ? decodeContact(row) : null;
  }

  getStats(campaignId: string): CampaignStats {
    const rows = all(
      this.db,
      `SELECT status, ab_variant, COUNT(*) AS cnt FROM outbound_campaign_contacts WHERE campaign_id = ? GROUP BY status, ab_variant`,
      [campaignId]
    );
    const stats = {
      total_contacts: 0,
      pending: 0,
      dialed: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      variant_a: { completed: 0, total: 0 },
      variant_b: { completed: 0, total: 0 }
    };
    for (const row of rows) {
      const status = String((row as { status: string }).status) as CampaignContactStatus;
      const variant = String((row as { ab_variant: string }).ab_variant) as 'A' | 'B';
      const cnt = Number((row as { cnt: number }).cnt);
      stats.total_contacts += cnt;
      if (status === 'pending') stats.pending += cnt;
      else if (status === 'dialed') stats.dialed += cnt;
      else if (status === 'completed') stats.completed += cnt;
      else if (status === 'failed') stats.failed += cnt;
      else if (status === 'skipped') stats.skipped += cnt;
      if (variant === 'A') stats.variant_a.total += cnt;
      if (variant === 'B') stats.variant_b.total += cnt;
      if (status === 'completed' && variant === 'A') stats.variant_a.completed += cnt;
      if (status === 'completed' && variant === 'B') stats.variant_b.completed += cnt;
    }
    // answer_rate = completed (answered + resolved) / total dialed (completed + failed + dialed-in-progress)
    // Previously: answered included 'dialed' (in-progress) which inflated the rate.
    const totalDialed = stats.completed + stats.failed + stats.dialed;
    const answerRate = totalDialed > 0 ? round(stats.completed / totalDialed) : 0;
    // abandon_rate = failed / (completed + failed) — actual abandonment,
    // not the env var constant that was previously used.
    const totalResolved = stats.completed + stats.failed;
    const abandonRate = totalResolved > 0 ? round(stats.failed / totalResolved) : 0;
    return {
      campaign_id: campaignId,
      ...stats,
      answer_rate: answerRate,
      conversion_rate: stats.total_contacts ? round(stats.completed / stats.total_contacts) : 0,
      abandon_rate: abandonRate
    };
  }
}


function decodeCampaign(row: Record<string, unknown>): OutboundCampaign {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    name: String(row.name),
    dial_mode: String(row.dial_mode) as CampaignDialMode,
    status: String(row.status) as CampaignStatus,
    agent_spec_id_a: String(row.agent_spec_id_a || ''),
    agent_spec_id_b: String(row.agent_spec_id_b || ''),
    ab_enabled: Boolean(row.ab_enabled),
    timezone: String(row.timezone || 'Asia/Shanghai'),
    scheduled_start: row.scheduled_start ? String(row.scheduled_start) : null,
    scheduled_end: row.scheduled_end ? String(row.scheduled_end) : null,
    stats: parseJson(String(row.stats || '{}'), {}),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at || row.created_at)
  };
}

function decodeContact(row: Record<string, unknown>): CampaignContact {
  return {
    id: String(row.id),
    campaign_id: String(row.campaign_id),
    tenant_id: String(row.tenant_id),
    phone_number: String(row.phone_number),
    display_name: String(row.display_name || ''),
    status: String(row.status) as CampaignContactStatus,
    ab_variant: String(row.ab_variant || 'A') as 'A' | 'B',
    disposition: row.disposition ? String(row.disposition) : null,
    outbound_task_id: row.outbound_task_id ? String(row.outbound_task_id) : null,
    metadata: parseJson(String(row.metadata || '{}'), {}),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at || row.created_at)
  };
}

function hashVariant(phone: string): number {
  // Use MD5 hash for unbiased A/B bucketing (charCode mod 2 was severely biased
  // for fixed-length numeric phone numbers).
  const hex = createHash('md5').update(phone).digest('hex');
  return parseInt(hex.slice(-1), 16) % 2;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function resolveCampaignSpecId(campaign: OutboundCampaign, variant: 'A' | 'B'): string {
  if (campaign.ab_enabled && variant === 'B' && campaign.agent_spec_id_b) {
    return campaign.agent_spec_id_b;
  }
  return campaign.agent_spec_id_a;
}
