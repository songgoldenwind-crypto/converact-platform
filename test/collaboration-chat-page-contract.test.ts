import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildCollaborationChatClientPlanPath,
  buildCollaborationChatPath,
  buildCollaborationMessageReceiptPath,
  buildCollaborationMessageStatePath,
  buildCollaborationPresencePath,
  buildCollaborationTypingPath,
  readCollaborationChatEvent
} from '../frontend/src/pages/collaboration-chat.js';
import * as collaborationChatModule from '../frontend/src/pages/collaboration-chat.js';

test('collaboration chat helper builds session paths', () => {
  assert.equal(
    buildCollaborationChatPath('collab 1'),
    '/api/collaboration/sessions/collab%201/chat'
  );
});

test('collaboration chat helper builds receipt and realtime state paths', () => {
  assert.equal(
    buildCollaborationMessageReceiptPath('collab 1', 'message/1'),
    '/api/collaboration/sessions/collab%201/messages/message%2F1/receipts'
  );
  assert.equal(
    buildCollaborationMessageStatePath('collab 1'),
    '/api/collaboration/sessions/collab%201/message-state'
  );
  assert.equal(buildCollaborationTypingPath('c1'), '/api/collaboration/sessions/c1/typing');
  assert.equal(buildCollaborationPresencePath('c1'), '/api/collaboration/sessions/c1/presence');
});

test('collaboration chat helper builds client plan paths', () => {
  assert.equal(
    buildCollaborationChatClientPlanPath('collab 1'),
    '/api/collaboration/sessions/collab%201/chat/client-plan'
  );
});

test('collaboration chat helper filters websocket events by session', () => {
  const event = readCollaborationChatEvent(
    'collaboration.message.created',
    {
      session_id: 'collab_1',
      message: { id: 'm1', body: 'hello' },
      policy: { matched: false, events: [] }
    },
    'collab_1'
  );

  assert.equal(event?.message.body, 'hello');
  assert.equal(readCollaborationChatEvent('collaboration.message.created', { session_id: 'other' }, 'collab_1'), null);
});

test('collaboration chat page is routed and listens to websocket messages', () => {
  const app = readFileSync('frontend/src/App.tsx', 'utf8');
  const page = readFileSync('frontend/src/pages/CollaborationChatPage.tsx', 'utf8');
  assert.match(app, /CollaborationChatPage/);
  assert.match(app, /collaboration\/chat/);
  assert.match(page, /useWebSocket/);
  assert.match(page, /collaboration\.message\.created/);
});

test('collaboration chat page requests a Tinode client join plan', () => {
  const page = readFileSync('frontend/src/pages/CollaborationChatPage.tsx', 'utf8');
  assert.match(page, /buildCollaborationChatClientPlanPath/);
  assert.match(page, /apiPost<CollaborationChatClientPlan>/);
});

test('collaboration chat page uses the receive-only Tinode adapter and iveKit state APIs', () => {
  const page = readFileSync('frontend/src/pages/CollaborationChatPage.tsx', 'utf8');
  const adapter = readFileSync('frontend/src/pages/tinode-realtime.ts', 'utf8');
  assert.match(page, /new TinodeRealtimeAdapter/);
  assert.match(page, /buildCollaborationMessageReceiptPath/);
  assert.match(page, /buildCollaborationPresencePath/);
  assert.match(page, /buildCollaborationTypingPath/);
  assert.match(page, /noteTyping/);
  assert.doesNotMatch(adapter, /\bpublish\s*\(/);
  assert.doesNotMatch(adapter, /sendMessage\s*\(/);
});

test('collaboration chat helpers preserve stable client plans and find the latest readable backlog message', () => {
  const helpers = collaborationChatModule as typeof collaborationChatModule & {
    sameCollaborationChatClientPlan?: (left: unknown, right: unknown) => boolean;
    latestReadableMessageId?: (messages: unknown[], identity: string) => string;
  };
  assert.equal(typeof helpers.sameCollaborationChatClientPlan, 'function');
  assert.equal(typeof helpers.latestReadableMessageId, 'function');
  if (!helpers.sameCollaborationChatClientPlan || !helpers.latestReadableMessageId) return;
  const plan = {
    provider: 'tinode',
    provider_topic_id: 'grp-1',
    provider_user_id: 'usr-1',
    auth_token: 'token-1',
    ws_url: 'wss://chat.example.test/v0/channels',
    api_key: 'api-key'
  };
  assert.equal(helpers.sameCollaborationChatClientPlan(plan, { ...plan }), true);
  assert.equal(helpers.sameCollaborationChatClientPlan(plan, { ...plan, auth_token: 'token-2' }), false);
  assert.equal(helpers.latestReadableMessageId([
    { id: 'm1', sender_identity: 'customer', message_type: 'text', body: 'one', created_at: '1' },
    { id: 'm2', sender_identity: 'agent', message_type: 'text', body: 'mine', created_at: '2' },
    { id: 'm3', sender_identity: 'customer', message_type: 'text', body: '', deleted_at: '3', created_at: '3' },
    { id: 'm4', sender_identity: 'customer', message_type: 'text', body: 'latest', created_at: '4' }
  ], 'agent'), 'm4');
});

test('collaboration chat presence heartbeat is independent of the Tinode client plan', () => {
  const page = readFileSync('frontend/src/pages/CollaborationChatPage.tsx', 'utf8');
  assert.match(page, /if \(!sessionId\) return;\s+const reportPresence/s);
  assert.doesNotMatch(page, /if \(!clientPlan[^\n]+\n[^]*?const reportPresence/);
});

test('collaboration chat marks backlog read after the Tinode participant plan is prepared', () => {
  const page = readFileSync('frontend/src/pages/CollaborationChatPage.tsx', 'utf8');
  const planRequest = page.indexOf('apiPost<CollaborationChatClientPlan>');
  const backlogReceipt = page.indexOf('await reportReceipt', planRequest);
  assert.ok(planRequest >= 0);
  assert.ok(backlogReceipt > planRequest);
});
