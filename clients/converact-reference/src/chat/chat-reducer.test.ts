import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConveractFabricChatMessage, ConveractFabricChatPin, ConveractFabricChatReaction, ConveractFabricChatRealtimeState, ConveractFabricChatReceipt } from '@converact/sdk';
import { chatReducer, initialChatState } from './chat-reducer.js';

test('chat reducer loads, prepends without duplication, and suppresses stale requests', () => {
  let state = chatReducer(initialChatState(), { type: 'request_started', requestId: 2 });
  state = chatReducer(state, { type: 'loaded', requestId: 1, messages: [message('stale', 1)] });
  assert.deepEqual(state.messages, []);
  state = chatReducer(state, { type: 'loaded', requestId: 2, messages: [message('b', 2), message('c', 3)] });
  state = chatReducer(state, { type: 'history_prepended', requestId: 2, messages: [message('a', 1), message('b', 2)] });
  assert.deepEqual(state.messages.map((item) => item.id), ['a', 'b', 'c']);
  assert.equal(state.historyPrependCount, 1);
});

test('chat reducer handles optimistic send, retryable delivery, terminal failure, and realtime dedupe', () => {
  let state = initialChatState();
  state = chatReducer(state, { type: 'optimistic_sent', message: message('local', 5), idempotencyKey: 'key-1' });
  assert.equal(state.messages[0].client_state, 'sending');
  state = chatReducer(state, { type: 'send_failed', requestId: 0, localId: 'local', retryable: true, error: 'provider pending' });
  assert.equal(state.messages[0].client_state, 'retry_wait');
  state = chatReducer(state, { type: 'send_failed', requestId: 0, localId: 'local', retryable: false, error: 'terminal' });
  assert.equal(state.messages[0].client_state, 'failed');
  state = chatReducer(state, { type: 'converged', messages: [message('server', 6), message('server', 6)] });
  assert.deepEqual(state.messages.map((item) => item.id), ['local', 'server']);
});

test('chat reducer projects unread receipts, presence expiry, typing expiry, edits, deletes, reactions, and pins', () => {
  const now = new Date('2026-07-11T12:00:00.000Z').getTime();
  const realtime = realtimeState('agent', now);
  let state = chatReducer(initialChatState(), { type: 'loaded', requestId: 0, messages: [message('a', 1)], realtime: [realtime] });
  state = chatReducer(state, { type: 'message_state_updated', requestId: 0, unreadCount: 4 });
  assert.equal(state.unreadCount, 4);
  state = chatReducer(state, { type: 'message_edited', requestId: 0, message: { ...message('a', 1), body: 'edited', edit_version: 1 } });
  assert.equal(state.messages[0].body, 'edited');
  state = chatReducer(state, { type: 'reactions_updated', requestId: 0, messageId: 'a', reactions: [reaction('a', 'like')] });
  assert.equal(state.messages[0].reactions?.[0].emoji, 'like');
  state = chatReducer(state, { type: 'pins_updated', requestId: 0, pins: [pin('a')] });
  assert.equal(state.messages[0].pinned, true);
  state = chatReducer(state, { type: 'realtime_expired', now });
  assert.equal(state.realtime[0].presence_status, 'offline');
  assert.equal(state.realtime[0].typing, false);
  state = chatReducer(state, { type: 'message_deleted', requestId: 0, message: { ...message('a', 1), body: '', deleted_at: new Date().toISOString() } });
  assert.ok(state.messages[0].deleted_at);
});

test('chat reducer closes a session and blocks later optimistic writes', () => {
  let state = chatReducer(initialChatState(), { type: 'session_closed' });
  state = chatReducer(state, { type: 'optimistic_sent', message: message('blocked', 1), idempotencyKey: 'key' });
  assert.equal(state.closed, true);
  assert.deepEqual(state.messages, []);
  assert.equal(state.connection, 'closed');
});

test('chat reducer resets the previous session projection', () => {
  const loaded = chatReducer(initialChatState(), {
    type: 'loaded', requestId: 3, messages: [message('old-session-message', 1)], unreadCount: 2
  });
  const reset = chatReducer(loaded, { type: 'reset' } as never);
  assert.deepEqual(reset, initialChatState());
});

test('chat reducer ignores a completed mutation from a previous session generation', () => {
  let state = chatReducer(initialChatState(), { type: 'request_started', requestId: 2 });
  state = chatReducer(state, {
    type: 'send_succeeded',
    requestId: 1,
    localId: 'local-old',
    message: message('old-session-message', 1)
  } as never);
  assert.deepEqual(state.messages, []);
});

test('chat reducer projects loaded and incremental read receipts', () => {
  let state = chatReducer(initialChatState(), {
    type: 'loaded', requestId: 1, messages: [message('a', 1)], receipts: [receipt('a', 'customer-1')]
  } as never);
  assert.deepEqual(state.receipts.map((item: ConveractFabricChatReceipt) => item.identity), ['customer-1']);
  state = chatReducer(state, {
    type: 'message_state_updated', requestId: 1, unreadCount: 0, receipts: [receipt('a', 'customer-2')]
  } as never);
  assert.deepEqual(state.receipts.map((item: ConveractFabricChatReceipt) => item.identity), ['customer-1', 'customer-2']);
});

function message(id: string, order: number): ConveractFabricChatMessage {
  return {
    id,
    created_at: new Date(order * 1000).toISOString(),
    body: id,
    edit_version: 0,
    deleted_at: null,
    reactions: []
  } as unknown as ConveractFabricChatMessage;
}

function realtimeState(identity: string, now: number): ConveractFabricChatRealtimeState {
  return {
    identity,
    presence_status: 'online',
    presence_expires_at: new Date(now - 1).toISOString(),
    typing: true,
    typing_expires_at: new Date(now - 1).toISOString()
  } as ConveractFabricChatRealtimeState;
}

function reaction(messageId: string, emoji: string): ConveractFabricChatReaction {
  return { message_id: messageId, emoji, identity: 'agent' } as ConveractFabricChatReaction;
}

function pin(messageId: string): ConveractFabricChatPin {
  return { message_id: messageId } as ConveractFabricChatPin;
}

function receipt(messageId: string, identity: string): ConveractFabricChatReceipt {
  return {
    id: `${messageId}-${identity}`,
    message_id: messageId,
    identity,
    read_at: '2026-07-11T12:00:00.000Z'
  } as ConveractFabricChatReceipt;
}
