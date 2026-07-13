import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { WebSocket, WebSocketServer } from 'ws';

export type ControlledVoiceProviderMode =
  | 'success'
  | 'retryable_503'
  | 'delayed_timeout'
  | 'async_success_after_timeout'
  | 'duplicate_events'
  | 'out_of_order_events'
  | 'malformed_response'
  | 'auth_failure'
  | 'capability_absence';

export interface ControlledVoiceProviderState {
  mode: ControlledVoiceProviderMode;
  token: string;
  control_token: string;
  response_delay_ms: number;
  resources: Map<string, {
    kind: string;
    revision: number;
    desired_state: Record<string, unknown>;
  }>;
  calls: Map<string, { state: string; action_id: string }>;
  recordings: Map<string, { state: string; object_ref: string }>;
  action_counts: Map<string, number>;
  action_results: Map<string, Record<string, unknown>>;
  events: Array<{
    event: 'call_state_change';
    event_id: string;
    call_id: string;
    action_id: string;
    state: string;
  }>;
}

export interface ControlledVoiceProviderRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface ControlledVoiceProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  delay_ms: number;
}

const MODES = new Set<ControlledVoiceProviderMode>([
  'success', 'retryable_503', 'delayed_timeout', 'async_success_after_timeout',
  'duplicate_events', 'out_of_order_events', 'malformed_response', 'auth_failure',
  'capability_absence'
]);

const CAPABILITIES = {
  management_http: true,
  json_rpc_routing: true,
  step_ivr: true,
  rwi: true,
  webrtc_extension: true,
  recording: true,
  sipflow: true,
  queue: true,
  postgres_backend: true
};

export function createControlledVoiceProviderState(input: {
  mode?: ControlledVoiceProviderMode;
  token?: string;
  control_token?: string;
  response_delay_ms?: number;
} = {}): ControlledVoiceProviderState {
  return {
    mode: input.mode ?? 'success',
    token: String(input.token || ''),
    control_token: String(input.control_token || ''),
    response_delay_ms: boundedDelay(input.response_delay_ms ?? 65_000),
    resources: new Map(),
    calls: new Map(),
    recordings: new Map(),
    action_counts: new Map(),
    action_results: new Map(),
    events: []
  };
}

export async function handleControlledVoiceProviderRequest(
  request: ControlledVoiceProviderRequest,
  state: ControlledVoiceProviderState
): Promise<ControlledVoiceProviderResponse> {
  const method = String(request.method || 'GET').toUpperCase();
  const path = String(request.path || '/').split('?')[0] || '/';
  if (method === 'POST' && path === '/__control/mode') {
    if (!state.control_token || bearer(request.headers) !== state.control_token) return unauthorized();
    const input = record(request.body);
    if (!MODES.has(input.mode as ControlledVoiceProviderMode)) {
      return json(400, { error: 'unsupported controlled Voice mode' });
    }
    state.mode = input.mode as ControlledVoiceProviderMode;
    if (input.response_delay_ms !== undefined) {
      state.response_delay_ms = boundedDelay(input.response_delay_ms);
    }
    return json(200, { mode: state.mode, response_delay_ms: state.response_delay_ms });
  }
  if (state.mode === 'auth_failure' || (state.token && bearer(request.headers) !== state.token)) {
    return unauthorized();
  }
  if (state.mode === 'retryable_503') return json(503, { error: 'controlled provider unavailable' });
  if (state.mode === 'malformed_response') return invalidJson();

  const response = routeManagement(method, path, request.body, state);
  if (state.mode === 'delayed_timeout') return { ...response, delay_ms: state.response_delay_ms };
  return response;
}

