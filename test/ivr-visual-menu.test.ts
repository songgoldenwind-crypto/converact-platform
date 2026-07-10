import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToRwi } from '../src/agent-runtime/ivr/ivr-rwi-bridge.js';
import { IVR_BRANCH } from '../src/agent-runtime/ivr/ivr-branch-handles.js';

function visualMenuGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'vm1',
    variables: [],
    nodes: [
      {
        id: 'vm1',
        type: 'visual_menu',
        name: 'VM',
        position: { x: 0, y: 0 },
        data: {
          title: '请选择',
          items: [
            { digit: '1', label: '销售' },
            { digit: '2', label: '支持' },
          ],
        },
      },
      { id: 's1', type: 'play', name: 'S1', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'sales' }] } },
      { id: 's2', type: 'play', name: 'S2', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'support' }] } },
      { id: 'inv', type: 'play', name: 'Inv', position: { x: 200, y: 200 }, data: { contents: [{ playType: 'tts', text: 'bad' }] } },
      { id: 'to', type: 'play', name: 'To', position: { x: 200, y: 300 }, data: { contents: [{ playType: 'tts', text: 'timeout' }] } },
    ],
    edges: [
      { id: 'e1', source: 'vm1', target: 's1', sourceHandle: 'digit_1' },
      { id: 'e2', source: 'vm1', target: 's2', sourceHandle: 'digit_2' },
      { id: 'e3', source: 'vm1', target: 'inv', sourceHandle: 'invalid' },
      { id: 'e4', source: 'vm1', target: 'to', sourceHandle: 'timeout' },
    ],
  };
}

test('visual_menu: presenting → visual_menu action with visual_payload', async () => {
  const step = await advanceSingleStep(createRuntimeContext(visualMenuGraph()), {});
  assert.equal(step.action.kind, 'visual_menu');
  if (step.action.kind === 'visual_menu') {
    const rwi = ivrActionToRwi(step.action, 'call-1');
    const meta = rwi?.params.metadata as { visual_payload?: { items: unknown[] } };
    assert.ok(meta?.visual_payload?.items?.length === 2);
  }
  assert.equal(step.context.interaction?.awaiting, true);
});

test('visual_menu: visualSelection routes like dtmf', async () => {
  let ctx = createRuntimeContext(visualMenuGraph());
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, { visualSelection: '2' });
  assert.equal(step.nextNodeId, 's2');
  assert.equal(step.context.variables.last_branch_handle, 'digit_2');
});

test('visual_menu: dtmf still works', async () => {
  let ctx = createRuntimeContext(visualMenuGraph());
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, { dtmf: '1' });
  assert.equal(step.nextNodeId, 's1');
});

test('visual_menu: invalid digit → invalid edge', async () => {
  let ctx = createRuntimeContext(visualMenuGraph());
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, { dtmf: '9' });
  assert.equal(step.nextNodeId, 'inv');
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.INVALID);
});

test('visual_menu: timeout → timeout edge', async () => {
  let ctx = createRuntimeContext(visualMenuGraph());
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, { timedOut: true });
  assert.equal(step.nextNodeId, 'to');
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.TIMEOUT);
});
