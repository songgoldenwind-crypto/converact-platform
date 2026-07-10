import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { validateFlowGraphDetailed } from '../src/agent-runtime/ivr/ivr-types.js';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import type { KnowledgeQaExecResult } from '../src/agent-runtime/ivr/ivr-side-effects.js';
import { routeKnowledgeQaMiss } from '../src/agent-runtime/ivr/ivr-knowledge-handler.js';

function kqGraph(overrides: Record<string, unknown> = {}): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'kq1',
    variables: [],
    nodes: [
      {
        id: 'kq1',
        type: 'knowledge_qa',
        name: 'KQ',
        position: { x: 0, y: 0 },
        data: {
          knowledgeBaseId: 'kb-1',
          maxResults: 1,
          noAnswerAction: 'continue',
          questionVariable: 'caller_question',
          answerPlayMode: 'none',
          ...overrides,
        },
      },
      { id: 'found', type: 'play', name: 'F', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
      { id: 'miss', type: 'play', name: 'M', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'no' }] } },
      { id: 'vm', type: 'voicemail', name: 'VM', position: { x: 200, y: 200 }, data: { maxDurationSec: 60 } },
    ],
    edges: [
      { id: 'e1', source: 'kq1', target: 'found', sourceHandle: 'found' },
      { id: 'e2', source: 'kq1', target: 'miss', sourceHandle: 'not_found' },
    ],
  };
}

function mockKb(result: KnowledgeQaExecResult) {
  return async () => result;
}

test('not found + continue → not_found edge', async () => {
  const step = await advanceSingleStep(createRuntimeContext(kqGraph()), {
    sideEffects: { executeKnowledgeQa: mockKb({ found: false, reason: 'no_match' }) },
  });
  assert.equal(step.nextNodeId, 'miss');
  assert.equal(step.context.variables.kb_result, 'not_found');
});

test('not found + transfer → transfer action, no not_found edge needed', async () => {
  const graph = kqGraph({ noAnswerAction: 'transfer', noAnswerTarget: 'support' });
  assert.equal(
    validateFlowGraphDetailed(graph).warnings.some((w) => w.handle === 'not_found'),
    false
  );
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: { executeKnowledgeQa: mockKb({ found: false }) },
  });
  assert.equal(step.action.kind, 'transfer');
  if (step.action.kind === 'transfer') {
    assert.equal(step.action.targetValue, 'support');
  }
  assert.equal(step.terminated, true);
});

test('not found + voicemail → terminated voicemail action', async () => {
  const graph = kqGraph({ noAnswerAction: 'voicemail' });
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: { executeKnowledgeQa: mockKb({ found: false }) },
  });
  assert.equal(step.action.kind, 'voicemail');
  assert.equal(step.terminated, true);
});

test('empty question → treated as not found', async () => {
  const step = await advanceSingleStep(createRuntimeContext(kqGraph()), {
    sideEffects: { executeKnowledgeQa: mockKb({ found: false, reason: 'empty_question' }) },
  });
  assert.equal(step.nextNodeId, 'miss');
});

test('low confidence → same as not found', async () => {
  const graph = kqGraph({ confidenceThreshold: 0.8 });
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: {
      executeKnowledgeQa: mockKb({ found: true, answer: 'x', confidence: 0.2 }),
    },
  });
  assert.equal(step.nextNodeId, 'miss');
});

test('found → found edge + kb_answer variable', async () => {
  const step = await advanceSingleStep(createRuntimeContext(kqGraph()), {
    sideEffects: {
      executeKnowledgeQa: mockKb({ found: true, answer: '答案A', confidence: 0.9, source: 'doc' }),
    },
  });
  assert.equal(step.nextNodeId, 'found');
  assert.equal(step.context.variables.kb_answer, '答案A');
  assert.equal(step.context.variables.kb_result, 'found');
  assert.equal(step.context.variables.last_branch_handle, 'found');
});

test('not found + continue records last_branch_handle', async () => {
  const step = await advanceSingleStep(createRuntimeContext(kqGraph()), {
    sideEffects: { executeKnowledgeQa: mockKb({ found: false, reason: 'no_match' }) },
  });
  assert.equal(step.context.variables.last_branch_handle, 'not_found');
});

test('missing not_found edge on continue → _branch_miss via executor', async () => {
  const graph = kqGraph();
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'not_found');
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: { executeKnowledgeQa: mockKb({ found: false }) },
  });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables._branch_miss, 'kq1:not_found');
});

test('missing found edge → _branch_miss via executor', async () => {
  const graph = kqGraph();
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'found');
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: {
      executeKnowledgeQa: mockKb({ found: true, answer: 'x', confidence: 0.9 }),
    },
  });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables._branch_miss, 'kq1:found');
});

test('found + tts → play then found + rwi maps answer text', async () => {
  const graph = kqGraph({ answerPlayMode: 'tts' });
  let ctx = createRuntimeContext(graph);
  const first = await advanceSingleStep(ctx, {
    sideEffects: {
      executeKnowledgeQa: mockKb({ found: true, answer: '播报内容', confidence: 1 }),
    },
  });
  assert.equal(first.action.kind, 'play');
  assert.equal(first.context.pendingAdvanceNodeId, 'found');
  assert.equal(first.context.variables.last_branch_handle, 'found');
  const second = await advanceSingleStep(first.context, { playCompleted: true });
  assert.equal(second.context.currentNodeId, 'found');
});

test('missing not_found edge on continue → requireEdge miss', () => {
  const graph = kqGraph();
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'not_found');
  const miss = routeKnowledgeQaMiss(graph, graph.nodes[0], {});
  assert.equal(miss.mode, 'branch');
  if (miss.mode === 'branch') {
    assert.equal(miss.nextNodeId, null);
  }
});
