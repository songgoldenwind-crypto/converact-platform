import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importIvrToVoiceAgentSpec } from '../src/agent-runtime/call-center/voice-agent-ivr-importer.js';
import { navigateVoiceAgentNode } from '../src/agent-runtime/call-center/voice-agent-navigator.js';
import type { VoiceAgentSpec } from '../src/agent-runtime/call-center/types.js';

const sampleMenus = [
  {
    id: 'root',
    name: '主菜单',
    prompt: '您好，请问需要销售咨询还是售后服务？可以说「销售」或「售后」。',
    options: [
      { key: '1', label: '销售', target: 'sales' },
      { key: '2', label: '售后', target: 'support' }
    ]
  },
  {
    id: 'sales',
    name: '销售咨询',
    prompt: '请告诉我您关注的户型和预算。',
    action: 'transfer_human' as const,
    transitions: { intent_high: 'sales' }
  },
  {
    id: 'support',
    name: '售后服务',
    prompt: '请描述您遇到的问题。',
    transitions: { default: 'root' }
  }
];

test('importIvrToVoiceAgentSpec builds nodes and navigation prompt', () => {
  const draft = importIvrToVoiceAgentSpec({
    tenant_id: 'tenant-1',
    goal: '房产咨询分流',
    brand_name: '安居客',
    menus: sampleMenus
  });
  assert.equal(draft.nodes?.length, 3);
  assert.ok(draft.runtime.system_prompt.includes('navigate_flow'));
  assert.ok(draft.tools?.includes('navigate_flow'));
  const root = draft.nodes?.find((node) => node.id === 'root');
  assert.ok(root?.transitions?.['dtmf:1'] === 'sales');
  assert.ok(root?.transitions?.['keyword:销售'] === 'sales');
});

test('navigateVoiceAgentNode moves from root to sales on dtmf 1', () => {
  const draft = importIvrToVoiceAgentSpec({
    tenant_id: 'tenant-1',
    menus: sampleMenus
  });
  const spec = {
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
  } satisfies VoiceAgentSpec;

  const start = navigateVoiceAgentNode(spec, 'root', 'start');
  assert.equal(start.current_node_id, 'root');

  const moved = navigateVoiceAgentNode(spec, 'root', '1');
  assert.equal(moved.current_node_id, 'sales');
  assert.equal(moved.action_taken, 'continued');

  const byKeyword = navigateVoiceAgentNode(spec, 'root', 'default', '我想了解销售');
  assert.equal(byKeyword.current_node_id, 'sales');
});

test('navigateVoiceAgentNode triggers transfer on sales node intent_high route', () => {
  const draft = importIvrToVoiceAgentSpec({
    tenant_id: 'tenant-1',
    menus: sampleMenus
  });
  const spec = {
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
  } satisfies VoiceAgentSpec;

  const transfer = navigateVoiceAgentNode(spec, 'sales', 'intent_high');
  assert.equal(transfer.action_taken, 'transfer_human');
  assert.equal(transfer.reached_terminal, true);
});