export async function startControlledVoiceProvider(input: {
  host?: string;
  port?: number;
  state?: ControlledVoiceProviderState;
} = {}): Promise<{
  server: ReturnType<typeof createServer>;
  state: ControlledVoiceProviderState;
  base_url: string;
  rwi_url: string;
  close(): Promise<void>;
}> {
  const host = validatedHost(input.host ?? '127.0.0.1');
  const port = boundedPort(input.port ?? 8791, true);
  const state = input.state ?? createControlledVoiceProviderState();
  const server = createServer((request, response) => {
    void routeHttp(request, response, state).catch(() => {
      if (!response.headersSent) write(response, json(500, { error: 'controlled Voice provider failure' }));
      else response.destroy();
    });
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url || '/', 'http://controlled.invalid').pathname;
    const authorized = state.mode !== 'auth_failure'
      && (!state.token || bearerHeader(request.headers.authorization) === state.token);
    if (path !== '/rwi/v1' || !authorized) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client, request));
  });
  sockets.on('connection', (socket) => {
    socket.on('message', (raw) => handleRwiMessage(socket, String(raw), state));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('controlled Voice provider address unavailable');
  const baseUrl = `http://${host}:${address.port}`;
  return {
    server,
    state,
    base_url: baseUrl,
    rwi_url: `ws://${host}:${address.port}/rwi/v1`,
    async close() {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

function routeManagement(
  method: string,
  path: string,
  body: unknown,
  state: ControlledVoiceProviderState
): ControlledVoiceProviderResponse {
  if (method === 'GET' && path === '/health') {
    return json(200, {
      ready: true,
      database: 'postgres',
      capabilities: state.mode === 'capability_absence'
        ? { ...CAPABILITIES, queue: false, step_ivr: false }
        : CAPABILITIES
    });
  }
  if (method === 'GET' && path === '/version') return json(200, { version: 'controlled-rustpbx-v1' });
  if (method === 'GET' && path === '/ami/v1/health') {
    return json(200, { ready: true, capabilities: CAPABILITIES });
  }
  if (method === 'POST' && path === '/management/routes/reload') {
    return json(200, { reloaded: true });
  }

  const trunkTest = resourcePath(path, /^\/management\/trunks\/([^/]+)\/test$/);
  if (method === 'POST' && trunkTest) {
    return json(200, {
      ready: state.resources.has(`trunk:${trunkTest}`),
      error_code: state.resources.has(`trunk:${trunkTest}`) ? '' : 'not_applied'
    });
  }
  const apply = applyResourcePath(path);
  if (method === 'PUT' && apply) return applyResource(apply.kind, apply.id, body, state);

  const route = resourcePath(path, /^\/management\/routes\/([^/]+)$/);
  if (method === 'POST' && route) {
    return json(200, { action: 'reject', code: 503, reason: 'controlled_route_only' });
  }
  const dialog = resourcePath(path, /^\/ami\/v1\/dialogs\/([^/]+)$/);
  if (method === 'GET' && dialog) {
    const direct = state.calls.get(dialog);
    const matched = direct
      ? [dialog, direct] as const
      : [...state.calls.entries()].find(([, value]) => value.action_id === dialog);
    return json(200, {
      state: matched?.[1].state ?? 'unknown',
      provider_call_id: matched?.[0] ?? ''
    });
  }
  const sipflow = resourcePath(path, /^\/ami\/v1\/sipflow\/([^/]+)$/);
  if (method === 'GET' && sipflow) return json(200, { items: [], provider_call_id: sipflow });
  const recording = resourcePath(path, /^\/management\/recordings\/([^/]+)$/);
  if (method === 'GET' && recording) {
    const found = state.recordings.get(recording);
    return json(200, {
      state: found?.state ?? 'unknown',
      object_ref: found?.object_ref ?? ''
    });
  }
  if (method === 'POST' && path === '/router') {
    return json(200, { action: 'reject', code: 503, reason: 'controlled_route_only' });
  }
  if (method === 'POST' && (path === '/cdr' || path === '/events')) {
    return json(202, { accepted: true });
  }
  return json(404, { error: 'controlled Voice provider route not found' });
}

function applyResource(
  kind: 'trunk' | 'did' | 'extension' | 'route',
  id: string,
  body: unknown,
  state: ControlledVoiceProviderState
): ControlledVoiceProviderResponse {
  const input = record(body);
  if (input.resource_id !== id || !isRecord(input.desired_state)) {
    return json(422, { error: 'resource_id and desired_state are required' });
  }
  const key = `${kind}:${id}`;
  const revision = (state.resources.get(key)?.revision ?? 0) + 1;
  state.resources.set(key, { kind, revision, desired_state: { ...input.desired_state } });
  return json(200, { provider_ref: `controlled:${kind}:${id}`, revision: String(revision), applied: true });
}

function handleRwiMessage(
  socket: WebSocket,
  raw: string,
  state: ControlledVoiceProviderState
): void {
  let message: Record<string, unknown>;
  try {
    message = record(JSON.parse(raw));
  } catch {
    socket.close(1007, 'invalid message');
    return;
  }
  const action = safeIdentifier(message.action);
  const actionId = safeIdentifier(message.action_id);
  if (!action || !actionId) {
    socket.close(1007, 'invalid envelope');
    return;
  }
  if (action === 'session.subscribe') return;
  const replay = state.action_results.get(actionId);
  if (replay) {
    sendJson(socket, { type: 'command_completed', action_id: actionId, action, data: replay });
    return;
  }
  state.action_counts.set(actionId, 1);
  if (state.mode === 'malformed_response') {
    socket.send('{invalid-json');
    return;
  }
  if (state.mode === 'retryable_503' || state.mode === 'capability_absence') {
    sendJson(socket, {
      type: 'command_failed', action_id: actionId, action,
      error_code: state.mode === 'capability_absence' ? 'not_implemented' : 'provider_unavailable'
    });
    return;
  }

  const callId = action === 'call.originate'
    ? `controlled-call:${actionId}`
    : safeIdentifier(record(message.params).call_id) || `controlled-call:${actionId}`;
  const result = { accepted: true, call_id: callId };
  state.action_results.set(actionId, result);
  const complete = () => {
    if (action === 'call.originate') state.calls.set(callId, { state: 'active', action_id: actionId });
    if (action === 'call.hangup') state.calls.set(callId, { state: 'completed', action_id: actionId });
    if (action === 'record.start') {
      state.recordings.set(`recording:${callId}`, {
        state: 'available', object_ref: `controlled://recording:${callId}`
      });
    }
    sendJson(socket, { type: 'command_completed', action_id: actionId, action, data: result });
    emitLifecycle(socket, state, action, actionId, callId);
  };
  if (state.mode === 'delayed_timeout' || state.mode === 'async_success_after_timeout') {
    setTimeout(complete, state.response_delay_ms).unref?.();
    return;
  }
  complete();
}

function emitLifecycle(
  socket: WebSocket,
  state: ControlledVoiceProviderState,
  action: string,
  actionId: string,
  callId: string
): void {
  if (action !== 'call.originate') return;
  const states = state.mode === 'out_of_order_events'
    ? ['answered', 'ringing']
    : ['ringing', 'answered'];
  for (const callState of states) emitEvent(socket, state, callState, actionId, callId);
  if (state.mode === 'duplicate_events') {
    emitEvent(socket, state, 'answered', actionId, callId);
    sendJson(socket, {
      type: 'command_completed', action_id: actionId, action,
      data: state.action_results.get(actionId) ?? {}
    });
  }
}

function emitEvent(
  socket: WebSocket,
  state: ControlledVoiceProviderState,
  callState: string,
  actionId: string,
  callId: string
): void {
  const event = {
    event: 'call_state_change' as const,
    event_id: `controlled-event:${actionId}:${callState}`,
    action_id: actionId,
    call_id: callId,
    state: callState
  };
  state.events.push(event);
  sendJson(socket, event);
}

async function routeHttp(
  request: IncomingMessage,
  response: ServerResponse,
  state: ControlledVoiceProviderState
): Promise<void> {
  const raw = await readBody(request, 2 * 1024 * 1024);
  const body = String(request.headers['content-type'] || '').includes('application/json')
    ? parseJson(raw)
    : {};
  const result = await handleControlledVoiceProviderRequest({
    method: request.method || 'GET',
    path: new URL(request.url || '/', 'http://controlled.invalid').pathname,
    headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [
      key, Array.isArray(value) ? value[0] : value
    ])),
    body
  }, state);
  if (result.delay_ms) await delay(result.delay_ms);
  if (!response.destroyed) write(response, result);
}

function applyResourcePath(path: string): { kind: 'trunk' | 'did' | 'extension' | 'route'; id: string } | null {
  for (const [kind, pattern] of [
    ['trunk', /^\/management\/trunks\/([^/]+)$/],
    ['did', /^\/management\/dids\/([^/]+)$/],
    ['extension', /^\/management\/extensions\/([^/]+)$/],
    ['route', /^\/management\/routes\/([^/]+)$/]
  ] as const) {
    const id = resourcePath(path, pattern);
    if (id) return { kind, id };
  }
  return null;
}

function resourcePath(path: string, pattern: RegExp): string {
  const value = path.match(pattern)?.[1];
  if (!value) return '';
  try {
    const decoded = decodeURIComponent(value);
    return safeIdentifier(decoded);
  } catch {
    return '';
  }
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function json(status: number, value: unknown): ControlledVoiceProviderResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
    delay_ms: 0
  };
}

function invalidJson(): ControlledVoiceProviderResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{invalid-json',
    delay_ms: 0
  };
}

