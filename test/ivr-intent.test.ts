import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import {
  evaluateIntentKeyword,
  resolveIntentBranch,
} from '../src/agent-runtime/ivr/ivr-intent-handler.js';
import { defaultSideEffects } from '../src/agent-runtime/ivr/ivr-side-effects.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function intentGraph(data: Record<string, unknown>): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'i1',
    variables: [],
    nodes: [
      { id: 'i1', type: 'intent', name: 'Intent', position: { x: 0, y: 0 }, data },
      { id: 'high', type: 'play', name: 'High', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'h' }] } },
      { id: 'low', type: 'play', name: 'Low', position: { x: 200, y: 50 }, data: { contents: [{ playType: 'tts', text: 'l' }] } },
      { id: 'mid', type: 'play', name: 'Mid', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'm' }] } },
    ],
    edges: [
      { id: 'e1', source: 'i1', target: 'high', sourceHandle: 'high' },
      { id: 'e2', source: 'i1', target: 'low', sourceHandle: 'low' },
      { id: 'e3', source: 'i1', target: 'mid', sourceHandle: 'continue' },
    ],
  };
}

test('evaluateIntentKeyword: case-insensitive substring', () => {
  assert.equal(evaluateIntentKeyword('我想了解贷款产品', ['贷款']), true);
  assert.equal(evaluateIntentKeyword('LOAN please', ['loan']), true);
  assert.equal(evaluateIntentKeyword('随便问问', ['贷款']), false);
});

test('resolveIntentBranch: keyword high / low / continue', () => {
  const graph = intentGraph({
    dimension: 'keyword',
    keywords: ['贷款'],
    lowKeywords: ['不需要'],
  });
  const node = graph.nodes[0];
  const vars1: Record<string, string> = { last_utterance: '咨询贷款' };
  assert.equal(resolveIntentBranch(graph, 'i1', node.data, vars1).branch, 'high');

  const vars2: Record<string, string> = { last_utterance: '不需要了' };
  assert.equal(resolveIntentBranch(graph, 'i1', node.data, vars2).branch, 'low');

  const vars3: Record<string, string> = { last_utterance: '你好' };
  assert.equal(resolveIntentBranch(graph, 'i1', node.data, vars3).branch, 'continue');
});

test('advanceSingleStep: score high branch', async () => {
  const step = await advanceSingleStep(createRuntimeContext(intentGraph({ dimension: 'score', threshold: 0.7 })), {
    sideEffects: { executeIntent: async () => ({ score: 0.9, dimension: 'score' }) },
  });
  assert.equal(step.nextNodeId, 'high');
  assert.equal(step.context.variables.intent_score, '0.9');
});

test('advanceSingleStep: score low branch', async () => {
  const step = await advanceSingleStep(createRuntimeContext(intentGraph({ dimension: 'score', threshold: 0.7 })), {
    sideEffects: { executeIntent: async () => ({ score: 0.2, dimension: 'score' }) },
  });
  assert.equal(step.nextNodeId, 'low');
});

test('advanceSingleStep: score continue branch', async () => {
  const step = await advanceSingleStep(createRuntimeContext(intentGraph({ dimension: 'score', threshold: 0.7 })), {
    sideEffects: { executeIntent: async () => ({ score: 0.55, dimension: 'score' }) },
  });
  assert.equal(step.nextNodeId, 'mid');
});

test('advanceSingleStep: keyword dimension via last_utterance', async () => {
  const ctx = createRuntimeContext(intentGraph({
    dimension: 'keyword',
    keywords: ['贷款'],
    lowKeywords: ['不需要'],
  }));
  ctx.variables.last_utterance = '我想贷款';
  const step = await advanceSingleStep(ctx, {});
  assert.equal(step.nextNodeId, 'high');
});

test('defaultSideEffects executeIntent: reuses variables.intent_score', async () => {
  const result = await defaultSideEffects.executeIntent!({ dimension: 'score' }, { intent_score: '0.85' });
  assert.equal(result.score, 0.85);
});
