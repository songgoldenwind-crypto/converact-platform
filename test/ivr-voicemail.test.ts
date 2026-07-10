import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToRwi } from '../src/agent-runtime/ivr/ivr-rwi-bridge.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

const originalEnv = process.env.IVR_VOICEMAIL_RECORD_AUDIO;

afterEach(() => {
  if (originalEnv === undefined) delete process.env.IVR_VOICEMAIL_RECORD_AUDIO;
  else process.env.IVR_VOICEMAIL_RECORD_AUDIO = originalEnv;
});

function vmGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'v1',
    variables: [],
    nodes: [
      {
        id: 'v1',
        type: 'voicemail',
        name: 'VM',
        position: { x: 0, y: 0 },
        data: { maxDurationSec: 120, mailboxId: 'sales-vm', playBeep: true },
      },
    ],
    edges: [],
  };
}

test('voicemail: default maps to transfer voicemail target', async () => {
  delete process.env.IVR_VOICEMAIL_RECORD_AUDIO;
  const step = await advanceSingleStep(createRuntimeContext(vmGraph()), {});
  assert.equal(step.action.kind, 'voicemail');
  assert.equal(step.terminated, true);
  const rwi = ivrActionToRwi(step.action, 'call-1');
  assert.equal(rwi?.command, 'transfer');
  assert.equal((rwi?.params as { target?: string }).target, 'sales-vm');
});

test('voicemail: IVR_VOICEMAIL_RECORD_AUDIO=1 → record_audio', async () => {
  process.env.IVR_VOICEMAIL_RECORD_AUDIO = '1';
  const step = await advanceSingleStep(createRuntimeContext(vmGraph()), {});
  const rwi = ivrActionToRwi(step.action, 'call-1');
  assert.equal(rwi?.command, 'record_audio');
  assert.equal((rwi?.params as { max_duration_sec?: number }).max_duration_sec, 120);
  assert.equal((rwi?.params as { play_beep?: boolean }).play_beep, true);
  assert.equal(rwi?.waitsForInput, true);
  assert.equal(step.terminated, false);
  assert.equal(step.context.waiting?.kind, 'record_audio');
});

test('voicemail: recordingEvent saves voicemail_id and terminates', async () => {
  process.env.IVR_VOICEMAIL_RECORD_AUDIO = '1';
  const ctx = createRuntimeContext(vmGraph());
  const first = await advanceSingleStep(ctx, {});
  assert.equal(first.terminated, false);

  const second = await advanceSingleStep(first.context, {
    recordingEvent: { recordingUrl: 'https://storage/vm.wav', durationSec: 42 },
    sideEffects: {
      executeVoicemailSave: async () => ({ voicemailId: 'vm_test_1' }),
    },
    tenantId: 'tenant-1',
    callSessionId: 'call-1',
  });
  assert.equal(second.terminated, true);
  assert.equal(second.context.variables.voicemail_id, 'vm_test_1');
  assert.equal(second.context.variables.recording_url, 'https://storage/vm.wav');
  assert.equal(second.context.variables.voicemail_duration_sec, '42');
  assert.equal(second.context.waiting, undefined);
});

test('voicemail: recordingEvent triggers notify webhook side effect', async () => {
  process.env.IVR_VOICEMAIL_RECORD_AUDIO = '1';
  const graph = vmGraph();
  graph.nodes[0].data = {
    ...graph.nodes[0].data,
    notifyWebhook: 'https://hooks.example.com/vm',
    notifyEmail: 'ops@example.com',
  };
  const first = await advanceSingleStep(createRuntimeContext(graph), {});
  let notified = false;
  const second = await advanceSingleStep(first.context, {
    recordingEvent: { recordingUrl: 'https://storage/vm.wav', durationSec: 10 },
    sideEffects: {
      executeVoicemailSave: async () => ({ voicemailId: 'vm_notify_1' }),
      executeVoicemailNotify: async (input) => {
        notified = true;
        assert.equal(input.voicemailId, 'vm_notify_1');
        assert.equal(input.notifyWebhook, 'https://hooks.example.com/vm');
        assert.equal(input.notifyEmail, 'ops@example.com');
      },
    },
    tenantId: 'tenant-1',
    callSessionId: 'call-1',
  });
  assert.equal(second.terminated, true);
  assert.equal(notified, true);
});
