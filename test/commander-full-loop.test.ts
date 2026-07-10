import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createTenant } from '../src/services.js';
import { expectSuccess, listenOnRandomPort } from './test-helpers.js';

test('commander plan exposes DAG, risk summary, approval points, and dry-run model summary', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Commander Plan 测试公司' });
  const harness = createHarness(db);

  const plan = await harness.commander.plan({
    tenant_id: tenant.id,
    user_id: 'user_test',
    goal: '给 lead_123 做一次外呼跟进',
    lead_id: 'lead_123',
    phone: '+1 415 555 0100',
    script: '确认需求、预算和下次会议时间。'
  });

  assert.equal(plan.status, 'planned');
  assert.equal(plan.route.playbook_id, 'voice_agent.queue_followup_call.v1');
  assert.equal(plan.dag.agent_id, 'voice_agent');
  assert.ok(plan.dag.nodes.some((node) => node.id === 'queue_call'));
  assert.deepEqual(plan.approval_points.map((point) => point.tool_id), ['voice.queue_call_for_approval']);
  assert.equal(plan.risk_summary.approval_required, true);
  assert.match(plan.plan_summary, /^\[dry-run:dry-run-v1]/);
});

test('commander can execute a generated DAG instead of the legacy linear runtime', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Commander DAG 测试公司' });
  const harness = createHarness(db);

  const result = await harness.commander.run({
    tenant_id: tenant.id,
    user_id: 'user_test',
    execution_mode: 'dag',
    goal: '创建一个跟进任务',
    object_type: 'lead',
    object_id: 'lead_dag',
    title: '跟进 lead_dag',
    priority: 'P1'
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.plan.dag.playbook_id, 'crm_agent.create_followup_task.v1');
  assert.equal(result.node_outputs.commit_task_plan.type, 'crm_task_plan');
  assert.equal(result.dag_nodes.every((node) => ['completed', 'skipped'].includes(node.status)), true);
});

test('commander plan uses tenant-routed live model provider when configured', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Commander Live Plan 公司' });
  const harness = createHarness(db);
  const previousKey = process.env.OPENAI_COMPATIBLE_COMMANDER_KEY;
  process.env.OPENAI_COMPATIBLE_COMMANDER_KEY = 'commander-model-key';
  const seenRequests = [];

  const providerServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    seenRequests.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: body.model,
      choices: [{ message: { role: 'assistant', content: 'Live commander plan summary' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19 }
    }));
  });
  const providerPort = await listenOnRandomPort(providerServer);
  const providerBaseUrl = `http://127.0.0.1:${providerPort}`;

  try {
    const secret = expectSuccess(await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'commander-model-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'openai-compatible',
        secret_key: 'api_key',
        secret_value: 'commander-model-key',
        env_var_name: 'OPENAI_COMPATIBLE_COMMANDER_KEY'
      }
    ));
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'commander-model-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'openai-compatible',
        status: 'configured',
        config: {
          base_url: providerBaseUrl,
          auth_secret_key: 'api_key',
          default_model: 'commander-default-model'
        },
        secret_ref_ids: [secret.output.id]
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'commander-model-policy'),
      'integration.provider_policy_upsert',
      {
        tenant_id: tenant.id,
        policy_id: 'commander-plan-model',
        name: 'Commander planning model',
        category: 'model_provider',
        capability: 'chat_completion',
        use_case: 'commander_plan',
        preferred_integration_ids: ['openai-compatible'],
        allow_fallback: true
      }
    );

    const plan = await harness.commander.plan({
      tenant_id: tenant.id,
      user_id: 'user_test',
      goal: '给 lead_789 做一次外呼跟进',
      lead_id: 'lead_789',
      phone: '+1 415 555 0101',
      script: '确认需求和下一步。'
    });

    assert.equal(plan.plan_summary, 'Live commander plan summary');
    assert.equal(seenRequests[0].body.model, 'commander-default-model');
    assert.equal(seenRequests[0].headers.authorization, 'Bearer commander-model-key');
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
    if (previousKey == null) delete process.env.OPENAI_COMPATIBLE_COMMANDER_KEY;
    else process.env.OPENAI_COMPATIBLE_COMMANDER_KEY = previousKey;
  }
});

function baseToolContext(tenantId, stepId) {
  return {
    tenantId,
    workspaceId: 'default',
    userId: 'admin_user',
    agentId: 'orchestration_agent',
    workflowRunId: null,
    agentRunId: null,
    playbookId: 'manual',
    stepId
  };
}

async function readJsonBody(req: AsyncIterable<Uint8Array | string>): Promise<any> {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}
