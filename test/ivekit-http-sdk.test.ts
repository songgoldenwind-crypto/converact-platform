import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import type {
  IveKitCreateMediaRoomInput,
  IveKitMediaRoomJoinInput,
  IveKitStartMediaRecordingInput
} from '../sdk/ivekit/src/media-types.js';

const legacyRoomJoinInput: IveKitMediaRoomJoinInput = { identity: 'customer-defaults' };
const legacyFlatRoomRef: IveKitCreateMediaRoomInput = {
  business_ref_type: 'service_order',
  business_ref_id: 'SO-FLAT-ROOM',
  business_ref_metadata: { source: 'legacy' }
};
const legacyFlatRecordingRef: IveKitStartMediaRecordingInput = {
  business_ref_type: 'service_order',
  business_ref_id: 'SO-FLAT-RECORDING',
  business_ref_metadata: { source: 'legacy' }
};
void legacyRoomJoinInput;
void legacyFlatRoomRef;
void legacyFlatRecordingRef;

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

test('iveKit HTTP SDK is extractable and exposes the complete Media and Chat facade', async () => {
  const sdkPath = 'src/agent-runtime/ivekit/http-sdk.ts';
  assert.equal(existsSync(sdkPath), true);
  const source = readFileSync(sdkPath, 'utf8');
  assert.doesNotMatch(source, /collaboration-store|db-pg|livekit\/index|media-http|chat-http/);
  assert.doesNotMatch(source, /\bpublish(?:Message)?\s*\(/);

  const module = await import('../src/agent-runtime/ivekit/http-sdk.js');
  const calls: FetchCall[] = [];
  const responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }> = [
    { body: { id: 'room_1', room_name: 'led-room' } },
    { body: { mode: 'webrtc', token: { token: 'join-token' } } },
    { body: [{ identity: 'agent-led' }] },
    { body: { id: 'rec_1', egress_id: 'egress_1' } },
    {
      body: new Uint8Array([1, 2, 3]),
      headers: {
        'content-type': 'video/webm',
        'content-disposition': 'attachment; filename="recording.webm"'
      }
    },
    { body: { id: 'collab_1' } },
    { body: { id: 'collab_close', status: 'closed' } },
    { body: { provider: 'tinode', provider_topic_id: 'grp_1' } },
    { body: { message: { id: 'cmsg_1' } } },
    { body: { unread_count: 0, receipts: [] } },
    { body: { state: { typing: true } } },
    { body: { message: { id: 'cmsg_1', edit_version: 1 } } },
    { body: { kind: 'image', storage_url: 's3://bucket/image.png' } },
    { body: { finding: { id: 'finding_1', review_status: 'confirmed' } } }
  ];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method || 'GET',
      headers: headersToRecord(init.headers),
      body: typeof init.body === 'string' ? init.body : null
    });
    const response = responses.shift();
    assert.ok(response);
    if (response.body instanceof Uint8Array) {
      return new Response(response.body, { status: response.status || 200, headers: response.headers });
    }
    return new Response(JSON.stringify(response.body), {
      status: response.status || 200,
      headers: { 'content-type': 'application/json', ...(response.headers || {}) }
    });
  };
  const sdk = module.createIveKitHttpSdk({
    baseUrl: 'https://opc.example.com/root/',
    apiKey: 'opc-key',
    tenantId: 'tenant-led',
    userId: 'agent-led',
    fetch: fetchImpl
  });

  for (const method of [
    'getCapabilities', 'createRoom', 'getRoom', 'closeRoom', 'createJoinPlan',
    'listParticipants', 'recoverModerationCommands', 'startRecording', 'stopRecording', 'listRecordings', 'listRecordingsPage',
    'getRecording', 'inspectRecordingObject', 'exportRecordingObject', 'cleanupRecordings'
  ]) assert.equal(typeof sdk.media[method], 'function', `missing media.${method}`);
  for (const method of [
    'getCapabilities', 'openSession', 'closeSession', 'listSessions', 'listSessionsByBusinessRef', 'bindSession',
    'createClientPlan', 'addParticipant', 'leaveParticipant', 'listMessages',
    'listMessagesPage', 'postMessage', 'getSnapshot', 'getDelivery', 'retryDelivery', 'listReceipts',
    'markReceipt', 'getMessageState', 'setTyping', 'setPresence', 'listRealtimeState',
    'editMessage', 'deleteMessage', 'listMutations', 'listReactions', 'addReaction',
    'removeReaction', 'listPins', 'pinMessage', 'unpinMessage', 'uploadAttachment',
    'uploadAttachmentWithProgress', 'downloadAttachment', 'getAttachment',
    'retryAttachment', 'listFindings', 'getFinding', 'reviewFinding', 'getQualityReview',
    'enqueueQualityReview', 'runAttachmentProcessing', 'runQualityReview'
  ]) assert.equal(typeof sdk.chat[method], 'function', `missing chat.${method}`);

  await sdk.media.createRoom({
    purpose: 'video_service',
    room_name: 'led-room',
    business_ref: { type: 'service_order', id: 'SO-1' }
  });
  await sdk.media.createJoinPlan('led-room', {
    identity: 'agent-led', role: 'agent', media: 'video', channel: 'webrtc'
  });
  await sdk.media.listParticipants('led-room', { include_left: true, limit: 25 });
  await sdk.media.startRecording('led-room', {
    business_ref: { type: 'service_order', id: 'SO-1' }, has_video: true
  });
  const exported = await sdk.media.exportRecordingObject('rec_1');
  assert.deepEqual([...exported.bytes], [1, 2, 3]);
  assert.equal(exported.filename, 'recording.webm');

  await sdk.chat.openSession({ business_ref: { type: 'service_order', id: 'SO-1' } });
  await sdk.chat.closeSession('collab_close');
  await sdk.chat.createClientPlan('collab_1', { identity: 'agent-led', role: 'agent' });
  await sdk.chat.postMessage('collab_1', { sender_identity: 'agent-led', body: 'hello' }, {
    idempotencyKey: 'led-message-1'
  });
  await sdk.chat.markReceipt('collab_1', 'cmsg_1', { status: 'read', identity: 'agent-led' });
  await sdk.chat.setTyping('collab_1', { identity: 'agent-led', typing: true });
  await sdk.chat.editMessage('collab_1', 'cmsg_1', { body: 'updated' });
  await sdk.chat.uploadAttachment('collab_1', {
    kind: 'image',
    filename: 'photo.png',
    contentType: 'image/png',
    body: new Uint8Array([9, 8, 7])
  });
  await sdk.chat.reviewFinding('collab_1', 'finding_1', {
    review_status: 'confirmed', note: 'reviewed'
  });

  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`), [
    'POST /api/ivekit/media/rooms',
    'POST /api/ivekit/media/rooms/led-room/join',
    'GET /api/ivekit/media/rooms/led-room/participants?include_left=1&limit=25',
    'POST /api/ivekit/media/rooms/led-room/recordings/start',
    'GET /api/ivekit/media/recordings/rec_1/export',
    'POST /api/ivekit/chat/sessions',
    'POST /api/ivekit/chat/sessions/collab_close/close',
    'POST /api/ivekit/chat/sessions/collab_1/client-plan',
    'POST /api/ivekit/chat/sessions/collab_1/messages',
    'POST /api/ivekit/chat/sessions/collab_1/messages/cmsg_1/receipts',
    'POST /api/ivekit/chat/sessions/collab_1/typing',
    'PATCH /api/ivekit/chat/sessions/collab_1/messages/cmsg_1',
    'POST /api/ivekit/chat/sessions/collab_1/attachments/upload?kind=image&filename=photo.png',
    'POST /api/ivekit/chat/sessions/collab_1/findings/finding_1/review'
  ]);
  for (const call of calls) {
    assert.equal(call.headers['x-api-key'], 'opc-key');
    assert.equal(call.headers['x-tenant-id'], 'tenant-led');
    assert.equal(call.headers['x-user-id'], 'agent-led');
  }
  assert.equal(calls[8]?.headers['idempotency-key'], 'led-message-1');
  assert.equal(calls[12]?.headers['content-type'], 'image/png');
});

test('iveKit HTTP SDK maps reaction and pin commands', async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const sdk = (await import('../sdk/ivekit/src/http-sdk.js')).createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example.com',
    tenantId: 'tenant-rich',
    accessToken: 'rich-token',
    fetch: async (input: string | URL, init: RequestInit = {}) => {
      calls.push({ method: init.method || 'GET', url: String(input) });
      return Response.json({ reactions: [], counts: {}, pins: [] });
    }
  });
  await sdk.chat.addReaction('session/1', 'message/1', 'thumbs up');
  await sdk.chat.removeReaction('session/1', 'message/1', 'thumbs up');
  await sdk.chat.listReactions('session/1', 'message/1');
  await sdk.chat.pinMessage('session/1', 'message/1');
  await sdk.chat.unpinMessage('session/1', 'message/1');
  await sdk.chat.listPins('session/1');

  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    'PUT /api/ivekit/chat/sessions/session%2F1/messages/message%2F1/reactions/thumbs%20up',
    'DELETE /api/ivekit/chat/sessions/session%2F1/messages/message%2F1/reactions/thumbs%20up',
    'GET /api/ivekit/chat/sessions/session%2F1/messages/message%2F1/reactions',
    'PUT /api/ivekit/chat/sessions/session%2F1/pins/message%2F1',
    'DELETE /api/ivekit/chat/sessions/session%2F1/pins/message%2F1',
    'GET /api/ivekit/chat/sessions/session%2F1/pins'
  ]);
});

test('iveKit media SDK maps durable call and moderation commands', async () => {
  const calls: FetchCall[] = [];
  const sdk = (await import('../sdk/ivekit/src/http-sdk.js')).createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example.com',
    tenantId: 'tenant-media-sdk',
    accessToken: 'media-access-token',
    fetch: async (input: string | URL, init: RequestInit = {}) => {
      calls.push({
        url: String(input),
        method: init.method || 'GET',
        headers: headersToRecord(init.headers),
        body: typeof init.body === 'string' ? init.body : null
      });
      return Response.json({});
    }
  });

  await sdk.media.createCall({
    media: 'video',
    participant_identities: ['customer-led'],
    business_ref: { type: 'service_order', id: 'SO-MEDIA-1' }
  });
  await sdk.media.getCall('call/1');
  await sdk.media.transitionCall('call/1', { action: 'accept' }, {
    idempotencyKey: 'call-action-1'
  });
  await sdk.media.createCallJoinPlan('call/1', {
    identity: 'engineer-led'
  });
  await sdk.media.listCallParticipants('call/1');
  await sdk.media.muteParticipant('room/1', 'customer/1', {
    track_sid: 'TR_audio_1',
    source: 'microphone',
    muted: true
  }, {
    idempotencyKey: 'mute-action-1'
  });
  await sdk.media.removeParticipant('room/1', 'customer/1', { reason: 'host_removed' }, {
    idempotencyKey: 'remove-action-1'
  });
  await sdk.media.recoverModerationCommands({ limit: 12 });

  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    'POST /api/ivekit/media/calls',
    'GET /api/ivekit/media/calls/call%2F1',
    'POST /api/ivekit/media/calls/call%2F1/actions',
    'POST /api/ivekit/media/calls/call%2F1/join',
    'GET /api/ivekit/media/calls/call%2F1/participants',
    'POST /api/ivekit/media/rooms/room%2F1/participants/customer%2F1/mute',
    'POST /api/ivekit/media/rooms/room%2F1/participants/customer%2F1/remove',
    'POST /api/ivekit/media/moderation/recover'
  ]);
  assert.deepEqual(calls.map((call) => call.body && JSON.parse(call.body)), [
    {
      media: 'video',
      participant_identities: ['customer-led'],
      business_ref: { type: 'service_order', id: 'SO-MEDIA-1' }
    },
    null,
    { action: 'accept' },
    { identity: 'engineer-led' },
    null,
    { track_sid: 'TR_audio_1', source: 'microphone', muted: true },
    { reason: 'host_removed' },
    { limit: 12 }
  ]);
  assert.equal(calls[2]?.headers['idempotency-key'], 'call-action-1');
  assert.equal(calls[5]?.headers['idempotency-key'], 'mute-action-1');
  assert.equal(calls[6]?.headers['idempotency-key'], 'remove-action-1');
});

test('iveKit HTTP SDK exposes cursor session and message history requests', async () => {
  const calls: string[] = [];
  const sdk = (await import('../sdk/ivekit/src/http-sdk.js')).createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example.com',
    tenantId: 'tenant-page',
    accessToken: 'page-token',
    fetch: async (input: string | URL) => {
      calls.push(String(input));
      return Response.json({ items: [], next_cursor: null, has_more: false });
    }
  });

  await sdk.chat.listSessions({
    status: 'open',
    business_ref_type: 'service_order',
    query: 'led',
    cursor: 'session-cursor',
    limit: 25
  });
  await sdk.chat.listMessagesPage('collab-1', {
    direction: 'after',
    query: 'needle',
    cursor: 'message-cursor',
    limit: 40
  });

  assert.equal(
    new URL(calls[0]).pathname + new URL(calls[0]).search,
    '/api/ivekit/chat/sessions?status=open&business_ref_type=service_order&query=led&cursor=session-cursor&limit=25'
  );
  assert.equal(
    new URL(calls[1]).pathname + new URL(calls[1]).search,
    '/api/ivekit/chat/sessions/collab-1/messages?direction=after&query=needle&cursor=message-cursor&limit=40'
  );
});

test('iveKit HTTP SDK keeps Bearer identity authoritative and exposes structured errors', async () => {
  const sdkPath = 'src/agent-runtime/ivekit/http-sdk.ts';
  assert.equal(existsSync(sdkPath), true);
  const module = await import('../src/agent-runtime/ivekit/http-sdk.js');
  let requestHeaders: Record<string, string> = {};
  const sdk = module.createIveKitHttpSdk({
    baseUrl: 'https://opc.example.com',
    accessToken: 'jwt-token',
    tenantId: 'tenant-led',
    userId: 'spoofed-header-user',
    fetch: async (_input: string | URL, init: RequestInit = {}) => {
      requestHeaders = headersToRecord(init.headers);
      return new Response(JSON.stringify({ error: 'active participant required' }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await assert.rejects(
    () => sdk.chat.getMessageState('collab_1'),
    (error: unknown) => {
      assert.equal(error instanceof module.IveKitHttpSdkError, true);
      const httpError = error as { status: number; method: string; path: string; payload: unknown };
      assert.equal(httpError.status, 403);
      assert.equal(httpError.method, 'GET');
      assert.equal(httpError.path, '/api/ivekit/chat/sessions/collab_1/message-state');
      return true;
    }
  );
  assert.equal(requestHeaders.authorization, 'Bearer jwt-token');
  assert.equal(requestHeaders['x-user-id'], undefined);
  assert.equal(requestHeaders['x-api-key'], undefined);

  assert.throws(
    () => module.createIveKitHttpSdk({ baseUrl: 'file:///tmp/opc', apiKey: 'k', tenantId: 't' }),
    /baseUrl must use http\(s\)/
  );
  assert.throws(
    () => module.createIveKitHttpSdk({ baseUrl: 'https://opc.example.com', tenantId: 't' }),
    /exactly one of apiKey or accessToken is required/
  );
  assert.throws(
    () => module.createIveKitHttpSdk({
      baseUrl: 'https://opc.example.com', apiKey: 'k', accessToken: 'jwt', tenantId: 't'
    }),
    /exactly one of apiKey or accessToken is required/
  );
});

test('iveKit SDK exports named browser-safe chat DTOs', () => {
  const typesPath = 'sdk/ivekit/src/chat-types.ts';
  assert.equal(existsSync(typesPath), true);
  const types = readFileSync(typesPath, 'utf8');
  const sdk = readFileSync('sdk/ivekit/src/http-sdk.ts', 'utf8');
  const chatInterface = sdk.match(/export interface IveKitChatHttpClient \{([\s\S]*?)\n\}/)?.[1] || '';

  for (const name of [
    'IveKitChatSession',
    'IveKitChatParticipant',
    'IveKitChatMessage',
    'IveKitChatAttachment',
    'IveKitChatDelivery',
    'IveKitChatReceipt',
    'IveKitChatRealtimeState',
    'IveKitPolicyFinding',
    'IveKitChatReaction',
    'IveKitChatPin',
    'IveKitCursorPage'
  ]) assert.match(types, new RegExp(`export interface ${name}`));

  assert.match(sdk, /from '\.\/chat-types\.js'/);
  assert.doesNotMatch(chatInterface, /Promise<Record<string, unknown>>/);
  assert.doesNotMatch(types, /agent-runtime|db-pg|node:/);
});

test('iveKit SDK exports named browser-safe media DTOs without untyped returns', () => {
  const typesPath = 'sdk/ivekit/src/media-types.ts';
  assert.equal(existsSync(typesPath), true);
  const types = readFileSync(typesPath, 'utf8');
  const sharedTypes = readFileSync('sdk/ivekit/src/types.ts', 'utf8');
  const sdk = readFileSync('sdk/ivekit/src/http-sdk.ts', 'utf8');
  const entrypoint = readFileSync('sdk/ivekit/src/index.ts', 'utf8');
  const mediaInterface = sdk.match(/export interface IveKitMediaHttpClient \{([\s\S]*?)\n\}/)?.[1] || '';
  const callJoinInterface = types.match(/export interface IveKitMediaJoinInput \{([\s\S]*?)\n\}/)?.[1] || '';

  for (const name of [
    'IveKitMediaCapabilities',
    'IveKitMediaCall',
    'IveKitMediaCallParticipant',
    'IveKitMediaCallSnapshot',
    'IveKitMediaRoom',
    'IveKitMediaJoinPlan',
    'IveKitMediaProviderParticipant',
    'IveKitMediaModerationResult',
    'IveKitMediaModerationRecoveryResult',
    'IveKitMediaRecording',
    'IveKitMediaRecordingObjectInspection',
    'IveKitMediaCursorPage'
  ]) assert.match(types, new RegExp(`export (?:interface|type) ${name}`));

  assert.match(sharedTypes, /export interface IveKitSdkBusinessRef/);
  assert.doesNotMatch(sdk, /export interface IveKitSdkBusinessRef/);
  assert.match(sdk, /from '\.\/media-types\.js'/);
  assert.match(entrypoint, /export type \* from '\.\/media-types\.js'/);
  assert.doesNotMatch(mediaInterface, /Promise<Record<string, unknown>>/);
  assert.doesNotMatch(mediaInterface, /Promise<Record<string, unknown>\[\]>/);
  assert.match(
    mediaInterface,
    /transitionCall\([\s\S]*?options: \{ idempotencyKey: string \}/
  );
  assert.match(mediaInterface, /muteParticipant\([\s\S]*?options: \{ idempotencyKey: string \}/);
  assert.match(mediaInterface, /removeParticipant\([\s\S]*?options: \{ idempotencyKey: string \}/);
  assert.doesNotMatch(callJoinInterface, /role:/);
  assert.doesNotMatch(types, /agent-runtime|db-pg|node:/);
});

test('iveKit LED handoff artifacts cover SDK, extraction, deployment, and validation boundaries', () => {
  const guidePath = 'docs/ivekit-led-integration-guide.md';
  const apiPath = 'docs/ivekit-openapi.md';
  const examplePath = 'scripts/ivekit-led-integration-example.ts';
  assert.equal(existsSync(guidePath), true);
  assert.equal(existsSync(apiPath), true);
  assert.equal(existsSync(examplePath), true);

  const guide = readFileSync(guidePath, 'utf8');
  const api = readFileSync(apiPath, 'utf8');
  const example = readFileSync(examplePath, 'utf8');
  const pkg = readFileSync('package.json', 'utf8');
  for (const marker of [
    'Media Core', 'Collaboration Session', 'Remote Assistance', 'PostgreSQL',
    'RLS', 'LED', 'OPC', '真实环境', '030_collaboration_message_state.sql'
  ]) assert.match(guide, new RegExp(marker));
  for (const marker of [
    '/api/ivekit/media', '/api/ivekit/chat', '/api/ivekit/rustdesk',
    'Idempotency-Key', 'collaboration.message.receipt_updated', 'JRP', 'direct_client_publish=false'
  ]) assert.match(api, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(example, /createIveKitHttpSdk/);
  assert.match(example, /createIveKitRustDeskLedSdk/);
  assert.match(example, /postMessage/);
  assert.match(example, /createJoinPlan/);
  assert.match(pkg, /"ivekit:led-example"/);
});

test('iveKit HTTP SDK exposes the unified business context endpoint', async () => {
  const calls: FetchCall[] = [];
  const sdk = (await import('../sdk/ivekit/src/http-sdk.js')).createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example.com/',
    tenantId: 'tenant-led',
    accessToken: 'user-token',
    fetch: async (input, init = {}) => {
      calls.push({
        url: String(input),
        method: init.method || 'GET',
        headers: headersToRecord(init.headers),
        body: typeof init.body === 'string' ? init.body : null
      });
      return new Response(JSON.stringify({
        tenant_id: 'tenant-led',
        business_ref: { type: 'service_order', id: 'SO-1' },
        viewer: { identity: 'agent-led', system: false },
        capabilities: { chat: true, media: true, remote_assistance: false },
        chat: { count: 0, sessions: [] },
        media: { count: 0, calls: [] },
        remote_assistance: { count: 0, sessions: [], devices: [] }
      }), { headers: { 'content-type': 'application/json' } });
    }
  });

  assert.equal(typeof sdk.context.getByBusinessRef, 'function');
  const context = await sdk.context.getByBusinessRef({ type: 'service_order', id: 'SO-1' });
  assert.equal(context.business_ref.id, 'SO-1');
  await sdk.context.listTimeline(
    { type: 'service_order', id: 'SO-1' },
    { cursor: 'opaque-cursor', limit: 25 }
  );
  assert.equal(calls.length, 2);
  const request = new URL(calls[0].url);
  assert.equal(calls[0].method, 'GET');
  assert.equal(request.pathname, '/api/ivekit/context/by-ref');
  assert.equal(request.searchParams.get('business_ref_type'), 'service_order');
  assert.equal(request.searchParams.get('business_ref_id'), 'SO-1');
  assert.equal(calls[0].headers.authorization, 'Bearer user-token');
  const timelineRequest = new URL(calls[1].url);
  assert.equal(timelineRequest.pathname, '/api/ivekit/context/timeline');
  assert.equal(timelineRequest.searchParams.get('business_ref_type'), 'service_order');
  assert.equal(timelineRequest.searchParams.get('business_ref_id'), 'SO-1');
  assert.equal(timelineRequest.searchParams.get('cursor'), 'opaque-cursor');
  assert.equal(timelineRequest.searchParams.get('limit'), '25');
});

function headersToRecord(headers: RequestInit['headers']): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}
