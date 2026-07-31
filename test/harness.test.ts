import assert from 'node:assert/strict';
import { test } from 'node:test';
import { all, one } from '../src/db.js';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createTenant } from '../src/services.js';
import type { ToolRegistry } from '../src/agent-runtime/tools/tool-registry.js';

/** Register a mock external-action tool that requires approval (R3). */
function registerMockExternalTool(toolRegistry: ToolRegistry): void {
  toolRegistry.register(
    {
      tool_id: 'content.publish_external',
      display_name: 'Publish content externally (mock)',
      toolset: 'content',
      category: 'external_action',
      risk_level: 'R3',
      input_schema: { tenant_id: 'string', channel: 'string', content: 'string' },
      output_schema: {},
      side_effect: true,
      idempotency_required: true,
      approval_required: true,
      allowed_agents: ['content_agent'],
      forbidden_agents: [],
      tenant_scope_required: true,
      object_scope_required: false,
      audit_event_name: 'tool.content_publish_external'
    },
    () => ({ queued: true })
  );
}

test('runs the growth loop through manifest, playbook, registry, runs, tools and artifacts', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Harness 测试公司' });
  const harness = createHarness(db);
  registerMockExternalTool(harness.toolRegistry);

  const result = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    user_id: 'user_test',
    playbook_id: 'orchestration_agent.growth_loop_intake.v1',
    goal: '从 LinkedIn 捕获一个高意向 demo 商机',
    platform_code: 'linkedin',
    entry_point: 'profile_link',
    priority_tier: 'P0',
    landing_page: {
      title: 'Book Demo Harness',
      slug: 'book-demo-harness',
      headline: 'Book a demo through harness',
      subheadline: 'Harness-managed landing page'
    },
    inquiry: {
      name: 'Alice',
      email: 'alice@example.com',
      message: 'I want pricing and want to book a demo today.'
    },
    scope_key: `tenant:${tenant.id}:campaign:harness-test`
  });

  assert.equal(result.agent_run.status, 'completed');
  assert.equal(result.workflow_run.status, 'completed');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].type, 'growth_loop_result');
  assert.equal(result.step_outputs.capture_lead.lead.status, 'opportunity');

  const toolCalls = harness.runStore.listToolCallsForRun(tenant.id, result.agent_run.id);
  assert.equal(toolCalls.length, 5);
  assert.deepEqual(
    toolCalls.map((call) => call.tool_id),
    [
      'channel.create',
      'source_tag.create',
      'landing_page.create',
      'lead.capture_from_form',
      'analytics.weekly_report'
    ]
  );

  const artifactRow = one(db, 'SELECT COUNT(*) AS count FROM agent_artifacts WHERE tenant_id = ?', [tenant.id]);
  assert.equal(artifactRow.count, 1);

  const auditRows = all(db, 'SELECT action FROM audit_logs WHERE tenant_id = ? ORDER BY created_at ASC', [tenant.id]);
  assert.ok(auditRows.some((row) => row.action === 'agent_run.created'));
  assert.ok(auditRows.some((row) => row.action === 'artifact.committed'));
  assert.ok(auditRows.some((row) => row.action === 'tool.lead_capture_from_form'));
});

test('blocks external actions through approval queue instead of executing them directly', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Approval 测试公司' });
  const harness = createHarness(db);
  registerMockExternalTool(harness.toolRegistry);

  const execution = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'content_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'publish'
    },
    'content.publish_external',
    {
      tenant_id: tenant.id,
      channel: 'linkedin',
      content: 'External post draft'
    }
  );

  assert.equal(execution.status, 'blocked_pending_approval');
  assert.equal(execution.approval_request.status, 'pending');

  const approvalRows = all(db, 'SELECT * FROM approval_requests WHERE tenant_id = ?', [tenant.id]);
  assert.equal(approvalRows.length, 1);
  assert.equal(approvalRows[0].risk_level, 'R3');
});

test('denies cross-tenant tool input before handler execution', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Tenant A' });
  const otherTenant = createTenant(db, { name: 'Tenant B' });
  const harness = createHarness(db);

  await assert.rejects(
    harness.toolExecutor.execute(
      {
        tenantId: tenant.id,
        workspaceId: 'default',
        userId: 'user_test',
        agentId: 'orchestration_agent',
        workflowRunId: null,
        agentRunId: null,
        playbookId: 'manual',
        stepId: 'cross-tenant'
      },
      'channel.create',
      {
        tenant_id: otherTenant.id,
        platform_code: 'linkedin'
      }
    ),
    /cross-tenant/
  );
});

