import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const FORWARD_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  '18005550200': 'sip:uas@172.30.44.22:5060',
  '18005550201': 'sip:uas@172.30.44.23:5060',
  '18005550202': 'sip:uas@172.30.44.24:5060',
  '18005550203': 'sip:uas@172.30.44.25:5060',
  '18005550204': 'sip:uas@172.30.44.26:5060',
  '18005550205': 'sip:uas@172.30.44.27:5060;transport=tcp',
  '18005550206': 'sip:uas@172.30.44.28:5060'
});

export function createRustPbxCapacityRouter(options: {
  token: string;
  max_body_bytes?: number;
}): Server {
  const token = boundedToken(options.token);
  const maxBodyBytes = boundedMaxBodyBytes(options.max_body_bytes);
  const evidence = { router_requests: 0, cdr_requests: 0 };

  return createServer(async (request, response) => {
    try {
      const path = new URL(request.url || '/', 'http://router.invalid').pathname;
      if (request.method === 'GET' && path === '/health') {
        writeJson(response, 200, { status: 'ok' });
        return;
      }
      if (!authorized(request, token)) {
        request.resume();
        writeJson(response, 401, { error: 'unauthorized' });
        return;
      }
      if (request.method === 'GET' && path === '/evidence') {
        writeJson(response, 200, { ...evidence });
        return;
      }
      if (request.method !== 'POST') {
        request.resume();
        writeJson(response, 404, { error: 'not_found' });
        return;
      }
      if (path === '/router') {
        const body = await readBody(request, maxBodyBytes);
        if (body === null) {
          writeJson(response, 413, { error: 'body_too_large' });
          return;
        }
        const payload = parseJsonObject(body);
        const required = ['call_id', 'from', 'to', 'direction', 'method', 'uri'];
        if (!payload || required.some((field) => typeof payload[field] !== 'string' || !payload[field])) {
          writeJson(response, 422, { error: 'invalid_router_payload' });
          return;
        }
        evidence.router_requests += 1;
        const target = FORWARD_ROUTES[sipUser(String(payload.to))];
        if (target) {
          writeJson(response, 200, {
            action: 'forward', targets: [target], strategy: 'sequential',
            record: false, timeout: 30, max_ring_time: 30
          });
          return;
        }
        writeJson(response, 200, { action: 'reject', status: 486, reason: 'acceptance-route' });
        return;
      }
      if (path === '/cdr') {
        const contentType = String(request.headers['content-type'] || '');
        const body = await readBody(request, maxBodyBytes);
        if (body === null) {
          writeJson(response, 413, { error: 'body_too_large' });
          return;
        }
        if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)
          || !body.includes('name="calllog.json"')) {
          writeJson(response, 422, { error: 'invalid_cdr_payload' });
          return;
        }
        evidence.cdr_requests += 1;
        writeJson(response, 200, { status: 'accepted' });
        return;
      }
      request.resume();
      writeJson(response, 404, { error: 'not_found' });
    } catch {
      if (!response.headersSent) writeJson(response, 400, { error: 'invalid_request' });
      else response.destroy();
    }
  });
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const actual = String(request.headers['x-pbx-key'] || '');
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readBody(request: IncomingMessage, maximum: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length'] || 0);
    let tooLarge = Number.isFinite(declared) && declared > maximum;
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximum) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function sipUser(value: string): string {
  return /sip:([^@;>]+)/i.exec(value)?.[1] || '';
}

function writeJson(response: ServerResponse, status: number, value: object): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'keep-alive'
  });
  response.end(body);
}

function boundedToken(value: string): string {
  if (!value || value.length < 16 || value.length > 512) throw new Error('Router token is invalid');
  return value;
}

function boundedMaxBodyBytes(value: number | undefined): number {
  const result = value ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(result) || result < 64 || result > 16 * 1024 * 1024) {
    throw new Error('Router body limit is invalid');
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const token = String(process.env.RUSTPBX_WEBHOOK_TOKEN || '');
  const host = String(process.env.IVEKIT_CAPACITY_ROUTER_HOST || '0.0.0.0');
  const port = Number(process.env.IVEKIT_CAPACITY_ROUTER_PORT || 8081);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Router port is invalid');
  const server = createRustPbxCapacityRouter({ token });
  server.listen(port, host, () => process.stdout.write(`iveKit capacity Router listening on ${host}:${port}\n`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
