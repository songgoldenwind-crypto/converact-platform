import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  emitIvrSessionEvents,
  projectIvrSessionEvents
} from '../src/agent-runtime/ivekit/ivr/events.js';
import { IvrSessionActionCompletion } from '../src/agent-runtime/ivekit/ivr/session-action-completion.js';
import type { IvrSessionService } from '../src/agent-runtime/ivekit/ivr/session-service.js';
import type { IvrSessionResult } from '../src/agent-runtime/ivekit/ivr/session-service.js';

test('IVR session events project bounded state without context or provider payloads', async () => {
  const result = sessionResult();
  const events = projectIvrSessionEvents(result, { started: true });

  assert.deepEqual(events.map((event) => event.type), [
    'ivr.session.started', 'ivr.session.step_completed', 'ivr.session.waiting'
  ]);
  assert.deepEqual(events[2]?.data, {
    ivr_session_id: 'session-a',
    voice_call_id: 'call-a',
    flow_id: 'flow-a',
    flow_version: 3,
    state: 'waiting',
    node_id: 'webhook-a',
    step_count: 4,
    steps_appended: 2,
    revision: 5,
    action_kind: 'webhook',
    waiting_reason: 'webhook',
    termination_reason: ''
  });
  assert.doesNotMatch(JSON.stringify(events), /phone|secret|provider raw|variables/i);

  const published: string[] = [];
  await emitIvrSessionEvents(events, async (_tenantId, type) => { published.push(type); });
  assert.deepEqual(published, events.map((event) => event.type));
});

test('IVR session event projection suppresses idempotent replays', () => {
  assert.deepEqual(projectIvrSessionEvents({ ...sessionResult(), replayed: true }), []);
});

test('IVR event publication attempts later durable events after one failure', async () => {
  const events = projectIvrSessionEvents(sessionResult(), { started: true });
  const attempted: string[] = [];
  await assert.rejects(() => emitIvrSessionEvents(events, async (_tenantId, type) => {
    attempted.push(type);
    if (type === 'ivr.session.started') throw new Error('token=must-not-surface');
  }), /1 IVR session event publication/);
  assert.deepEqual(attempted, events.map((event) => event.type));
});

test('post-commit IVR event failures never turn a completed action uncertain', async (t) => {
  const messages: unknown[][] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { messages.push(values); };
  t.after(() => { console.error = original; });
  let completions = 0;
  const service = {
    async completeWorkerAction() { completions += 1; return sessionResult(); }
  } as unknown as IvrSessionService;
  const completion = new IvrSessionActionCompletion(service, {
    on_transition: async () => { throw new Error('token=must-not-be-logged'); }
  });

  await completion.complete({ action: {} as never, worker_id: 'worker-a', result: {} });
  assert.equal(completions, 1);
  assert.deepEqual(messages, [['[ivr-session-event] post-commit publish failed']]);
});

function sessionResult(): IvrSessionResult {
  return {
    session: {
      id: 'session-a', tenant_id: 'tenant-a', call_id: 'call-a', flow_id: 'flow-a',
      flow_version: 3, state: 'waiting', current_node_id: 'webhook-a',
      context: { variables: { phone: '13800138000', secret: 'never-publish' } },
      step_count: 4, revision: 5, waiting_reason: 'webhook', termination_reason: '',
      created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:01.000Z',
      completed_at: null, provider_profile_id: 'profile-a', provider_session_id: 'provider raw',
      last_event_sequence: 1, last_event_payload_hash: 'a'.repeat(64), last_action_revision: 1,
      last_action: {}, provider_metadata: { secret: 'never-publish' }, trace_id: 'trace-a'
    },
    action: { kind: 'webhook', node_id: 'webhook-a', payload: { secret: 'never-publish' } },
    replayed: false,
    steps_appended: 2
  };
}
