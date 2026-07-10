import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToVideoCommand } from '../src/agent-runtime/ivr/ivr-video-bridge.js';
import { IVR_BRANCH } from '../src/agent-runtime/ivr/ivr-branch-handles.js';

function avatarGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'av1',
    variables: [],
    nodes: [
      {
        id: 'av1',
        type: 'avatar_switch',
        name: 'AV',
        position: { x: 0, y: 0 },
        data: { direction: 'voice_to_video', avatarId: 'avatar-1' },
      },
      { id: 'ok', type: 'play', name: 'Ok', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
      { id: 'no', type: 'play', name: 'No', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'no' }] } },
      { id: 'err', type: 'play', name: 'Err', position: { x: 200, y: 200 }, data: { contents: [{ playType: 'tts', text: 'err' }] } },
    ],
    edges: [
      { id: 'e1', source: 'av1', target: 'ok', sourceHandle: 'success' },
      { id: 'e2', source: 'av1', target: 'no', sourceHandle: 'declined' },
      { id: 'e3', source: 'av1', target: 'err', sourceHandle: 'error' },
    ],
  };
}

function videoGraph(skippable = true): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'v1',
    variables: [],
    nodes: [
      {
        id: 'v1',
        type: 'video_play',
        name: 'V',
        position: { x: 0, y: 0 },
        data: { sourceType: 'prerecorded', videoUrl: 'https://cdn.test/v.mp4', loop: false, skippable },
      },
      { id: 'out', type: 'play', name: 'Out', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'done' }] } },
      { id: 'skip', type: 'play', name: 'Skip', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'skip' }] } },
      { id: 'err', type: 'play', name: 'Err', position: { x: 200, y: 200 }, data: { contents: [{ playType: 'tts', text: 'err' }] } },
    ],
    edges: [
      { id: 'e1', source: 'v1', target: 'out', sourceHandle: 'out' },
      { id: 'e2', source: 'v1', target: 'skip', sourceHandle: 'skipped' },
      { id: 'e3', source: 'v1', target: 'err', sourceHandle: 'error' },
    ],
  };
}

function screenShareGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'ss1',
    variables: [],
    nodes: [
      {
        id: 'ss1',
        type: 'screen_share',
        name: 'SS',
        position: { x: 0, y: 0 },
        data: { source: 'agent', allowRemoteControl: false },
      },
      { id: 'out', type: 'play', name: 'Out', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
      { id: 'deny', type: 'play', name: 'Deny', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'no' }] } },
      { id: 'err', type: 'play', name: 'Err', position: { x: 200, y: 200 }, data: { contents: [{ playType: 'tts', text: 'err' }] } },
    ],
    edges: [
      { id: 'e1', source: 'ss1', target: 'out', sourceHandle: 'out' },
      { id: 'e2', source: 'ss1', target: 'deny', sourceHandle: 'denied' },
      { id: 'e3', source: 'ss1', target: 'err', sourceHandle: 'error' },
    ],
  };
}

test('avatar_switch: voice session → error edge', async () => {
  const step = await advanceSingleStep(createRuntimeContext(avatarGraph()), {
    mediaType: 'voice',
  });
  assert.equal(step.nextNodeId, 'err');
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.ERROR);
  assert.equal(step.context.variables.video_error, 'voice_session');
});

test('avatar_switch: video session success → success edge', async () => {
  const step = await advanceSingleStep(createRuntimeContext(avatarGraph()), {
    mediaType: 'video',
    sideEffects: { executeAvatarSwitch: async () => ({ status: 'success' }) },
  });
  assert.equal(step.nextNodeId, 'ok');
  assert.equal(step.action.kind, 'avatar_switch');
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.SUCCESS);
  const cmd = ivrActionToVideoCommand(step.action, 'call-1');
  assert.equal(cmd?.command, 'switch_avatar');
});

test('avatar_switch: declined → declined edge', async () => {
  const step = await advanceSingleStep(createRuntimeContext(avatarGraph()), {
    mediaType: 'video',
    sideEffects: { executeAvatarSwitch: async () => ({ status: 'declined' }) },
  });
  assert.equal(step.nextNodeId, 'no');
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.DECLINED);
});

test('avatar_switch: missing success edge → _branch_miss', async () => {
  const graph = avatarGraph();
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'success');
  const step = await advanceSingleStep(createRuntimeContext(graph), { mediaType: 'video' });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables._branch_miss, 'av1:success');
});

test('video_play: voice session → error', async () => {
  const step = await advanceSingleStep(createRuntimeContext(videoGraph()), { mediaType: 'voice' });
  assert.equal(step.nextNodeId, 'err');
});

test('video_play: video session enters waiting', async () => {
  const step = await advanceSingleStep(createRuntimeContext(videoGraph()), { mediaType: 'video' });
  assert.equal(step.action.kind, 'video_play');
  assert.equal(step.context.waiting?.kind, 'video');
  assert.equal(step.nextNodeId, 'v1');
  const cmd = ivrActionToVideoCommand(step.action, 'call-1');
  assert.equal(cmd?.command, 'play_video');
  assert.equal(cmd?.waitsForInput, true);
});

test('video_play: completed event → out edge', async () => {
  let ctx = createRuntimeContext(videoGraph());
  ctx = (await advanceSingleStep(ctx, { mediaType: 'video' })).context;
  const step = await advanceSingleStep(ctx, { videoEvent: { kind: 'completed' } });
  assert.equal(step.nextNodeId, 'out');
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.OUT);
});

test('video_play: skippable + # → skipped edge', async () => {
  let ctx = createRuntimeContext(videoGraph(true));
  ctx = (await advanceSingleStep(ctx, { mediaType: 'video' })).context;
  const step = await advanceSingleStep(ctx, { dtmf: '#' });
  assert.equal(step.nextNodeId, 'skip');
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.SKIPPED);
});

test('screen_share: denied event → denied edge', async () => {
  let ctx = createRuntimeContext(screenShareGraph());
  ctx = (await advanceSingleStep(ctx, { mediaType: 'video' })).context;
  const step = await advanceSingleStep(ctx, { screenShareEvent: { kind: 'denied' } });
  assert.equal(step.nextNodeId, 'deny');
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.DENIED);
});

test('screen_share: accepted → out', async () => {
  let ctx = createRuntimeContext(screenShareGraph());
  ctx = (await advanceSingleStep(ctx, { mediaType: 'video' })).context;
  const step = await advanceSingleStep(ctx, { screenShareEvent: { kind: 'accepted' } });
  assert.equal(step.nextNodeId, 'out');
});
