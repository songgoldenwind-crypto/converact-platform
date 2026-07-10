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

test('manual outbound call creates a voice session and writes callback outcome back to CRM tasks', async () => {
  const tenant = await post('/api/tenants', { name: 'Call Center 外呼公司' });
  const intake = await post('/api/forms/submit', {
    tenant_id: tenant.id,
    name: '陈总',
    phone: '+8613500000000',
    message: '我想了解报价，下午方便电话沟通。'
  });

  const outbound = await post('/api/voice/manual-outbound', {
    tenant_id: tenant.id,
    phone: '+8613500000000',
    lead_id: intake.lead.id,
    script: '确认需求和回拨时间。',
    lead_run_context_kind: 'repair_requeue',
    lead_run_id: 'lead_run_context_test',
    lead_run_task_id: 'task_context_test',
    lead_run_lead_name: '陈总',
    lead_run_reason: '补齐联系方式后已进入今日可联系队列',
    lead_run_next_action: '通话后回写结果并接下一步',
    agent_id: 'agent_chen'
  });

  assert.equal(outbound.call_session.direction, 'outbound');
  assert.equal(outbound.call_session.status, 'active');
  assert.equal(outbound.call_log.phone_redacted.endsWith('0000'), true);
  assert.equal(outbound.call_session.metadata.lead_run_context_kind, 'repair_requeue');
  assert.equal(outbound.call_session.metadata.lead_run_id, 'lead_run_context_test');
  assert.equal(outbound.call_session.metadata.lead_run_reason, '补齐联系方式后已进入今日可联系队列');

  const completed = await post(`/api/voice/sessions/${outbound.call_session.id}/complete`, {
    tenant_id: tenant.id,
    disposition: 'connected_callback',
    summary: '客户要求今天下午 4 点回拨。',
    next_step_due_at: '2026-04-30T16:00:00.000Z'
  });

  assert.equal(completed.call_session.status, 'completed');
  assert.equal(completed.call_session.metadata.disposition, 'connected_callback');
  assert.equal(completed.call_session.metadata.lead_run_id, 'lead_run_context_test');
  assert.equal(completed.followup_task.object_id, intake.lead.id);
  assert.match(completed.followup_task.title, /回拨/);

  const leads = await get(`/api/leads?tenant_id=${encodeURIComponent(tenant.id)}`);
  assert.equal(leads[0].status, 'contacted');
  assert.match(leads[0].next_action, /回拨/);
});

test('inbound call can be recorded, answered, completed, and isolated by tenant', async () => {
  const tenant = await post('/api/tenants', { name: 'Call Center 呼入公司' });
  const otherTenant = await post('/api/tenants', { name: 'Call Center 隔离公司' });

  const inbound = await post('/api/voice/inbound', {
    tenant_id: tenant.id,
    phone: '+8613600001234',
    caller_name: '赵女士',
    intent: '咨询价格并要求人工处理',
    required_skills: ['inbound']
  });

  assert.equal(inbound.call_session.direction, 'inbound');
  assert.equal(inbound.call_session.status, 'ringing');
  assert.equal(inbound.call_session.metadata.caller_name, '赵女士');

  const answered = await post(`/api/voice/sessions/${inbound.call_session.id}/answer`, {
    tenant_id: tenant.id,
    agent_id: 'agent_inbound'
  });
  assert.equal(answered.status, 'active');
  assert.equal(answered.metadata.answered_by, 'agent_inbound');

  const completed = await post(`/api/voice/sessions/${inbound.call_session.id}/complete`, {
    tenant_id: tenant.id,
    disposition: 'transfer_required',
    summary: '客户需要主管确认折扣。',
    next_step_due_at: '2026-04-30T18:00:00.000Z'
  });
  assert.equal(completed.followup_task.object_type, 'voice_call_session');
  assert.equal(completed.followup_task.priority, 'P0');

  const workbench = await get(`/api/voice/call-center/workbench?tenant_id=${encodeURIComponent(tenant.id)}`);
  assert.equal(workbench.summary.inbound_today, 1);
  assert.equal(workbench.recent_sessions.length, 1);

  const otherWorkbench = await get(`/api/voice/call-center/workbench?tenant_id=${encodeURIComponent(otherTenant.id)}`);
  assert.equal(otherWorkbench.recent_sessions.length, 0);
  assert.equal(otherWorkbench.summary.inbound_today, 0);
});

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

async function get<T = any>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  const data = (await response.json()) as T;
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}
