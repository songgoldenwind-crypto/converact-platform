import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { TriggerRunner } from '../src/agent-runtime/scheduler/trigger-runner.js';
import { createTenant } from '../src/services.js';

test('scheduled trigger result includes feedback_receipt quality status', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Trigger Runner Feedback 公司' });
  const triggerRunner = new TriggerRunner({
    db,
    runtime: {
      runPlaybook: async () => ({
        workflow_run: { id: 'workflow_1', status: 'completed' },
        agent_run: { id: 'agent_1' },
        step_outputs: [{ step_id: 'discover' }],
        artifacts: [{ id: 'artifact_1' }]
      })
    },
    playbookRouter: {
      route: () => ({ playbook_id: 'analytics_agent.weekly_review.v1' })
    }
  });

  const trigger = triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: 'Feedback Heartbeat',
    goal: 'Run scheduled review',
    interval_seconds: 3600,
    next_run_at: '2026-01-01T00:00:00.000Z'
  });
  const result = await triggerRunner.runScheduledTrigger(trigger!, {
    now: '2026-01-01T00:00:00.000Z'
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.feedback_receipt.quality_status, 'pass');
});
