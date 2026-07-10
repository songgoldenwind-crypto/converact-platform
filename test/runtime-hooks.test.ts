import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createTenant } from '../src/services.js';

test('runtime hooks wrap context, tool, and artifact lifecycles', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Hook 测试公司' });
  const harness = createHarness(db);
  const seen = [];

  harness.hookManager.on('before_context_build', (payload) => {
    seen.push(`before_context:${payload.agent.agent_id}`);
  });
  harness.hookManager.on('after_context_build', (payload) => {
    seen.push(`after_context:${payload.contextPack.playbookId}`);
  });
  harness.hookManager.on('before_tool_call', (payload) => {
    seen.push(`before_tool:${payload.tool.tool_id}`);
  });
  harness.hookManager.on('after_tool_call', (payload) => {
    seen.push(`after_tool:${payload.tool.tool_id}:${payload.result.status}`);
  });
  harness.hookManager.on('before_artifact_commit', (payload) => {
    seen.push(`before_artifact:${payload.input.type}`);
  });
  harness.hookManager.on('after_artifact_commit', (payload) => {
    seen.push(`after_artifact:${payload.artifact.type}`);
  });

  const result = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    user_id: 'user_test',
    playbook_id: 'analytics_agent.weekly_review.v1',
    goal: '生成本周复盘'
  });

  assert.equal(result.agent_run.status, 'completed');
  assert.deepEqual(seen, [
    'before_context:analytics_agent',
    'after_context:analytics_agent.weekly_review.v1',
    'before_tool:analytics.weekly_report',
    'after_tool:analytics.weekly_report:success',
    'before_artifact:weekly_report',
    'after_artifact:weekly_report'
  ]);
});
