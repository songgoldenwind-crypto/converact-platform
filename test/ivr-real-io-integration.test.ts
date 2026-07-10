/**
 * Real-network IVR I/O integration gate (audit P0 / todo #7 / A-06 E2E-01..04).
 *
 * Unlike ivr-http-request.test.ts / ivr-webhook-request.test.ts / ivr-recording.test.ts
 * (which all replace globalThis.fetch with mocks or inject stub sideEffects), THIS
 * suite stands up a real Node http.Server, points the IVR out-network URLs at it via
 * nodeData.url and process.env.EGRESS_API_URL, and does NOT mock fetch. The whole
 * retry / timeout / branch-routing / variable-write path runs against a real socket.
 *
 * Scaffold reused: test/test-helpers.ts `listenOnRandomPort` (server.listen(0)).
 *
 * This is the falsifiable guardrail for the real side-effects already shipped:
 * ivr-http-request.ts, ivr-webhook-request.ts, ivr-side-effects.ts:157-202. If the
 * retry/abort/branch logic regresses against a real server, these tests turn red —
 * not the mock-only tests, which can pass while the real path is broken.
 */
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, afterEach, before, after } from 'node:test';
import { listenOnRandomPort } from './test-helpers.js';
import { defaultSideEffects } from '../src/agent-runtime/ivr/ivr-side-effects.js';
import { executeHttpRequest } from '../src/agent-runtime/ivr/ivr-http-request.js';
import { executeWebhookRequest, signWebhookBody } from '../src/agent-runtime/ivr/ivr-webhook-request.js';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

type ReqHandler = (req: IncomingMessage, res: ServerResponse, seen: SeenReq[]) => void;
interface SeenReq {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

const servers: import('node:http').Server[] = [];
const envBefore = { ...process.env };
const fetchBefore = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = fetchBefore;
});
after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers.length = 0;
  for (const [k, v] of Object.entries(envBefore)) process.env[k] = v as string;
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

async function startServer(handler: ReqHandler): Promise<{ baseUrl: string; seen: SeenReq[] }> {
  const seen: SeenReq[] = [];
  const srv = createHttpServer(async (req, res) => {
    const bodyRaw = await readBody(req);
    let body: unknown = bodyRaw;
    if (req.headers['content-type']?.includes('json') && bodyRaw) {
      try { body = JSON.parse(bodyRaw); } catch { /* keep raw */ }
    }
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    handler(req, res, seen);
  });
  servers.push(srv);
  const port = await listenOnRandomPort(srv);
  return { baseUrl: `http://127.0.0.1:${port}`, seen };
}

// ─── HTTP node: real retry then success ─────────────────────────────────────
test('HTTP node retries 5xx against real server then succeeds, writes mapped var', async () => {
  let attempts = 0;
  const { baseUrl, seen } = await startServer((_req, res) => {
    attempts++;
    if (attempts < 2) { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { id: 'abc-123' } }));
  });

  const result = await executeHttpRequest(
    {
      method: 'POST',
      url: `${baseUrl}/items`,
      timeoutSec: 5,
      retryCount: 2,
      requestParams: [{ key: 'k', source: 'v' }],
      responseMappings: [{ responsePath: 'data.id', targetVariable: 'item_id' }],
    },
    {}
  );

  assert.equal(result.success, true, 'expected success after retry');
  assert.equal(result.statusCode, 200);
  assert.equal(result.mappedVariables?.item_id, 'abc-123', 'responseMap must write variable against real response');
  assert.equal(seen.length, 2, 'server must observe 2 real attempts (1 fail + 1 success)');
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual(seen[1].body, { k: 'v' }, 'request body must reach real server');
});

// ─── HTTP node: real timeout aborts to timeout branch ───────────────────────
test('HTTP node real slow server aborts → error timeout → advances to timeout edge', async () => {
  const { baseUrl } = await startServer((_req, res) => {
    // Slower than the node's timeoutSec; do not respond, force AbortController.
    setTimeout(() => res.writeHead(204).end(), 3000);
  });

  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'h1',
    variables: [],
    nodes: [
      { id: 'h1', type: 'http', name: 'HTTP', position: { x: 0, y: 0 }, data: { method: 'GET', url: `${baseUrl}/slow`, timeoutSec: 0.2 } },
      { id: 'to', type: 'play', name: 'To', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'to' }] } },
    ],
    edges: [{ id: 'e1', source: 'h1', target: 'to', sourceHandle: 'timeout' }],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), { sideEffects: defaultSideEffects });

  assert.equal(step.nextNodeId, 'to', 'slow HTTP must route to timeout edge');
  assert.equal(step.context.variables.last_branch_handle, 'timeout');
  assert.equal(step.context.variables.http_status, '0');
});

// ─── HTTP node: persistent failure → fail branch + last_error ────────────────
test('HTTP node persistent 500 against real server → fail branch + last_error', async () => {
  const { baseUrl } = await startServer((_req, res) => { res.writeHead(500); res.end('boom'); });

  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'h1',
    variables: [],
    nodes: [
      { id: 'h1', type: 'http', name: 'HTTP', position: { x: 0, y: 0 }, data: { method: 'GET', url: `${baseUrl}/x`, timeoutSec: 5, retryCount: 1 } },
      { id: 'fail', type: 'play', name: 'F', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'f' }] } },
    ],
    edges: [{ id: 'e1', source: 'h1', target: 'fail', sourceHandle: 'fail' }],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), { sideEffects: defaultSideEffects });

  assert.equal(step.nextNodeId, 'fail');
  assert.equal(step.context.variables.last_branch_handle, 'fail');
  assert.equal(step.context.variables.http_status, '500');
  assert.match(step.context.variables.last_error ?? '', /boom|http_failed/);
});

