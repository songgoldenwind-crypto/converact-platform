import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import { WebSocketServer, type WebSocket } from 'ws';

type Json = Record<string, unknown>;

export interface ControlledChatServer {
  baseUrl: string;
  eventsUrl: string;
  state: ControlledChatState;
  injectTinodeOnlyMessage(body: string): void;
  releasePendingUploads(): void;
  close(): Promise<void>;
}

export interface ControlledChatState {
  messages: Json[];
  receipts: Json[];
  pins: Json[];
  findings: Json[];
  reviews: Json[];
  realtime: Map<string, Json>;
  uploadCalls: number;
  tinodeConnections: number;
  tinodeActiveConnections: number;
  tinodePublishAttempts: number;
  tinodeAuthenticatedConnections: number;
  tinodeApiKeyConnections: number;
  tinodeSubscriptions: number;
  tinodeProtocolRejections: number;
  tinodeDataPacketsSent: number;
  ivekitEventsSent: number;
  ivekitMessageCreatedEvents: number;
  sessionClosed: boolean;
}

const SESSION_ID = 'session-e2e';
const TENANT_ID = 'tenant-e2e';
const TOPIC_ID = 'grpIveKitE2E';
const NOW = '2026-07-11T08:00:00.000Z';

export async function startControlledChatServer(): Promise<ControlledChatServer> {
  const events = new Set<WebSocket>();
  const tinode = new Set<WebSocket>();
  const authenticatedTinode = new Set<WebSocket>();
  const subscribedTinode = new Set<WebSocket>();
  const uploadWaiters = new Set<() => void>();
  let uploadsBlocked = true;
  let sequence = 1;
  const state: ControlledChatState = {
    messages: [message({ id: 'message-initial', sender: 'customer-1', body: 'My display still shows the old campaign.', createdAt: NOW })],
    receipts: [],
    pins: [],
    findings: [finding()],
    reviews: [],
    realtime: new Map(),
    uploadCalls: 0,
    tinodeConnections: 0,
    tinodeActiveConnections: 0,
    tinodePublishAttempts: 0,
    tinodeAuthenticatedConnections: 0,
    tinodeApiKeyConnections: 0,
    tinodeSubscriptions: 0,
    tinodeProtocolRejections: 0,
    tinodeDataPacketsSent: 0,
    ivekitEventsSent: 0,
    ivekitMessageCreatedEvents: 0,
    sessionClosed: false
  };

  const server = createServer((request, response) => {
    void routeRequest(request, response, state, broadcast, waitForUploadRelease);
  });
  const eventWss = new WebSocketServer({ noServer: true });
  const tinodeWss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const path = url.pathname;
    const target = path === '/events' ? eventWss : path === '/v0/channels' ? tinodeWss : null;
    if (!target) {
      socket.destroy();
      return;
    }
    if (target === tinodeWss) {
      if (url.searchParams.get('apikey') !== 'tinode-e2e-key') {
        state.tinodeProtocolRejections += 1;
        socket.destroy();
        return;
      }
      state.tinodeApiKeyConnections += 1;
    }
    target.handleUpgrade(request, socket, head, (client) => target.emit('connection', client, request));
  });
  eventWss.on('connection', (socket) => {
    events.add(socket);
    socket.on('close', () => events.delete(socket));
  });
  tinodeWss.on('connection', (socket) => {
    state.tinodeConnections += 1;
    state.tinodeActiveConnections += 1;
    tinode.add(socket);
    socket.on('close', () => {
      tinode.delete(socket);
      authenticatedTinode.delete(socket);
      subscribedTinode.delete(socket);
      state.tinodeActiveConnections = Math.max(0, state.tinodeActiveConnections - 1);
    });
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw)) as Json;
      if (packet.hi) replyTinode(socket, packet.hi as Json, { ver: '0.25' });
      else if (packet.login) {
        const login = packet.login as Json;
        const valid = login.scheme === 'token' && ['tinode-token-agent-1', 'tinode-token-customer-1'].includes(String(login.secret || ''));
        if (!valid) {
          state.tinodeProtocolRejections += 1;
          replyTinode(socket, login, {}, undefined, 401, 'invalid token');
        } else {
          authenticatedTinode.add(socket);
          state.tinodeAuthenticatedConnections += 1;
          replyTinode(socket, login, { user: 'usrE2E' });
        }
      }
      else if (packet.sub) {
        const sub = packet.sub as Json;
        const topic = String(sub.topic || '');
        if (!authenticatedTinode.has(socket) || topic !== TOPIC_ID) {
          state.tinodeProtocolRejections += 1;
          replyTinode(socket, sub, {}, topic, 403, 'invalid subscription');
        } else {
          subscribedTinode.add(socket);
          state.tinodeSubscriptions += 1;
          replyTinode(socket, sub, {}, topic);
        }
      }
      else if (packet.leave) {
        subscribedTinode.delete(socket);
        replyTinode(socket, packet.leave as Json, {}, String((packet.leave as Json).topic || TOPIC_ID));
      }
      else if (packet.pub) {
        state.tinodePublishAttempts += 1;
        replyTinode(socket, packet.pub as Json, {}, String((packet.pub as Json).topic || ''), 403, 'receive only');
      }
      else if (packet.note) return;
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('controlled chat server failed to bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  function broadcast(type: string, data: Json) {
    const envelope = JSON.stringify({ type, data: { session_id: SESSION_ID, ...data } });
    state.ivekitEventsSent += 1;
    if (type === 'collaboration.message.created') state.ivekitMessageCreatedEvents += 1;
    for (const socket of events) if (socket.readyState === socket.OPEN) socket.send(envelope);
    broadcastTinode();
  }

  function broadcastTinode() {
    const tinodePacket = JSON.stringify({
      data: { topic: TOPIC_ID, from: 'usrE2E', seq: sequence++, ts: new Date().toISOString(), content: {} }
    });
    for (const socket of subscribedTinode) {
      if (socket.readyState !== socket.OPEN) continue;
      socket.send(tinodePacket);
      state.tinodeDataPacketsSent += 1;
    }
  }

  function waitForUploadRelease(): Promise<void> {
    if (!uploadsBlocked) return Promise.resolve();
    return new Promise((resolve) => uploadWaiters.add(resolve));
  }

  function releasePendingUploads() {
    uploadsBlocked = false;
    for (const resolve of uploadWaiters) resolve();
    uploadWaiters.clear();
  }

  return {
    baseUrl,
    eventsUrl: `${baseUrl.replace(/^http/, 'ws')}/events`,
    state,
    injectTinodeOnlyMessage: (body) => {
      const createdAt = new Date(Date.parse(NOW) + state.messages.length * 60_000).toISOString();
      state.messages.push(message({
        id: `message-${state.messages.length + 1}`,
        sender: 'customer-1',
        body,
        createdAt
      }));
      broadcastTinode();
    },
    releasePendingUploads,
    close: async () => {
      releasePendingUploads();
      for (const socket of [...events, ...tinode]) socket.close();
      await Promise.all([
        new Promise<void>((resolve) => eventWss.close(() => resolve())),
        new Promise<void>((resolve) => tinodeWss.close(() => resolve()))
      ]);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: ControlledChatState,
  broadcast: (type: string, data: Json) => void,
  waitForUploadRelease: () => Promise<void>
) {
  setCors(request, response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  const url = new URL(request.url || '/', 'http://localhost');
  const path = url.pathname;
  const method = request.method || 'GET';
  const identity = identityFor(request);
  const body = await readBody(request);
  const input = jsonBody(body);
  const session = sessionDto(state, identity);

  if (method === 'GET' && path === '/api/ivekit/context/by-ref') {
    const participantRows = participants();
    const viewer = participantRows.find((participant) => participant.identity === identity);
    return json(response, 200, {
      tenant_id: TENANT_ID,
      business_ref: { type: 'service_order', id: 'LED-E2E-1' },
      viewer: { identity, system: false },
      capabilities: { chat: true, media: false, remote_assistance: false },
      chat: { count: 1, sessions: [{
        id: SESSION_ID, title: 'LED display support', status: state.sessionClosed ? 'closed' : 'open',
        created_at: NOW, updated_at: new Date().toISOString(), closed_at: null
      }] },
      media: { count: 0, calls: [] },
      remote_assistance: { count: 0, sessions: [], devices: [] },
      authorization: {
        chat: [{
          session_id: SESSION_ID, viewer_role: viewer?.role || null,
          participants: participantRows.map((participant) => ({
            identity: participant.identity, display_name: participant.display_name,
            role: participant.role, status: participant.left_at ? 'left' : 'active'
          }))
        }],
        media: [], remote_assistance: []
      }
    });
  }

  if (method === 'GET' && path === '/api/ivekit/chat/sessions') {
    return json(response, 200, { items: [session], next_cursor: null, has_more: false });
  }
  if (method === 'GET' && path === `/api/ivekit/chat/sessions/${SESSION_ID}/snapshot`) {
    return json(response, 200, {
      session,
      binding: { id: 'binding-e2e', tenant_id: TENANT_ID, session_id: SESSION_ID, provider: 'tinode', provider_topic_id: TOPIC_ID, provider_status: 'active', metadata: {}, created_at: NOW, updated_at: NOW },
      participants: participants(),
      messages: state.messages,
      policy_events: [],
      policy_findings: state.findings
    });
  }
  if (method === 'GET' && path === `/api/ivekit/chat/sessions/${SESSION_ID}/messages`) {
    const direction = url.searchParams.get('direction') || 'before';
    if (direction === 'after') {
      const start = cursorIndex(url.searchParams.get('cursor'));
      return json(response, 200, {
        items: state.messages.slice(start),
        next_cursor: `after:${state.messages.length}`,
        has_more: false
      });
    }
    return json(response, 200, { items: state.messages, next_cursor: null, has_more: false });
  }
  if (method === 'GET' && path === `/api/ivekit/chat/sessions/${SESSION_ID}/realtime-state`) {
    return json(response, 200, { session_id: SESSION_ID, states: [...state.realtime.values()] });
  }
  if (method === 'GET' && path === `/api/ivekit/chat/sessions/${SESSION_ID}/message-state`) {
    return json(response, 200, {
      session_id: SESSION_ID,
      identity,
      unread_count: unreadCount(state, identity),
      receipts: state.receipts
    });
  }
  if (method === 'GET' && path === `/api/ivekit/chat/sessions/${SESSION_ID}/pins`) {
    return json(response, 200, { session_id: SESSION_ID, pins: state.pins });
  }
  if (method === 'GET' && path === `/api/ivekit/chat/sessions/${SESSION_ID}/findings`) {
    return json(response, 200, { session_id: SESSION_ID, findings: state.findings });
  }
  const findingMatch = path.match(new RegExp(`^/api/ivekit/chat/sessions/${SESSION_ID}/findings/([^/]+)$`));
  if (method === 'GET' && findingMatch) {
    const finding = state.findings.find((item) => item.id === decodeURIComponent(findingMatch[1]));
    return finding
      ? json(response, 200, { session_id: SESSION_ID, finding, reviews: state.reviews })
      : json(response, 404, { error: 'finding not found' });
  }
  const reviewMatch = path.match(new RegExp(`^/api/ivekit/chat/sessions/${SESSION_ID}/findings/([^/]+)/review$`));
  if (method === 'POST' && reviewMatch) {
    const finding = state.findings.find((item) => item.id === decodeURIComponent(reviewMatch[1]));
    if (!finding) return json(response, 404, { error: 'finding not found' });
    const previous = String(finding.review_status);
    finding.review_status = String(input.review_status);
    finding.reviewed_by = identity;
    finding.review_note = String(input.note || '');
    finding.reviewed_at = new Date().toISOString();
    finding.updated_at = finding.reviewed_at;
    const review = {
      id: `review-${state.reviews.length + 1}`, tenant_id: TENANT_ID, finding_id: finding.id,
      from_status: previous, to_status: finding.review_status, reviewed_by: identity,
      note: finding.review_note, note_hash: 'redacted', metadata: {}, created_at: finding.reviewed_at
    };
    state.reviews.push(review);
    broadcast('collaboration.policy.finding_reviewed', { finding, review });
    return json(response, 201, { session_id: SESSION_ID, finding, review });
  }
  if (method === 'POST' && path === `/api/ivekit/chat/sessions/${SESSION_ID}/client-plan`) {
    return json(response, 200, {
      provider: 'tinode', provider_topic_id: TOPIC_ID, provider_user_id: `usr-${identity}`,
      auth_token: `tinode-token-${identity}`, ws_url: `ws://${request.headers.host}/v0/channels`,
      api_key: 'tinode-e2e-key', participant: participants().find((item) => item.identity === identity)
    });
  }
  if (method === 'POST' && path === `/api/ivekit/chat/sessions/${SESSION_ID}/presence`) {
    state.realtime.set(identity, realtimeState(identity, String(input.status || 'online'), false));
    broadcast('collaboration.presence.updated', { identity });
    return json(response, 201, { session_id: SESSION_ID, state: state.realtime.get(identity) });
  }
  if (method === 'POST' && path === `/api/ivekit/chat/sessions/${SESSION_ID}/typing`) {
    const current = state.realtime.get(identity) || realtimeState(identity, 'online', false);
    state.realtime.set(identity, { ...current, typing: input.typing === true, typing_expires_at: input.typing === true ? future(8_000) : null });
    broadcast('collaboration.typing.updated', { identity });
    return json(response, 201, { session_id: SESSION_ID, state: state.realtime.get(identity) });
  }
  if (method === 'POST' && path === `/api/ivekit/chat/sessions/${SESSION_ID}/attachments/upload`) {
    state.uploadCalls += 1;
    await waitForUploadRelease();
    return json(response, 201, {
      kind: url.searchParams.get('kind') || 'file',
      storage_url: `ivekit://chat-attachments/upload-${state.uploadCalls}`,
      filename: url.searchParams.get('filename') || 'upload.bin',
      content_type: request.headers['content-type'] || 'application/octet-stream',
      size_bytes: body.length,
      checksum: `sha256:e2e-${state.uploadCalls}`,
      processing_status: 'ready',
      metadata: {}
    });
  }
  if (method === 'POST' && path === `/api/ivekit/chat/sessions/${SESSION_ID}/messages`) {
    const createdAt = new Date(Date.parse(NOW) + state.messages.length * 60_000).toISOString();
    const persisted = message({
      id: `message-${state.messages.length + 1}`,
      sender: identity,
      body: String(input.body || ''),
      createdAt,
      attachments: Array.isArray(input.attachments) ? input.attachments as Json[] : [],
      replyTo: String(input.reply_to_message_id || ''),
      forwardFrom: String(input.forwarded_from_message_id || '')
    });
    state.messages.push(persisted);
    broadcast('collaboration.message.created', { message: persisted });
    return json(response, 201, { session_id: SESSION_ID, message: persisted, policy: { matched: false, events: [], findings: [] } });
  }
  const receiptMatch = path.match(new RegExp(`^/api/ivekit/chat/sessions/${SESSION_ID}/messages/([^/]+)/receipts$`));
  if (method === 'POST' && receiptMatch) {
    const target = decodeURIComponent(receiptMatch[1]);
    for (const candidate of state.messages) {
      if (String(candidate.sender_identity) === identity) continue;
      if (String(candidate.created_at) > String(state.messages.find((item) => item.id === target)?.created_at || '')) continue;
      const key = `${candidate.id}:${identity}`;
      if (!state.receipts.some((item) => `${item.message_id}:${item.identity}` === key)) {
        state.receipts.push({ id: `receipt-${state.receipts.length + 1}`, tenant_id: TENANT_ID, session_id: SESSION_ID, message_id: candidate.id, identity, delivered_at: new Date().toISOString(), read_at: new Date().toISOString(), metadata: {} });
      }
    }
    broadcast('collaboration.message.receipt_updated', { message_id: target, identity });
    return json(response, 201, { session_id: SESSION_ID, message_id: target, identity, receipts: state.receipts, unread_count: unreadCount(state, identity) });
  }
  const reactionMatch = path.match(new RegExp(`^/api/ivekit/chat/sessions/${SESSION_ID}/messages/([^/]+)/reactions/([^/]+)$`));
  if (reactionMatch && (method === 'PUT' || method === 'DELETE')) {
    const messageId = decodeURIComponent(reactionMatch[1]);
    const emoji = decodeURIComponent(reactionMatch[2]);
    const target = state.messages.find((item) => item.id === messageId)!;
    const current = Array.isArray(target.reactions) ? target.reactions as Json[] : [];
    target.reactions = method === 'DELETE'
      ? current.filter((item) => !(item.identity === identity && item.emoji === emoji))
      : [...current.filter((item) => !(item.identity === identity && item.emoji === emoji)), { id: `reaction-${identity}-${emoji}`, tenant_id: TENANT_ID, session_id: SESSION_ID, message_id: messageId, identity, emoji, created_at: new Date().toISOString() }];
    broadcast('collaboration.message.reaction_updated', { message_id: messageId, reactions: target.reactions as Json[] });
    return json(response, 200, { session_id: SESSION_ID, message_id: messageId, reactions: target.reactions });
  }
  const pinMatch = path.match(new RegExp(`^/api/ivekit/chat/sessions/${SESSION_ID}/pins/([^/]+)$`));
  if (pinMatch && (method === 'PUT' || method === 'DELETE')) {
    const messageId = decodeURIComponent(pinMatch[1]);
    state.pins = method === 'DELETE'
      ? state.pins.filter((item) => item.message_id !== messageId)
      : [...state.pins.filter((item) => item.message_id !== messageId), { id: `pin-${messageId}`, tenant_id: TENANT_ID, session_id: SESSION_ID, message_id: messageId, pinned_by: identity, created_at: new Date().toISOString() }];
    broadcast('collaboration.message.pin_updated', { message_id: messageId, pins: state.pins });
    return json(response, 200, { session_id: SESSION_ID, pins: state.pins });
  }
  const messageMatch = path.match(new RegExp(`^/api/ivekit/chat/sessions/${SESSION_ID}/messages/([^/]+)$`));
  if (messageMatch && (method === 'PATCH' || method === 'DELETE')) {
    const target = state.messages.find((item) => item.id === decodeURIComponent(messageMatch[1]));
    if (!target) return json(response, 404, { error: 'message not found' });
    if (method === 'PATCH') {
      target.body = String(input.body || '');
      target.edit_version = Number(target.edit_version || 0) + 1;
      target.edited_at = new Date().toISOString();
      broadcast('collaboration.message.edited', { message: target });
    } else {
      target.body = '';
      target.deleted_at = new Date().toISOString();
      broadcast('collaboration.message.deleted', { message: target });
    }
    return json(response, 200, { session_id: SESSION_ID, message: target, mutation: null, quality_review_job: null });
  }
  if (method === 'POST' && path === `/api/ivekit/chat/sessions/${SESSION_ID}/close`) {
    state.sessionClosed = true;
    broadcast('collaboration.session.closed', { session: sessionDto(state, identity), closed_by: identity });
    return json(response, 200, sessionDto(state, identity));
  }

  return json(response, 404, { error: `unhandled controlled route: ${method} ${path}` });
}

function message(input: { id: string; sender: string; body: string; createdAt: string; attachments?: Json[]; replyTo?: string; forwardFrom?: string }): Json {
  return {
    id: input.id, tenant_id: TENANT_ID, session_id: SESSION_ID, sender_identity: input.sender,
    message_type: input.attachments?.length ? 'file' : 'text', body: input.body,
    original_language: '', metadata: {}, created_at: input.createdAt,
    attachments: (input.attachments || []).map((attachment, index) => ({
      ...attachment, id: `attachment-${input.id}-${index}`, tenant_id: TENANT_ID,
      session_id: SESSION_ID, message_id: input.id, created_at: input.createdAt
    })),
    mentions: [], reactions: [], reply_to_message_id: input.replyTo || null,
    forwarded_from_message_id: input.forwardFrom || null, deleted_at: null,
    edited_at: null, edit_version: 0, pinned: false,
    provider_delivery: { id: `delivery-${input.id}`, status: 'delivered', attempt_count: 1, next_attempt_at: null }
  };
}

function finding(): Json {
  return {
    id: 'finding-e2e', tenant_id: TENANT_ID, session_id: SESSION_ID, message_id: 'message-initial',
    source: 'text', source_ref_id: 'message-initial', policy_type: 'contact_exchange', severity: 'high',
    matched_text_hash: 'not-rendered', fingerprint: 'fingerprint-e2e', action: 'review', confidence: 0.92,
    rationale: 'Potential contact exchange detected; content is redacted.', review_status: 'pending',
    evidence_refs: [{ type: 'message', id: 'message-initial' }], reviewed_by: '', reviewed_at: null,
    review_note: '', metadata: {}, created_at: NOW, updated_at: NOW, resolved_at: null
  };
}

function participants(): Json[] {
  return [
    { id: 'participant-agent', tenant_id: TENANT_ID, session_id: SESSION_ID, identity: 'agent-1', role: 'agent', display_name: 'Mina Agent', user_ref_type: 'user', user_ref_id: 'agent-1', joined_at: NOW, left_at: null },
    { id: 'participant-customer', tenant_id: TENANT_ID, session_id: SESSION_ID, identity: 'customer-1', role: 'customer', display_name: 'Northwind Customer', user_ref_type: 'customer', user_ref_id: 'customer-1', joined_at: NOW, left_at: null }
  ];
}

function sessionDto(state: ControlledChatState, identity: string): Json {
  const latest = state.messages.at(-1)!;
  return {
    id: SESSION_ID, tenant_id: TENANT_ID,
    business_ref_type: 'service_order',
    business_ref_id: 'LED-E2E-1',
    business_ref: { tenant_id: TENANT_ID, type: 'service_order', id: 'LED-E2E-1' },
    title: 'LED display support', status: state.sessionClosed ? 'closed' : 'open',
    metadata: {}, created_at: NOW, updated_at: new Date().toISOString(),
    closed_at: state.sessionClosed ? new Date().toISOString() : null,
    summary: {
      unread_count: unreadCount(state, identity),
      online_participant_count: [...state.realtime.values()].filter((item) => item.presence_status === 'online').length,
      last_message: { id: latest.id, body: latest.deleted_at ? '' : latest.body, sender_identity: latest.sender_identity, message_type: latest.message_type, created_at: latest.created_at, deleted: Boolean(latest.deleted_at) }
    }
  };
}

function realtimeState(identity: string, status: string, typing: boolean): Json {
  return {
    id: `realtime-${identity}`, tenant_id: TENANT_ID, session_id: SESSION_ID, identity,
    presence_status: status, presence_expires_at: status === 'online' ? future(90_000) : null,
    typing, typing_expires_at: typing ? future(8_000) : null,
    last_seen_at: new Date().toISOString(), metadata: {}, created_at: NOW, updated_at: new Date().toISOString()
  };
}

function unreadCount(state: ControlledChatState, identity: string): number {
  return state.messages.filter((item) => item.sender_identity !== identity && !item.deleted_at)
    .filter((item) => !state.receipts.some((receipt) => receipt.message_id === item.id && receipt.identity === identity && receipt.read_at)).length;
}

function identityFor(request: IncomingMessage): string {
  const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token === 'token-customer') return 'customer-1';
  return 'agent-1';
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function jsonBody(body: Buffer): Json {
  if (!body.length) return {};
  try { return JSON.parse(body.toString('utf8')) as Json; } catch { return {}; }
}

function json(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function setCors(request: IncomingMessage, response: ServerResponse) {
  response.setHeader('access-control-allow-origin', String(request.headers.origin || '*'));
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.setHeader('access-control-allow-headers', 'authorization,content-type,idempotency-key,x-tenant-id,x-upload-id');
}

function replyTinode(socket: WebSocket, request: Json, params: Json, topic?: string, code = 200, text = 'ok') {
  socket.send(JSON.stringify({ ctrl: { id: request.id, topic, code, text, params } }));
}

function cursorIndex(cursor: string | null): number {
  const match = String(cursor || '').match(/^after:(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function future(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}
