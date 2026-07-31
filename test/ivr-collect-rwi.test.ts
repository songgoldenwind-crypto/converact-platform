import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToRwi } from '../src/agent-runtime/ivr/ivr-rwi-bridge.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

const collectGraph: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'col1',
  variables: [],
  nodes: [
    {
      id: 'col1',
      type: 'collect',
      name: 'Collect',
      position: { x: 0, y: 0 },
      data: {
        prompt: [{ playType: 'tts', text: '请输入账号' }],
        minDigits: 4,
        maxDigits: 6,
        endMode: 'hash_key',
        inputWaitSec: 7,
        timeoutSec: 20,
        maxRetries: 2,
        retryPrompt: [{ playType: 'tts', text: '请重试' }],
        storeVariable: 'account',
      },
    },
    { id: 'next', type: 'disconnect', name: 'End', position: { x: 200, y: 0 }, data: {} },
  ],
  edges: [{ id: 'e1', source: 'col1', target: 'next', sourceHandle: 'out' }],
};

test('collect_digits RWI: end_mode hash_key from node config', async () => {
  const step = await advanceSingleStep(createRuntimeContext(collectGraph));
  assert.equal(step.action.kind, 'collect_digits');
  const rwi = ivrActionToRwi(step.action, 'call-99');
  assert.equal(rwi?.command, 'gather_digits');
  assert.equal(rwi?.params.end_mode, 'hash_key');
});

test('collect_digits RWI: inputWaitSec → inter_digit_timeout_sec', async () => {
  const step = await advanceSingleStep(createRuntimeContext(collectGraph));
  const rwi = ivrActionToRwi(step.action, 'call-99');
  assert.equal(rwi?.params.inter_digit_timeout_sec, 7);
});

test('collect_digits RWI: timeoutSec and maxRetries mapped', async () => {
  const step = await advanceSingleStep(createRuntimeContext(collectGraph));
  const rwi = ivrActionToRwi(step.action, 'call-99');
  assert.equal(rwi?.params.timeout_sec, 20);
  assert.equal(rwi?.params.max_retries, 2);
});

test('collect_digits RWI: retry_prompt resolved from retryPrompt contents', async () => {
  const step = await advanceSingleStep(createRuntimeContext(collectGraph));
  const rwi = ivrActionToRwi(step.action, 'call-99');
  assert.equal(rwi?.params.retry_prompt, '请重试');
});

test('collect_digits RWI: max_digits end_mode', async () => {
  const graph: IvrFlowGraph = {
    ...collectGraph,
    nodes: collectGraph.nodes.map((n) =>
      n.id === 'col1'
        ? { ...n, data: { ...n.data, endMode: 'max_digits' } }
        : n
    ),
  };
  const step = await advanceSingleStep(createRuntimeContext(graph));
  const rwi = ivrActionToRwi(step.action, 'call-99');
  assert.equal(rwi?.params.end_mode, 'max_digits');
});
