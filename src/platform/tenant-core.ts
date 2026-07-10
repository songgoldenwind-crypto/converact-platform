/**
 * Phase K Batch 100: tenant + channel platform implementations.
 */
import { all, id, one, run } from '../db.js';
import { trackEvent } from './events.js';
import { badRequest, notFound, required } from './errors.js';

const sourceDefaults: Record<string, { name: string; type: string; region: string; score: number }> = {
  xiaohongshu: { name: '小红书', type: 'social', region: 'CN', score: 16 },
  douyin: { name: '抖音', type: 'social', region: 'CN', score: 14 },
  wechat: { name: '微信', type: 'private', region: 'CN', score: 18 },
  linkedin: { name: 'LinkedIn', type: 'social', region: 'Global', score: 18 },
  reddit: { name: 'Reddit', type: 'community', region: 'Global', score: 13 },
  tiktok: { name: 'TikTok', type: 'social', region: 'Global', score: 14 },
  google: { name: 'Google SEO', type: 'search', region: 'Global', score: 17 },
  producthunt: { name: 'Product Hunt', type: 'community', region: 'Global', score: 16 }
};

export function getTenant(db: unknown, tenantId: string) {
  const tenant = one(db, 'SELECT * FROM tenants WHERE id = ?', [tenantId]);
  if (!tenant) throw notFound('tenant not found');
  return tenant;
}

export function ensureTenant(db: unknown, tenantId: string) {
  required(tenantId, 'tenant_id');
  return getTenant(db, tenantId);
}

export function createTenant(db: unknown, input: Record<string, any>) {
  const tenant = {
    id: id('tenant'),
    name: String(required(input.name, 'name')),
    plan_code: String(input.plan_code || 'free')
  };

  run(db, 'INSERT INTO tenants (id, name, plan_code) VALUES (?, ?, ?)', [
    tenant.id,
    tenant.name,
    tenant.plan_code
  ]);
  trackEvent(db, tenant.id, 'tenant_created', 'tenant', tenant.id, null, { name: tenant.name });
  return getTenant(db, tenant.id);
}

export function listTenants(db: unknown) {
  return all(db, 'SELECT * FROM tenants ORDER BY created_at DESC');
}

export function createChannel(db: unknown, input: Record<string, any>) {
  ensureTenant(db, String(input.tenant_id));
  const platformCode = String(input.platform_code || '');
  const defaults = sourceDefaults[platformCode] || {} as Record<string, any>;
  const channel = {
    id: id('channel'),
    tenant_id: String(input.tenant_id),
    platform_code: String(required(input.platform_code, 'platform_code')),
    platform_name: String(input.platform_name || defaults.name || input.platform_code),
    channel_type: String(input.channel_type || defaults.type || 'social'),
    region: String(input.region || defaults.region || 'Global'),
    monthly_budget: Number(input.monthly_budget || 0),
    target_goal: String(input.target_goal || 'lead'),
    default_score: Number(input.default_score ?? defaults.score ?? 10)
  };

  run(
    db,
    `INSERT INTO channels
      (id, tenant_id, platform_code, platform_name, channel_type, region, monthly_budget, target_goal, default_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      channel.id,
      channel.tenant_id,
      channel.platform_code,
      channel.platform_name,
      channel.channel_type,
      channel.region,
      channel.monthly_budget,
      channel.target_goal,
      channel.default_score
    ]
  );

  trackEvent(db, channel.tenant_id, 'channel_created', 'channel', channel.id, null, channel);
  return getChannel(db, channel.tenant_id, channel.id);
}

export function listChannels(db: unknown, tenantId: string) {
  ensureTenant(db, tenantId);
  return all(db, 'SELECT * FROM channels WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
}

export function getChannel(db: unknown, tenantId: string, channelId: string) {
  const channel = one(db, 'SELECT * FROM channels WHERE tenant_id = ? AND id = ?', [tenantId, channelId]);
  if (!channel) throw notFound('channel not found');
  return channel;
}
