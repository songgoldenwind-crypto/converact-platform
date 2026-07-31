import {
  acceptInboundCallCommand,
  createDidNumberCommand,
  createQueueCommand,
  getQueueStatusCommand,
  listDidNumbersCommand,
  listQueuesCommand,
  requestQueueCallbackCommand,
  updateAutoAttendantCommand
} from '../application.js';
import { resolveAuthContext } from '../../../middleware/auth.js';

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

function requireAdmin(headers: Record<string, string | string[] | undefined>) {
  const ctx = requireAuth(headers);
  if (ctx.role !== 'owner' && ctx.role !== 'admin') {
    throw Object.assign(new Error('admin role required'), { status: 403 });
  }
  return ctx;
}

export async function routeInboundApi(
  db: unknown,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  if (path === '/api/call-center/queues' && method === 'GET') {
    const ctx = requireAuth(headers);
    return listQueuesCommand(db, ctx.tenantId!);
  }
  if (path === '/api/call-center/queues' && method === 'POST') {
    const ctx = requireAdmin(headers);
    return createQueueCommand(db, ctx.tenantId!, body as Record<string, unknown>);
  }

  const queueStatusMatch = path.match(/^\/api\/call-center\/queues\/([^/]+)\/status$/);
  if (queueStatusMatch && method === 'GET') {
    const ctx = requireAuth(headers);
    return getQueueStatusCommand(db, ctx.tenantId!, queueStatusMatch[1]);
  }

  const queueCallbackMatch = path.match(/^\/api\/call-center\/queues\/([^/]+)\/callback$/);
  if (queueCallbackMatch && method === 'POST') {
    const ctx = requireAuth(headers);
    return requestQueueCallbackCommand(db, ctx.tenantId!, queueCallbackMatch[1], body as Record<string, unknown>);
  }

  if (path === '/api/call-center/did-numbers' && method === 'GET') {
    const ctx = requireAuth(headers);
    return listDidNumbersCommand(db, ctx.tenantId!);
  }
  if (path === '/api/call-center/did-numbers' && method === 'POST') {
    const ctx = requireAdmin(headers);
    return createDidNumberCommand(db, ctx.tenantId!, body as Record<string, unknown>);
  }

  if (path === '/api/call-center/auto-attendant' && method === 'PUT') {
    const ctx = requireAdmin(headers);
    return updateAutoAttendantCommand(db, ctx.tenantId!, body as Record<string, unknown>);
  }

  const acceptInboundMatch = path.match(/^\/api\/call-center\/inbound\/([^/]+)\/accept$/);
  if (acceptInboundMatch && method === 'POST') {
    const ctx = requireAuth(headers);
    if (!ctx.userId) throw Object.assign(new Error('authentication required'), { status: 401 });
    const input = body as { seat_id?: string };
    if (!input.seat_id) return { status: 400, data: { error: 'seat_id is required' } };
    return acceptInboundCallCommand(db, ctx.tenantId!, input.seat_id, acceptInboundMatch[1], ctx.userId);
  }

  return undefined;
}
