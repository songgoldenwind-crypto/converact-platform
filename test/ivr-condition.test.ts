import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function conditionGraph(
  rules: Array<{ field: string; op: string; value: string }>,
  logic: 'and' | 'or' = 'and'
): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'c1',
    variables: [],
    nodes: [
      {
        id: 'c1',
        type: 'condition',
        name: 'Cond',
        position: { x: 0, y: 0 },
        data: { logic, rules },
      },
      { id: 't', type: 'play', name: 'True', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'yes' }] } },
      { id: 'f', type: 'play', name: 'False', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'no' }] } },
    ],
    edges: [
      { id: 'e1', source: 'c1', target: 't', sourceHandle: 'true' },
      { id: 'e2', source: 'c1', target: 'f', sourceHandle: 'false' },
    ],
  };
}

test('condition: all AND rules pass → true edge', async () => {
  const step = await advanceSingleStep(
    createRuntimeContext(conditionGraph([
      { field: 'vip', op: 'eq', value: '1' },
      { field: 'region', op: 'eq', value: 'east' },
    ]), { vip: '1', region: 'west' })
  );
  assert.equal(step.nextNodeId, 'f');
});

test('condition: AND both pass → true', async () => {
  const step = await advanceSingleStep(
    createRuntimeContext(conditionGraph([
      { field: 'vip', op: 'eq', value: '1' },
      { field: 'level', op: 'eq', value: 'gold' },
    ]), { vip: '1', level: 'gold' })
  );
  assert.equal(step.nextNodeId, 't');
});

test('condition: OR any pass → true', async () => {
  const step = await advanceSingleStep(
    createRuntimeContext(conditionGraph(
      [
        { field: 'vip', op: 'eq', value: '1' },
        { field: 'level', op: 'eq', value: 'gold' },
      ],
      'or'
    ), { vip: '0', level: 'gold' })
  );
  assert.equal(step.nextNodeId, 't');
});

test('condition: empty rules → false', async () => {
  const step = await advanceSingleStep(createRuntimeContext(conditionGraph([])));
  assert.equal(step.nextNodeId, 'f');
});

test('condition: in_region_group uses checker', async () => {
  const ctx = createRuntimeContext(conditionGraph([{ field: 'x', op: 'in_region_group', value: 'rg-east' }]), {
    caller_area_code: '021',
  });
  const ok = await advanceSingleStep(ctx, {
    regionGroupChecker: (groupId, area) => groupId === 'rg-east' && area === '021',
  });
  assert.equal(ok.nextNodeId, 't');
});

test('condition: matches_regex op', async () => {
  const step = await advanceSingleStep(
    createRuntimeContext(conditionGraph([{ field: 'caller_phone', op: 'matches_regex', value: '^138' }]), {
      caller_phone: '13800138000',
    })
  );
  assert.equal(step.nextNodeId, 't');

  const fail = await advanceSingleStep(
    createRuntimeContext(conditionGraph([{ field: 'caller_phone', op: 'matches_regex', value: '^138' }]), {
      caller_phone: '10086',
    })
  );
  assert.equal(fail.nextNodeId, 'f');
});

test('condition: invalid regex → false', async () => {
  const step = await advanceSingleStep(
    createRuntimeContext(conditionGraph([{ field: 'x', op: 'matches_regex', value: '[' }]), { x: 'a' })
  );
  assert.equal(step.nextNodeId, 'f');
});

test('condition: missing true edge → nextNodeId null with _branch_miss', async () => {
  const graph = conditionGraph([{ field: 'vip', op: 'eq', value: '1' }]);
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'true');
  const step = await advanceSingleStep(createRuntimeContext(graph, { vip: '1' }));
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables._branch_miss, 'c1:true');
});
