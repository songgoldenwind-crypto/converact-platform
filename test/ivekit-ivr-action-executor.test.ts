import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IvrError,
  IvrPortActionExecutor,
  type IvrPendingAction
} from '../src/agent-runtime/ivekit/ivr/index.js';

test('IVR port action executor dispatches each external action family with stable idempotency', async () => {
  const calls: string[] = [];
  const executor = new IvrPortActionExecutor({
    resolve_call_id: async () => 'call-a',
    call_control: { async execute(_tenant, _call, action, key) { calls.push(`call:${action.kind}:${key}`); return { ok: true }; } },
    queue: { async enqueue(input) { calls.push(`queue:${input.queue_id}:${input.idempotency_key}`); return { queue_entry_id: 'entry-a', position: 2 }; } },
    knowledge: { async query(input) { calls.push(`knowledge:${input.profile_id}:${input.text}`); return { answer: 'Answer', citations: [], confidence: 0.9 }; } },
    realtime_ai: { async respond(input) { calls.push(`ai:${input.profile_id}:${input.text}`); return { text: 'Reply', intent: 'support', tool_calls: [] }; } },
    recording: { async execute(_tenant, _call, action, key) { calls.push(`record:${action.kind}:${key}`); return { recording_id: 'recording-a' }; } },
    media: { async execute(_tenant, _call, action, key) { calls.push(`media:${action.payload.operation}:${key}`); return { disposition: 'completed' }; } },
    webhook: { async request(input) { calls.push(`webhook:${input.url_ref}:${input.idempotency_key}`); return { status: 204, body: {} }; } }
  });

  assert.deepEqual(await executor.execute(action('flush', {})), { ok: true });
  assert.deepEqual(await executor.execute(action('queue', { queue_id: 'support', priority: 3 })),
    { queue_entry_id: 'entry-a', position: 2 });
  assert.equal((await executor.execute(action('knowledge', {
    knowledge_profile_id: 'kb', text: 'Question', language: 'zh-CN'
  }))).answer, 'Answer');
  assert.equal((await executor.execute(action('ai', {
    ai_profile_id: 'dialogue', text: 'Hello', context: { turn: 1 }
  }))).intent, 'support');
  assert.deepEqual(await executor.execute(action('record', {})), { recording_id: 'recording-a' });
  assert.deepEqual(await executor.execute(action('media', { operation: 'video_play' })), { disposition: 'completed' });
  assert.deepEqual(await executor.execute(action('webhook', {
    webhook_ref: 'crm', method: 'POST', body: { ticket: 'T-1' }, timeout_ms: 5_000
  })), { status: 204, body: {} });

  assert.equal(calls.every((call) => call.includes('action-key-a') || call.startsWith('knowledge:') || call.startsWith('ai:')), true);
});

test('IVR port action executor fails closed for missing ports and provider-exchange-only collect', async () => {
  const executor = new IvrPortActionExecutor({});
  for (const kind of ['webhook', 'knowledge', 'ai', 'media', 'queue', 'record', 'flush', 'collect'] as const) {
    await assert.rejects(() => executor.execute(action(kind, {})),
      (error: unknown) => error instanceof IvrError && error.code === 'capability_unavailable');
  }
});

function action(kind: IvrPendingAction['action_kind'], payload: Record<string, unknown>): IvrPendingAction {
  return {
    id: 'action-a', tenant_id: 'tenant-a', session_id: 'session-a', step_index: 1, node_id: 'node-a',
    action_kind: kind, state: 'processing', dispatch_mode: 'worker', idempotency_key: 'action-key-a',
    payload_hash: 'a'.repeat(64), payload, result: {}, attempt_count: 1, max_attempts: 3,
    next_attempt_at: null, lease_until: null, worker_id: 'worker-a', provider_profile_id: '',
    provider_action_id: '', error_code: '', error_message: '', trace_id: '', reconciliation_count: 0,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z', completed_at: null
  };
}
