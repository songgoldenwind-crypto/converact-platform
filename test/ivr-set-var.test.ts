import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateIvrExpression } from '../src/agent-runtime/ivr/ivr-expression.js';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

test('evaluateIvrExpression: arithmetic with variables', () => {
  assert.equal(evaluateIvrExpression('{{price}} * {{qty}}', { price: '10', qty: '3' }), '30');
});

test('evaluateIvrExpression: upper function', () => {
  assert.equal(evaluateIvrExpression('upper({{name}})', { name: 'alice' }), 'ALICE');
});

test('evaluateIvrExpression: lower and len', () => {
  assert.equal(evaluateIvrExpression('lower(HELLO)', {}), 'hello');
  assert.equal(evaluateIvrExpression('len({{x}})', { x: 'abcd' }), '4');
});

test('evaluateIvrExpression: unknown function throws', () => {
  assert.throws(() => evaluateIvrExpression('evil(1)', {}), /unknown function/);
});

test('set_var expression writes computed total', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 's1',
    variables: [],
    nodes: [
      {
        id: 's1',
        type: 'set_var',
        name: 'Calc',
        position: { x: 0, y: 0 },
        data: { variableName: 'total', valueType: 'expression', value: '{{price}} * {{qty}}' },
      },
      { id: 'end', type: 'disconnect', name: 'End', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [{ id: 'e1', source: 's1', target: 'end', sourceHandle: 'out' }],
  };
  const step = await advanceSingleStep(
    createRuntimeContext(graph, { price: '12', qty: '5' })
  );
  assert.equal(step.context.variables.total, '60');
  assert.equal(step.nextNodeId, 'end');
});

test('set_var string template substitutes variables (SV-2)', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 's1',
    variables: [],
    nodes: [
      {
        id: 's1',
        type: 'set_var',
        name: 'Tpl',
        position: { x: 0, y: 0 },
        data: { variableName: 'greet', valueType: 'string', value: '{{a}}-{{b}}' },
      },
      { id: 'end', type: 'disconnect', name: 'End', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [{ id: 'e1', source: 's1', target: 'end', sourceHandle: 'out' }],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph, { a: 'hi', b: 'there' }));
  assert.equal(step.context.variables.greet, 'hi-there');
});

test('set_var expression error writes last_error and still advances out', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 's1',
    variables: [],
    nodes: [
      {
        id: 's1',
        type: 'set_var',
        name: 'Bad',
        position: { x: 0, y: 0 },
        data: { variableName: 'x', valueType: 'expression', value: 'badfunc(1)' },
      },
      { id: 'end', type: 'disconnect', name: 'End', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [{ id: 'e1', source: 's1', target: 'end', sourceHandle: 'out' }],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph));
  assert.match(step.context.variables.last_error ?? '', /unknown function/);
  assert.equal(step.nextNodeId, 'end');
});
