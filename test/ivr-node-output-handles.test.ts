import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getNodeOutputHandles, nodeAcceptsInboundEdge } from '../src/agent-runtime/ivr/ivr-node-output-handles.js';

test('menu output handles include timeout invalid max_retries and digit edges', () => {
  const handles = getNodeOutputHandles({
    type: 'menu',
    data: {
      options: [
        { digit: '1', label: 'a', routeType: 'node', routeTarget: '' },
        { digit: '2', label: 'b', routeType: 'queue', routeTarget: 'q' },
      ],
    },
  });
  assert.ok(handles.includes('timeout'));
  assert.ok(handles.includes('invalid'));
  assert.ok(handles.includes('max_retries'));
  assert.ok(handles.includes('digit_1'));
  assert.equal(handles.includes('digit_2'), false);
});

test('webhook includes timeout handle', () => {
  const handles = getNodeOutputHandles({ type: 'webhook', data: {} });
  assert.deepEqual(handles.sort(), ['fail', 'success', 'timeout'].sort());
});

test('compliance recording_consent dynamic handles', () => {
  const handles = getNodeOutputHandles({
    type: 'compliance',
    data: { complianceType: 'recording_consent' },
  });
  assert.deepEqual(handles.sort(), ['acknowledged', 'declined', 'out', 'timeout'].sort());
});

test('transfer accepts inbound and exposes out plus failure handles', () => {
  assert.equal(nodeAcceptsInboundEdge({ type: 'transfer', data: {} }), true);
  const handles = getNodeOutputHandles({ type: 'transfer', data: {} });
  assert.deepEqual(handles.sort(), ['busy', 'failed', 'no_answer', 'out'].sort());
});

test('visual_menu digit handles from items', () => {
  const handles = getNodeOutputHandles({
    type: 'visual_menu',
    data: { items: [{ digit: '3', label: 'x' }] },
  });
  assert.ok(handles.includes('digit_3'));
  assert.ok(handles.includes('timeout'));
});
