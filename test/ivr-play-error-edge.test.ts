import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import { resolvePlayContentsResult } from '../src/agent-runtime/ivr/ivr-play-resolver.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

test('resolvePlayContentsResult: missing audio file → audio_not_found', () => {
  const result = resolvePlayContentsResult(
    [{ playType: 'audio', audioFile: 'missing-id' }],
    {},
    () => null
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'audio_not_found');
});

test('resolvePlayContentsResult: empty tts_var → tts_var_empty', () => {
  const result = resolvePlayContentsResult(
    [{ playType: 'tts_var', variable: 'greeting' }],
    {}
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'tts_var_empty');
});

test('resolvePlayContentsResult: empty audio_var → audio_var_empty', () => {
  const result = resolvePlayContentsResult(
    [{ playType: 'audio_var', variable: 'prompt_url' }],
    { prompt_url: '' }
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'audio_var_empty');
});

test('play tts_var empty routes to error edge', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'p1',
    variables: [],
    nodes: [
      {
        id: 'p1',
        type: 'play',
        name: 'P',
        position: { x: 0, y: 0 },
        data: { contents: [{ playType: 'tts_var', variable: 'missing' }] },
      },
      { id: 'fallback', type: 'play', name: 'F', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'fallback' }] } },
    ],
    edges: [{ id: 'e1', source: 'p1', target: 'fallback', sourceHandle: 'error' }],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph));
  assert.equal(step.nextNodeId, 'fallback');
  assert.equal(step.context.variables.play_resolve_error, 'tts_var_empty');
});

test('play resolve error routes to error edge when present', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'p1',
    variables: [],
    nodes: [
      {
        id: 'p1',
        type: 'play',
        name: 'P',
        position: { x: 0, y: 0 },
        data: { contents: [{ playType: 'audio', audioFile: 'missing' }] },
      },
      { id: 'fallback', type: 'play', name: 'F', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'fallback' }] } },
    ],
    edges: [{ id: 'e1', source: 'p1', target: 'fallback', sourceHandle: 'error' }],
  };

  const step = await advanceSingleStep(createRuntimeContext(graph));

  assert.equal(step.nextNodeId, 'fallback');
  assert.equal(step.context.variables.play_resolve_error, 'audio_not_found');
  assert.equal(step.context.variables.last_branch_handle, 'error');
});
