import { timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http';
import {
  createServer as createHttpsServer,
  type Server as HttpsServer
} from 'node:https';

import {
  MediaControlAgent,
  MediaControlError
} from './agent.js';
import type {
  MediaControlCommand,
  MediaControlReconcileInput
} from './protocol.js';

export interface MediaControlServerTlsOptions {
  key: string | Buffer;
  cert: string | Buffer;
  ca: string | Buffer | Array<string | Buffer>;
}

export type MediaControlHttpServer = HttpServer | HttpsServer;

export function createMediaControlHttpServer(input: {
  agent: MediaControlAgent;
  service_token: string;
  production?: boolean;
  tls?: MediaControlServerTlsOptions;
  max_body_bytes?: number;
  now?: () => Date;
  ready?: () => boolean;
}): MediaControlHttpServer {
  const token = safeToken(input.service_token);
  const maxBodyBytes = boundedInteger(
    input.max_body_bytes ?? 262_144,
    1_024,
    1_048_576,
    'media control body limit'
  );
  const now = input.now ?? (() => new Date());
  const ready = input.ready ?? (() => true);
  if (input.production && !input.tls) {
    throw new Error('media control production mTLS is required');
  }
  const handler = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    try {
      const url = new URL(
        request.url || '/',
        `http://${request.headers.host || 'localhost'}`
      );
      if (request.method === 'GET' && url.pathname === '/livez') {
        return sendJson(response, 200, { status: 'alive' });
      }
      if (request.method === 'GET' && url.pathname === '/readyz') {
        const isReady = ready();
        return sendJson(response, isReady ? 200 : 503, {
          status: isReady ? 'ready' : 'not_ready'
        });
      }

      requireToken(request.headers, token);
      if (request.method === 'GET' && url.pathname === '/metrics') {
        return sendMetrics(response, input.agent.renderMetrics());
      }
      if (request.method === 'POST' && url.pathname === '/v1/commands') {
        requireJson(request.headers);
        const body = await readJsonBody(request, maxBodyBytes);
        const result = await input.agent.execute(
          structuredClone(body) as MediaControlCommand,
          now()
        );
        return sendJson(response, 200, { data: result });
      }
      if (request.method === 'POST' && url.pathname === '/v1/reconcile') {
        requireJson(request.headers);
        const body = await readJsonBody(request, maxBodyBytes);
        const result = await input.agent.reconcile(
          structuredClone(body) as MediaControlReconcileInput,
          now()
        );
        return sendJson(response, 200, { data: result });
      }
      const session = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (request.method === 'GET' && session) {
        const reservationId = decodeSegment(session[1]);
        if (!/^[A-Za-z0-9._:@/-]{1,256}$/.test(reservationId)) {
          throw new MediaControlError('media_session_id_invalid', 400, false);
        }
        const snapshot = input.agent.session(reservationId);
        if (!snapshot) {
          throw new MediaControlError('media_session_not_found', 404, false);
        }
        return sendJson(response, 200, { data: snapshot });
      }
      return sendJson(response, 404, {
        error: { code: 'not_found', retryable: false }
      });
    } catch (error) {
      const projected = projectError(error);
      return sendJson(response, projected.status, {
        error: {
          code: projected.code,
          retryable: projected.retryable
        }
      });
    }
  };

  const server = !input.tls
    ? createHttpServer(handler)
    : secureServer(input.tls, handler);
  server.maxHeadersCount = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

function secureServer(
  tls: MediaControlServerTlsOptions,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
): HttpsServer {
  validateTls(tls);
  return createHttpsServer({
    key: tls.key,
    cert: tls.cert,
    ca: tls.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2'
  }, handler);
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number
): Promise<unknown> {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new MediaControlError('content_length_invalid', 400, false);
    }
    if (declared > maximumBytes) {
      throw new MediaControlError('request_too_large', 413, false);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maximumBytes) {
      throw new MediaControlError('request_too_large', 413, false);
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new MediaControlError('invalid_json', 400, false);
  }
}

function requireJson(headers: IncomingHttpHeaders): void {
  const type = String(headers['content-type'] || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (type !== 'application/json') {
    throw new MediaControlError('content_type_invalid', 415, false);
  }
}

function requireToken(headers: IncomingHttpHeaders, expected: string): void {
  const supplied = String(headers.authorization || '');
  if (!safeEqual(supplied, `Bearer ${expected}`)) {
    throw new MediaControlError('authentication_required', 401, false);
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer);
}

function safeToken(value: string): string {
  if (typeof value !== 'string' ||
      value.length < 24 ||
      value.length > 512 ||
      /[\0\r\n]/.test(value)) {
    throw new Error('invalid media control service token');
  }
  return value;
}

function validateTls(tls: MediaControlServerTlsOptions): void {
  for (const value of [tls.key, tls.cert]) {
    if ((typeof value !== 'string' && !Buffer.isBuffer(value)) ||
        Buffer.byteLength(value) < 1) {
      throw new Error('invalid media control TLS configuration');
    }
  }
  const authorities = Array.isArray(tls.ca) ? tls.ca : [tls.ca];
  if (authorities.length < 1 ||
      authorities.some((value) =>
        (typeof value !== 'string' && !Buffer.isBuffer(value)) ||
        Buffer.byteLength(value) < 1)) {
    throw new Error('invalid media control TLS configuration');
  }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new MediaControlError('invalid_request', 400, false);
  }
}

function projectError(error: unknown): {
  code: string;
  status: number;
  retryable: boolean;
} {
  if (error instanceof MediaControlError) {
    return {
      code: error.code,
      status: error.status,
      retryable: error.retryable
    };
  }
  return {
    code: 'internal_error',
    status: 500,
    retryable: true
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(JSON.stringify(value));
}

function sendMetrics(response: ServerResponse, value: string): void {
  response.writeHead(200, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(value);
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}
