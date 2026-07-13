import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

export type ControlledProviderMode =
  | 'success'
  | 'timeout'
  | 'transient_failure'
  | 'terminal_failure'
  | 'invalid_json'
  | 'oversized_response';

export interface ControlledProviderState {
  mode: ControlledProviderMode;
  token: string;
  controlToken: string;
  requestCount: number;
}

export interface ControlledProviderRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface ControlledProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  delay_ms: number;
}

const MODES = new Set<ControlledProviderMode>([
  'success',
  'timeout',
  'transient_failure',
  'terminal_failure',
  'invalid_json',
  'oversized_response'
]);

export function createControlledProviderState(input: {
  mode?: ControlledProviderMode;
  token?: string;
  controlToken?: string;
} = {}): ControlledProviderState {
  return {
    mode: input.mode || 'success',
    token: String(input.token || ''),
    controlToken: String(input.controlToken || ''),
    requestCount: 0
  };
}

export async function handleControlledProviderRequest(
  request: ControlledProviderRequest,
  state: ControlledProviderState
): Promise<ControlledProviderResponse> {
  const path = request.path.split('?')[0];
  const method = request.method.toUpperCase();
  if (method === 'GET' && path === '/health') {
    return json(200, { status: 'ok', service: 'ivekit-controlled-provider' });
  }
  if (method === 'POST' && path === '/__control/mode') {
    if (!state.controlToken || bearer(request.headers) !== state.controlToken) return unauthorized();
    const mode = record(request.body).mode;
    if (!MODES.has(mode as ControlledProviderMode)) return json(400, { error: 'unsupported controlled mode' });
    state.mode = mode as ControlledProviderMode;
    return json(200, { mode: state.mode });
  }
  if (state.token && bearer(request.headers) !== state.token) return unauthorized();
  if (method !== 'POST' || !['/v1/ocr', '/v1/asr', '/v1/quality-review', '/v1/translate'].includes(path)) {
    return json(404, { error: 'controlled provider route not found' });
  }

  state.requestCount += 1;
  const failure = failureResponse(state.mode);
  if (failure) return failure;
  const requestId = `controlled-${state.requestCount}`;
  if (path === '/v1/ocr' || path === '/v1/asr') {
    const capability = path.endsWith('/ocr') ? 'ocr' : 'asr';
    return json(200, {
      text: `controlled ${capability} extracted text`,
      confidence: 0.99,
      language: 'en-US',
      provider_request_id: requestId,
      metadata: { fixture: capability }
    });
  }
  if (path === '/v1/quality-review') {
    return json(200, {
      findings: [{
        policy_type: 'controlled_contact_exchange',
        severity: 'high',
        confidence: 0.97,
        recommended_action: 'review',
        rationale: 'Controlled quality finding'
      }],
      metadata: { fixture: 'quality_review', request_id: requestId }
    });
  }
  const body = record(request.body);
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 200_000) : '';
  const targetLanguage = typeof body.target_language === 'string'
    ? body.target_language.trim().slice(0, 35)
    : '';
  if (!text || !targetLanguage) return json(400, { error: 'text and target_language are required' });
  return json(200, {
    translated_text: `[${targetLanguage}] ${text}`,
    detected_language: body.source_language === 'auto' ? 'en-US' : body.source_language,
    confidence: 0.99,
    provider_request_id: requestId,
    metadata: { fixture: 'translation' }
  });
}

export function startControlledIntelligenceProvider(input: {
  host?: string;
  port?: number;
  state?: ControlledProviderState;
} = {}) {
  const host = String(input.host || '127.0.0.1');
  const port = boundedPort(input.port ?? 8790);
  const state = input.state || createControlledProviderState();
  const server = createServer((request, response) => {
    void routeHttp(request, response, state).catch(() => write(response, json(500, { error: 'controlled provider failure' })));
  });
  server.listen(port, host);
  return {
    server,
    state,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function routeHttp(
  request: IncomingMessage,
  response: ServerResponse,
  state: ControlledProviderState
): Promise<void> {
  const raw = await readBody(request, 2_097_152);
  const contentType = String(request.headers['content-type'] || '');
  const body = contentType.includes('application/json') ? parseJson(raw) : {};
  const result = await handleControlledProviderRequest({
    method: request.method || 'GET',
    path: new URL(request.url || '/', 'http://controlled.local').pathname,
    headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value[0] : value
    ])),
    body
  }, state);
  if (result.delay_ms) await delay(result.delay_ms);
  write(response, result);
}

function failureResponse(mode: ControlledProviderMode): ControlledProviderResponse | null {
  if (mode === 'success') return null;
  if (mode === 'timeout') return { ...json(200, { status: 'delayed' }), delay_ms: 65_000 };
  if (mode === 'transient_failure') return json(503, { error: 'controlled transient failure' });
  if (mode === 'terminal_failure') return json(422, { error: 'controlled terminal failure' });
  if (mode === 'invalid_json') {
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '{invalid-json', delay_ms: 0 };
  }
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ translated_text: 'x'.repeat(1_048_577) }),
    delay_ms: 0
  };
}

function json(status: number, value: unknown): ControlledProviderResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
    delay_ms: 0
  };
}

function unauthorized(): ControlledProviderResponse {
  return json(401, { error: 'controlled provider authentication required' });
}

function bearer(headers: Record<string, string | undefined>): string {
  return String(headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJson(value: Buffer): unknown {
  if (!value.length) return {};
  try { return JSON.parse(value.toString('utf8')) as unknown; } catch { return {}; }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maxBytes) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function write(response: ServerResponse, result: ControlledProviderResponse): void {
  response.writeHead(result.status, {
    ...result.headers,
    'content-length': Buffer.byteLength(result.body),
    'cache-control': 'no-store'
  });
  response.end(result.body);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error('controlled provider port is invalid');
  return value;
}

function configuredMode(value: string | undefined): ControlledProviderMode {
  const mode = String(value || 'success') as ControlledProviderMode;
  if (!MODES.has(mode)) throw new Error('OPC_IVEKIT_CONTROLLED_MODE is invalid');
  return mode;
}

function main(): void {
  const state = createControlledProviderState({
    mode: configuredMode(process.env.OPC_IVEKIT_CONTROLLED_MODE),
    token: process.env.OPC_IVEKIT_CONTROLLED_TOKEN,
    controlToken: process.env.OPC_IVEKIT_CONTROL_TOKEN
  });
  const host = process.env.OPC_IVEKIT_CONTROLLED_HOST || '127.0.0.1';
  const port = Number(process.env.OPC_IVEKIT_CONTROLLED_PORT || 8790);
  const running = startControlledIntelligenceProvider({ host, port, state });
  running.server.on('listening', () => console.log(JSON.stringify({
    status: 'listening', host, port, mode: state.mode
  })));
  const stop = () => { void running.close().finally(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