test('builds tenant-isolated memory packs and routes playbooks', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Memory A' });
  const otherTenant = createTenant(db, { name: 'Memory B' });
  const harness = createHarness(db);

  harness.memoryStore.write({
    tenant_id: tenant.id,
    scope_type: 'tenant',
    memory_type: 'preference',
    content: '品牌语气要直接、务实、少废话。'
  });
  harness.memoryStore.write({
    tenant_id: otherTenant.id,
    scope_type: 'tenant',
    memory_type: 'preference',
    content: '这是另一个租户的记忆，不能被看到。'
  });

  const memoryPack = harness.contextBuilder.build({
    tenantId: tenant.id,
    agent: harness.agentRegistry.getManifest('orchestration_agent'),
    playbook: harness.agentRegistry.getPlaybook('orchestration_agent.growth_loop_intake.v1'),
    goal: '获客',
    businessContext: {}
  }).memoryPack;

  assert.equal(memoryPack.facts.length, 1);
  assert.equal(memoryPack.facts[0].content, '品牌语气要直接、务实、少废话。');

  const routed = harness.playbookRouter.route({ goal: '帮我做一次 weekly report 复盘' });
  assert.equal(routed.playbook_id, 'analytics_agent.weekly_review.v1');
});

test('emits events and dispatches handlers', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Event 测试公司' });
  const harness = createHarness(db);
  const seen = [];

  harness.eventBus.on('lead.created', async (event) => {
    seen.push(event.object_id);
  });
  const event = await harness.eventBus.emit({
    tenant_id: tenant.id,
    event_name: 'lead.created',
    object_type: 'lead',
    object_id: 'lead_demo',
    properties: { score: 90 }
  });

  assert.equal(event.event_name, 'lead.created');
  assert.deepEqual(seen, ['lead_demo']);
});

test('artifact review foundation lists and transitions artifact status with review history', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Artifact Review 公司' });
  const harness = createHarness(db);

  const artifact = harness.artifactStore.commit({
    tenant_id: tenant.id,
    type: 'wiki_page_draft',
    status: 'draft',
    payload: { title: 'Draft wiki page' }
  });

  const listed = harness.artifactStore.list({ tenant_id: tenant.id, status: 'draft' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, artifact.id);

  const review = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'admin_user',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'artifact-review'
    },
    'artifact.review',
    {
      tenant_id: tenant.id,
      artifact_id: artifact.id,
      decision: 'approve',
      review_notes: 'Looks good'
    }
  );

  assert.equal(review.output.artifact.status, 'approved');
  assert.equal(review.output.review.from_status, 'draft');
  assert.equal(review.output.review.to_status, 'approved');

  const reviews = harness.artifactStore.listReviews(tenant.id, artifact.id);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].decision, 'approve');
});

test('commander routes and runs CRM follow-up task playbook', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Commander CRM 测试公司' });
  const harness = createHarness(db);

  const route = harness.commander.route({
    tenant_id: tenant.id,
    goal: '给这个线索创建一个 follow up task',
    object_type: 'lead',
    object_id: 'lead_123',
    title: '今天联系 lead_123，确认预算和时间'
  });
  assert.equal(route.playbook_id, 'crm_agent.create_followup_task.v1');
  assert.deepEqual(route.missing_inputs, []);

  const result = await harness.commander.run({
    tenant_id: tenant.id,
    user_id: 'user_test',
    goal: '给这个线索创建一个 follow up task',
    object_type: 'lead',
    object_id: 'lead_123',
    title: '今天联系 lead_123，确认预算和时间',
    priority: 'P1',
    due_hours: 8
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.artifacts[0].type, 'crm_task_plan');
  assert.equal(result.step_outputs.create_task.priority, 'P1');

  const reports = all(db, 'SELECT * FROM completion_reports WHERE tenant_id = ?', [tenant.id]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'completed');
});

test('commander returns missing inputs instead of guessing', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Missing Input 测试公司' });
  const harness = createHarness(db);

  const result = await harness.commander.run({
    tenant_id: tenant.id,
    goal: '帮我创建跟进任务',
    object_type: 'lead'
  });

  assert.equal(result.status, 'blocked_missing_context');
  assert.deepEqual(result.missing_inputs, ['object_id', 'title']);
});

test('approved external action can be resumed safely', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Resume Approval 测试公司' });
  const harness = createHarness(db);
  registerMockExternalTool(harness.toolRegistry);

  const blocked = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'content_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'publish'
    },
    'content.publish_external',
    {
      tenant_id: tenant.id,
      channel: 'linkedin',
      content: 'External post draft'
    }
  );

  harness.approvalQueue.decide(tenant.id, blocked.approval_request.id, 'approved', 'user_test');
  const resumed = await harness.toolExecutor.resumeApproved(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'content_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'publish'
    },
    blocked.approval_request.tool_call_id
  );

  assert.equal(resumed.status, 'success');
  assert.deepEqual(resumed.output, { queued: true });
});
