/**
 * Phase K Batch 101: source tags, landing pages, inquiries.
 *
 * Lead-acquisition specific hooks (getLeadAcquisitionRun for run binding,
 * bridgeLandingInquiryToLeadAcquisitionRun for form->run bridging) are now
 * injected via wireLandingLeadAcquisitionHooks. When lead-acquisition is
 * archived/unwired, those binding paths gracefully fall back to null.
 */
import { all, id, json, one, parseJson, run } from '../db.js';
import { trackEvent } from './events.js';
import {
  badRequest,
  displayContact,
  enrichLead,
  ensureTenant,
  nextActionForStatus,
  notFound,
  required,
  scoreInquiry,
  slugify,
  statusFromScore,
  upsertContact
} from './scoring.js';
import { createTask } from './tasks.js';
import { getChannel } from './tenant-core.js';

export interface LandingLeadAcquisitionHooks {
  getLeadAcquisitionRun?: (db: unknown, tenantId: string, runId: string) => any;
  bridgeLandingInquiryToLeadAcquisitionRun?: (db: unknown, input: any) => any;
}

const leadAcquisitionHooks: LandingLeadAcquisitionHooks = {};

export function wireLandingLeadAcquisitionHooks(next: LandingLeadAcquisitionHooks): void {
  Object.assign(leadAcquisitionHooks, next);
}

export function createSourceTag(db: unknown, input: Record<string, any>) {
  ensureTenant(db, String(input.tenant_id));
  const channel = input.channel_id
    ? getChannel(db, String(input.tenant_id), String(input.channel_id))
    : null;
  const platform = String(input.platform || channel?.platform_code || required(input.platform_code, 'platform'));
  const entryPoint = String(input.entry_point || 'bio_link');
  const campaign = String(input.utm_campaign || input.campaign_name || 'default');
  const tag = {
    id: id('src'),
    tenant_id: String(input.tenant_id),
    channel_id: input.channel_id || null,
    campaign_id: input.campaign_id || null,
    region: String(input.region || channel?.region || 'Global'),
    channel_type: String(input.channel_type || channel?.channel_type || 'social'),
    platform,
    entry_point: entryPoint,
    integration_mode: String(input.integration_mode || 'manual'),
    priority_tier: String(input.priority_tier || 'P1'),
    utm_source: platform,
    utm_medium: String(input.utm_medium || channel?.channel_type || 'social'),
    utm_campaign: campaign,
    utm_content: String(input.utm_content || entryPoint),
    tracking_url: ''
  };

  tag.tracking_url =
    String(input.base_url || '') ||
    `/p/${String(input.slug || 'landing')}?source_tag_id=${encodeURIComponent(tag.id)}&utm_source=${encodeURIComponent(
      tag.utm_source
    )}&utm_medium=${encodeURIComponent(tag.utm_medium)}&utm_campaign=${encodeURIComponent(tag.utm_campaign)}`;

  run(
    db,
    `INSERT INTO source_tags
      (id, tenant_id, channel_id, campaign_id, region, channel_type, platform, entry_point, integration_mode,
       priority_tier, utm_source, utm_medium, utm_campaign, utm_content, tracking_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tag.id,
      tag.tenant_id,
      tag.channel_id,
      tag.campaign_id,
      tag.region,
      tag.channel_type,
      tag.platform,
      tag.entry_point,
      tag.integration_mode,
      tag.priority_tier,
      tag.utm_source,
      tag.utm_medium,
      tag.utm_campaign,
      tag.utm_content,
      tag.tracking_url
    ]
  );

  trackEvent(db, tag.tenant_id, 'source_link_created', 'source_tag', tag.id, tag.id, tag);
  return getSourceTag(db, tag.tenant_id, tag.id);
}

export function listSourceTags(db: unknown, tenantId: string) {
  ensureTenant(db, tenantId);
  return all(db, 'SELECT * FROM source_tags WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
}

export function getSourceTag(db: unknown, tenantId: string, sourceTagId: string) {
  const tag = one(db, 'SELECT * FROM source_tags WHERE tenant_id = ? AND id = ?', [tenantId, sourceTagId]);
  if (!tag) throw notFound('source tag not found');
  return tag;
}

export function createLandingPage(db: unknown, input: Record<string, any>) {
  ensureTenant(db, String(input.tenant_id));
  if (input.source_tag_id) getSourceTag(db, String(input.tenant_id), String(input.source_tag_id));
  const linkedRun = input.lead_acquisition_run_id && leadAcquisitionHooks.getLeadAcquisitionRun
    ? leadAcquisitionHooks.getLeadAcquisitionRun(db, String(input.tenant_id), String(input.lead_acquisition_run_id))
    : null;

  const page = {
    id: id('page'),
    tenant_id: String(input.tenant_id),
    source_tag_id: input.source_tag_id || null,
    lead_acquisition_run_id: linkedRun?.id || null,
    title: required(input.title, 'title'),
    slug: slugify(String(input.slug || input.title)),
    headline: String(input.headline || input.title),
    subheadline: String(input.subheadline || ''),
    cta_text: String(input.cta_text || '提交咨询'),
    status: String(input.status || 'live')
  };

  run(
    db,
    `INSERT INTO landing_pages
      (id, tenant_id, source_tag_id, lead_acquisition_run_id, title, slug, headline, subheadline, cta_text, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      page.id,
      page.tenant_id,
      page.source_tag_id,
      page.lead_acquisition_run_id,
      page.title,
      page.slug,
      page.headline,
      page.subheadline,
      page.cta_text,
      page.status
    ]
  );

  trackEvent(db, page.tenant_id, 'landing_page_created', 'landing_page', page.id, page.source_tag_id, {
    ...page,
    linked_run_goal: linkedRun?.goal || ''
  });
  return getLandingPageById(db, page.tenant_id, page.id);
}

