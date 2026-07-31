import assert from 'node:assert/strict';
import { test } from 'node:test';
import { all, one } from '../src/db.js';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createServer } from '../src/http.js';
import { createChannel, createLandingPage, createSourceTag, createTask, createTenant, submitInquiry } from '../src/services.js';
import { listenOnRandomPort } from './test-helpers.js';

test('RBAC enforces tenant member roles before tool execution', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'RBAC 测试公司' });
  const harness = createHarness(db);

  harness.rbacStore.upsertMember({
    tenant_id: tenant.id,
    user_id: 'viewer_user',
    role_code: 'viewer',
    created_by: 'owner_user'
  });

  const read = await harness.toolExecutor.execute(
    toolContext(tenant.id, 'viewer_user', 'analytics_agent'),
    'analytics.weekly_report',
    { tenant_id: tenant.id }
  );
  assert.equal(read.status, 'success');

  await assert.rejects(
    harness.toolExecutor.execute(toolContext(tenant.id, 'viewer_user', 'crm_agent'), 'crm.create_task', {
      tenant_id: tenant.id,
      lead_id: 'lead_1',
      title: '联系客户'
    }),
    /missing permission: crm:write/
  );

  const deniedDecision = one(
    db,
    "SELECT * FROM policy_decisions WHERE tenant_id = ? AND actor_id = ? AND decision = 'deny'",
    [tenant.id, 'viewer_user']
  );
  assert.equal(deniedDecision.tool_id, 'crm.create_task');
});

test('R5 admin tools require admin permission and still pause for approval', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'R5 Policy 公司' });
  const harness = createHarness(db);

  harness.rbacStore.upsertMember({ tenant_id: tenant.id, user_id: 'operator_user', role_code: 'operator' });
  harness.rbacStore.upsertMember({ tenant_id: tenant.id, user_id: 'admin_user', role_code: 'admin' });

  harness.toolRegistry.register(
    {
      tool_id: 'admin.rotate_secret_reference',
      display_name: 'Rotate secret reference',
      toolset: 'admin',
      category: 'admin_action',
      risk_level: 'R5',
      input_schema: {},
      output_schema: {},
      side_effect: true,
      idempotency_required: true,
      approval_required: true,
      allowed_agents: ['orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.admin_rotate_secret_reference'
    },
    async () => ({ rotated: true })
  );

  await assert.rejects(
    harness.toolExecutor.execute(toolContext(tenant.id, 'operator_user', 'orchestration_agent'), 'admin.rotate_secret_reference', {
      tenant_id: tenant.id
    }),
    /missing permission: admin:manage/
  );

  const blocked = await harness.toolExecutor.execute(
    toolContext(tenant.id, 'admin_user', 'orchestration_agent'),
    'admin.rotate_secret_reference',
    { tenant_id: tenant.id }
  );
  assert.equal(blocked.status, 'blocked_pending_approval');
  assert.equal(blocked.approval_request.risk_level, 'R5');
});

test('quota limits block tool execution after usage reaches hard limit', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Quota 测试公司' });
  const harness = createHarness(db);

  harness.quotaStore.upsertLimit({
    tenant_id: tenant.id,
    quota_key: 'monthly_tool_calls',
    hard_limit: 1,
    soft_limit: 1
  });

  const first = await harness.toolExecutor.execute(
    toolContext(tenant.id, 'user_test', 'analytics_agent'),
    'analytics.weekly_report',
    { tenant_id: tenant.id }
  );
  assert.equal(first.status, 'success');

  await assert.rejects(
    harness.toolExecutor.execute(toolContext(tenant.id, 'user_test', 'analytics_agent'), 'analytics.weekly_report', {
      tenant_id: tenant.id
    }),
    /monthly_tool_calls quota exceeded/
  );

  const usage = harness.quotaStore.getUsage({ tenant_id: tenant.id, quota_key: 'monthly_tool_calls' });
  assert.equal(usage.used, 1);
  assert.equal(usage.hard_limit, 1);
});

