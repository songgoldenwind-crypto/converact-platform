import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToRwi } from '../src/agent-runtime/ivr/ivr-rwi-bridge.js';
import { resolveMenuInput } from '../src/agent-runtime/ivr/ivr-menu-handler.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

afterEach(() => {
  delete process.env.IVR_SPEECH_PRODUCTION;
});

function speechMenuGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'm1',
    variables: [],
    nodes: [
      {
        id: 'm1',
        type: 'menu',
        name: 'M',
        position: { x: 0, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: '说销售或按1' }],
          options: [{ digit: '1', label: '销售', routeType: 'node', routeTarget: '' }],
          speechEnabled: true,
          speechAliases: [{ digit: '1', phrases: ['销售', '买'] }],
          timeoutSec: 5,
          maxRetries: 3,
        },
      },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: { targetType: 'queue', targetValue: 'sales' } },
      { id: 'inv', type: 'play', name: 'Inv', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'invalid' }] } },
    ],
    edges: [
      { id: 'e1', source: 'm1', target: 't1', sourceHandle: 'digit_1' },
      { id: 'e2', source: 'm1', target: 'inv', sourceHandle: 'invalid' },
      { id: 'e3', source: 'm1', target: 'inv', sourceHandle: 'timeout' },
      { id: 'e4', source: 'm1', target: 'inv', sourceHandle: 'max_retries' },
    ],
  };
}

test('speech alias maps to digit and routes like dtmf', async () => {
  let ctx = createRuntimeContext(speechMenuGraph());
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, { speechResult: '我想找销售' });
  assert.equal(step.nextNodeId, 't1');
});

test('unmatched speech → invalid edge', async () => {
  let ctx = createRuntimeContext(speechMenuGraph());
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, { speechResult: '天气' });
  assert.equal(step.nextNodeId, 'inv');
});

test('dtmf present ignores speechResult', () => {
  const node = speechMenuGraph().nodes[0];
  const r = resolveMenuInput(node, { dtmf: '1', speechResult: '天气' });
  assert.equal(r.kind, 'digit');
  if (r.kind === 'digit') assert.equal(r.digit, '1');
});

test('speech disabled → speechResult treated as none', () => {
  const node = { ...speechMenuGraph().nodes[0], data: { ...speechMenuGraph().nodes[0].data, speechEnabled: false } };
  const r = resolveMenuInput(node, { speechResult: '销售' });
  assert.equal(r.kind, 'none');
});

test('timedOut takes precedence over speech', () => {
  const node = speechMenuGraph().nodes[0];
  const r = resolveMenuInput(node, { speechResult: '销售', timedOut: true });
  assert.equal(r.kind, 'timeout');
});

test('Presenting then Consuming with speechResult (Task -1 two-phase)', async () => {
  let ctx = createRuntimeContext(speechMenuGraph());
  const presenting = await advanceSingleStep(ctx, {});
  assert.equal(presenting.context.interaction?.awaiting, true);
  const consuming = await advanceSingleStep(presenting.context, { speechResult: '销售' });
  assert.equal(consuming.context.interaction, undefined);
  assert.equal(consuming.nextNodeId, 't1');
});

test('rwi gather_speech when IVR_SPEECH_PRODUCTION=1 and speechEnabled', () => {
  process.env.IVR_SPEECH_PRODUCTION = '1';
  const rwi = ivrActionToRwi(
    {
      kind: 'menu',
      prompt: '说销售',
      options: [{ digit: '1', label: '销售' }],
      speechEnabled: true,
      speechLanguage: 'zh-CN',
      speechHints: ['销售'],
      timeoutSec: 10,
      maxRetries: 3,
      node: 'm1',
    },
    'call-1'
  );
  assert.equal(rwi?.command, 'gather_speech');
  assert.equal(rwi?.waitsForInput, true);
});

test('rwi gather_digits when speech production gate off', () => {
  const rwi = ivrActionToRwi(
    {
      kind: 'menu',
      prompt: '按1',
      options: [{ digit: '1', label: '销售' }],
      speechEnabled: true,
      node: 'm1',
    },
    'call-2'
  );
  assert.equal(rwi?.command, 'gather_digits');
});