export function listLandingPages(db: unknown, tenantId: string) {
  ensureTenant(db, tenantId);
  return all(db, 'SELECT * FROM landing_pages WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
}

export function getLandingPageBySlug(db: unknown, slug: string) {
  const page = one(db, 'SELECT * FROM landing_pages WHERE slug = ? AND status = ?', [slug, 'live']);
  if (!page) throw notFound('landing page not found');
  return page;
}

export function getLandingPageById(db: unknown, tenantId: string, pageId: string) {
  const page = one(db, 'SELECT * FROM landing_pages WHERE tenant_id = ? AND id = ?', [tenantId, pageId]);
  if (!page) throw notFound('landing page not found');
  return page;
}

export function submitInquiry(db: unknown, input: Record<string, any>) {
  ensureTenant(db, String(input.tenant_id));
  const landingPage = input.landing_page_id
    ? getLandingPageById(db, String(input.tenant_id), String(input.landing_page_id))
    : null;
  const resolvedSourceTagId = input.source_tag_id || landingPage?.source_tag_id || null;
  const sourceTag = resolvedSourceTagId
    ? getSourceTag(db, String(input.tenant_id), String(resolvedSourceTagId))
    : null;
  const explicitRunId = String(input.lead_acquisition_run_id || '').trim();
  const landingPageRunId = String(landingPage?.lead_acquisition_run_id || '').trim();
  if (explicitRunId && landingPageRunId && explicitRunId !== landingPageRunId) {
    throw badRequest('lead_acquisition_run_id does not match landing page binding');
  }
  const linkedRunId = explicitRunId || landingPageRunId || '';
  const payload = {
    ...(input.payload && typeof input.payload === 'object' ? input.payload as Record<string, any> : {}),
    landing_page_id: input.landing_page_id || null,
    lead_acquisition_run_id: linkedRunId || null
  };

  const inquiryId = id('inq');
  run(
    db,
    `INSERT INTO raw_inquiries
      (id, tenant_id, source_tag_id, landing_page_id, lead_acquisition_run_id, contact_name, contact_email, contact_phone, platform_account, message, source_payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      inquiryId,
      input.tenant_id,
      resolvedSourceTagId,
      input.landing_page_id || null,
      linkedRunId || null,
      input.contact_name || input.name || '',
      input.contact_email || input.email || '',
      input.contact_phone || input.phone || '',
      input.platform_account || '',
      input.message || '',
      json(payload)
    ]
  );

  trackEvent(db, String(input.tenant_id), 'inquiry_created', 'raw_inquiry', inquiryId, resolvedSourceTagId, {
    landing_page_id: input.landing_page_id || null,
    lead_acquisition_run_id: linkedRunId || null
  });

  const inquiry = one(db, 'SELECT * FROM raw_inquiries WHERE id = ?', [inquiryId]);
  const contact = upsertContact(db, inquiry);
  const score = scoreInquiry(inquiry, sourceTag);
  const leadStatus = statusFromScore(score.total);
  const nextAction = nextActionForStatus(leadStatus);
  const leadId = id('lead');

  run(
    db,
    `INSERT INTO leads
      (id, tenant_id, raw_inquiry_id, contact_id, status, score_total, score_breakdown, score_reason, next_action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      leadId,
      input.tenant_id,
      inquiryId,
      contact?.id || null,
      leadStatus,
      score.total,
      json(score.breakdown),
      score.reason,
      nextAction
    ]
  );

  run(db, 'UPDATE raw_inquiries SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
    'lead_scored',
    inquiryId
  ]);

  trackEvent(db, String(input.tenant_id), 'lead_created', 'lead', leadId, resolvedSourceTagId, { status: leadStatus });
  trackEvent(db, String(input.tenant_id), 'lead_scored', 'lead', leadId, resolvedSourceTagId, score);

  let opportunity = null;
  let task = null;
  if (leadStatus === 'opportunity') {
    const opportunityId = id('opp');
    run(db, 'INSERT INTO opportunities (id, tenant_id, lead_id) VALUES (?, ?, ?)', [
      opportunityId,
      input.tenant_id,
      leadId
    ]);
    opportunity = one(db, 'SELECT * FROM opportunities WHERE id = ?', [opportunityId]);
    trackEvent(db, String(input.tenant_id), 'opportunity_created', 'opportunity', opportunityId, resolvedSourceTagId, {
      lead_id: leadId
    });
    task = createTask(db, {
      tenant_id: input.tenant_id,
      object_type: 'opportunity',
      object_id: opportunityId,
      title: `2 小时内跟进高意向商机：${displayContact(inquiry)}`,
      priority: 'P0',
      due_hours: 2
    });
  } else if (leadStatus === 'qualified_lead') {
    trackEvent(db, String(input.tenant_id), 'lead_qualified', 'lead', leadId, resolvedSourceTagId, { score: score.total });
    task = createTask(db, {
      tenant_id: input.tenant_id,
      object_type: 'lead',
      object_id: leadId,
      title: `24 小时内首次跟进线索：${displayContact(inquiry)}`,
      priority: 'P1',
      due_hours: 24
    });
  } else if (leadStatus === 'disqualified') {
    trackEvent(db, String(input.tenant_id), 'lead_disqualified', 'lead', leadId, resolvedSourceTagId, { score: score.total });
  }

  const result = {
    inquiry: one(db, 'SELECT * FROM raw_inquiries WHERE id = ?', [inquiryId]),
    contact,
    lead: enrichLead(one(db, 'SELECT * FROM leads WHERE id = ?', [leadId])),
    opportunity,
    task
  };
  const bridgedRun = linkedRunId && leadAcquisitionHooks.bridgeLandingInquiryToLeadAcquisitionRun
    ? leadAcquisitionHooks.bridgeLandingInquiryToLeadAcquisitionRun(db, {
        tenant_id: input.tenant_id,
        run_id: linkedRunId,
        landing_page: landingPage,
        source_tag: sourceTag,
        result
      })
    : null;
  return {
    ...result,
    lead_run_bridge: bridgedRun
      ? {
          linked: true,
          via: 'landing_form',
          run_id: bridgedRun.id,
          current_stage: bridgedRun.current_stage,
          summary: bridgedRun.summary,
          next_recommended_action:
            bridgedRun.computed_next_recommended_action || bridgedRun.next_recommended_action || '',
          landing_page_id: landingPage?.id || null,
          inquiry_id: inquiryId
        }
      : null,
    lead_acquisition_run: bridgedRun
  };
}

export function listInquiries(db: unknown, tenantId: string) {
  ensureTenant(db, tenantId);
  return all(db, 'SELECT * FROM raw_inquiries WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]).map((row) => ({
    ...row,
    source_payload: parseJson(row.source_payload)
  }));
}