test('model token usage is metered and participates in quota checks', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Model Quota 公司' });
  const harness = createHarness(db);

  harness.quotaStore.upsertLimit({
    tenant_id: tenant.id,
    quota_key: 'monthly_model_tokens',
    hard_limit: 5,
    soft_limit: 5
  });

  const first = await harness.modelGateway.complete(
    {
      tenantId: tenant.id,
      userId: 'user_test'
    },
    { purpose: 'quota_test', prompt: 'This prompt should use more than five dry-run tokens.' }
  );
  assert.equal(first.status, 'success');

  await assert.rejects(
    harness.modelGateway.complete(
      {
        tenantId: tenant.id,
        userId: 'user_test'
      },
      { purpose: 'quota_test', prompt: 'second call' }
    ),
    /monthly_model_tokens quota exceeded/
  );
});

test('trace store captures context tool and artifact lifecycle events', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Trace 测试公司' });
  const harness = createHarness(db);

  const result = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    user_id: 'user_test',
    playbook_id: 'analytics_agent.weekly_review.v1',
    goal: '生成 trace 周报'
  });

  const traces = harness.traceStore.list({
    tenant_id: tenant.id,
    workflow_run_id: result.workflow_run.id
  });
  const eventNames = traces.map((trace) => trace.event_name);

  assert.ok(eventNames.includes('before_context_build'));
  assert.ok(eventNames.includes('after_context_build'));
  assert.ok(eventNames.includes('before_tool_call'));
  assert.ok(eventNames.includes('after_tool_call'));
  assert.ok(eventNames.includes('before_artifact_commit'));
  assert.ok(eventNames.includes('after_artifact_commit'));

  const usageRows = all(db, 'SELECT * FROM usage_ledger WHERE tenant_id = ? AND quota_key = ?', [
    tenant.id,
    'monthly_tool_calls'
  ]);
  assert.ok(usageRows.length >= 1);
});

