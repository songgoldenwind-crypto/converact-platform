import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWebhookRequestBody } from '../src/agent-runtime/ivr/ivr-webhook-payload.js';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

test('buildWebhookRequestBody: includeVariables whitelist only', () => {
  const body = buildWebhookRequestBody(
    {
      eventType: 'ivr.entered',
      includeVariables: ['caller_phone', 'intent_score'],
      payload: { nodeId: '{{current_node}}' },
    },
    {
      caller_phone: '13800138000',
      intent_score: '0.8',
      secret_token: 'must-not-leak',
      current_node: 'menu1',
    }
  );
  assert.equal(body.event, 'ivr.entered');
  assert.deepEqual(body.variables, {
    caller_phone: '13800138000',
    intent_score: '0.8',
  });
  assert.equal((body as { secret_token?: string }).secret_token, undefined);
  assert.equal(body.nodeId, 'menu1');
});

test('webhook integration: executeWebhook uses whitelist body', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'wh1',
    variables: [],
    nodes: [
      {
        id: 'wh1',
        type: 'webhook',
        name: 'WH',
        position: { x: 0, y: 0 },
        data: {
          url: 'https://example.com/hook',
          method: 'POST',
          eventType: 'ivr.entered',
          includeVariables: ['caller_phone'],
        },
      },
      { id: 'ok', type: 'play', name: 'OK', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
    ],
    edges: [{ id: 'e1', source: 'wh1', target: 'ok', sourceHandle: 'success' }],
  };
  let capturedBody = '';
  const step = await advanceSingleStep(
    createRuntimeContext(graph, { caller_phone: '10086', other: 'x' }),
    {
      sideEffects: {
        executeWebhook: async (nodeData, variables) => {
          const body = buildWebhookRequestBody(nodeData, variables);
          capturedBody = JSON.stringify(body);
          return { success: true, statusCode: 200 };
        },
      },
    }
  );
  assert.equal(step.nextNodeId, 'ok');
  const parsed = JSON.parse(capturedBody) as { variables: Record<string, string> };
  assert.equal(parsed.variables.caller_phone, '10086');
  assert.equal(parsed.variables.other, undefined);
});
