import {
  createTenant,
  getLandingPageBySlug,
  getWorkbench,
  listChannels,
  listInquiries,
  listLandingPages,
  listLeads,
  listSourceTags,
  listTasks,
  listTenants,
  trackEvent
} from '../platform/index.js';
import { executeTool, requiredQuery, queryInput } from './_helpers.js';

export async function routePlatformApi(
  db: unknown,
  harness: any,
  method: string,
  path: string,
  url: URL,
  body: any,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  if (method === 'GET' && path.startsWith('/p/')) {
    const slug = decodeURIComponent(path.replace('/p/', ''));
    const page = getLandingPageBySlug(db, slug);
    trackEvent(db, page.tenant_id, 'page_view', 'landing_page', page.id, url.searchParams.get('source_tag_id'), {
      slug
    });
    return { html: renderLandingPage(page, url.searchParams.get('source_tag_id') || page.source_tag_id) };
  }

  if (path === '/api/tenants' && method === 'GET') return listTenants(db);
  if (path === '/api/tenants' && method === 'POST') return { status: 201, data: createTenant(db, body) };

  if (path === '/api/security/members' && method === 'GET') {
    return harness.rbacStore.listMembers(requiredQuery(url, 'tenant_id'));
  }

  if (path === '/api/security/members' && method === 'POST') {
    return { status: 201, data: harness.rbacStore.upsertMember(body) };
  }

  if (path === '/api/security/policy-decisions' && method === 'GET') {
    return harness.rbacStore.listPolicyDecisions({
      tenant_id: requiredQuery(url, 'tenant_id'),
      actor_id: url.searchParams.get('actor_id'),
      decision_type: url.searchParams.get('decision_type'),
      limit: Number(url.searchParams.get('limit') || 50)
    });
  }

  if (path === '/api/quota/limits' && method === 'GET') {
    return harness.quotaStore.listLimits(requiredQuery(url, 'tenant_id'));
  }

  if (path === '/api/quota/limits' && method === 'POST') {
    return { status: 201, data: harness.quotaStore.upsertLimit(body) };
  }

  if (path === '/api/quota/usage' && method === 'GET') {
    return harness.quotaStore.listUsage({
      tenant_id: requiredQuery(url, 'tenant_id'),
      quota_key: url.searchParams.get('quota_key'),
      period_key: url.searchParams.get('period_key'),
      limit: Number(url.searchParams.get('limit') || 100)
    });
  }

  if (path === '/api/traces' && method === 'GET') {
    return harness.traceStore.list({
      tenant_id: requiredQuery(url, 'tenant_id'),
      trace_id: url.searchParams.get('trace_id'),
      workflow_run_id: url.searchParams.get('workflow_run_id'),
      agent_run_id: url.searchParams.get('agent_run_id'),
      limit: Number(url.searchParams.get('limit') || 100)
    });
  }

  if (path === '/api/channels' && method === 'GET') return listChannels(db, requiredQuery(url, 'tenant_id'));
  if (path === '/api/channels' && method === 'POST') return { status: 201, data: await executeTool(harness, body, 'orchestration_agent', 'channel.create') };

  if (path === '/api/source-tags' && method === 'GET') return listSourceTags(db, requiredQuery(url, 'tenant_id'));
  if (path === '/api/source-tags' && method === 'POST') return { status: 201, data: await executeTool(harness, body, 'orchestration_agent', 'source_tag.create') };

  if (path === '/api/landing-pages' && method === 'GET') return listLandingPages(db, requiredQuery(url, 'tenant_id'));
  if (path === '/api/landing-pages' && method === 'POST') return { status: 201, data: await executeTool(harness, body, 'orchestration_agent', 'landing_page.create') };

  if (path === '/api/forms/submit' && method === 'POST') {
    if (body.landing_page_id) {
      await executeTool(harness, {
        ...body,
        user_id: body.user_id || 'system',
        event_name: 'cta_click',
        object_type: 'landing_page',
        object_id: body.landing_page_id,
        properties: {
          has_email: Boolean(body.email || body.contact_email),
          has_phone: Boolean(body.phone || body.contact_phone)
        }
      }, 'orchestration_agent', 'event.track');
    }
    await executeTool(harness, {
      ...body,
      user_id: body.user_id || 'system',
      event_name: 'form_submit',
      object_type: 'landing_page',
      object_id: body.landing_page_id || '',
      properties: {
        has_email: Boolean(body.email || body.contact_email),
        has_phone: Boolean(body.phone || body.contact_phone)
      }
    }, 'orchestration_agent', 'event.track');
    return {
      status: 201,
      data: await executeTool(harness, { ...body, user_id: body.user_id || 'system' }, 'orchestration_agent', 'lead.capture_from_form')
    };
  }

  if (path === '/api/inquiries' && method === 'GET') return listInquiries(db, requiredQuery(url, 'tenant_id'));
  if (path === '/api/leads' && method === 'GET') return listLeads(db, requiredQuery(url, 'tenant_id'));
  if (path === '/api/tasks' && method === 'GET') {
    return listTasks(db, requiredQuery(url, 'tenant_id'), url.searchParams.get('status'));
  }
  if (path === '/api/workbench/today' && method === 'GET') return getWorkbench(db, requiredQuery(url, 'tenant_id'));

  const completeTaskMatch = path.match(/^\/api\/tasks\/([^/]+)\/complete$/);
  if (completeTaskMatch && method === 'POST') {
    const input = { ...body, tenant_id: body.tenant_id || requiredQuery(url, 'tenant_id'), task_id: completeTaskMatch[1] };
    return await executeTool(harness, input, 'crm_agent', 'crm.complete_task');
  }

  const rescheduleTaskMatch = path.match(/^\/api\/tasks\/([^/]+)\/reschedule$/);
  if (rescheduleTaskMatch && method === 'POST') {
    const input = { ...body, tenant_id: body.tenant_id || requiredQuery(url, 'tenant_id'), task_id: rescheduleTaskMatch[1] };
    return await executeTool(harness, input, 'crm_agent', 'crm.reschedule_task');
  }

  if (path === '/api/events' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, 'orchestration_agent', 'event.track') };
  }

  if (path === '/api/analytics/funnel' && method === 'GET') {
    return await executeTool(harness, queryInput(url), 'analytics_agent', 'analytics.compute_funnel');
  }
  if (path === '/api/analytics/channels' && method === 'GET') {
    return await executeTool(harness, queryInput(url), 'analytics_agent', 'analytics.channel_report');
  }
  if (path === '/api/analytics/pages' && method === 'GET') {
    return await executeTool(harness, queryInput(url), 'analytics_agent', 'analytics.page_report');
  }
  if (path === '/api/analytics/weekly-report' && method === 'GET') {
    return await executeTool(harness, queryInput(url), 'analytics_agent', 'analytics.weekly_report');
  }

  if (path === '/api/commander/route' && method === 'POST') {
    return harness.commander.route(body);
  }

  if (path === '/api/commander/plan' && method === 'POST') {
    const result = await harness.commander.plan(body);
    return { status: result.status === 'blocked_missing_context' ? 422 : 200, data: result };
  }

  if (path === '/api/commander/run' && method === 'POST') {
    const result = await harness.commander.run(body);
    return { status: result.status === 'blocked_missing_context' ? 422 : 201, data: result };
  }

  return undefined;
}

