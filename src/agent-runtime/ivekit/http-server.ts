import { createServer as createHttpServer, type Server } from 'node:http';

import type { PgQueryable } from '../../db-pg.js';
import {
  resolvePgTenantContextForRequest,
  runWithPgTenantContextAsync,
  withPgRequestContext
} from '../../db-pg-tenant.js';
import { routeCollaborationApi } from '../collaboration/collaboration-http.js';
import { routeIveKitChatApi } from './chat-http.js';
import { createIveKitMediaHooks } from './media-hooks.js';
import {
  routeIveKitMediaApi,
  type RouteIveKitMediaApiOptions
} from './media-http.js';

type MediaRoute = typeof routeIveKitMediaApi;
type ChatRoute = typeof routeIveKitChatApi;
type CollaborationRoute = typeof routeCollaborationApi;

export interface IveKitRouteAdapters {
  media: MediaRoute;
  chat: ChatRoute;
  collaboration: CollaborationRoute;
}

export interface IveKitHttpServerInput {
  db: unknown;
  pg: PgQueryable | null;
  routes?: Partial<IveKitRouteAdapters>;
  mediaOptions?: RouteIveKitMediaApiOptions;
}

const allowedPrefixes = [
  '/api/ivekit/media/',
  '/api/ivekit/chat/',
  '/api/ivekit/rustdesk/',
  '/api/opc/rustdesk/'
];

const allowedExactPaths = new Set([
  '/health',
  '/metrics',
  '/api/media/webhooks/livekit',
  '/remote/rustdesk/launch'
]);

export function createIveKitHttpServer(input: IveKitHttpServerInput): Server {
  const routes: IveKitRouteAdapters = {
    media: input.routes?.media || routeIveKitMediaApi,
    chat: input.routes?.chat || routeIveKitChatApi,
    collaboration: input.routes?.collaboration || routeCollaborationApi
  };
  const mediaOptions = input.mediaOptions || (input.pg
    ? createIveKitMediaHooks({ db: input.db, pg: input.pg })
    : {});

  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      const path = url.pathname;
      if (!isAllowedIveKitPath(path)) {
        sendJson(response, 404, { error: { message: 'not found', status: 404 } });
        return;
      }
      if (path === '/health' && request.method === 'GET') {
        sendJson(response, 200, { ok: true, postgres: Boolean(input.pg) });
        return;
      }
      if (path === '/metrics' && request.method === 'GET') {
        const { metricsRegistry } = await import('../../metrics.js');
        send(response, 200, await metricsRegistry.metrics(), metricsRegistry.contentType);
        return;
      }

      const method = request.method || 'GET';
      const isAttachmentUpload = method === 'POST' &&
        /^\/api\/ivekit\/chat\/sessions\/[^/]+\/attachments\/upload$/.test(path);
      const isLiveKitWebhook = method === 'POST' &&
        (path === '/api/ivekit/media/webhooks/livekit' || path === '/api/media/webhooks/livekit');
      const rawBody = isAttachmentUpload
        ? await readBuffer(request, collaborationAttachmentMaxBytes())
        : await readText(request);
      const body = isAttachmentUpload
        ? null
        : isLiveKitWebhook
          ? rawBody
          : safeJsonParse(rawBody);
      const headers = request.headers;
      const tenantContext = resolvePgTenantContextForRequest(path, headers, { url, body });
      const mediaPath = path === '/api/media/webhooks/livekit'
        ? '/api/ivekit/media/webhooks/livekit'
        : path;
      const mediaUrl = mediaPath === path ? url : new URL(mediaPath, url);
      const dispatch = async (pg: PgQueryable | null) =>
        await routes.media(input.db, method, mediaPath, mediaUrl, body, rawBody, headers, mediaOptions)
        ?? await routes.chat(pg, method, path, url, body, rawBody, headers, { db: input.db })
        ?? await routes.collaboration(pg, method, path, url, body, rawBody, headers, { db: input.db });
      const result = await runWithPgTenantContextAsync(tenantContext, () =>
        input.pg
          ? withPgRequestContext(input.pg, tenantContext, (scopedPg) => dispatch(scopedPg))
          : dispatch(null)
      );

      if (result === undefined) {
        sendJson(response, 404, { error: { message: 'not found', status: 404 } });
        return;
      }
      const output = result as Record<string, unknown>;
      if (typeof output.html === 'string') {
        send(response, 200, output.html, 'text/html; charset=utf-8');
        return;
      }
      if (typeof output.contentType === 'string') {
        send(
          response,
          Number.isInteger(output.status) ? Number(output.status) : 200,
          output.data,
          output.contentType,
          isHeaderRecord(output.headers) ? output.headers : {}
        );
        return;
      }
      sendJson(
        response,
        Number.isInteger(output.status) ? Number(output.status) : 200,
        output.data ?? output
      );
    } catch (error) {
      const status = Number((error as { status?: number }).status || 500);
      sendJson(response, status, {
        error: {
          message: status === 500 ? 'internal server error' : (error as Error).message,
          status
        }
      });
    }
  });
}

function isAllowedIveKitPath(path: string): boolean {
  return allowedExactPaths.has(path) || allowedPrefixes.some((prefix) => path.startsWith(prefix));
}

async function readBuffer(
  request: import('node:http').IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('attachment upload exceeds configured size limit'), { status: 413 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readText(request: import('node:http').IncomingMessage): Promise<string> {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method || '')) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function safeJsonParse(value: string | Buffer): unknown {
  const raw = typeof value === 'string' ? value : value.toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function collaborationAttachmentMaxBytes(): number {
  const value = Number(process.env.OPC_COLLABORATION_ATTACHMENT_MAX_BYTES || 26_214_400);
  if (!Number.isInteger(value) || value < 1 || value > 1_073_741_824) {
    throw new Error('OPC_COLLABORATION_ATTACHMENT_MAX_BYTES is invalid');
  }
  return value;
}

function sendJson(response: import('node:http').ServerResponse, status: number, data: unknown): void {
  send(response, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

function send(
  response: import('node:http').ServerResponse,
  status: number,
  data: unknown,
  contentType: string,
  headers: Record<string, string | number | readonly string[]> = {}
): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    ...headers,
    'content-type': contentType
  });
  response.end(data as string | Buffer | Uint8Array);
}

function isHeaderRecord(value: unknown): value is Record<string, string | number | readonly string[]> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
