import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  executeIvrNode,
  type IvrExecutionContext,
  type IvrFlowGraph,
  type IvrNodeBase,
  type IvrNodeType
} from '../src/agent-runtime/ivekit/ivr/index.js';

test('IVR executor deterministically runs start, set_var, condition, and time_condition', () => {
  const context = emptyContext();
  const start = executeIvrNode({ graph: single('start', {}, ['out']), node_id: 'node', context, event: { type: 'enter' } });
  assert.equal(start.state, 'advanced');
  assert.equal(start.branch, 'out');
  assert.equal(start.context.variables.language, 'zh-CN');

  const set = executeIvrNode({
    graph: single('set_var', { variable: 'greeting', value: 'Hello ${caller}' }, ['out']),
    node_id: 'node', context: { ...context, variables: { caller: 'Alice' } }, event: { type: 'enter' }
  });
  assert.equal(set.context.variables.greeting, 'Hello Alice');

  const condition = executeIvrNode({
    graph: single('condition', { variable: 'score', operator: 'gte', value: 80 }, ['true', 'false']),
    node_id: 'node', context: { ...context, variables: { score: 90 } }, event: { type: 'enter' }
  });
  assert.equal(condition.branch, 'true');

  const time = executeIvrNode({
    graph: single('time_condition', { time_group_id: 'business-hours' }, ['true', 'false']),
    node_id: 'node', context, event: { type: 'enter' },
    environment: { is_time_group_active: (id) => id === 'business-hours' }
  });
  assert.equal(time.branch, 'true');
});

test('IVR executor plans every provider-neutral action family', () => {
  const cases: Array<[IvrNodeType, Record<string, unknown>, string]> = [
    ['play', { text: 'Welcome' }, 'play'],
    ['menu', { prompt: 'Press one' }, 'collect'],
    ['collect', { variable: 'account' }, 'collect'],
    ['flush_audio', {}, 'flush'],
    ['queue', { queue_id: 'support' }, 'queue'],
    ['http', { webhook_ref: 'crm' }, 'webhook'],
    ['webhook', { webhook_ref: 'audit' }, 'webhook'],
    ['transfer', { target_ref: 'agent-1' }, 'transfer'],
    ['sip', { target_ref: 'sip-route-1' }, 'transfer'],
    ['voicemail', { max_duration_ms: 60_000 }, 'record'],
    ['disconnect', { reason: 'completed' }, 'hangup'],
    ['recording', { action: 'start' }, 'record'],
    ['knowledge_qa', { knowledge_profile_id: 'kb' }, 'knowledge'],
    ['ai_dialogue', { ai_profile_id: 'dialogue' }, 'ai'],
    ['intent', { ai_profile_id: 'intent', dimension: 'model' }, 'ai'],
    ['avatar_switch', { avatar_ref: 'avatar-1' }, 'media'],
    ['video_play', { asset_ref: 'video-1' }, 'media'],
    ['screen_share', { participant_ref: 'user-1' }, 'media'],
    ['visual_menu', { items: [] }, 'media'],
    ['compliance', { complianceType: 'recording_consent' }, 'collect']
  ];
  for (const [type, data, kind] of cases) {
    const outcome = executeIvrNode({
      graph: single(type, data, branches(type)), node_id: 'node', context: emptyContext(), event: { type: 'enter' }
    });
    assert.equal(outcome.state, 'waiting', type);
    assert.equal(outcome.action?.kind, kind, type);
    assert.equal(outcome.action?.node_id, 'node', type);
  }
});

test('IVR executor routes interaction events with exact handles and updates variables', () => {
  const menu = executeIvrNode({
    graph: single('menu', { options: [{ digit: '1' }] }, ['digit_1', 'timeout', 'invalid', 'max_retries']),
    node_id: 'node', context: emptyContext(), event: { type: 'dtmf', digit: '1' }
  });
  assert.equal(menu.branch, 'digit_1');

  const collect = executeIvrNode({
    graph: single('collect', { variable: 'account', min_digits: 3, max_digits: 6 }, ['out', 'timeout', 'invalid']),
    node_id: 'node', context: emptyContext(), event: { type: 'dtmf', digit: '1234' }
  });
  assert.equal(collect.branch, 'out');
  assert.equal(collect.context.variables.account, '1234');

  const invalid = executeIvrNode({
    graph: single('collect', { variable: 'account', min_digits: 3 }, ['out', 'timeout', 'invalid']),
    node_id: 'node', context: emptyContext(), event: { type: 'dtmf', digit: '1' }
  });
  assert.equal(invalid.branch, 'invalid');

  const visual = executeIvrNode({
    graph: single('visual_menu', { items: [{ digit: '2' }] }, ['digit_2', 'timeout', 'invalid']),
    node_id: 'node', context: emptyContext(), event: { type: 'selection', value: '2' }
  });
  assert.equal(visual.branch, 'digit_2');
});

