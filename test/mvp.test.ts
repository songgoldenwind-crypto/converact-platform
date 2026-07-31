import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createServer } from '../src/http.js';
import { listenOnRandomPort } from './test-helpers.js';

const db = createDatabase(':memory:');
const server = createServer(db);
let baseUrl = '';

before(async () => {
  const port = await listenOnRandomPort(server);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('runs the source to opportunity MVP loop', async () => {
  const tenant = await post('/api/tenants', { name: '测试一人公司' });
  const channel = await post('/api/channels', {
    tenant_id: tenant.id,
    platform_code: 'linkedin'
  });
  const sourceTag = await post('/api/source-tags', {
    tenant_id: tenant.id,
    channel_id: channel.id,
    entry_point: 'profile_link',
    priority_tier: 'P0',
    slug: 'demo'
  });
  const page = await post('/api/landing-pages', {
    tenant_id: tenant.id,
    source_tag_id: sourceTag.id,
    title: 'Book Demo',
    slug: 'demo',
    headline: 'Book a demo',
    status: 'live'
  });
  const result = await post('/api/forms/submit', {
    tenant_id: tenant.id,
    source_tag_id: sourceTag.id,
    landing_page_id: page.id,
    name: 'Alice',
    email: 'alice@example.com',
    message: 'I want pricing and want to book a demo today.'
  });

  assert.equal(result.lead.status, 'opportunity');
  assert.ok(result.opportunity.id);
  assert.equal(result.task.priority, 'P0');

  const workbench = await get(`/api/workbench/today?tenant_id=${tenant.id}`);
  assert.equal(workbench.summary.opportunities, 1);
  assert.equal(workbench.tasks.length, 1);

  const funnel = await get(`/api/analytics/funnel?tenant_id=${tenant.id}`);
  assert.equal(funnel.counts.inquiry_created, 1);
  assert.equal(funnel.counts.cta_click, 1);
  assert.equal(funnel.counts.form_submit, 1);
  assert.equal(funnel.counts.opportunity_created, 1);

  const channels = await get(`/api/analytics/channels?tenant_id=${tenant.id}`);
  assert.equal(channels[0].platform, 'linkedin');
  assert.equal(channels[0].opportunities, 1);

  const weeklyReport = await get(`/api/analytics/weekly-report?tenant_id=${tenant.id}`);
  assert.equal(weeklyReport.best_channel.platform, 'linkedin');
  assert.ok(Array.isArray(weeklyReport.recommendations));

  const completedTask = await post(`/api/tasks/${result.task.id}/complete`, { tenant_id: tenant.id });
  assert.equal(completedTask.status, 'done');

  const openTasks = await get(`/api/tasks?tenant_id=${tenant.id}&status=open`);
  assert.equal(openTasks.length, 0);
});

test('keeps low-intent inquiries out of urgent tasks', async () => {
  const tenant = await post('/api/tenants', { name: '低意向测试' });
  const result = await post('/api/forms/submit', {
    tenant_id: tenant.id,
    name: 'Bob',
    message: '我只是随便看看，想找资料，免费吗'
  });

  assert.match(result.lead.status, /nurturing|disqualified/);
  assert.equal(result.task, null);
});

async function get<T = any>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  const data = (await response.json()) as T;
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}

async function post<T = any>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = (await response.json()) as T;
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}