function renderLandingPage(page: any, sourceTagId: string) {
  const safe = (value: unknown) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safe(page.title)}</title>
  <link rel="stylesheet" href="/assets/styles.css" />
</head>
<body class="landing">
  <main class="landing-card">
    <p class="eyebrow">OPC Growth Platform</p>
    <h1>${safe(page.headline)}</h1>
    <p>${safe(page.subheadline || '留下你的问题，系统会自动进入咨询池、评分并生成跟进任务。')}</p>
    <form id="landing-form">
      <input type="hidden" name="tenant_id" value="${safe(page.tenant_id)}" />
      <input type="hidden" name="landing_page_id" value="${safe(page.id)}" />
      <input type="hidden" name="source_tag_id" value="${safe(sourceTagId || '')}" />
      <label>姓名 / 昵称<input name="name" placeholder="例如：张三" /></label>
      <label>邮箱<input name="email" type="email" placeholder="you@example.com" /></label>
      <label>电话 / WhatsApp<input name="phone" placeholder="+86..." /></label>
      <label>你的问题<textarea name="message" required placeholder="比如：我想预约一次增长诊断，了解价格和方案。"></textarea></label>
      <button type="submit">${safe(page.cta_text)}</button>
    </form>
    <p id="landing-result" class="muted"></p>
  </main>
  <script>
    document.querySelector('#landing-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target));
      const response = await fetch('/api/forms/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await response.json();
      document.querySelector('#landing-result').textContent = response.ok
        ? '已提交，线索状态：' + result.lead.status + '，评分：' + result.lead.score_total
        : result.error.message;
    });
  </script>
</body>
</html>`;
}
