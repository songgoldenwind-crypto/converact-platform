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
      audit_event_name: 'tool.content_publish_external'
    },
    () => ({ queued: true })
  );
}

test('dag engine persists nodes and executes tool, condition, and artifact branches', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'DAG 条件测试公司' });
  const harness = createHarness(db);

  const result = await harness.dagEngine.run({
    tenant_id: tenant.id,
    user_id: 'user_test',
    goal: '验证 DAG 条件分支',
    dag: {
      nodes: [
        {
          id: 'create_channel',
          type: 'tool',
          tool_id: 'channel.create',
          input: {
            tenant_id: '$input.tenant_id',
            platform_code: 'linkedin',
            target_goal: 'lead'
          }
        },
        {
          id: 'is_linkedin',
          type: 'condition',
          input: {
            value: '$nodes.create_channel.platform_code'
          },
          condition: {
            equals: 'linkedin'
          }
        },
        {
          id: 'commit_true',
          type: 'artifact',
          artifact_type: 'dag_branch_result',
          input: {
            payload: {
              matched: true,
              channel: '$nodes.create_channel',
              condition: '$nodes.is_linkedin'
            }
          }
        },
        {
          id: 'commit_false',
          type: 'artifact',
          artifact_type: 'dag_false_branch',
          input: {
            payload: {
              matched: false
            }
          }
        }
      ],
      edges: [
        { from: 'create_channel', to: 'is_linkedin' },
        { from: 'is_linkedin', to: 'commit_true', when: true },
        { from: 'is_linkedin', to: 'commit_false', when: false }
      ]
    }
  });

  assert.equal(result.workflow_run.status, 'completed');
  assert.equal(result.node_outputs.is_linkedin.result, true);
  assert.equal(result.node_outputs.commit_true.type, 'dag_branch_result');

  const nodeStatuses = Object.fromEntries(result.dag_nodes.map((node) => [node.node_id, node.status]));
  assert.deepEqual(nodeStatuses, {
    create_channel: 'completed',
    is_linkedin: 'completed',
    commit_true: 'completed',
    commit_false: 'skipped'
  });

  const persistedNodes = all(db, 'SELECT node_id FROM workflow_dag_nodes WHERE tenant_id = ? ORDER BY node_id', [tenant.id]);
  assert.deepEqual(
    persistedNodes.map((row) => row.node_id),
    ['commit_false', 'commit_true', 'create_channel', 'is_linkedin']
  );
});

test('dag engine pauses approval-gated tool nodes without executing downstream nodes', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'DAG 审批测试公司' });
  const harness = createHarness(db);
  registerMockExternalTool(harness.toolRegistry);

  const result = await harness.dagEngine.run({
    tenant_id: tenant.id,
    user_id: 'user_test',
    goal: '验证 DAG 审批暂停',
    dag: {
      nodes: [
        {
          id: 'publish',
          type: 'tool',
          agent_id: 'content_agent',
          tool_id: 'content.publish_external',
          input: {
            tenant_id: '$input.tenant_id',
            channel: 'linkedin',
            content: 'Approval gated DAG post'
          }
        },
        {
          id: 'commit_after_publish',
          type: 'artifact',
          artifact_type: 'publish_result',
          input: {
            payload: '$nodes.publish'
          }
        }
      ],
      edges: [{ from: 'publish', to: 'commit_after_publish' }]
    }
  });

  assert.equal(result.workflow_run.status, 'awaiting_human_approval');
  const nodeStatuses = Object.fromEntries(result.dag_nodes.map((node) => [node.node_id, node.status]));
  assert.equal(nodeStatuses.publish, 'waiting_approval');
  assert.equal(nodeStatuses.commit_after_publish, 'pending');

  const approvals = all(db, 'SELECT * FROM approval_requests WHERE tenant_id = ?', [tenant.id]);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].action_type, 'content.publish_external');
});

