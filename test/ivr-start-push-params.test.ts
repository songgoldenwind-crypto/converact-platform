import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import {
  applyStartPushParams,
  resolveParamSource,
} from '../src/agent-runtime/ivr/ivr-start-handler.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function startGraph(pushParams: Array<{ key: string; source: string }>): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'start',
    variables: [],
    nodes: [
      {
        id: 'start',
        type: 'start',
        name: 'Start',
        position: { x: 0, y: 0 },
        data: { pushParams },
      },
      { id: 'next', type: 'play', name: 'Next', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'hi' }] } },
    ],
    edges: [{ id: 'e1', source: 'start', target: 'next', sourceHandle: 'out' }],
  };
}

test('resolveParamSource: channel.caller_area_code', () => {
  assert.equal(
    resolveParamSource('channel.caller_area_code', { caller_area_code: '021' }, {}),
    '021'
  );
});

test('resolveParamSource: custom SIP header', () => {
  assert.equal(
    resolveParamSource('custom.X-Campaign', { 'custom.X-Campaign': 'summer' }, {}),
    'summer'
  );
});

test('resolveParamSource: literal prefix', () => {
  assert.equal(resolveParamSource('literal:fixed', {}, {}), 'fixed');
});

test('resolveParamSource: missing channel key → empty string', () => {
  assert.equal(resolveParamSource('channel.missing', {}, {}), '');
});

test('pushParams maps channel and advances to out', async () => {
  const graph = startGraph([
    { key: 'region', source: 'channel.caller_area_code' },
    { key: 'campaign', source: 'custom.X-Campaign' },
  ]);
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    channelVariables: {
      caller_area_code: '021',
      'custom.X-Campaign': 'summer2026',
    },
  });
  assert.equal(step.nextNodeId, 'next');
  assert.equal(step.context.variables.region, '021');
  assert.equal(step.context.variables.campaign, 'summer2026');
  assert.equal(step.context.variables.last_branch_handle, 'out');
});

test('applyStartPushParams: template variable', () => {
  const node = startGraph([{ key: 'greet', source: '{{name}}' }]).nodes[0];
  const vars = applyStartPushParams(node, { name: 'Alice' }, {});
  assert.equal(vars.greet, 'Alice');
});
