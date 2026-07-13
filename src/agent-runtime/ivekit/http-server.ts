import { createServer as createHttpServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import {
  resolvePgTenantContextForRequest,
  runWithPgTenantContextAsync,
  withPgRequestContext
} from '../../db-pg-tenant.js';
import { routeCollaborationApi } from '../collaboration/collaboration-http.js';
import { routeIveKitChatApi } from './chat-http.js';
import {
  routeIveKitIntelligenceApi,
  type RouteIveKitIntelligenceApiOptions
} from './intelligence-http.js';
import { routeIveKitEventApi } from './event-http.js';
import { createIveKitMediaHooks } from './media-hooks.js';
import {
  routeIveKitMediaApi,
  type RouteIveKitMediaApiOptions
} from './media-http.js';
import {
  routeIveKitVoiceApi,
  type RouteIveKitVoiceApiOptions
} from './voice/http.js';
import { VoiceError } from './voice/errors.js';
import { runWithWsBroadcastBuffer } from '../../ws.js';

type MediaRoute = typeof routeIveKitMediaApi;
type ChatRoute = typeof routeIveKitChatApi;
type IntelligenceRoute = typeof routeIveKitIntelligenceApi;
type EventRoute = typeof routeIveKitEventApi;
type CollaborationRoute = typeof routeCollaborationApi;
type VoiceRoute = typeof routeIveKitVoiceApi;

export interface IveKitRouteAdapters {
  media: MediaRoute;
  chat: ChatRoute;
  intelligence: IntelligenceRoute;
  events: EventRoute;
  voice: VoiceRoute;
  collaboration: CollaborationRoute;
}

export interface IveKitHttpServerInput {
  db: unknown;
  pg: PgQueryable | null;
  routes?: Partial<IveKitRouteAdapters>;
  mediaOptions?: RouteIveKitMediaApiOptions;
  intelligenceOptions?: RouteIveKitIntelligenceApiOptions;
  voiceOptions?: RouteIveKitVoiceApiOptions;
}

const allowedPrefixes = [
  '/api/ivekit/media/',
  '/api/ivekit/chat/',
  '/api/ivekit/intelligence/',
  '/api/ivekit/voice/',
  '/api/ivekit/context/',
  '/api/ivekit/rustdesk/',
  '/api/opc/rustdesk/'
];

const allowedExactPaths = new Set([
  '/health',
  '/metrics',
  '/api/ivekit/events',
  '/api/media/webhooks/livekit',
  '/remote/rustdesk/launch'
]);

export function createIveKitHttpServer(input: IveKitHttpServerInput): Server {
  const routes: IveKitRouteAdapters = {
    media: input.routes?.media || routeIveKitMediaApi,
    chat: input.routes?.chat || routeIveKitChatApi,
    intelligence: input.routes?.intelligence || routeIveKitIntelligenceApi,
    events: input.routes?.events || routeIveKitEventApi,
    voice: input.routes?.voice || routeIveKitVoiceApi,
    collaboration: input.routes?.collaboration || routeCollaborationApi
  };
  const mediaOptions = input.mediaOptions || (input.pg
    ? createIveKitMediaHooks({ db: input.db, pg: input.pg })
    : {});

  return createHttpServer(async (request, response) => {
    const requestId = requestIdentifier(request.headers);
    response.setHeader('x-request-id', requestId);
    let requestPath = '/';
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      const path = url.pathname;
      requestPath = path;
      if (!isAllowedIveKitPath(path)) {
        sendJson(response, 404, { error: { message: 'not found', status: 404 } });
        return;
      }
      const origin = requestHeader(request.headers, 'origin');
      if (origin) {
        if (!allowedCorsOrigins().has(origin)) {
          sendJson(response, 403, { error: { message: 'origin not allowed', status: 403 } });
          return;
        }
        setCorsHeaders(response, origin);
      }
      if (request.method === 'OPTIONS') {
        if (!origin) {
          sendJson(response, 400, { error: { message: 'origin is required', status: 400 } });
          return;
        }
        response.writeHead(204);
        response.end();
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
        : await readText(request, iveKitHttpBodyMaxBytes());
      const body = isAttachmentUpload
        ? null
        : isLiveKitWebhook
          ? rawBody
          : parseJsonBody(rawBody);
      const headers = request.headers;
      const tenantContext = isVoiceProviderWebhook(method, path)
        ? {}
        : resolvePgTenantContextForRequest(path, headers, { url, body });
      const mediaPath = path === '/api/media/webhooks/livekit'
        ? '/api/ivekit/media/webhooks/livekit'
        : path;
      const mediaUrl = mediaPath === path ? url : new URL(mediaPath, url);
      const dispatch = async (pg: PgQueryable | null) =>
        await routes.media(input.db, method, mediaPath, mediaUrl, body, rawBody, headers, {
          ...mediaOptions,
          ...(pg ? { pg } : {})
        })
        ?? await routes.events(pg, method, path, url, headers)
        ?? await routes.intelligence(pg, method, path, url, body, headers, {
          db: input.db,
          ...input.intelligenceOptions
        })
        ?? await routes.chat(pg, method, path, url, body, rawBody, headers, { db: input.db })
        ?? await routes.voice(pg, method, path, url, body, rawBody, headers, input.voiceOptions)
        ?? await routes.collaboration(pg, method, path, url, body, rawBody, headers, { db: input.db });
      const buffered = await runWithWsBroadcastBuffer(() =>
        runWithPgTenantContextAsync(tenantContext, () =>
          input.pg
            ? withPgRequestContext(input.pg, tenantContext, (scopedPg) => dispatch(scopedPg))
            : dispatch(null)
        )
      );
      const result = buffered.result;

      if (result === undefined) {
        if (path.startsWith('/api/ivekit/voice/')) {
          sendJson(response, 404, voiceErrorEnvelope('not_found', false, requestId));
        } else {
          sendJson(response, 404, { error: { message: 'not found', status: 404 } });
        }
        return;
      }
      await buffered.flush();
      await runAfterCommit(result);
      const output = result as Record<string, unknown>;
      if (typeof output.html === 'string') {
        send(response, 200, output.html, 'text/html; charset=utf-8');
        return;
      }
      if (typeof output.contentType === 'string') {
        await send(
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
        output.data ?? output,
        isHeaderRecord(output.headers) ? output.headers : {}
      );
    } catch (error) {
      const status = Number((error as { status?: number }).status || 500);
      if (requestPath.startsWith('/api/ivekit/voice/')) {
        const voiceError = error instanceof VoiceError ? error : null;
        const code = voiceError?.code ?? (status >= 500 ? 'internal_error' : httpVoiceErrorCode(status));
        sendJson(
          response,
          status,
          voiceErrorEnvelope(code, voiceError?.retryable === true, requestId)
        );
        return;
      }
      sendJson(response, status, {
        error: {
          message: status === 500 ? 'internal server error' : (error as Error).message,
          status
        }
      });
    }
  });
}

function isVoiceProviderWebhook(method: string, path: string): boolean {
  return method === 'POST'
    && /^\/api\/ivekit\/voice\/providers\/[^/]+\/(router|events|cdrs)$/.test(path);
}

function requestIdentifier(headers: Record<string, string | string[] | undefined>): string {
  const provided = requestHeader(headers, 'x-request-id');
  return provided && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(provided)
    ? provided
    : randomUUID();
}

function voiceErrorEnvelope(code: string, retryable: boolean, requestId: string): Record<string, unknown> {
  return {
    error: {
      code,
      message: voiceErrorMessage(code),
      retryable,
      request_id: requestId,
      details: {}
    }
  };
}

function voiceErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    invalid_call_transition: 'voice call transition is not allowed',
    terminal_call_state: 'voice call is already terminal',
    invalid_address: 'voice address is invalid',
    validation_failed: 'voice request validation failed',
    not_found: 'voice resource was not found',
    revision_conflict: 'voice resource revision changed',
    idempotency_conflict: 'voice idempotency key conflicts with an existing request',
    capability_unavailable: 'voice capability is unavailable',
    provider_auth_failed: 'voice provider authentication failed',
    provider_unavailable: 'voice provider is unavailable',
    provider_timeout: 'voice provider result is uncertain',
    protocol_mismatch: 'voice provider protocol response is invalid',
    compliance_denied: 'voice compliance policy denied the request',
    webhook_auth_failed: 'voice provider webhook authentication failed',
    secret_ref_invalid: 'voice secret reference is invalid',
    secret_unavailable: 'voice secret is unavailable',
    internal_error: 'internal server error'
  };
  return messages[code] || 'voice request failed';
}

function httpVoiceErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'webhook_auth_failed';
  if (status === 404) return 'not_found';
  if (status === 409) return 'revision_conflict';
  return 'validation_failed';
}

async function runAfterCommit(result: unknown): Promise<void> {
  if (!result || typeof result !== 'object') return;
  const callback = (result as { afterCommit?: unknown }).afterCommit;
  if (typeof callback !== 'function') return;
  try {
    await callback();
  } catch (error) {
    console.error('[ivekit] post-commit event failed', error);
  }
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

async function readText(
  request: import('node:http').IncomingMessage,
  maxBytes: number
): Promise<string> {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method || '')) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('request body exceeds configured size limit'), { status: 413 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonBody(value: string | Buffer): unknown {
  const raw = typeof value === 'string' ? value : value.toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
}

function iveKitHttpBodyMaxBytes(): number {
  const value = Number(process.env.OPC_IVEKIT_HTTP_BODY_MAX_BYTES || 1_048_576);
  if (!Number.isInteger(value) || value < 1 || value > 26_214_400) {
    throw new Error('OPC_IVEKIT_HTTP_BODY_MAX_BYTES is invalid');
  }
  return value;
}

function collaborationAttachmentMaxBytes(): number {
  const value = Number(process.env.OPC_COLLABORATION_ATTACHMENT_MAX_BYTES || 26_214_400);
  if (!Number.isInteger(value) || value < 1 || value > 1_073_741_824) {
    throw new Error('OPC_COLLABORATION_ATTACHMENT_MAX_BYTES is invalid');
  }
  return value;
}

function allowedCorsOrigins(): Set<string> {
  return new Set(
    String(process.env.OPC_IVEKIT_ALLOWED_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function requestHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const value = headers[name.toLowerCase()];
  return String(Array.isArray(value) ? value[0] || '' : value || '').trim();
}

function setCorsHeaders(response: import('node:http').ServerResponse, origin: string): void {
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.setHeader(
    'access-control-allow-headers',
    'authorization,content-type,idempotency-key,x-api-key,x-tenant-id,x-upload-id,x-user-id'
  );
  response.setHeader('access-control-expose-headers', 'content-disposition,content-type');
  response.setHeader('access-control-max-age', '600');
  response.setHeader('vary', 'Origin');
}

function sendJson(
  response: import('node:http').ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string | number | readonly string[]> = {}
): void {
  send(response, status, JSON.stringify(data), 'application/json; charset=utf-8', headers);
}

async function send(
  response: import('node:http').ServerResponse,
  status: number,
  data: unknown,
  contentType: string,
  headers: Record<string, string | number | readonly string[]> = {}
): Promise<void> {
  response.writeHead(status, {
    'cache-control': 'no-store',
    ...headers,
    'content-type': contentType
  });
  if (!isAsyncIterable(data)) {
    response.end(data as string | Buffer | Uint8Array);
    return;
  }
  try {
    for await (const chunk of data) {
      if (!response.write(chunk)) {
        await new Promise<void>((resolve) => response.once('drain', resolve));
      }
    }
    response.end();
  } catch (error) {
    response.destroy(error as Error);
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return Boolean(value) && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

function isHeaderRecord(value: unknown): value is Record<string, string | number | readonly string[]> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(
    (header) => typeof header === 'string' || typeof header === 'number' || (
      Array.isArray(header) && header.every((item) => typeof item === 'string')
    )
  );
}
