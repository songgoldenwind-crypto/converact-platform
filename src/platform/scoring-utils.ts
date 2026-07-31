/**
 * Platform scoring + utility functions (extracted from
 * lead-acquisition/queries/builders/platform-scoring-utils-builders.ts).
 *
 * These are pure helpers used by both the platform CRUD layer and the
 * call-center modules. No dependency on lead-acquisition internals.
 */
import { id, one, parseJson, run } from '../db.js';
import { ensureTenant as ensurePlatformTenant } from './tenant-core.js';

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

const highIntentWords = [
  '报价', '价格', '收费', '预算', '预约', '咨询', 'demo', 'pricing', 'quote', 'book', 'trial', '方案', '采购', '合作'
];

const lowIntentWords = ['随便看看', '免费吗', '学生', '找资料', '不考虑', '以后再说'];

export function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

export function notFound(message: string) {
  return Object.assign(new Error(message), { status: 404 });
}

export function required<T>(value: T, field: string): T {
  if (value === undefined || value === null || value === '') {
    throw badRequest(`${field} is required`);
  }
  return value;
}

export function slugify(value: unknown): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function rate(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

export function eventCount(
  db: unknown,
  tenantId: string,
  eventName: string,
  objectType: string | null = null,
  objectId: string | null = null
): number {
  let sql = 'SELECT COUNT(*) AS count FROM events WHERE tenant_id = ? AND event_name = ?';
  const params: any[] = [tenantId, eventName];
  if (objectType) {
    sql += ' AND object_type = ?';
    params.push(objectType);
  }
  if (objectId) {
    sql += ' AND object_id = ?';
    params.push(objectId);
  }
  return one(db, sql, params).count;
}

export function displayContact(inquiry: Record<string, any>): string {
  return inquiry.contact_name || inquiry.contact_email || inquiry.contact_phone || inquiry.platform_account || '未知联系人';
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function buildScoreReason(
  total: number,
  sourceTag: Record<string, any> | null,
  demandStrength: number,
  contactability: number,
  negative: number
): string {
  const pieces = [`总分 ${total}`];
  if (sourceTag) pieces.push(`来源 ${sourceTag.platform}/${sourceTag.entry_point}`);
  if (demandStrength >= 18) pieces.push('需求表达强');
  if (contactability >= 12) pieces.push('联系方式完整');
  if (negative < 0) pieces.push('存在低意向信号');
  return pieces.join('；');
}

export function scoreSource(sourceTag: Record<string, any> | null): number {
  if (!sourceTag) return 6;
  const tierBonus = sourceTag.priority_tier === 'P0' ? 4 : sourceTag.priority_tier === 'P1' ? 2 : 0;
  const platform = sourceDefaults[sourceTag.platform]?.score ?? 10;
  return Math.min(20, platform + tierBonus);
}

export function statusFromScore(score: number): string {
  if (score >= 80) return 'opportunity';
  if (score >= 60) return 'qualified_lead';
  if (score >= 40) return 'nurturing';
  return 'disqualified';
}

export function nextActionForStatus(status: string): string | undefined {
  return ({
    opportunity: '2 小时内人工跟进，并优先引导预约或明确下一步',
    qualified_lead: '24 小时内首次跟进，补充需求与预算信息',
    nurturing: '进入养熟池，发送资料或低频维护',
    disqualified: '不主动跟进，仅保留来源分析'
  } as Record<string, string>)[status];
}

export function scoreInquiry(inquiry: Record<string, any>, sourceTag: Record<string, any> | null) {
  const message = `${inquiry.message} ${inquiry.source_payload}`.toLowerCase();
  const sourceQuality = scoreSource(sourceTag);
  const profileFit = 15 + (message.includes('公司') || message.includes('team') || message.includes('business') ? 5 : 0);
  const demandStrength = Math.min(
    25,
    highIntentWords.reduce((sum, word) => sum + (message.includes(word.toLowerCase()) ? 6 : 0), 8)
  );
  const contactability = Math.min(
    15,
    (inquiry.contact_phone ? 8 : 0) +
      (inquiry.contact_email ? 10 : 0) +
      (inquiry.platform_account ? 6 : 0) +
      (!inquiry.contact_phone && !inquiry.contact_email && !inquiry.platform_account ? 2 : 0)
  );
  const timeliness =
    message.includes('马上') ||
    message.includes('今天') ||
    message.includes('urgent') ||
    message.includes('today') ||
    message.includes('asap') ||
    message.includes('this week')
      ? 10
      : 6;
  const negative = lowIntentWords.some((word) => message.includes(word.toLowerCase())) ? -15 : 0;
  const total = clamp(sourceQuality + profileFit + demandStrength + contactability + timeliness + negative, 0, 100);

  return {
    total,
    breakdown: {
      source_quality: sourceQuality,
      profile_fit: profileFit,
      demand_strength: demandStrength,
      contactability,
      timeliness,
      negative
    },
    reason: buildScoreReason(total, sourceTag, demandStrength, contactability, negative)
  };
}

export function upsertContact(db: unknown, inquiry: Record<string, any>) {
  const identifiers: Array<[string, any]> = [
    ['email', inquiry.contact_email],
    ['phone', inquiry.contact_phone],
    ['platform_account', inquiry.platform_account]
  ].filter(([, value]) => value) as Array<[string, any]>;

  for (const [field, value] of identifiers) {
    const existing = one(db, `SELECT * FROM contacts WHERE tenant_id = ? AND ${field} = ? LIMIT 1`, [
      inquiry.tenant_id,
      value
    ]);
    if (existing) {
      run(
        db,
        `UPDATE contacts SET
          name = COALESCE(NULLIF(?, ''), name),
          email = COALESCE(NULLIF(?, ''), email),
          phone = COALESCE(NULLIF(?, ''), phone),
          platform_account = COALESCE(NULLIF(?, ''), platform_account),
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          inquiry.contact_name,
          inquiry.contact_email,
          inquiry.contact_phone,
          inquiry.platform_account,
          existing.id
        ]
      );
      return one(db, 'SELECT * FROM contacts WHERE id = ?', [existing.id]);
    }
  }

  if (!identifiers.length && !inquiry.contact_name) return null;

  const contactId = id('contact');
  run(
    db,
    `INSERT INTO contacts (id, tenant_id, name, email, phone, platform_account)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      contactId,
      inquiry.tenant_id,
      inquiry.contact_name,
      inquiry.contact_email,
      inquiry.contact_phone,
      inquiry.platform_account
    ]
  );
  return one(db, 'SELECT * FROM contacts WHERE id = ?', [contactId]);
}

export function ensureTenant(db: unknown, tenantId: string) {
  return ensurePlatformTenant(db, tenantId);
}

/**
 * Minimal contact completeness rollup used by enrichLead.
 * Extracted from lead-acquisition repair-queue-reactivation-builders
 * (which depended on shared.normalizePhone via runtime injection).
 */
function normalizePhone(value: unknown): string {
  return String(value || '').replace(/[^\d+]/g, '').trim();
}

function buildLeadContactCompleteness(contact: Record<string, any>) {
  const phone = normalizePhone(contact?.contact_phone || contact?.phone || '');
  const email = String(contact?.contact_email || contact?.email || '').trim();
  const platformAccount = String(contact?.platform_account || contact?.account || '').trim();
  const channels = [
    phone ? { key: 'phone', label: '电话' } : null,
    email ? { key: 'email', label: '邮箱' } : null,
    platformAccount ? { key: 'platform_account', label: '账号' } : null
  ].filter(Boolean) as Array<{ key: string; label: string }>;
  const channelKeys = channels.map((item) => item.key);
  const channelLabels = channels.map((item) => item.label);
  if (!channels.length) {
    return {
      level: 'missing' as const,
      label: '缺联系方式',
      channel_keys: [] as string[],
      channel_labels: [] as string[],
      has_any_contact: false,
      phone_ready: false,
      digital_only: false,
      multi_channel: false
    };
  }
  return {
    level: channels.length >= 2 ? ('complete' as const) : ('partial' as const),
    label: channels.length >= 2 ? '联系方式完整' : '联系方式部分',
    channel_keys: channelKeys,
    channel_labels: channelLabels,
    has_any_contact: true,
    phone_ready: !!phone,
    digital_only: !phone && (!!email || !!platformAccount),
    multi_channel: channels.length >= 2
  };
}

export function enrichLead(lead: Record<string, any>): Record<string, any> {
  return {
    ...lead,
    score_breakdown: parseJson(lead.score_breakdown),
    source_payload: parseJson(lead.source_payload),
    contact_completeness: buildLeadContactCompleteness(lead)
  };
}
