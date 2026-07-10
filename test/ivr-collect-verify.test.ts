import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import {
  createRuntimeContext,
  advanceSingleStep,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import {
  formatVerifyPrompt,
  validateCollectedDigits,
  handleCollectStep,
} from '../src/agent-runtime/ivr/ivr-collect-handler.js';

function buildCollectGraph(overrides: Partial<Record<string, unknown>> = {}): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'c1',
    variables: [],
    nodes: [
      {
        id: 'c1',
        type: 'collect',
        name: '收号',
        position: { x: 0, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: '请输入后四位' }],
          minDigits: 4,
          maxDigits: 4,
          endMode: 'hash_key',
          storeVariable: 'card_tail',
          verifyMode: 'digits',
          maxVerifyRetries: 2,
          maxRetries: 3,
          ...overrides,
        },
      },
      { id: 'ok', type: 'play', name: '成功', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
      { id: 'bad', type: 'play', name: '无效', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'invalid' }] } },
      { id: 'to', type: 'play', name: '超时', position: { x: 200, y: 200 }, data: { contents: [{ playType: 'tts', text: 'timeout' }] } },
      { id: 'mx', type: 'play', name: '超限', position: { x: 200, y: 300 }, data: { contents: [{ playType: 'tts', text: 'max' }] } },
    ],
    edges: [
      { id: 'e1', source: 'c1', target: 'ok', sourceHandle: 'out' },
      { id: 'e2', source: 'c1', target: 'bad', sourceHandle: 'invalid' },
      { id: 'e3', source: 'c1', target: 'to', sourceHandle: 'timeout' },
      { id: 'e4', source: 'c1', target: 'mx', sourceHandle: 'max_retries' },
    ],
  };
}

test('unit: validateCollectedDigits rejects too short', () => {
  assert.equal(validateCollectedDigits('12', { minDigits: 4, maxDigits: 4 }), 'too_short');
});

test('unit: formatVerifyPrompt digits mode spaces digits', () => {
  assert.equal(formatVerifyPrompt('1234', 'digits', '{{value}}'), '1 2 3 4');
});

test('verify: 1234 then press 1 commits variable and goes out edge', async () => {
  const graph = buildCollectGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  let step = await advanceSingleStep(ctx, { dtmf: '1234#' });
  assert.equal(step.action.kind, 'collect_verify');
  ctx = step.context;
  ctx = (await advanceSingleStep(ctx, {})).context;
  step = await advanceSingleStep(ctx, { dtmf: '1' });
  assert.equal(step.context.variables.card_tail, '1234');
  assert.equal(step.context.variables.last_branch_handle, 'out');
  assert.equal(step.nextNodeId, 'ok');
});

test('verify: press 2 re-enters collect without committing variable', async () => {
  const graph = buildCollectGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  let step = await advanceSingleStep(ctx, { dtmf: '1234#' });
  ctx = step.context;
  ctx = (await advanceSingleStep(ctx, {})).context;
  step = await advanceSingleStep(ctx, { dtmf: '2' });
  assert.equal(step.action.kind, 'collect_digits');
  assert.equal(step.context.variables.card_tail, undefined);
});

test('verify: timeout on verify phase goes timeout edge', async () => {
  const graph = buildCollectGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  let step = await advanceSingleStep(ctx, { dtmf: '1234#' });
  ctx = step.context;
  ctx = (await advanceSingleStep(ctx, {})).context;
  step = await advanceSingleStep(ctx, { timedOut: true });
  assert.equal(step.nextNodeId, 'to');
});

test('no verify: direct out edge', async () => {
  const graph = buildCollectGraph({ verifyMode: 'none' });
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, { dtmf: '1234#' });
  assert.equal(step.context.variables.card_tail, '1234');
  assert.equal(step.nextNodeId, 'ok');
});

test('invalid length goes invalid edge', async () => {
  const graph = buildCollectGraph({ verifyMode: 'none' });
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, { dtmf: '12#' });
  assert.equal(step.context.variables.last_branch_handle, 'invalid');
  assert.equal(step.nextNodeId, 'bad');
});

test('validationRegex reject goes invalid', () => {
  const graph = buildCollectGraph({ verifyMode: 'none', validationRegex: '^\\d{4}$' });
  const node = graph.nodes[0];
  const ctx = createRuntimeContext(graph);
  const r = handleCollectStep(graph, node, ctx, { dtmf: '12ab#' });
  assert.equal(r.type, 'advance');
  if (r.type === 'advance') assert.equal(r.branch, 'invalid');
});

test('max verify retries → max_retries edge', async () => {
  const graph = buildCollectGraph({ maxVerifyRetries: 1 });
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  let step = await advanceSingleStep(ctx, { dtmf: '1234#' });
  ctx = step.context;
  ctx = (await advanceSingleStep(ctx, {})).context;
  step = await advanceSingleStep(ctx, { dtmf: '2' });
  ctx = step.context;
  ctx = (await advanceSingleStep(ctx, {})).context;
  step = await advanceSingleStep(ctx, { dtmf: '1234#' });
  ctx = step.context;
  ctx = (await advanceSingleStep(ctx, {})).context;
  step = await advanceSingleStep(ctx, { dtmf: '2' });
  assert.equal(step.nextNodeId, 'mx');
});
