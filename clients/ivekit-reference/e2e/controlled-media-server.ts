import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

type Json = Record<string, unknown>;
type CallStatus = 'created' | 'ringing' | 'accepted' | 'active' | 'rejected' | 'cancelled' | 'timed_out' | 'ended' | 'failed';
type ParticipantStatus = 'invited' | 'ringing' | 'accepted' | 'joined' | 'declined' | 'left' | 'missed' | 'removed';

interface ControlledCall {
  call: Json & { id: string; room_name: string; status: CallStatus };
  participants: Array<Json & { identity: string; role: string; status: ParticipantStatus }>;
}

export interface ControlledMediaServer {
  baseUrl: string;
  eventsUrl: string;
  state: {
    transitions: string[];
    joins: string[];
    moderation: string[];
    recordingStarts: number;
    recordingStops: number;
    eventConnections: number;
  };
  expire(callId: string): void;
  close(): Promise<void>;
}

const TENANT_ID = 'tenant-e2e';
const HOST = 'host-1';
const PARTICIPANT = 'participant-1';
const NOW = '2026-07-12T08:00:00.000Z';

export async function startControlledMediaServer(): Promise<ControlledMediaServer> {
  const sockets = new Set<WebSocket>();
  const calls = new Map<string, ControlledCall>([
    ['call-main', call('call-main', 'created')],
    ['call-reject', call('call-reject', 'ringing')],
    ['call-cancel', call('call-cancel', 'ringing')],
    ['call-timeout', call('call-timeout', 'ringing')],
    ['call-revoke', call('call-revoke', 'active')],
    ['call-mobile', call('call-mobile', 'active')]
  ]);
  const recordings: Json[] = [];
  const state = {
    transitions: [] as string[],
    joins: [] as string[],
    moderation: [] as string[],
    recordingStarts: 0,
    recordingStops: 0,
    eventConnections: 0
  };

  const server = createServer((request, response) => {
    void route(request, response, calls, recordings, state, broadcast).catch((cause) => {
      json(response, Number((cause as { status?: number }).status || 500), { error: errorMessage(cause) });
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname !== '/events' || !url.searchParams.get('token')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client));
  });
  wss.on('connection', (socket) => {
    state.eventConnections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('controlled media server failed to bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  function broadcast(type: string, callId: string) {
    const envelope = JSON.stringify({ type, data: { call_id: callId } });
    for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(envelope);
  }

  return {
    baseUrl,
    eventsUrl: `${baseUrl.replace(/^http/, 'ws')}/events`,
    state,
    expire: (callId) => {
      const value = requiredCall(calls, callId);
      value.call.status = 'timed_out';
      value.call.ended_at = new Date().toISOString();
      for (const participant of value.participants) if (participant.role !== 'host') participant.status = 'missed';
      broadcast('ivekit.media.call.ended', callId);
    },
    close: async () => {
      for (const socket of sockets) socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  calls: Map<string, ControlledCall>,
  recordings: Json[],
  state: ControlledMediaServer['state'],
  broadcast: (type: string, callId: string) => void
): Promise<void> {
  cors(response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  const url = new URL(request.url || '/', 'http://localhost');
  const path = url.pathname;
  const method = request.method || 'GET';
  const identity = authenticatedIdentity(request);
  const input = await body(request);

  const callMatch = path.match(/^\/api\/ivekit\/media\/calls\/([^/]+)(?:\/([^/]+))?$/);
  if (callMatch) {
    const callId = decodeURIComponent(callMatch[1]);
    const action = callMatch[2] || '';
    const value = requiredCall(calls, callId);
    requireMember(value, identity);
    if (!action && method === 'GET') return json(response, 200, snapshot(value));
    if (action === 'join' && method === 'POST') {
      state.joins.push(`${callId}:${identity}`);
      return json(response, 201, {
        mode: 'webrtc',
        channel: 'webrtc',
        roomName: value.call.room_name,
        role: value.participants.find((item) => item.identity === identity)?.role || 'participant',
        token: {
          token: `controlled:${identity}`,
          livekit_url: 'wss://controlled.livekit.invalid',
          room_name: value.call.room_name,
          configured: true
        }
      });
    }
    if (action === 'actions' && method === 'POST') {
      const transition = String(input.action || '');
      applyTransition(value, transition, identity);
      state.transitions.push(`${callId}:${identity}:${transition}`);
      broadcast(value.call.status === 'active' ? 'ivekit.media.call.updated' : terminal(value.call.status) ? 'ivekit.media.call.ended' : 'ivekit.media.call.updated', callId);
      return json(response, 201, snapshot(value));
    }
  }

  const moderationMatch = path.match(/^\/api\/ivekit\/media\/rooms\/([^/]+)\/participants\/([^/]+)\/(mute|remove)$/);
  if (moderationMatch && method === 'POST') {
    const roomName = decodeURIComponent(moderationMatch[1]);
    const target = decodeURIComponent(moderationMatch[2]);
    const action = moderationMatch[3];
    const value = [...calls.values()].find((item) => item.call.room_name === roomName);
    if (!value) throw statusError(404, 'media room not found');
    const actor = value.participants.find((item) => item.identity === identity);
    if (actor?.role !== 'host') throw statusError(403, 'host required');
    const participant = value.participants.find((item) => item.identity === target);
    if (!participant) throw statusError(404, 'participant not found');
    if (action === 'remove') participant.status = 'removed';
    state.moderation.push(`${value.call.id}:${action}:${target}`);
    broadcast('ivekit.media.participant.updated', value.call.id);
    return json(response, 201, {
      room_name: roomName,
      identity: target,
      action,
      status: 'succeeded',
      replayed: false,
      provider_configured: true
    });
  }

  const startMatch = path.match(/^\/api\/ivekit\/media\/rooms\/([^/]+)\/recordings\/start$/);
  if (startMatch && method === 'POST') {
    const callId = String(input.media_call_id || '');
    const value = requiredCall(calls, callId);
    requireHost(value, identity);
    if (recordings.some((item) => item.media_call_id === callId && ['pending', 'recording', 'stopping'].includes(String(item.status)))) {
      throw statusError(409, 'an active recording already exists for this room');
    }
    const recording = recordingDto(value, recordings.length + 1, 'recording');
    recordings.unshift(recording);
    state.recordingStarts += 1;
    broadcast('ivekit.media.recording.started', callId);
    return json(response, 201, recording);
  }

  if (path === '/api/ivekit/media/recordings' && method === 'GET') {
    const callId = url.searchParams.get('call_id') || '';
    const value = requiredCall(calls, callId);
    requireMember(value, identity);
    const items = recordings.filter((item) => item.media_call_id === callId);
    return json(response, 200, url.searchParams.get('page') === '1'
      ? { items, next_cursor: null, has_more: false }
      : items);
  }

  const recordingMatch = path.match(/^\/api\/ivekit\/media\/recordings\/([^/]+)(?:\/(stop|object|export))?$/);
  if (recordingMatch) {
    const key = decodeURIComponent(recordingMatch[1]);
    const action = recordingMatch[2] || '';
    const recording = recordings.find((item) => item.id === key || item.egress_id === key);
    if (!recording) throw statusError(404, 'media recording not found');
    const value = requiredCall(calls, String(recording.media_call_id));
    requireMember(value, identity);
    if (!action && method === 'GET') return json(response, 200, recording);
    if (action === 'stop' && method === 'POST') {
      requireHost(value, identity);
      recording.status = 'completed';
      recording.object_status = 'readable';
      recording.duration_ms = 12_000;
      recording.completed_at = new Date().toISOString();
      state.recordingStops += 1;
      broadcast('ivekit.media.recording.updated', value.call.id);
      return json(response, 201, recording);
    }
    if (action === 'object' && method === 'GET') {
      return json(response, 200, { status: 'readable', readable: true, source: 'controlled', size_bytes: 16, checksum: 'sha256:controlled' });
    }
    if (action === 'export' && method === 'GET') {
      response.writeHead(200, {
        'access-control-allow-origin': '*',
        'content-type': 'video/webm',
        'content-disposition': `attachment; filename="${recording.id}.webm"`
      });
      response.end(Buffer.from('controlled-media'));
      return;
    }
  }

  throw statusError(404, `unhandled controlled route ${method} ${path}`);
}

function call(id: string, status: CallStatus): ControlledCall {
  const active = status === 'active';
  return {
    call: {
      id,
      tenant_id: TENANT_ID,
      room_name: `room-${id}`,
      media: 'video',
      status,
      initiated_by: HOST,
      business_ref: { type: 'service_order', id: `SO-${id}`, metadata: {} },
      title: `LED support ${id}`,
      metadata: {},
      ring_timeout_seconds: 30,
      ring_expires_at: status === 'ringing' ? '2026-07-12T08:00:30.000Z' : null,
      accepted_at: active ? NOW : null,
      started_at: active ? NOW : null,
      ended_at: terminal(status) ? NOW : null,
      end_reason: '',
      created_at: NOW,
      updated_at: NOW
    },
    participants: [
      participant(id, HOST, 'host', active ? 'joined' : status === 'ringing' ? 'ringing' : 'invited', 'LED Host'),
      participant(id, PARTICIPANT, 'participant', active ? 'joined' : status === 'ringing' ? 'ringing' : 'invited', 'LED Customer')
    ]
  };
}

function participant(callId: string, identity: string, role: string, status: ParticipantStatus, name: string) {
  return {
    id: `${callId}-${identity}`,
    tenant_id: TENANT_ID,
    call_id: callId,
    identity,
    role,
    status,
    display_name: name,
    metadata: {},
    invited_at: NOW,
    accepted_at: status === 'joined' ? NOW : null,
    joined_at: status === 'joined' ? NOW : null,
    left_at: null,
    updated_at: NOW
  };
}

function applyTransition(value: ControlledCall, action: string, identity: string): void {
  const actor = value.participants.find((item) => item.identity === identity)!;
  if (action === 'ring' && value.call.status === 'created') {
    value.call.status = 'ringing';
    value.call.ring_expires_at = '2026-07-12T08:00:30.000Z';
    for (const participant of value.participants) participant.status = 'ringing';
    return;
  }
  if (action === 'accept' && value.call.status === 'ringing' && actor.role !== 'host') {
    value.call.status = 'accepted';
    value.call.accepted_at = new Date().toISOString();
    actor.status = 'accepted';
    return;
  }
  if (action === 'activate' && value.call.status === 'accepted') {
    value.call.status = 'active';
    value.call.started_at = new Date().toISOString();
    for (const participant of value.participants) if (participant.status !== 'removed') participant.status = 'joined';
    return;
  }
  if (action === 'reject' && value.call.status === 'ringing' && actor.role !== 'host') {
    value.call.status = 'rejected';
    actor.status = 'declined';
    return;
  }
  if (action === 'cancel' && ['created', 'ringing'].includes(value.call.status) && actor.role === 'host') {
    value.call.status = 'cancelled';
    return;
  }
  if (action === 'end' && value.call.status === 'active') {
    value.call.status = 'ended';
    value.call.ended_at = new Date().toISOString();
    for (const participant of value.participants) if (participant.status !== 'removed') participant.status = 'left';
    return;
  }
  throw statusError(409, `invalid ${action} transition from ${value.call.status}`);
}

function recordingDto(value: ControlledCall, sequence: number, status: string): Json {
  return {
    id: `recording-${sequence}`,
    tenant_id: TENANT_ID,
    call_session_id: '',
    media_call_id: value.call.id,
    room_name: value.call.room_name,
    business_ref_type: 'service_order',
    business_ref_id: `SO-${value.call.id}`,
    business_ref: value.call.business_ref,
    source: 'livekit_egress',
    format: 'webm',
    storage_url: 's3://controlled/never-render',
    duration_ms: null,
    file_size_bytes: null,
    has_video: 1,
    egress_id: `egress-${sequence}`,
    status,
    retention_until: '2026-10-10T08:00:00.000Z',
    object_status: 'unchecked',
    object_checked_at: null,
    failure_code: '',
    completed_at: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    evidence_record_id: `evidence-${sequence}`
  };
}

function snapshot(value: ControlledCall): Json {
  return { call: value.call, participants: value.participants };
}

function requiredCall(calls: Map<string, ControlledCall>, callId: string): ControlledCall {
  const value = calls.get(callId);
  if (!value) throw statusError(404, 'media call not found');
  return value;
}

function requireMember(value: ControlledCall, identity: string): void {
  if (!value.participants.some((item) => item.identity === identity && item.status !== 'removed')) {
    throw statusError(404, 'media call not found');
  }
}

function requireHost(value: ControlledCall, identity: string): void {
  if (value.participants.find((item) => item.identity === identity)?.role !== 'host') {
    throw statusError(403, 'host required');
  }
}

function authenticatedIdentity(request: IncomingMessage): string {
  const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token === 'token-host') return HOST;
  if (token === 'token-participant') return PARTICIPANT;
  throw statusError(401, 'authentication required');
}

async function body(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json; } catch { return {}; }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'access-control-allow-origin': '*', 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function cors(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'authorization,content-type,idempotency-key,x-tenant-id');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
}

function terminal(status: CallStatus): boolean {
  return ['rejected', 'cancelled', 'timed_out', 'ended', 'failed'].includes(status);
}

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
