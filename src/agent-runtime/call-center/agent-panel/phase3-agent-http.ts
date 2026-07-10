import { resolveAuthContext } from '../../../middleware/auth.js';
import {
  acceptTransferCommand,
  endAgentCallCommand,
  getCallSessionDetailCommand,
  heartbeatAgentSeatCommand,
  listConversationTurnsCommand,
  updateAgentSeatStatusCommand
} from '../application.js';
import { AgentSeatStore } from '../seat-store.js';
import type { AgentSeatStatus } from '../types.js';
import { sseManager } from './sse-manager.js';
import { TransferQueueStore } from './transfer-queue-store.js';
import { createObjectStorage, isLocalObjectStorage, readLocalUpload } from '../../../storage/object-storage.js';
import { ScreenRecordingStore } from '../analytics/screen-recording.js';

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId || !ctx.userId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

/** Authenticate + verify seat belongs to caller's tenant. */
function requireSeatAuth(db: unknown, headers: Record<string, string | string[] | undefined>, seatId: string) {
  const ctx = requireAuth(headers);
  new AgentSeatStore(db).assertSeatOwnership(ctx.tenantId!, seatId);
  return ctx;
}

export async function routePhase3AgentApi(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  const seatEventsMatch = path.match(/^\/api\/call-center\/seats\/([^/]+)\/events$/);
  if (seatEventsMatch && method === 'GET') {
    const mergedHeaders: Record<string, string | string[] | undefined> = { ...headers };
    const token = url.searchParams.get('token');
    if (token && !mergedHeaders.Authorization && !mergedHeaders.authorization) {
      mergedHeaders.Authorization = `Bearer ${token}`;
    }
    const seatId = seatEventsMatch[1];
    const ctx = requireSeatAuth(db, mergedHeaders, seatId);
    return {
      sse: true,
      attach: (res: import('node:http').ServerResponse) => {
        sseManager.register(seatId, ctx.tenantId!, res);
        const queue = new TransferQueueStore(db).listWaiting(ctx.tenantId!);
        sseManager.send(seatId, 'queue_update', { queue });
      }
    };
  }

  const seatHeartbeatMatch = path.match(/^\/api\/call-center\/seats\/([^/]+)\/heartbeat$/);
  if (seatHeartbeatMatch && method === 'POST') {
    const ctx = requireSeatAuth(db, headers, seatHeartbeatMatch[1]);
    return heartbeatAgentSeatCommand(db, ctx.tenantId!, seatHeartbeatMatch[1]);
  }

  const seatStatusMatch = path.match(/^\/api\/call-center\/seats\/([^/]+)\/status$/);
  if (seatStatusMatch && method === 'POST') {
    const ctx = requireSeatAuth(db, headers, seatStatusMatch[1]);
    const input = body as { status?: string };
    if (!input.status) return { status: 400, data: { error: 'status required' } };
    return updateAgentSeatStatusCommand(db, ctx.tenantId!, seatStatusMatch[1], {
      status: input.status as AgentSeatStatus
    });
  }

  if (path === '/api/call-center/transfer-queue' && method === 'GET') {
    const ctx = requireAuth(headers);
    return { data: new TransferQueueStore(db).listWaiting(ctx.tenantId!) };
  }

  if (path === '/api/call-center/transfer-queue' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      call_session_id?: string;
      room_name?: string;
      customer_name?: string;
      customer_phone?: string;
      customer_summary?: string;
      intent_score?: number;
      priority?: number;
    };
    if (!input.call_session_id) return { status: 400, data: { error: 'call_session_id required' } };
    const entry = new TransferQueueStore(db).enqueue({
      tenant_id: ctx.tenantId!,
      call_session_id: input.call_session_id,
      room_name: input.room_name,
      customer_name: input.customer_name,
      customer_phone: input.customer_phone,
      customer_summary: input.customer_summary,
      intent_score: input.intent_score,
      priority: input.priority
    });
    sseManager.broadcast(ctx.tenantId!, 'queue_update', {
      queue: new TransferQueueStore(db).listWaiting(ctx.tenantId!)
    });
    return { status: 201, data: entry };
  }

  const acceptMatch = path.match(/^\/api\/call-center\/seats\/([^/]+)\/accept$/);
  if (acceptMatch && method === 'POST') {
    const ctx = requireSeatAuth(db, headers, acceptMatch[1]);
    const seatId = acceptMatch[1];
    const input = body as { queue_entry_id?: string; call_session_id?: string };
    let callSessionId = input.call_session_id || '';
    if (input.queue_entry_id) {
      const assigned = new TransferQueueStore(db).assign(input.queue_entry_id, ctx.tenantId!, seatId);
      if (!assigned) return { status: 404, data: { error: 'queue entry not found' } };
      callSessionId = assigned.call_session_id;
    }
    if (!callSessionId) return { status: 400, data: { error: 'queue_entry_id or call_session_id required' } };
    const result = await acceptTransferCommand(db, ctx.tenantId!, seatId, callSessionId, ctx.userId!);
    sseManager.send(seatId, 'call_assigned', result.data);
    sseManager.broadcast(ctx.tenantId!, 'queue_update', {
      queue: new TransferQueueStore(db).listWaiting(ctx.tenantId!)
    });
    return result;
  }

  const hangupMatch = path.match(/^\/api\/call-center\/seats\/([^/]+)\/hangup$/);
  if (hangupMatch && method === 'POST') {
    const ctx = requireSeatAuth(db, headers, hangupMatch[1]);
    const input = body as { call_session_id?: string; disposition?: string };
    if (!input.call_session_id) return { status: 400, data: { error: 'call_session_id required' } };
    const result = await endAgentCallCommand(
      db,
      ctx.tenantId!,
      hangupMatch[1],
      input.call_session_id,
      ctx.userId!,
      { disposition: input.disposition }
    );
    sseManager.send(hangupMatch[1], 'call_ended', { call_session_id: input.call_session_id });
    return result;
  }

  const wrapUpMatch = path.match(/^\/api\/call-center\/seats\/([^/]+)\/wrap-up$/);
  if (wrapUpMatch && method === 'POST') {
    const ctx = requireSeatAuth(db, headers, wrapUpMatch[1]);
    const input = body as { notes?: string; tags?: string[] };
    await updateAgentSeatStatusCommand(db, ctx.tenantId!, wrapUpMatch[1], { status: 'wrap_up' });
    return {
      data: {
        seat_id: wrapUpMatch[1],
        status: 'wrap_up',
        notes: input.notes || '',
        tags: input.tags || []
      }
    };
  }

  const callContextMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/context$/);
  if (callContextMatch && method === 'GET') {
    const ctx = requireAuth(headers);
    const detail = getCallSessionDetailCommand(db, ctx.tenantId!, callContextMatch[1]) as {
      data: Record<string, unknown>;
    };
    const turns = listConversationTurnsCommand(db, callContextMatch[1]) as {
      data: unknown[];
    };
    return {
      data: {
        call: detail.data,
        transcript: turns.data,
        ai_summary: detail.data.customer_summary || ''
      }
    };
  }

  const mediaMatch = path.match(/^\/api\/call-center\/media\/(.+)$/);
  if (mediaMatch && method === 'GET') {
    if (!isLocalObjectStorage()) return { status: 404, data: { error: 'media not available' } };
    const buffer = readLocalUpload(mediaMatch[1]);
    if (!buffer) return { status: 404, data: { error: 'not found' } };
    return {
      contentType: 'video/webm',
      data: buffer
    };
  }

  if (path === '/api/call-center/screen-recordings/upload' && method === 'POST') {
    const ctx = requireAuth(headers);
    const buffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
    if (!buffer.length) return { status: 400, data: { error: 'empty body' } };
    const filename = String(headers['x-filename'] || headers['X-Filename'] || `recording-${Date.now()}.webm`);
    const contentType = String(headers['content-type'] || 'video/webm');
    const uploaded = await createObjectStorage().upload({
      tenantId: ctx.tenantId!,
      filename,
      body: buffer,
      contentType
    });
    const callSessionId = url.searchParams.get('call_session_id') || undefined;
    const seatId = url.searchParams.get('seat_id') || undefined;
    const durationSec = Number(url.searchParams.get('duration_sec') || 0);
    const rec = new ScreenRecordingStore(db).create({
      tenant_id: ctx.tenantId!,
      call_session_id: callSessionId,
      seat_id: seatId,
      storage_url: uploaded.storage_url,
      duration_sec: durationSec
    });
    return { status: 201, data: rec };
  }

  return undefined;
}

export { sseManager };
