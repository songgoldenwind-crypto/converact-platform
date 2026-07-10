import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { VoiceAgentSpecStore } from '../src/agent-runtime/call-center/voice-agent-spec-store.js';

test('voice_agent_specs table exists and builtin default-outbound-zh loads', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Spec Tenant' });
  const store = new VoiceAgentSpecStore(db);
  const spec = store.getSpec('default-outbound-zh', tenant.id);
  assert.ok(spec);
  assert.equal(spec.language, 'zh');
  assert.ok(spec.runtime.system_prompt.includes('外呼'));
  assert.ok(spec.tools.includes('check_intent'));
});

test('create and list tenant voice agent spec', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Spec Tenant 2' });
  const store = new VoiceAgentSpecStore(db);
  const created = store.createSpec({
    tenant_id: tenant.id,
    language: 'zh',
    goal: '测试外呼',
    status: 'published',
    runtime: {
      system_prompt: '你是测试助手',
      greeting: '你好'
    },
    tools: ['check_intent']
  });
  assert.equal(created.status, 'published');
  const listed = store.listSpecs(tenant.id);
  assert.ok(listed.some((row) => row.id === created.id));
});
