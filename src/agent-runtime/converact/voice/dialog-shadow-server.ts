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
import { type TLSSocket } from 'node:tls';

import {
  handleDialogShadowRequest,
  type DialogOwnerTakeoverHttpCoordinator,
  type DialogShadowHttpCoordinator
} from './dialog-shadow-http.js';
import type {
  DialogPeerIdentity
} from './dialog-owner-takeover.js';

export interface DialogShadowServerTlsOptions {
  key: string | Buffer;
  cert: string | Buffer;
  ca: string | Buffer | Array<string | Buffer>;
}

export type DialogShadowHttpServer = HttpServer | HttpsServer;

export function createDialogShadowHttpServer(input: {
  coordinator: DialogShadowHttpCoordinator;
  takeover_coordinator?: DialogOwnerTakeoverHttpCoordinator;
  service_token: string;
  production?: boolean;
  tls?: DialogShadowServerTlsOptions;
  spiffe_trust_domain?: string;
  development_peer_identity?: DialogPeerIdentity;
  ready?: () => boolean;
  max_body_bytes?: number;
}): DialogShadowHttpServer {
  const production = input.production ?? true;
  const ready = input.ready ?? (() => true);
  const maxBodyBytes = boundedInteger(
    input.max_body_bytes ?? 128 * 1024,
    1024,
    1024 * 1024,
    'dialog shadow body limit'
  );
  if (production && !input.tls) {
    throw new Error('dialog shadow production mTLS is required');
  }
  if (production && input.development_peer_identity) {
    throw new Error('dialog shadow development identity is forbidden');
  }
  const trustDomain = trustDomainValue(input.spiffe_trust_domain, production);
  const handler = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    try {
      const url = new URL(
        request.url || '/',
        `${input.tls ? 'https' : 'http'}://${request.headers.host || 'localhost'}`
      );
      if (request.method === 'GET' && url.pathname === '/livez') {
        return sendJson(response, 200, { status: 'alive' });
      }
      if (request.method === 'GET' && url.pathname === '/readyz') {
        const available = ready();
        return sendJson(response, available ? 200 : 503, {
          status: available ? 'ready' : 'not_ready'
        });
      }
      const body = await readBody(request, maxBodyBytes);
      const fetchRequest = new Request(url, {
        method: request.method,
        headers: fetchHeaders(request.headers),
        body: body.byteLength > 0 ? body : undefined
      });
      await sendFetchResponse(
        response,
        await handleDialogShadowRequest(fetchRequest, {
          service_token: input.service_token,
          coordinator: input.coordinator,
          takeover_coordinator: input.takeover_coordinator,
          peer_identity: peerIdentity(
            request,
            trustDomain,
            input.development_peer_identity
          ),
          max_body_bytes: maxBodyBytes
        })
      );
    } catch (error) {
      const tooLarge = error instanceof DialogShadowServerError &&
        error.code === 'request_too_large';
      sendJson(response, tooLarge ? 413 : 400, {
        error: tooLarge ? 'body_too_large' : 'invalid_request'
      });
    }
  };
  const server = input.tls
    ? secureServer(input.tls, handler)
    : createHttpServer(handler);
  server.maxHeadersCount = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

function peerIdentity(
  request: IncomingMessage,
  trustDomain: string,
  developmentIdentity?: DialogPeerIdentity
): DialogPeerIdentity | undefined {
  if (developmentIdentity) return developmentIdentity;
  const socket = request.socket as TLSSocket;
  if (!socket.authorized || typeof socket.getPeerX509Certificate !== 'function') {
    return undefined;
  }
  const certificate = socket.getPeerX509Certificate();
  const san = certificate?.subjectAltName || '';
  const identities = [...san.matchAll(/(?:^|,\s*)URI:([^,]+)(?=,\s*|$)/g)]
    .map((match) => match[1] || '')
    .filter((value) => value.startsWith('spiffe://'));
  if (identities.length !== 1) return undefined;
  let uri: URL;
  try {
    uri = new URL(identities[0]);
  } catch {
    return undefined;
  }
  if (uri.protocol !== 'spiffe:' || uri.hostname !== trustDomain ||
      uri.username || uri.password || uri.port || uri.search || uri.hash ||
      uri.pathname.includes('%')) {
    return undefined;
  }
  const match = uri.pathname.match(
    /^\/cells\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/fault-domains\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/nodes\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/
  );
  if (!match) return undefined;
  return {
    spiffe_id: uri.toString(),
    cell_id: match[1]!,
    fault_domain: match[2]!,
    node_id: match[3]!
  };
}

function trustDomainValue(value: unknown, required: boolean): string {
  const result = String(value || '');
  if (!result && !required) return 'ivekit.invalid';
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(result) ||
      result.includes('..')) {
    throw new Error('dialog shadow SPIFFE trust domain is invalid');
  }
  return result;
}

function secureServer(
  tls: DialogShadowServerTlsOptions,
  handler: (
    request: IncomingMessage,
    response: ServerResponse
  ) => Promise<void>
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

async function readBody(
  request: IncomingMessage,
  maximumBytes: number
): Promise<Buffer> {
  const declared = request.headers['content-length'];
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new DialogShadowServerError('content_length_invalid');
    }
    if (size > maximumBytes) {
      throw new DialogShadowServerError('request_too_large');
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maximumBytes) {
      throw new DialogShadowServerError('request_too_large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function fetchHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

async function sendFetchResponse(
  target: ServerResponse,
  source: Response
): Promise<void> {
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  };
  source.headers.forEach((value, name) => {
    headers[name] = value;
  });
  target.writeHead(source.status, headers);
  target.end(Buffer.from(await source.arrayBuffer()));
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': encoded.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(encoded);
}

function validateTls(tls: DialogShadowServerTlsOptions): void {
  for (const value of [tls.key, tls.cert]) {
    if ((typeof value !== 'string' && !Buffer.isBuffer(value)) ||
        Buffer.byteLength(value) < 1) {
      throw new Error('dialog shadow TLS configuration is invalid');
    }
  }
  const authorities = Array.isArray(tls.ca) ? tls.ca : [tls.ca];
  if (authorities.length < 1 || authorities.some((value) =>
    (typeof value !== 'string' && !Buffer.isBuffer(value)) ||
    Buffer.byteLength(value) < 1
  )) {
    throw new Error('dialog shadow TLS CA configuration is invalid');
  }
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string
): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) ||
      result < minimum ||
      result > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return result;
}

class DialogShadowServerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DialogShadowServerError';
  }
}
