import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToRwi } from '../src/agent-runtime/ivr/ivr-rwi-bridge.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function sipGraph(data: Record<string, unknown>): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 's1',
    variables: [],
    nodes: [{ id: 's1', type: 'sip', name: 'SIP', position: { x: 0, y: 0 }, data }],
    edges: [],
  };
}

test('sip: substituteVars in sipUri', async () => {
  const graph = sipGraph({ sipUri: 'sip:{{agent}}@pbx.example.com' });
  const step = await advanceSingleStep(createRuntimeContext(graph, { agent: '1001' }), {});
  assert.equal(step.action.kind, 'sip');
  if (step.action.kind === 'sip') {
    assert.equal(step.action.sipUri, 'sip:1001@pbx.example.com');
  }
});

test('sip: headers variable substitution', async () => {
  const graph = sipGraph({
    sipUri: 'sip:agent@pbx.example.com',
    headers: [{ key: 'X-Customer-Id', value: '{{customer_id}}' }],
  });
  const step = await advanceSingleStep(createRuntimeContext(graph, { customer_id: 'cust-42' }), {});
  assert.equal(step.action.kind, 'sip');
  if (step.action.kind === 'sip') {
    assert.equal(step.action.headers?.['X-Customer-Id'], 'cust-42');
  }
});

test('sip: RWI transfer passes sip_headers metadata', async () => {
  const graph = sipGraph({
    sipUri: 'sip:u@domain',
    headers: [{ key: 'X-Trace', value: 'abc' }],
  });
  const step = await advanceSingleStep(createRuntimeContext(graph), {});
  assert.equal(step.terminated, true);
  const rwi = ivrActionToRwi(step.action, 'call-9');
  assert.equal(rwi?.command, 'transfer');
  assert.equal((rwi?.params as { target_type?: string }).target_type, 'sip');
  const meta = (rwi?.params as { metadata?: Record<string, unknown> }).metadata;
  assert.deepEqual(meta?.sip_headers, { 'X-Trace': 'abc' });
});
