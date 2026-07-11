import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IveKitChatMessage, IveKitChatRealtimeState, IveKitChatSession } from '@opc/ivekit-sdk';
import { projectSessionSummary } from './session-summary.js';

test('session summary projects latest message, unread count, and live online participants', () => {
  const projected = projectSessionSummary(
    { id: 'session-1' } as IveKitChatSession,
    [{
      id: 'message-1', sender_identity: 'customer-1', message_type: 'text', body: '',
      created_at: '2026-07-11T08:00:00.000Z', deleted_at: '2026-07-11T08:01:00.000Z'
    } as IveKitChatMessage],
    [
      { identity: 'customer-1', presence_status: 'online' },
      { identity: 'agent-1', presence_status: 'offline' }
    ] as IveKitChatRealtimeState[],
    4
  );
  assert.deepEqual(projected.summary, {
    unread_count: 4,
    online_participant_count: 1,
    last_message: {
      id: 'message-1',
      body: '',
      sender_identity: 'customer-1',
      message_type: 'text',
      created_at: '2026-07-11T08:00:00.000Z',
      deleted: true
    }
  });
});