function unauthorized(): ControlledVoiceProviderResponse {
  return json(401, { error: 'controlled Voice provider authentication required' });
}

function bearer(headers: Record<string, string | undefined>): string {
  return bearerHeader(headers.authorization);
}

function bearerHeader(value: string | string[] | undefined): string {
  return String(Array.isArray(value) ? value[0] : value || '').replace(/^Bearer\s+/i, '').trim();
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeIdentifier(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : '';
  return result && result.length <= 256 && !/[\u0000-\u001f\u007f]/.test(result) ? result : '';
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
    if (bytes > maxBytes) throw new Error('request body too large');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function write(response: ServerResponse, result: ControlledVoiceProviderResponse): void {
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

function boundedDelay(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 120_000) {
    throw new Error('controlled Voice response delay is invalid');
  }
  return Number(value);
}

function boundedPort(value: number, allowEphemeral: boolean): number {
  const minimum = allowEphemeral ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > 65_535) {
    throw new Error('controlled Voice provider port is invalid');
  }
  return value;
}

function validatedHost(value: string): string {
  const host = value.trim();
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('controlled Voice provider must bind to loopback');
  }
  return host;
}

function configuredMode(value: string | undefined): ControlledVoiceProviderMode {
  const mode = String(value || 'success') as ControlledVoiceProviderMode;
  if (!MODES.has(mode)) throw new Error('OPC_IVEKIT_CONTROLLED_VOICE_MODE is invalid');
  return mode;
}

async function main(): Promise<void> {
  const host = process.env.OPC_IVEKIT_CONTROLLED_VOICE_HOST || '127.0.0.1';
  const port = boundedPort(Number(process.env.OPC_IVEKIT_CONTROLLED_VOICE_PORT || 8791), false);
  const running = await startControlledVoiceProvider({
    host,
    port,
    state: createControlledVoiceProviderState({
      mode: configuredMode(process.env.OPC_IVEKIT_CONTROLLED_VOICE_MODE),
      token: process.env.OPC_IVEKIT_CONTROLLED_VOICE_TOKEN,
      control_token: process.env.OPC_IVEKIT_CONTROL_TOKEN,
      response_delay_ms: Number(process.env.OPC_IVEKIT_CONTROLLED_VOICE_DELAY_MS || 65_000)
    })
  });
  console.log(JSON.stringify({
    status: 'listening', base_url: running.base_url, rwi_url: running.rwi_url,
    mode: running.state.mode
  }));
  const stop = () => { void running.close().finally(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
