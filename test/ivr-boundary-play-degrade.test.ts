/**
 * P0 — play 解析失败、无 error 出边时的降级边界。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function playGraph(onError: 'continue' | 'branch'): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'p1',
    variables: [],
    nodes: [
      {
        id: 'p1',
        type: 'play',
        name: 'P',
        position: { x: 0, y: 0 },
        data: {
          contents: [{ playType: 'audio', audioFile: 'missing-audio' }],
          onError,
        },
      },
    ],
    edges: [],
  };
}

test('play resolve error + onError continue → stays on node, enqueues fallback', async () => {
  const step = await advanceSingleStep(createRuntimeContext(playGraph('continue')));
  assert.equal(step.nextNodeId, 'p1');
  assert.equal(step.context.currentNodeId, 'p1');
  assert.equal(step.context.audioQueue?.length, 1);
  assert.equal(step.context.audioQueue?.[0]?.text, '(audio not found)');
  assert.equal(step.context.variables._branch_miss, undefined);
  assert.equal(step.context.variables.play_resolve_error, undefined);
});

test('play resolve error + onError branch + no error edge → branch_miss, stays on node', async () => {
  const step = await advanceSingleStep(createRuntimeContext(playGraph('branch')));
  assert.equal(step.nextNodeId, 'p1');
  assert.equal(step.context.variables._branch_miss, 'p1:error');
  assert.equal(step.context.variables.last_error, 'audio_not_found');
  assert.equal(step.context.variables.play_resolve_error, undefined);
});
