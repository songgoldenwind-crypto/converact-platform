import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConveractFabricVoiceOverflowAdapter
} from '../src/agent-runtime/converact/contact-center/index.js';

test('Contact Center overflow adapter maps terminal actions to durable Voice commands', async () => {
  const observed: unknown[] = [];
  const adapter = new ConveractFabricVoiceOverflowAdapter({
    calls: {
      async enqueueAction(input) {
        observed.push(structuredClone(input));
        return { id: `command-${observed.length}` } as never;
      }
    }
  });
  assert.equal((await adapter.enqueue({
    tenant_id: 'tenant-a', call_id: 'call-a', action: 'hangup', target: '',
    idempotency_key: 'overflow:a:voice'
  })).command_id, 'command-1');
  await adapter.enqueue({
    tenant_id: 'tenant-a', call_id: 'call-b', action: 'voicemail', target: '7001',
    idempotency_key: 'overflow:b:voice'
  });
  await adapter.enqueue({
    tenant_id: 'tenant-a', call_id: 'call-c', action: 'external',
    target: 'sip:backup@example.test', idempotency_key: 'overflow:c:voice'
  });
  assert.deepEqual(observed, [
    {
      tenant_id: 'tenant-a', call_id: 'call-a', kind: 'hangup',
      payload: { reason: 'contact_center_overflow' }, actor: 'system:contact-center',
      idempotency_key: 'overflow:a:voice'
    },
    {
      tenant_id: 'tenant-a', call_id: 'call-b', kind: 'blind_transfer',
      payload: { target: '7001', overflow_action: 'voicemail' },
      actor: 'system:contact-center', idempotency_key: 'overflow:b:voice'
    },
    {
      tenant_id: 'tenant-a', call_id: 'call-c', kind: 'blind_transfer',
      payload: { target: 'sip:backup@example.test', overflow_action: 'external' },
      actor: 'system:contact-center', idempotency_key: 'overflow:c:voice'
    }
  ]);
});
