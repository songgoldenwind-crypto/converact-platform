import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startAiDialogue } from '../src/agent-runtime/ivr/ivr-ai-dialogue-bridge.js';

test('startAiDialogue: missing agentSpecId → dispatch_failed path', async () => {
  const result = await startAiDialogue({
    node: { id: 'ai1', type: 'ai_dialogue', name: 'AI', position: { x: 0, y: 0 }, data: { maxTurns: 5, timeoutSec: 30 } },
    roomName: 'room-1',
    callSessionId: 'call-1',
    tenantId: 't1',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'missing_agent_spec');
});

test('startAiDialogue: missing room → missing_room', async () => {
  const result = await startAiDialogue({
    node: {
      id: 'ai1',
      type: 'ai_dialogue',
      name: 'AI',
      position: { x: 0, y: 0 },
      data: { agentSpecId: 'spec-1', maxTurns: 5, timeoutSec: 30 },
    },
    roomName: '',
    callSessionId: 'call-1',
    tenantId: 't1',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'missing_room');
});

test('startAiDialogue: no LiveKit config → dispatch_failed', async () => {
  const result = await startAiDialogue({
    node: {
      id: 'ai1',
      type: 'ai_dialogue',
      name: 'AI',
      position: { x: 0, y: 0 },
      data: { agentSpecId: 'spec-1', maxTurns: 8, timeoutSec: 120 },
    },
    roomName: 'room-abc',
    callSessionId: 'call-1',
    tenantId: 't1',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'dispatch_failed');
});
