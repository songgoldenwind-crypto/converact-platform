import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import { shouldStopWalk } from '../src/agent-runtime/ivr/ivr-step-lifecycle.js';
import { walkToPromptableAction } from '../src/agent-runtime/ivr/ivr-runtime.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function aiGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'ai1',
    variables: [],
    nodes: [
      {
        id: 'ai1',
        type: 'ai_dialogue',
        name: 'AI',
        position: { x: 0, y: 0 },
        data: { agentSpecId: 'spec-1', maxTurns: 8, timeoutSec: 120, role: 'inbound_support' },
      },
      { id: 'out', type: 'transfer', name: 'Handoff', position: { x: 200, y: 0 }, data: { targetType: 'queue', targetValue: 'sales' } },
      { id: 'tout', type: 'play', name: 'Timeout', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'timeout' }] } },
      { id: 'err', type: 'play', name: 'Error', position: { x: 200, y: 200 }, data: { contents: [{ playType: 'tts', text: 'error' }] } },
    ],
    edges: [
      { id: 'e1', source: 'ai1', target: 'out', sourceHandle: 'out' },
      { id: 'e2', source: 'ai1', target: 'tout', sourceHandle: 'timeout' },
      { id: 'e3', source: 'ai1', target: 'err', sourceHandle: 'error' },
    ],
  };
}

function mockStart(ok: boolean) {
  return {
    startAiDialogue: async () => (ok ? { ok: true as const } : { ok: false as const, reason: 'dispatch_failed' }),
  };
}

test('first advance starts dispatch and pauses on node', async () => {
  const step = await advanceSingleStep(createRuntimeContext(aiGraph()), {
    tenantId: 't1',
    callSessionId: 'call-1',
    roomName: 'room-1',
    sideEffects: mockStart(true),
  });
  assert.equal(step.action.kind, 'ai_dialogue');
  assert.equal(step.context.waiting?.kind, 'ai_dialogue');
  assert.equal(step.context.waiting?.nodeId, 'ai1');
  assert.equal(step.context.currentNodeId, 'ai1');
  assert.equal(step.terminated, false);
});

test('dispatch failure routes to error edge', async () => {
  const step = await advanceSingleStep(createRuntimeContext(aiGraph()), {
    tenantId: 't1',
    callSessionId: 'call-1',
    roomName: 'room-1',
    sideEffects: mockStart(false),
  });
  assert.equal(step.nextNodeId, 'err');
  assert.equal(step.context.variables.ai_dispatch_error, 'dispatch_failed');
});

test('ai-result completed → out edge', async () => {
  let ctx = createRuntimeContext(aiGraph());
  ctx = (
    await advanceSingleStep(ctx, {
      tenantId: 't1',
      callSessionId: 'call-1',
      roomName: 'room-1',
      sideEffects: mockStart(true),
    })
  ).context;
  const step = await advanceSingleStep(ctx, {
    aiDialogueResult: { reason: 'completed', turnCount: 3 },
  });
  assert.equal(step.nextNodeId, 'out');
  assert.equal(step.context.waiting, undefined);
});

test('ai-result handoff → out edge with intent_score variable', async () => {
  let ctx = createRuntimeContext(aiGraph());
  ctx = (
    await advanceSingleStep(ctx, {
      tenantId: 't1',
      sideEffects: mockStart(true),
      roomName: 'room-1',
      callSessionId: 'call-1',
    })
  ).context;
  const step = await advanceSingleStep(ctx, {
    aiDialogueResult: { reason: 'handoff', intentScore: 0.82, variables: { last_utterance: '转人工' } },
  });
  assert.equal(step.nextNodeId, 'out');
  assert.equal(step.context.variables.intent_score, '0.82');
  assert.equal(step.context.variables.last_utterance, '转人工');
});

test('ai-result timeout → timeout edge', async () => {
  let ctx = createRuntimeContext(aiGraph());
  ctx = (await advanceSingleStep(ctx, { tenantId: 't1', sideEffects: mockStart(true), roomName: 'r', callSessionId: 'c' })).context;
  const step = await advanceSingleStep(ctx, { aiDialogueResult: { reason: 'timeout' } });
  assert.equal(step.nextNodeId, 'tout');
});

test('ai-result error → error edge', async () => {
  let ctx = createRuntimeContext(aiGraph());
  ctx = (await advanceSingleStep(ctx, { tenantId: 't1', sideEffects: mockStart(true), roomName: 'r', callSessionId: 'c' })).context;
  const step = await advanceSingleStep(ctx, { aiDialogueResult: { reason: 'error' } });
  assert.equal(step.nextNodeId, 'err');
});

test('walkToPromptableAction stops when context.waiting is set', async () => {
  let ctx = createRuntimeContext(aiGraph());
  ctx = (
    await advanceSingleStep(ctx, {
      tenantId: 't1',
      sideEffects: mockStart(true),
      roomName: 'room-1',
      callSessionId: 'call-1',
    })
  ).context;
  assert.equal(shouldStopWalk(ctx), true);
  const walked = await walkToPromptableAction(ctx, {});
  assert.equal(walked.terminated, false);
  assert.equal(walked.context.waiting?.kind, 'ai_dialogue');
});

test('missing error edge on dispatch failure → null nextNodeId', async () => {
  const graph = aiGraph();
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'error');
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    tenantId: 't1',
    roomName: 'room-1',
    callSessionId: 'call-1',
    sideEffects: mockStart(false),
  });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables.last_branch_handle, 'error');
  assert.equal(step.context.variables._branch_miss, 'ai1:error');
});

test('ai-result timeout without timeout edge → _branch_miss', async () => {
  const graph = aiGraph();
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'timeout');
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, { tenantId: 't1', sideEffects: mockStart(true), roomName: 'r', callSessionId: 'c' })).context;
  const step = await advanceSingleStep(ctx, { aiDialogueResult: { reason: 'timeout' } });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables.last_branch_handle, 'timeout');
  assert.equal(step.context.variables._branch_miss, 'ai1:timeout');
});

test('still waiting without aiDialogueResult stays on node', async () => {
  let ctx = createRuntimeContext(aiGraph());
  ctx = (
    await advanceSingleStep(ctx, {
      tenantId: 't1',
      sideEffects: mockStart(true),
      roomName: 'room-1',
      callSessionId: 'call-1',
    })
  ).context;
  const step = await advanceSingleStep(ctx, {});
  assert.equal(step.context.currentNodeId, 'ai1');
  assert.equal(step.context.waiting?.kind, 'ai_dialogue');
});
