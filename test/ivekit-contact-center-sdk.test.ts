import assert from 'node:assert/strict';
import test from 'node:test';

import { createIveKitHttpSdk } from '../sdk/converact/src/http-sdk.js';
import { createIveKitClient } from '../sdk/converact/src/index.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

test('iveKit SDK exposes the complete Contact Center control plane', () => {
  const sdk = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example/', tenantId: 'tenant-a', apiKey: 'api-key',
    fetch: async () => new Response('{}', { status: 200 })
  });
  for (const method of [
    'getCapabilities', 'getMonitorSnapshot',
    'listSkills', 'createSkill', 'getSkill', 'updateSkill',
    'listAgents', 'createAgent', 'getAgent', 'updateAgent', 'updatePresence',
    'listAgentSkills', 'replaceAgentSkills',
    'listQueues', 'createQueue', 'getQueue', 'updateQueue',
    'listMemberships', 'upsertMembership', 'removeMembership',
    'listQueueSkillRequirements', 'replaceQueueSkillRequirements', 'listQueueEntries',
    'listCallbacks', 'requestCallback', 'getCallback', 'cancelCallback',
    'offerNext', 'actOnAssignment', 'startSupervisor', 'endSupervisor'
  ]) assert.equal(
    typeof sdk.contactCenter[method as keyof typeof sdk.contactCenter], 'function', method
  );
});

test('iveKit Contact Center client preserves paths filters bodies and idempotency', async () => {
  const calls: CapturedRequest[] = [];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(input), method: init.method || 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null
    });
    const path = new URL(String(input)).pathname;
    const body = path.endsWith('/skills') || path.endsWith('/memberships')
      ? { items: [] }
      : path.endsWith('/skill-requirements') ? { items: [] }
        : { items: [], next_cursor: null };
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  const sdk = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example/', tenantId: 'tenant-a', apiKey: 'api-key',
    userId: 'admin-a', fetch: fetchImpl
  });

  await sdk.contactCenter.getMonitorSnapshot();
  await sdk.contactCenter.createQueue({
    name: 'Support', overflow_action: 'queue', overflow_queue_id: 'queue-b'
  }, { idempotencyKey: 'queue-key-a' });
  await sdk.contactCenter.listQueueEntries('queue/a', {
    state: 'waiting', cursor: 'cursor-a', limit: 25
  });
  await sdk.contactCenter.replaceAgentSkills('agent/a', [{
    skill_id: 'support', proficiency: 80
  }]);
  await sdk.contactCenter.removeMembership('queue/a', 'agent/a');
  await sdk.contactCenter.requestCallback({
    queue_entry_id: 'entry-a', source_call_id: 'call-a',
    address: { kind: 'e164', value: '+8613800138000' }, max_attempts: 4
  }, { idempotencyKey: 'callback-key-a' });
  await sdk.contactCenter.actOnAssignment('assignment/a', 'reject', {
    agent_id: 'agent-a', reason: 'declined'
  });
  await sdk.contactCenter.startSupervisor({
    call_id: 'call-a', target_agent_id: 'agent-a', mode: 'monitor',
    authorization_ref: 'policy:42'
  }, { idempotencyKey: 'supervisor-key-a' });

  assert.match(calls[0]!.url, /contact-center\/monitor$/);
  assert.equal(calls[1]!.headers['idempotency-key'], 'queue-key-a');
  assert.equal(calls[1]!.headers['x-tenant-id'], 'tenant-a');
  assert.deepEqual(calls[1]!.body, {
    name: 'Support', overflow_action: 'queue', overflow_queue_id: 'queue-b'
  });
  assert.match(calls[2]!.url, /queues\/queue%2Fa\/entries/);
  assert.match(calls[2]!.url, /state=waiting/);
  assert.match(calls[2]!.url, /cursor=cursor-a/);
  assert.match(calls[2]!.url, /limit=25/);
  assert.deepEqual(calls[3]!.body, {
    skills: [{ skill_id: 'support', proficiency: 80 }]
  });
  assert.match(calls[4]!.url, /queues\/queue%2Fa\/memberships\/agent%2Fa$/);
  assert.equal(calls[4]!.method, 'DELETE');
  assert.equal(calls[5]!.headers['idempotency-key'], 'callback-key-a');
  assert.equal(calls[5]!.body && (calls[5]!.body as { max_attempts: number }).max_attempts, 4);
  assert.match(calls[6]!.url, /assignments\/assignment%2Fa\/reject$/);
  assert.deepEqual(calls[6]!.body, { agent_id: 'agent-a', reason: 'declined' });
  assert.equal(calls[7]!.headers['idempotency-key'], 'supervisor-key-a');
  assert.deepEqual(calls[7]!.body, {
    action: 'start', call_id: 'call-a', target_agent_id: 'agent-a',
    mode: 'monitor', authorization_ref: 'policy:42'
  });
});

test('unified iveKit client includes Contact Center alongside reusable media and remote clients', () => {
  const sdk = createIveKitClient({
    baseUrl: 'https://ivekit.example/', tenantId: 'tenant-a', accessToken: 'token-a',
    fetch: async () => new Response('{}', { status: 200 })
  });
  assert.equal(typeof sdk.contactCenter.getMonitorSnapshot, 'function');
  assert.equal(typeof sdk.voice.createOutboundCall, 'function');
  assert.equal(typeof sdk.rustdesk.startSession, 'function');
});
