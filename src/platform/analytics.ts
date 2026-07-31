/**
 * Phase K Batch 102: funnel, channel, landing, workbench, weekly report.
 */
import { all, one } from '../db.js';
import { listInquiries, listLandingPages, listSourceTags } from './channel-source-landing.js';
import { listLeads, listTasks } from './leads.js';
import { ensureTenant, eventCount, rate } from './scoring.js';

export { listLeads, listTasks } from './leads.js';
export { trackEvent } from './events.js';

export function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function getLandingPageAnalytics(db: unknown, tenantId: string) {
  ensureTenant(db, tenantId);
  const pages = listLandingPages(db, tenantId);
  return pages
    .map((page) => {
      const pageViews = eventCount(db, tenantId, 'page_view', 'landing_page', page.id);
      const ctaClicks = eventCount(db, tenantId, 'cta_click', 'landing_page', page.id);
      const formSubmits = eventCount(db, tenantId, 'form_submit', 'landing_page', page.id);
      const inquiries = one(
        db,
        'SELECT COUNT(*) AS count FROM raw_inquiries WHERE tenant_id = ? AND landing_page_id = ?',
        [tenantId, page.id]
      ).count;

      return {
        ...page,
        page_views: pageViews,
        cta_clicks: ctaClicks,
        form_submits: formSubmits,
        inquiries,
        cta_click_rate: rate(ctaClicks, pageViews),
        submit_rate: rate(formSubmits, pageViews)
      };
    })
    .sort((a, b) => b.form_submits - a.form_submits || b.page_views - a.page_views);
}

export function getFunnel(db: unknown, tenantId: string) {
  ensureTenant(db, tenantId);
  const counts = {
    page_view: eventCount(db, tenantId, 'page_view'),
    cta_click: eventCount(db, tenantId, 'cta_click'),
    form_submit: eventCount(db, tenantId, 'form_submit'),
    inquiry_created: one(db, 'SELECT COUNT(*) AS count FROM raw_inquiries WHERE tenant_id = ?', [tenantId]).count,
    lead_created: one(db, 'SELECT COUNT(*) AS count FROM leads WHERE tenant_id = ?', [tenantId]).count,
    lead_qualified: one(
      db,
      "SELECT COUNT(*) AS count FROM leads WHERE tenant_id = ? AND status IN ('qualified_lead', 'opportunity')",
      [tenantId]
    ).count,
    opportunity_created: one(db, 'SELECT COUNT(*) AS count FROM opportunities WHERE tenant_id = ?', [tenantId]).count
  };

  return {
    counts,
    rates: {
      cta_click_rate: rate(counts.cta_click, counts.page_view),
      form_submit_rate: rate(counts.form_submit, counts.page_view),
      lead_rate: rate(counts.lead_created, counts.inquiry_created),
      qualified_rate: rate(counts.lead_qualified, counts.lead_created),
      opportunity_rate: rate(counts.opportunity_created, counts.lead_created)
    }
  };
}

export function getChannelAnalytics(db: unknown, tenantId: string) {
  ensureTenant(db, tenantId);
  return all(
    db,
    `SELECT
      COALESCE(source_tags.platform, 'unknown') AS platform,
      COALESCE(source_tags.channel_type, 'unknown') AS channel_type,
      COUNT(DISTINCT raw_inquiries.id) AS inquiries,
      COUNT(DISTINCT leads.id) AS leads,
      SUM(CASE WHEN leads.status IN ('qualified_lead', 'opportunity') THEN 1 ELSE 0 END) AS qualified_leads,
      SUM(CASE WHEN leads.status = 'opportunity' THEN 1 ELSE 0 END) AS opportunities,
      ROUND(AVG(leads.score_total), 1) AS avg_score
    FROM raw_inquiries
    LEFT JOIN source_tags ON source_tags.id = raw_inquiries.source_tag_id
    LEFT JOIN leads ON leads.raw_inquiry_id = raw_inquiries.id
     WHERE raw_inquiries.tenant_id = ?
     GROUP BY source_tags.platform, source_tags.channel_type
     ORDER BY opportunities DESC, qualified_leads DESC, inquiries DESC`,
    [tenantId]
  ).map((row) => ({
    ...row,
    qualification_rate: rate(row.qualified_leads, row.leads),
    opportunity_rate: rate(row.opportunities, row.leads)
  }));
}