test('admin operations overview combines approvals audit quota voice geo and sidecar readiness', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const baseUrl = await listen(server);
  try {
    const tenant = createTenant(db, { name: 'Admin Ops Overview 公司' });
    const harness = createHarness(db);
    harness.quotaStore.upsertLimit({
      tenant_id: tenant.id,
      quota_key: 'monthly_tool_calls',
      hard_limit: 50,
      soft_limit: 4
    });
    harness.quotaStore.recordUsage({
      tenant_id: tenant.id,
      quota_key: 'monthly_tool_calls',
      amount: 4
    });
    await harness.toolExecutor.execute(
      toolContext(tenant.id, 'ops_user', 'voice_agent'),
      'voice.queue_call_for_approval',
      {
        tenant_id: tenant.id,
        lead_id: 'admin_ops_lead',
        phone: '+1 415 555 0188',
        script: 'Admin overview pending approval.',
        idempotency_key: 'admin_ops_lead:first'
      }
    );
    await harness.toolExecutor.execute(
      toolContext(tenant.id, 'ops_user', 'voice_agent'),
      'voice.call_center_routing_snapshot',
      {
        tenant_id: tenant.id,
        route_id: 'admin_ops_overflow',
        required_skills: ['vip']
      }
    );

    const overview = await harness.toolExecutor.execute(
      toolContext(tenant.id, 'ops_user', 'ops_agent'),
      'admin.tenant_operations_overview',
      {
        tenant_id: tenant.id,
        timeout_ms: 50
      }
    );
    const httpOverview = await get(baseUrl, `/api/admin/operations/overview?tenant_id=${tenant.id}&timeout_ms=50`);

    assert.equal(overview.output.components.approvals.pending, 1);
    assert.equal(overview.output.components.quota.near_or_over_limit, 1);
    assert.equal(overview.output.components.voice.summary.overflow_routing_snapshots, 1);
    assert.equal(overview.output.remediation_needed.some((item) => item.component === 'approvals'), true);
    assert.equal(overview.output.remediation_needed.some((item) => item.component === 'quota'), true);
    assert.equal(httpOverview.components.sidecars.sidecars.length, 3);
    assert.equal(httpOverview.health_status, 'degraded');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('P1 admin ops overviews cover provider routing CRM notebook billing and quality readiness', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const baseUrl = await listen(server);
  try {
    const tenant = createTenant(db, { name: 'P1 Ops Overview 公司' });
    const harness = createHarness(db);
    harness.quotaStore.upsertLimit({
      tenant_id: tenant.id,
      quota_key: 'monthly_tool_calls',
      hard_limit: 100,
      soft_limit: 50
    });
    harness.quotaStore.recordUsage({
      tenant_id: tenant.id,
      quota_key: 'monthly_tool_calls',
      amount: 12
    });

    await harness.toolExecutor.execute(
      toolContext(tenant.id, 'ops_user', 'orchestration_agent'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'openai-compatible',
        status: 'configured',
        config: { base_url: 'https://model.local/v1', default_model: 'gpt-test' }
      }
    );
    await harness.toolExecutor.execute(
      toolContext(tenant.id, 'ops_user', 'orchestration_agent'),
      'integration.provider_policy_upsert',
      {
        tenant_id: tenant.id,
        policy_id: 'p1-model-routing',
        name: 'P1 model routing',
        category: 'model',
        capability: 'chat.completions',
        preferred_integration_ids: ['openai-compatible'],
        allow_fallback: true
      }
    );
    await harness.toolExecutor.execute(
      toolContext(tenant.id, 'ops_user', 'orchestration_agent'),
      'integration.provider_health_snapshot',
      {
        tenant_id: tenant.id,
        integration_id: 'openai-compatible',
        category: 'model',
        status: 'healthy',
        summary: 'configured for P1 routing'
      }
    );
    await harness.modelGateway.complete(
      { tenantId: tenant.id, workspaceId: 'default', userId: 'ops_user' },
      { purpose: 'p1_ops_test', prompt: 'Summarize P1 ops readiness.' }
    );

    const channel = createChannel(db, {
      tenant_id: tenant.id,
      platform_code: 'linkedin',
      platform_name: 'LinkedIn',
      channel_type: 'social'
    });
    const sourceTag = createSourceTag(db, {
      tenant_id: tenant.id,
      channel_id: channel.id,
      platform: 'linkedin',
      channel_type: 'social',
      entry_point: 'campaign'
    });
    const page = createLandingPage(db, {
      tenant_id: tenant.id,
      source_tag_id: sourceTag.id,
      title: 'P1 Landing',
      slug: `p1-${tenant.id}`,
      headline: 'P1 readiness'
    });
    const submitted = submitInquiry(db, {
      tenant_id: tenant.id,
      landing_page_id: page.id,
      source_tag_id: sourceTag.id,
      name: 'P1 Lead',
      phone: '+1 415 555 0199',
      message: 'Need a call center demo.'
    });
    createTask(db, {
      tenant_id: tenant.id,
      object_type: 'lead',
      object_id: submitted.lead.id,
      title: 'Follow up P1 lead',
      priority: 'P1'
    });

    const source = harness.wikiStore.ingestSource({
      tenant_id: tenant.id,
      title: 'P1 Knowledge Source',
      content: 'Provider routing, CRM sync, notebook grounding, quota and quality all need ops surfaces.',
      source_type: 'note'
    });
    harness.wikiStore.upsertPage({
      tenant_id: tenant.id,
      title: 'P1 Ops SOP',
      category: 'ops',
      content_markdown: '# P1 Ops SOP\n\nUse cited sources and review artifacts.',
      source_ids: [source.id]
    });
    harness.researchStore.upsertNotebook({
      tenant_id: tenant.id,
      notebook_id: 'p1-ops',
      title: 'P1 Ops Notebook',
      source_refs: [{ ref_type: 'source', ref_id: source.id, title: source.title }]
    });

    const overview = await harness.toolExecutor.execute(
      toolContext(tenant.id, 'ops_user', 'ops_agent'),
      'admin.p1_foundation_overview',
      { tenant_id: tenant.id }
    );
    const httpOverview = await get(baseUrl, `/api/admin/p1-foundation/overview?tenant_id=${tenant.id}`);
    const providerHttp = await get(baseUrl, `/api/admin/provider-routing/ops-overview?tenant_id=${tenant.id}`);
    const crmHttp = await get(baseUrl, `/api/admin/crm-sync/mapping-overview?tenant_id=${tenant.id}`);
    const notebookHttp = await get(baseUrl, `/api/admin/notebook-knowledge/ops-overview?tenant_id=${tenant.id}`);
    const billingHttp = await get(baseUrl, `/api/admin/billing-quota/ops-overview?tenant_id=${tenant.id}`);
    const qualityHttp = await get(baseUrl, `/api/admin/quality-contracts/ops-overview?tenant_id=${tenant.id}`);

    assert.equal(overview.output.provider_routing.summary.configured_integrations, 1);
    assert.equal(overview.output.provider_routing.policy_coverage.active_policy_count, 1);
    assert.equal(overview.output.crm_sync_mapping.summary.lead_count, 1);
    assert.equal(overview.output.crm_sync_mapping.field_mapping_template.some((field) => field.opc_field === 'contact.phone'), true);
    assert.equal(overview.output.notebook_knowledge.summary.active_notebooks, 1);
    assert.equal(overview.output.notebook_knowledge.summary.ungrounded_wiki_pages, 0);
    assert.equal(overview.output.billing_quota.summary.quota_limit_count, 1);
    assert.ok(overview.output.quality_contracts.summary.registered_tool_count > 0);
    assert.equal(httpOverview.provider_routing.summary.configured_integrations, 1);
    assert.equal(providerHttp.policy_coverage.active_policy_count, 1);
    assert.ok(crmHttp.summary.high_priority_open_task_count >= 1);
    assert.equal(notebookHttp.summary.knowledge_source_count, 1);
    assert.equal(billingHttp.summary.quota_limit_count, 1);
    assert.ok(qualityHttp.summary.tool_contract_coverage > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('public form submit remains allowed after tenant members enable RBAC', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const baseUrl = await listen(server);
  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Public Form RBAC 公司' });
    await post(baseUrl, '/api/security/members', {
      tenant_id: tenant.id,
      user_id: 'admin_user',
      role_code: 'admin'
    });
    const channel = await post(baseUrl, '/api/channels', {
      tenant_id: tenant.id,
      user_id: 'admin_user',
      platform_code: 'linkedin',
      platform_name: 'LinkedIn',
      channel_type: 'social'
    });
    const sourceTag = await post(baseUrl, '/api/source-tags', {
      tenant_id: tenant.id,
      user_id: 'admin_user',
      channel_id: channel.id,
      platform: 'linkedin',
      channel_type: 'social',
      entry_point: 'profile'
    });
    const page = await post(baseUrl, '/api/landing-pages', {
      tenant_id: tenant.id,
      user_id: 'admin_user',
      source_tag_id: sourceTag.id,
      title: 'RBAC Landing',
      slug: 'rbac-public-form',
      headline: 'Submit without login'
    });

    const submission = await post(baseUrl, '/api/forms/submit', {
      tenant_id: tenant.id,
      landing_page_id: page.id,
      source_tag_id: sourceTag.id,
      name: 'Public Lead',
      email: 'lead@example.com',
      message: 'I want a demo this week.'
    });

    assert.equal(submission.inquiry.tenant_id, tenant.id);
    assert.equal(submission.lead.status, 'qualified_lead');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function toolContext(tenantId, userId, agentId) {
  return {
    tenantId,
    workspaceId: 'default',
    userId,
    agentId,
    workflowRunId: null,
    agentRunId: null,
    playbookId: 'manual',
    stepId: 'security-test'
  };
}

async function listen(server): Promise<string> {
  const port = await listenOnRandomPort(server);
  return `http://127.0.0.1:${port}`;
}

async function post<T = any>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = (await response.json()) as T;
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}

async function get<T = any>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  const data = (await response.json()) as T;
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}