test('IVR executor maps action results to success, fallback, and terminal states', () => {
  const httpSuccess = executeIvrNode({
    graph: single('http', {}, ['success', 'fail', 'timeout']), node_id: 'node', context: emptyContext(),
    event: { type: 'action_succeeded', result: { status: 204, mapped_variables: { ticket: 'T-1' } } }
  });
  assert.equal(httpSuccess.branch, 'success');
  assert.equal(httpSuccess.context.variables.ticket, 'T-1');

  const queueFull = executeIvrNode({
    graph: single('queue', {}, ['out', 'timeout', 'at_capacity', 'error']), node_id: 'node', context: emptyContext(),
    event: { type: 'action_succeeded', result: { status: 'at_capacity' } }
  });
  assert.equal(queueFull.branch, 'at_capacity');

  const transfer = executeIvrNode({
    graph: single('transfer', {}, []), node_id: 'node', context: emptyContext(),
    event: { type: 'action_succeeded', result: {} }
  });
  assert.equal(transfer.state, 'completed');

  const failed = executeIvrNode({
    graph: single('screen_share', {}, ['out', 'denied', 'error']), node_id: 'node', context: emptyContext(),
    event: { type: 'action_succeeded', result: { disposition: 'denied' } }
  });
  assert.equal(failed.branch, 'denied');

  const timeout = executeIvrNode({
    graph: single('ai_dialogue', {}, ['out', 'timeout', 'error']), node_id: 'node', context: emptyContext(),
    event: { type: 'timeout' }
  });
  assert.equal(timeout.branch, 'timeout');
});

test('IVR executor exposes subflow delegation and fails closed on a missing branch', () => {
  const delegated = executeIvrNode({
    graph: single('subflow', { flow_id: 'child', flow_version: 2 }, ['out', 'error']),
    node_id: 'node', context: emptyContext(), event: { type: 'enter' }
  });
  assert.equal(delegated.state, 'delegated');
  assert.deepEqual(delegated.delegation, { flow_id: 'child', flow_version: 2 });

  const missing = executeIvrNode({
    graph: single('condition', { variable: 'x', operator: 'equals', value: 'yes' }, ['false']),
    node_id: 'node', context: { ...emptyContext(), variables: { x: 'yes' } }, event: { type: 'enter' }
  });
  assert.equal(missing.state, 'failed');
  assert.equal(missing.error_code, 'branch_missing');
});

function single(type: IvrNodeType, data: Record<string, unknown>, handles: string[]): IvrFlowGraph {
  const subject: IvrNodeBase = { id: 'node', type, name: type, position: { x: 0, y: 0 }, data };
  const targets = handles.map((handle) => ({
    id: `target-${handle}`, type: 'disconnect' as const, name: handle, position: { x: 1, y: 0 }, data: {}
  }));
  return {
    version: 1,
    entryNodeId: 'node',
    nodes: [subject, ...targets],
    edges: handles.map((handle) => ({
      id: `edge-${handle}`, source: 'node', target: `target-${handle}`, sourceHandle: handle
    })),
    variables: [{ name: 'language', defaultValue: 'zh-CN' }]
  };
}

function branches(type: IvrNodeType): string[] {
  const values: Partial<Record<IvrNodeType, string[]>> = {
    play: ['out', 'error'], menu: ['timeout', 'invalid', 'max_retries'],
    collect: ['out', 'timeout', 'invalid'], flush_audio: ['out', 'error'],
    queue: ['out', 'timeout', 'at_capacity', 'error'], http: ['success', 'fail', 'timeout'],
    webhook: ['success', 'fail', 'timeout'], recording: ['out', 'skipped', 'error'],
    knowledge_qa: ['found', 'not_found', 'error'], ai_dialogue: ['out', 'timeout', 'error'],
    intent: ['high', 'low', 'continue', 'error'], avatar_switch: ['success', 'declined', 'error'],
    video_play: ['out', 'skipped', 'error'], screen_share: ['out', 'denied', 'error'],
    visual_menu: ['timeout', 'invalid'], compliance: ['out', 'acknowledged', 'declined', 'timeout', 'error']
  };
  return values[type] ?? [];
}

function emptyContext(): IvrExecutionContext {
  return {
    variables: {}, interaction_attempts: {},
    active_flow: { flow_id: 'flow-a', flow_version: 1 }, subflow_stack: []
  };
}
