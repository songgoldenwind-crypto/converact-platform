import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import { COMPLIANCE_CONSENT_BRANCH } from '../src/agent-runtime/ivr/ivr-compliance-handler.js';
import { IVR_BRANCH } from '../src/agent-runtime/ivr/ivr-branch-handles.js';
import { ivrActionToRwi } from '../src/agent-runtime/ivr/ivr-rwi-bridge.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function consentGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'c1',
    variables: [],
    nodes: [
      {
        id: 'c1',
        type: 'compliance',
        name: 'Consent',
        position: { x: 0, y: 0 },
        data: { complianceType: 'recording_consent', language: 'zh' },
      },
      { id: 'ack', type: 'play', name: 'Ack', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
      { id: 'dec', type: 'play', name: 'Dec', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'no' }] } },
      { id: 'to', type: 'play', name: 'To', position: { x: 200, y: 200 }, data: { contents: [{ playType: 'tts', text: 'timeout' }] } },
    ],
    edges: [
      { id: 'e1', source: 'c1', target: 'ack', sourceHandle: 'acknowledged' },
      { id: 'e2', source: 'c1', target: 'dec', sourceHandle: 'declined' },
      { id: 'e3', source: 'c1', target: 'to', sourceHandle: 'timeout' },
    ],
  };
}

function disclosureGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'c1',
    variables: [],
    nodes: [
      {
        id: 'c1',
        type: 'compliance',
        name: 'AI',
        position: { x: 0, y: 0 },
        data: { complianceType: 'ai_disclosure', language: 'zh' },
      },
      { id: 'next', type: 'play', name: 'Next', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'go' }] } },
    ],
    edges: [{ id: 'e1', source: 'c1', target: 'next', sourceHandle: 'out' }],
  };
}

test('recording_consent: disclosure → consent gather', async () => {
  let ctx = createRuntimeContext(consentGraph());
  const disclose = await advanceSingleStep(ctx, {});
  assert.equal(disclose.action.kind, 'compliance');
  assert.equal(disclose.context.compliancePhase, 'disclosure');

  ctx = disclose.context;
  const gather = await advanceSingleStep(ctx, { playCompleted: true });
  assert.equal(gather.action.kind, 'collect_digits');
  assert.equal(gather.context.compliancePhase, 'consent');
  assert.equal(gather.context.interaction?.kind, 'collect');
});

test('recording_consent: press 1 → acknowledged + compliance_ack', async () => {
  let ctx = createRuntimeContext(consentGraph());
  ctx = (await advanceSingleStep(ctx, {})).context;
  ctx = (await advanceSingleStep(ctx, { playCompleted: true })).context;
  const step = await advanceSingleStep(ctx, { dtmf: '1' });
  assert.equal(step.nextNodeId, 'ack');
  assert.equal(step.context.variables.compliance_ack, 'true');
  assert.equal(step.context.variables.last_branch_handle, COMPLIANCE_CONSENT_BRANCH.ACKNOWLEDGED);
});

test('recording_consent: press 2 → declined', async () => {
  let ctx = createRuntimeContext(consentGraph());
  ctx = (await advanceSingleStep(ctx, {})).context;
  ctx = (await advanceSingleStep(ctx, { playCompleted: true })).context;
  const step = await advanceSingleStep(ctx, { dtmf: '2' });
  assert.equal(step.nextNodeId, 'dec');
  assert.equal(step.context.variables.compliance_ack, 'false');
  assert.equal(step.context.variables.last_branch_handle, COMPLIANCE_CONSENT_BRANCH.DECLINED);
});

test('recording_consent: timeout → timeout edge', async () => {
  let ctx = createRuntimeContext(consentGraph());
  ctx = (await advanceSingleStep(ctx, {})).context;
  ctx = (await advanceSingleStep(ctx, { playCompleted: true })).context;
  const step = await advanceSingleStep(ctx, { timedOut: true });
  assert.equal(step.nextNodeId, 'to');
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.TIMEOUT);
});

test('recording_consent: missing acknowledged edge → _branch_miss', async () => {
  const graph = consentGraph();
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'acknowledged');
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  ctx = (await advanceSingleStep(ctx, { playCompleted: true })).context;
  const step = await advanceSingleStep(ctx, { dtmf: '1' });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables._branch_miss, 'c1:acknowledged');
});

test('ai_disclosure: playCompleted → out edge', async () => {
  let ctx = createRuntimeContext(disclosureGraph());
  const first = await advanceSingleStep(ctx, {});
  assert.equal(first.action.kind, 'compliance');
  assert.ok(first.action.kind === 'compliance' && first.action.prompt.includes('AI'));
  assert.equal(first.nextNodeId, 'c1');

  const step = await advanceSingleStep(first.context, { playCompleted: true });
  assert.equal(step.nextNodeId, 'next');
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.OUT);
});

test('rwi compliance play_audio uses resolved prompt text', async () => {
  const step = await advanceSingleStep(createRuntimeContext(disclosureGraph()), {});
  assert.equal(step.action.kind, 'compliance');
  if (step.action.kind !== 'compliance') return;
  const rwi = ivrActionToRwi(step.action, 'call-1');
  assert.ok(rwi);
  assert.equal(rwi!.command, 'play_audio');
  assert.equal(rwi!.params.prompt, step.action.prompt);
  assert.notEqual(rwi!.params.prompt, 'ai_disclosure');
});

test('resolveCompliancePrompt: custom node prompt overrides defaults', async () => {
  const graph = disclosureGraph();
  graph.nodes[0].data = {
    complianceType: 'ai_disclosure',
    language: 'zh',
    prompt: '自定义披露语',
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), {});
  assert.equal(step.action.kind, 'compliance');
  if (step.action.kind === 'compliance') {
    assert.equal(step.action.prompt, '自定义披露语');
  }
});
