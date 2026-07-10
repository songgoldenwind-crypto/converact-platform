import assert from 'node:assert/strict';
import { test } from 'node:test';
import { all } from '../src/db.js';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createTenant } from '../src/services.js';

test('context builder creates tenant-scoped session keys for business objects', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Session 隔离测试公司' });
  const harness = createHarness(db);

  const result = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    user_id: 'user_test',
    channel: 'telegram',
    playbook_id: 'crm_agent.create_followup_task.v1',
    goal: '给 lead_123 创建跟进任务',
    object_type: 'lead',
    object_id: 'lead_123',
    title: '确认预算和上线时间',
    business_context: {
      object_type: 'lead',
      object_id: 'lead_123'
    }
  });

  assert.equal(result.agent_run.context_pack.session.businessObjectType, 'lead');
  assert.equal(result.agent_run.context_pack.session.businessObjectId, 'lead_123');
  assert.match(result.agent_run.context_pack.session.sessionKey, /:telegram:lead:lead_123:crm_agent$/);

  const sessions = all(db, 'SELECT * FROM agent_sessions WHERE tenant_id = ?', [tenant.id]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sandbox_scope, 'business_object');
  assert.equal(sessions[0].dm_scope, 'per_business_object');
});

test('context builder rejects cross-tenant business context before memory retrieval', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Tenant A' });
  const otherTenant = createTenant(db, { name: 'Tenant B' });
  const harness = createHarness(db);

  assert.throws(
    () =>
      harness.contextBuilder.build({
        tenantId: tenant.id,
        workspaceId: 'default',
        userId: 'user_test',
        agent: harness.agentRegistry.getManifest('crm_agent'),
        playbook: harness.agentRegistry.getPlaybook('crm_agent.create_followup_task.v1'),
        goal: '跨租户上下文应被拒绝',
        businessContext: {
          object_type: 'lead',
          object_id: 'lead_1',
          tenant_id: otherTenant.id
        }
      }),
    /crosses tenant boundary/
  );
});