test('dag engine resumes a paused approval node and continues downstream execution', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'DAG 审批恢复测试公司' });
  const harness = createHarness(db);
  registerMockExternalTool(harness.toolRegistry);

  const paused = await harness.dagEngine.run({
    tenant_id: tenant.id,
    user_id: 'user_test',
    goal: '验证 DAG 审批恢复',
    dag: {
      nodes: [
        {
          id: 'publish',
          type: 'tool',
          agent_id: 'content_agent',
          tool_id: 'content.publish_external',
          input: {
            tenant_id: '$input.tenant_id',
            channel: 'linkedin',
            content: 'Approval resume DAG post'
          }
        },
        {
          id: 'commit_after_publish',
          type: 'artifact',
          artifact_type: 'publish_result',
          input: {
            payload: '$nodes.publish'
          }
        }
      ],
      edges: [{ from: 'publish', to: 'commit_after_publish' }]
    }
  });

  const approvalId = paused.node_outputs.publish.approval_request.id;
  harness.approvalQueue.decide(tenant.id, approvalId, 'approved', 'owner_test');

  const resumed = await harness.dagEngine.resumeAfterApproval({
    tenant_id: tenant.id,
    user_id: 'user_test',
    workflow_run_id: paused.workflow_run.id,
    approval_request_id: approvalId
  });

  assert.equal(resumed.workflow_run.status, 'completed');
  assert.deepEqual(resumed.node_outputs.publish, { queued: true });
  assert.equal(resumed.node_outputs.commit_after_publish.type, 'publish_result');
  assert.deepEqual(resumed.node_outputs.commit_after_publish.payload, { queued: true });
});

test('dag engine retries retryable nodes up to max_attempts', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'DAG 重试测试公司' });
  const harness = createHarness(db);
  let attempts = 0;

  harness.toolRegistry.register(
    {
      tool_id: 'test.flaky_read',
      display_name: 'Flaky read',
      toolset: 'test',
      category: 'read',
      risk_level: 'R0',
      input_schema: {},
      output_schema: {},
      side_effect: false,
      idempotency_required: false,
      approval_required: false,
      allowed_agents: ['orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: false,
      object_scope_required: false,
      audit_event_name: 'tool.test_flaky_read'
    },
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary provider failure');
      return { ok: true, attempts };
    }
  );

  const result = await harness.dagEngine.run({
    tenant_id: tenant.id,
    user_id: 'user_test',
    goal: '验证 DAG 重试',
    dag: {
      nodes: [
        {
          id: 'flaky',
          type: 'tool',
          tool_id: 'test.flaky_read',
          max_attempts: 2,
          input: {}
        }
      ],
      edges: []
    }
  });

  assert.equal(result.workflow_run.status, 'completed');
  assert.equal(result.node_outputs.flaky.ok, true);
  assert.equal(result.dag_nodes[0].attempts, 2);
  assert.equal(result.dag_nodes[0].status, 'completed');
});


test('dag engine waits for all success parents by default before running a child node', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'DAG 依赖守卫测试公司' });
  const harness = createHarness(db);

  harness.toolRegistry.register(
    {
      tool_id: 'test.join_guard',
      display_name: 'Join guard',
      toolset: 'test',
      category: 'read',
      risk_level: 'R0',
      input_schema: {},
      output_schema: {},
      side_effect: false,
      idempotency_required: false,
      approval_required: false,
      allowed_agents: ['orchestration_agent'],
      forbidden_agents: [],
      tenant_scope_required: false,
      object_scope_required: false,
      audit_event_name: 'tool.test_join_guard'
    },
    async (input) => {
      assert.equal(input.direct_parent_ready, true);
      assert.equal(input.chained_parent_ready, true);
      return { ready: true };
    }
  );

  const result = await harness.dagEngine.run({
    tenant_id: tenant.id,
    user_id: 'user_test',
    goal: '验证 DAG 默认需要全部成功父节点',
    dag: {
      nodes: [
        {
          id: 'direct_parent',
          type: 'condition',
          input: { value: true }
        },
        {
          id: 'seed_parent',
          type: 'condition',
          input: { value: true }
        },
        {
          id: 'chained_parent',
          type: 'artifact',
          artifact_type: 'chained_parent_result',
          input: {
            payload: {
              ready: '$nodes.seed_parent.result'
            }
          }
        },
        {
          id: 'join_after_both',
          type: 'tool',
          tool_id: 'test.join_guard',
          input: {
            direct_parent_ready: '$nodes.direct_parent.result',
            chained_parent_ready: '$nodes.chained_parent.payload.ready'
          }
        }
      ],
      edges: [
        { from: 'seed_parent', to: 'chained_parent' },
        { from: 'direct_parent', to: 'join_after_both' },
        { from: 'chained_parent', to: 'join_after_both' }
      ]
    }
  });

  assert.equal(result.workflow_run.status, 'completed');
  assert.equal(result.node_outputs.join_after_both.ready, true);
  const nodeStatuses = Object.fromEntries(result.dag_nodes.map((node) => [node.node_id, node.status]));
  assert.deepEqual(nodeStatuses, {
    direct_parent: 'completed',
    seed_parent: 'completed',
    chained_parent: 'completed',
    join_after_both: 'completed'
  });
});