export function getWorkbench(db: unknown, tenantId: string) {
  ensureTenant(db, tenantId);
  const tasks = listTasks(db, tenantId, 'open').slice(0, 20);
  const recentInquiries = listInquiries(db, tenantId).slice(0, 10);
  const recentLeads = listLeads(db, tenantId).slice(0, 10);
  const recentPages = getLandingPageAnalytics(db, tenantId).slice(0, 5);
  const recentSources = listSourceTags(db, tenantId).slice(0, 5);
  return {
    tasks,
    hot_leads: recentLeads.filter((lead) => lead.score_total >= 60).slice(0, 10),
    recent_inquiries: recentInquiries,
    recent_leads: recentLeads,
    recent_pages: recentPages,
    recent_sources: recentSources,
    summary: {
      open_tasks: one(db, "SELECT COUNT(*) AS count FROM tasks WHERE tenant_id = ? AND status = 'open'", [tenantId]).count,
      completed_tasks: one(db, "SELECT COUNT(*) AS count FROM tasks WHERE tenant_id = ? AND status = 'done'", [tenantId]).count,
      opportunities: one(db, "SELECT COUNT(*) AS count FROM leads WHERE tenant_id = ? AND status = 'opportunity'", [
        tenantId
      ]).count,
      qualified_leads: one(db, "SELECT COUNT(*) AS count FROM leads WHERE tenant_id = ? AND status = 'qualified_lead'", [
        tenantId
      ]).count,
      total_inquiries: one(db, 'SELECT COUNT(*) AS count FROM raw_inquiries WHERE tenant_id = ?', [tenantId]).count,
      total_leads: one(db, 'SELECT COUNT(*) AS count FROM leads WHERE tenant_id = ?', [tenantId]).count,
      overdue_tasks: one(
        db,
        "SELECT COUNT(*) AS count FROM tasks WHERE tenant_id = ? AND status = 'open' AND due_at IS NOT NULL AND datetime(due_at) < CURRENT_TIMESTAMP",
        [tenantId]
      ).count,
      page_views: eventCount(db, tenantId, 'page_view')
    }
  };
}

export function getWeeklyReport(db: unknown, tenantId: string) {
  ensureTenant(db, tenantId);
  const funnel = getFunnel(db, tenantId);
  const channels = getChannelAnalytics(db, tenantId);
  const pages = getLandingPageAnalytics(db, tenantId);
  const workbench = getWorkbench(db, tenantId);

  const bestChannel = channels[0] || null;
  const bestPage = pages[0] || null;
  const recommendations: string[] = [];
  const warnings: string[] = [];

  if (funnel.counts.page_view === 0) {
    recommendations.push('先把来源链接投出去，当前还没有页面访问。');
  }
  if (funnel.counts.page_view > 0 && funnel.rates.cta_click_rate < 0.2) {
    recommendations.push('页面有访问但 CTA 点击偏低，先改主标题、首屏承诺和按钮文案。');
  }
  if (funnel.counts.form_submit > 0 && funnel.rates.qualified_rate < 0.5) {
    recommendations.push('提交不少但合格线索偏低，优先收紧来源和表单问题。');
  }
  if (workbench.summary.open_tasks > 5) {
    warnings.push('未完成任务偏多，先清空 P0/P1 跟进，避免线索变冷。');
  }
  if (workbench.summary.overdue_tasks > 0) {
    warnings.push(`当前有 ${workbench.summary.overdue_tasks} 个逾期任务。`);
  }
  if (bestChannel) {
    recommendations.push(
      `当前优先继续加码 ${bestChannel.platform}，它的商机率为 ${formatPercent(bestChannel.opportunity_rate)}。`
    );
  }
  if (bestPage?.page_views > 0 && bestPage.submit_rate < 0.1) {
    warnings.push(`页面「${bestPage.title}」有流量但提交率只有 ${formatPercent(bestPage.submit_rate)}。`);
  }
  if (!recommendations.length) {
    recommendations.push('当前漏斗健康，继续复用高分来源、保持每日处理高意向商机。');
  }

  return {
    generated_at: new Date().toISOString(),
    summary: {
      open_tasks: workbench.summary.open_tasks,
      completed_tasks: workbench.summary.completed_tasks,
      opportunities: workbench.summary.opportunities,
      qualified_leads: workbench.summary.qualified_leads,
      total_inquiries: workbench.summary.total_inquiries,
      total_leads: workbench.summary.total_leads,
      overdue_tasks: workbench.summary.overdue_tasks,
      page_views: funnel.counts.page_view,
      cta_clicks: funnel.counts.cta_click,
      form_submits: funnel.counts.form_submit,
      inquiries_created: funnel.counts.inquiry_created,
      leads_created: funnel.counts.lead_created,
      qualified_leads_created: funnel.counts.lead_qualified,
      opportunities_created: funnel.counts.opportunity_created,
      cta_click_rate: funnel.rates.cta_click_rate,
      form_submit_rate: funnel.rates.form_submit_rate,
      lead_rate: funnel.rates.lead_rate,
      qualified_rate: funnel.rates.qualified_rate,
      opportunity_rate: funnel.rates.opportunity_rate
    },
    best_channel: bestChannel,
    best_page: bestPage,
    warnings,
    recommendations,
    channels: channels.slice(0, 5),
    pages: pages.slice(0, 5)
  };
}
