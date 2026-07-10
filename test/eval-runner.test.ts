import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createQualityGateFixture } from '../src/agent-runtime/eval/eval-runner.js';
import { createTenant } from '../src/services.js';

test('eval runner validates playbook fixtures and quality gate fixtures', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Eval Runner 公司' });
  const harness = createHarness(db);

  const playbook = harness.agentRegistry.getPlaybook('analytics_agent.weekly_review.v1');
  const suite = await harness.evalRunner.runSuite({
    id: 'foundation_smoke',
    playbook_cases: [
      {
        id: 'weekly_review_artifact',
        input: {
          tenant_id: tenant.id,
          user_id: 'user_test',
          playbook_id: 'analytics_agent.weekly_review.v1',
          goal: '生成 eval 周报'
        },
        expect: {
          agent_status: 'completed',
          workflow_status: 'completed',
          artifacts: ['weekly_report']
        }
      }
    ],
    quality_gate_cases: [
      {
        id: 'artifact_presence_passes',
        gate_ids: ['artifact_presence_gate'],
        context: createQualityGateFixture({
          tenant_id: tenant.id,
          playbook,
          agentRun: { tenant_id: tenant.id },
          artifacts: [{ type: 'weekly_report' }]
        }),
        expect: {
          statuses: {
            artifact_presence_gate: 'passed'
          }
        }
      }
    ]
  });

  assert.equal(suite.status, 'passed');
  assert.equal(suite.total, 2);
  assert.equal(suite.failed, 0);
});

test('eval runner reports failed expectations without throwing', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Eval Failure 公司' });
  const harness = createHarness(db);

  const result = await harness.evalRunner.runPlaybookCase({
    id: 'wrong_expectation',
    input: {
      tenant_id: tenant.id,
      user_id: 'user_test',
      playbook_id: 'analytics_agent.weekly_review.v1',
      goal: '生成 eval 周报'
    },
    expect: {
      agent_status: 'failed_blocked'
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0].name, 'agent_run.status');
  assert.equal(result.checks[0].actual, 'completed');
});