// ─── Webhook node: real HMAC signature reaches server, 200 → success branch ─
test('Webhook node signs body with real HMAC, server verifies, routes success', async () => {
  const secret = 'test-webhook-secret';
  const { baseUrl, seen } = await startServer((req, res) => {
    const sig = req.headers['x-opc-signature'];
    const bodyRaw = seen[seen.length - 1].body as string ?? '';
    // server side re-signs to prove the body that arrived matches the signature
    if (sig && Array.isArray(sig) ? sig[0] : sig) {
      const expected = signWebhookBody(typeof bodyRaw === 'string' ? bodyRaw : JSON.stringify(bodyRaw), secret);
      if ((Array.isArray(sig) ? sig[0] : sig) !== expected) { res.writeHead(401); res.end('bad sig'); return; }
    }
    res.writeHead(200);
    res.end('ok');
  });

  const result = await executeWebhookRequest(
    { url: `${baseUrl}/hook`, method: 'POST', eventType: 'call.ended', hmacSecret: secret, payload: { call_id: 'c1' } },
    {}
  );
  assert.equal(result.success, true);
  assert.equal(result.statusCode, 200);
  assert.equal(seen.length, 1);
  assert.match(String(seen[0].headers['x-opc-signature']), /^sha256=/, 'HMAC header reached real server');
  assert.deepEqual((seen[0].body as { event: string; call_id: string }).call_id, 'c1', 'payload body reached real server');
});

// ─── Webhook node: async fire-and-forget returns 202 without blocking ────────
test('Webhook async mode returns 202 immediately and delivers to real server', async () => {
  let delivered = 0;
  const { baseUrl } = await startServer((_req, res) => { delivered++; res.writeHead(200); res.end('ok'); });

  const result = await executeWebhookRequest(
    { url: `${baseUrl}/hook`, method: 'POST', eventType: 'e1', async: true, hmacSecret: undefined, timeoutSec: 5 },
    {}
  );
  assert.equal(result.statusCode, 202, 'async webhook returns 202 without awaiting delivery');
  assert.equal(result.success, true);
  // fire-and-forget resolves on next tick; give it a beat.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(delivered, 1, 'real server must still receive the async webhook');
});

// ─── Webhook node: real 404 (non-5xx) → fail branch, no retry ────────────────
test('Webhook non-retryable 404 against real server → fail branch', async () => {
  const { baseUrl, seen } = await startServer((_req, res) => { res.writeHead(404); res.end('nf'); });

  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'w1',
    variables: [],
    nodes: [
      { id: 'w1', type: 'webhook', name: 'WH', position: { x: 0, y: 0 }, data: { url: `${baseUrl}/hook`, method: 'POST', timeoutSec: 5, retryCount: 3 } },
      { id: 'fail', type: 'play', name: 'F', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'f' }] } },
    ],
    edges: [{ id: 'e1', source: 'w1', target: 'fail', sourceHandle: 'fail' }],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), { sideEffects: defaultSideEffects });

  assert.equal(step.nextNodeId, 'fail');
  assert.equal(step.context.variables.last_branch_handle, 'fail');
  assert.equal(step.context.variables.webhook_status, '404');
  assert.equal(seen.length, 1, '404 is non-retryable — server must see exactly 1 request despite retryCount=3');
});

// ─── Recording node: real egress start/stop round-trip ───────────────────────
test('Recording executeRecording start+stop hits real egress server, persists egress_id', async () => {
  const { baseUrl, seen } = await startServer((req, res) => {
    if (req.url === '/recordings/start') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ egress_id: 'eg-xyz' }));
      return;
    }
    if (req.url === '/recordings/stop') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ recording_url: 'https://minio.local/eg-xyz.wav' }));
      return;
    }
    res.writeHead(404).end();
  });

  process.env.EGRESS_API_URL = baseUrl;
  const roomName = 'room-test-1';
  const start = await defaultSideEffects.executeRecording!(
    { action: 'start', format: 'wav' }, 'call-session-1', roomName, {}
  );
  assert.equal(start.success, true, 'recording start must succeed against real egress');
  assert.equal(start.egressId, 'eg-xyz');

  const stop = await defaultSideEffects.executeRecording!(
    { action: 'stop', format: 'wav' }, 'call-session-1', roomName, { egress_id: 'eg-xyz' }
  );
  assert.equal(stop.success, true, 'recording stop must succeed against real egress');
  assert.equal(stop.recordingUrl, 'https://minio.local/eg-xyz.wav');

  assert.equal(seen.length, 2, 'egress server must observe both start and stop');
  assert.equal(seen[0].url, '/recordings/start');
  assert.equal(seen[1].url, '/recordings/stop');
  assert.deepEqual((seen[0].body as { room_name: string; format: string }).format, 'wav', 'format reached real egress');
});

// ─── Recording node: egress 500 → failure surfaces ──────────────────────────
test('Recording executeRecording start against failing egress → success=false', async () => {
  const { baseUrl } = await startServer((_req, res) => { res.writeHead(500); res.end('egress down'); });
  process.env.EGRESS_API_URL = baseUrl;

  const result = await defaultSideEffects.executeRecording!(
    { action: 'start', format: 'wav' }, 'cs-2', 'room-down', {}
  );
  assert.equal(result.success, false, 'egress 500 must surface as failure, not false green');
  assert.equal(result.egressId, undefined);
});