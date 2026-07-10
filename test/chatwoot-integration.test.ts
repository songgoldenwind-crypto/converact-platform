import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatwootClient } from '../src/agent-runtime/call-center/chatwoot/chatwoot-client.js';
import {
  handleChatwootWebhook,
  generateAutoReply
} from '../src/agent-runtime/call-center/chatwoot/chatwoot-webhook-handler.js';
import type { ChatwootWebhookPayload } from '../src/agent-runtime/call-center/chatwoot/chatwoot-webhook-handler.js';

function makeMockClient() {
  const calls: { method: string; args: unknown[] }[] = [];
  const mock = {
    sendMessage: async (...args: unknown[]) => { calls.push({ method: 'sendMessage', args }); return { id: 1 }; },
    addLabel: async (...args: unknown[]) => { calls.push({ method: 'addLabel', args }); return {}; },
    assignConversation: async (...args: unknown[]) => { calls.push({ method: 'assignConversation', args }); return {}; },
    getConversation: async (...args: unknown[]) => { calls.push({ method: 'getConversation', args }); return {}; },
    searchContacts: async (...args: unknown[]) => { calls.push({ method: 'searchContacts', args }); return {}; }
  } as unknown as ChatwootClient;
  return { mock, calls };
}

const baseConversation = { id: 42, inbox_id: 1, contact_id: 10, status: 'open' };

test('handleChatwootWebhook processes incoming message with auto-reply', async () => {
  const { mock, calls } = makeMockClient();
  const payload: ChatwootWebhookPayload = {
    event: 'message_created',
    content: '你好，想了解一下',
    message_type: 'incoming',
    conversation: baseConversation,
    sender: { id: 10, name: 'Alice', type: 'contact' }
  };

  const result = await handleChatwootWebhook(payload, {
    chatwootClient: mock,
    tenantId: 'test-tenant'
  });

  assert.equal(result.handled, true);
  assert.equal(result.action, 'auto_reply');
  assert.ok(result.reply);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
});

test('handleChatwootWebhook labels new conversations', async () => {
  const { mock, calls } = makeMockClient();
  const payload: ChatwootWebhookPayload = {
    event: 'conversation_created',
    conversation: baseConversation
  };

  const result = await handleChatwootWebhook(payload, {
    chatwootClient: mock,
    tenantId: 'test-tenant'
  });

  assert.equal(result.handled, true);
  assert.equal(result.action, 'label_added');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'addLabel');
  assert.deepEqual(calls[0].args, [42, ['new_lead']]);
});

test('handleChatwootWebhook ignores outgoing messages', async () => {
  const { mock, calls } = makeMockClient();
  const payload: ChatwootWebhookPayload = {
    event: 'message_created',
    content: 'bot reply',
    message_type: 'outgoing',
    conversation: baseConversation,
    sender: { id: 1, name: 'Bot', type: 'agent_bot' }
  };

  const result = await handleChatwootWebhook(payload, {
    chatwootClient: mock,
    tenantId: 'test-tenant'
  });

  assert.equal(result.handled, false);
  assert.equal(result.action, 'ignored');
  assert.equal(calls.length, 0);
});

test('handleChatwootWebhook detects high-intent and labels', async () => {
  const { mock, calls } = makeMockClient();
  const payload: ChatwootWebhookPayload = {
    event: 'message_created',
    content: '你们的价格怎么样？',
    message_type: 'incoming',
    conversation: baseConversation,
    sender: { id: 10, name: 'Bob', type: 'contact' }
  };

  const result = await handleChatwootWebhook(payload, {
    chatwootClient: mock,
    tenantId: 'test-tenant'
  });

  assert.equal(result.handled, true);
  assert.equal(result.action, 'assign_agent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'addLabel');
  assert.deepEqual(calls[0].args, [42, ['high_intent']]);
});

test('ChatwootClient constructs correct URLs', () => {
  const client = new ChatwootClient({
    baseUrl: 'http://chatwoot:3000/',
    apiAccessToken: 'test-token',
    accountId: 5
  });

  const url = (client as any).accountUrl();
  assert.equal(url, 'http://chatwoot:3000/api/v1/accounts/5');
});

test('generateAutoReply returns keyword-based responses', () => {
  assert.ok(generateAutoReply('价格多少').includes('定制'));
  assert.ok(generateAutoReply('我想预约一下').includes('安排'));
  assert.ok(generateAutoReply('你好').includes('感谢'));
});
