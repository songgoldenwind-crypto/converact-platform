import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { importIvrToVoiceAgentSpec } from '../src/agent-runtime/call-center/voice-agent-ivr-importer.js';
import { buildSpecNodeIndex } from '../src/agent-runtime/call-center/voice-agent-navigator.js';
import {
  asCallSessionMetadata,
  buildNavigationMetadataPatch,
  persistNavigationResult
} from '../src/agent-runtime/call-center/voice-agent-navigation-session.js';
import type { VoiceAgentSpec } from '../src/agent-runtime/call-center/types.js';

const sampleMenus = [
  {
    id: 'root',
    name: '主菜单',
    prompt: '按1销售按2售后',
    options: [
      { key: '1', label: '销售', target: 'sales' },
      { key: '2', label: '售后', target: 'support' }
    ]
  },
  { id: 'sales', name: '销售', prompt: '请说预算', action: 'transfer_human' as const },
  { id: 'support', name: '售后', prompt: '请说问题' }
];

function buildSpec(): VoiceAgentSpec {
  const draft = importIvrToVoiceAgentSpec({ tenant_id: 'tenant-1', menus: sampleMenus });
  return {
    id: 'spec-1',
    tenant_id: 'tenant-1',
    language: 'zh',
    goal: draft.goal,
    status: 'published',
    version: 1,
    tools: draft.tools || [],
    compliance: draft.compliance || {},
    runtime: draft.runtime,
    nodes: draft.nodes || []
  };
}

test('buildSpecNodeIndex resolves nodes in O(1)', () => {
  const spec = buildSpec();
  const index = buildSpecNodeIndex(spec);
  assert.equal(index.get('sales')?.name, '销售');
  assert.equal(index.size, 3);
});

test('persistNavigationResult increments navigation_version', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Nav Version' });
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    provider: 'rustpbx',
    direction: 'outbound',
    status: 'active',
    phone: '+8613800138000',
    metadata: { agent_spec_id: 'spec-1' }
  });
  const spec = buildSpec();

  persistNavigationResult(voiceStore, tenant.id, session.id, spec, {
    agentSpecId: 'spec-1',
    trigger: '1'
  });

  const updated = voiceStore.getCallSession(tenant.id, session.id);
  const meta = asCallSessionMetadata(updated?.metadata);
  assert.equal(meta.current_node_id, 'sales');
  assert.equal(meta.navigation_version, 1);
});

test('buildNavigationMetadataPatch appends node_history', () => {
  const patch = buildNavigationMetadataPatch(
    { node_history: ['root'], navigation_version: 0 },
    {
      agentSpecId: 'spec-1',
      navigation: {
        previous_node_id: 'root',
        current_node_id: 'sales',
        node_name: '销售',
        prompt: '请说预算',
        action_taken: 'continued',
        message_for_agent: '已进入销售',
        reached_terminal: false
      },
      trigger: '1'
    }
  );
  assert.deepEqual(patch.node_history, ['root', 'sales']);
  assert.equal(patch.agent_spec_id, 'spec-1');
});
