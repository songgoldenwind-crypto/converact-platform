import assert from 'node:assert/strict';
import { test } from 'node:test';
import { all } from '../src/db.js';
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
      audit_event_name: 'tool.content_publish_external',
      compensation: { strategy: 'external_delete_or_unpublish' }
    },
    () => ({ queued: true })
  );
}

test('checkpoint hooks record tool and artifact recovery points', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Checkpoint 测试公司' });
  const harness = createHarness(db);

  const result = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    user_id: 'user_test',
    playbook_id: 'analytics_agent.weekly_review.v1',
    goal: '生成 checkpoint 测试周报'
  });

  const checkpoints = harness.checkpointManager.listForWorkflow(tenant.id, result.workflow_run.id);
  assert.equal(checkpoints.length, 2);
  assert.deepEqual(
    checkpoints.map((checkpoint) => checkpoint.type),
    ['tool', 'artifact']
  );
  assert.equal(checkpoints[0].state.tool_id, 'analytics.weekly_report');
  assert.equal(checkpoints[1].state.artifact_input.type, 'weekly_report');
});

test('R3 tool checkpoints are marked non-recoverable before approval', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'R3 Checkpoint 测试公司' });
  const harness = createHarness(db);
  registerMockExternalTool(harness.toolRegistry);

  await harness.toolExecutor.execute(
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

  const checkpoints = all(db, 'SELECT * FROM checkpoints WHERE tenant_id = ? AND type = ?', [tenant.id, 'tool']);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].recoverable, 0);
});

test('checkpoint manager restores artifact snapshots as a new draft version', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Artifact Restore 测试公司' });
  const harness = createHarness(db);

  const artifact = harness.artifactStore.commit({
    tenant_id: tenant.id,
    type: 'content_draft',
    status: 'draft',
    payload: {
      title: 'Version A'
    }
  });
  const checkpoint = harness.checkpointManager.createArtifactSnapshot(artifact);
  const restored = harness.checkpointManager.restoreArtifactSnapshot(tenant.id, checkpoint.id, harness.artifactStore);

  assert.equal(restored.type, 'content_draft');
  assert.equal(restored.status, 'draft');
  assert.equal(restored.version, 2);
  assert.equal(restored.parent_artifact_id, artifact.id);
  assert.deepEqual(restored.payload, artifact.payload);
});

test('side effect tracker records committed external actions and compensation state after approval', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Side Effect 测试公司' });
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
  assert.equal(harness.sideEffectTracker.listForToolCall(tenant.id, blocked.approval_request.tool_call_id).length, 0);

  harness.approvalQueue.decide(tenant.id, blocked.approval_request.id, 'approved', 'owner_test');
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

  const sideEffects = harness.sideEffectTracker.listForToolCall(tenant.id, resumed.tool_call.id);
  assert.equal(sideEffects.length, 1);
  assert.equal(sideEffects[0].status, 'committed');
  assert.equal(sideEffects[0].compensation_status, 'manual_required');
  assert.equal(sideEffects[0].compensation.strategy, 'external_delete_or_unpublish');

  const required = harness.sideEffectTracker.requireCompensation(tenant.id, sideEffects[0].id, 'owner cancelled this post');
  assert.equal(required.status, 'compensation_required');
  assert.equal(required.compensation.required_reason, 'owner cancelled this post');

  const compensated = harness.sideEffectTracker.markCompensated(tenant.id, sideEffects[0].id, {
    actor_id: 'owner_test',
    note: 'deleted in LinkedIn'
  });
  assert.equal(compensated.status, 'compensated');
  assert.equal(compensated.compensation_status, 'completed');
});

test('failed tool call writes recoverable failure checkpoint recipe fields', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Tool Failure Checkpoint 公司' });
  const harness = createHarness(db);
  harness.toolRegistry.register(
    {
      tool_id: 'test.timeout_tool',
      display_name: 'Timeout Tool',
      toolset: 'test',
      category: 'read',
      risk_level: 'R1',
      input_schema: { type: 'object', properties: {} },
      output_schema: { type: 'object', properties: {} },
      side_effect: false,
      idempotency_required: false,
      approval_required: false,
      allowed_agents: ['test_agent'],
      tenant_scope_required: true,
      audit_event_name: 'test.timeout_tool.called',
      retry_policy: { max_attempts: 2 }
    },
    () => {
      const error = new Error('provider timeout while fetching data');
      error.name = 'NetworkError';
      (error as Error & { code?: string }).code = 'ETIMEDOUT';
      throw error;
    }
  );

  await assert.rejects(() =>
    harness.toolExecutor.execute(
      {
        tenantId: tenant.id,
        workspaceId: 'default',
        userId: 'user_test',
        agentId: 'test_agent',
        workflowRunId: null,
        agentRunId: null,
        playbookId: 'manual',
        stepId: 'network_step'
      },
      'test.timeout_tool',
      {}
    )
  );

  const checkpoints = all(db, 'SELECT * FROM checkpoints WHERE tenant_id = ? AND type = ?', [tenant.id, 'tool_failure']);
  assert.equal(checkpoints.length, 1);
  const checkpoint = checkpoints[0];
  assert.equal(checkpoint.recoverable, 1);
  const state = JSON.parse(checkpoint.state);
  assert.equal(state.failure_type, 'external');
  assert.equal(state.failure_message, 'provider timeout while fetching data');
  assert.equal(state.recovery_strategy, 'bounded_retry');
  assert.equal(state.retryable, true);
});
