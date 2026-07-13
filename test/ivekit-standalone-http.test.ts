import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIveKitHttpServer } from '../src/agent-runtime/ivekit/index.js';
import { createDatabase } from '../src/db.js';
import { MemoryPg, type PgQueryable } from '../src/db-pg.js';
import { getPgTenantContext } from '../src/db-pg-tenant.js';
import { listenOnRandomPort } from './test-helpers.js';

test('standalone iveKit server exposes only approved routes', async (t) => {
  const calls: string[] = [];
  const intelligenceCalls: string[] = [];
  const contactCenterCalls: string[] = [];
  const collaborationCalls: string[] = [];
  const db = createDatabase(':memory:');
  const server = createIveKitHttpServer({
    db,
    pg: null,
    routes: {
      media: async (_db, _method, path) => {
        calls.push(path);
        return path === '/api/ivekit/media/capabilities'
          ? { data: { media: true } }
          : undefined;
      },
      intelligence: async (_pg, _method, path) => {
        intelligenceCalls.push(path);
        return path === '/api/ivekit/intelligence/capabilities'
          ? { data: { intelligence: true } }
          : undefined;
      },
      chat: async () => undefined,
      contactCenter: async (_pg, _method, path) => {
        contactCenterCalls.push(path);
        return path === '/api/ivekit/contact-center/capabilities'
          ? { data: { contact_center: true } }
          : undefined;
      },
      collaboration: async (_pg, _method, path) => {
        collaborationCalls.push(path);
        return path === '/api/ivekit/context/by-ref'
          ? { data: { business_ref: { type: 'service_order', id: 'SO-1' } } }
          : undefined;
      }
    }
  });

  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  const capabilities = await fetch(`${baseUrl}/api/ivekit/media/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.deepEqual(await capabilities.json(), { media: true });

  const context = await fetch(
    `${baseUrl}/api/ivekit/context/by-ref?business_ref_type=service_order&business_ref_id=SO-1`
  );
  assert.equal(context.status, 200);
  assert.deepEqual(await context.json(), { business_ref: { type: 'service_order', id: 'SO-1' } });

  const intelligence = await fetch(`${baseUrl}/api/ivekit/intelligence/capabilities`);
  assert.equal(intelligence.status, 200);
  assert.deepEqual(await intelligence.json(), { intelligence: true });

  const contactCenter = await fetch(`${baseUrl}/api/ivekit/contact-center/capabilities`);
  assert.equal(contactCenter.status, 200);
  assert.deepEqual(await contactCenter.json(), { contact_center: true });

  const unrelated = await fetch(`${baseUrl}/api/call-center/dashboard`);
  assert.equal(unrelated.status, 404);
  assert.deepEqual(calls, [
    '/api/ivekit/media/capabilities',
    '/api/ivekit/context/by-ref',
    '/api/ivekit/intelligence/capabilities',
    '/api/ivekit/contact-center/capabilities'
  ]);
  assert.deepEqual(collaborationCalls, ['/api/ivekit/context/by-ref']);
  assert.deepEqual(intelligenceCalls, [
    '/api/ivekit/context/by-ref',
    '/api/ivekit/intelligence/capabilities',
    '/api/ivekit/contact-center/capabilities'
  ]);
  assert.deepEqual(contactCenterCalls, ['/api/ivekit/contact-center/capabilities']);
});

test('standalone iveKit server exposes Prometheus metrics', async (t) => {
  const db = createDatabase(':memory:');
  const server = createIveKitHttpServer({ db, pg: null });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  const port = await listenOnRandomPort(server);
  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/plain/);
  assert.match(await response.text(), /opc_node_/);
});

test('standalone iveKit server preserves bounded attachment bytes', async (t) => {
  const previousLimit = process.env.OPC_COLLABORATION_ATTACHMENT_MAX_BYTES;
  process.env.OPC_COLLABORATION_ATTACHMENT_MAX_BYTES = '4';
  const received: Buffer[] = [];
  const db = createDatabase(':memory:');
  const server = createIveKitHttpServer({
    db,
    pg: null,
    routes: {
      media: async () => undefined,
      chat: async (_pg, _method, _path, _url, body, rawBody) => {
        assert.equal(body, null);
        assert.ok(Buffer.isBuffer(rawBody));
        received.push(rawBody as Buffer);
        return { status: 201, data: { size: (rawBody as Buffer).length } };
      },
      collaboration: async () => undefined
    }
  });

  t.after(async () => {
    if (previousLimit === undefined) delete process.env.OPC_COLLABORATION_ATTACHMENT_MAX_BYTES;
    else process.env.OPC_COLLABORATION_ATTACHMENT_MAX_BYTES = previousLimit;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  const port = await listenOnRandomPort(server);
  const path = '/api/ivekit/chat/sessions/session-1/attachments/upload?kind=file&filename=a.txt';
  const accepted = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('1234')
  });
  assert.equal(accepted.status, 201);
  assert.deepEqual(await accepted.json(), { size: 4 });
  assert.equal(received[0]?.toString('utf8'), '1234');

  const rejected = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('12345')
  });
  assert.equal(rejected.status, 413);
  assert.equal(received.length, 1);
});

test('standalone iveKit server parses JSON request bodies', async (t) => {
  const db = createDatabase(':memory:');
  const server = createIveKitHttpServer({
    db,
    pg: null,
    routes: {
      media: async (_db, _method, _path, _url, body) => ({ status: 201, data: body }),
      chat: async () => undefined,
      collaboration: async () => undefined
    }
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  const port = await listenOnRandomPort(server);
  const response = await fetch(`http://127.0.0.1:${port}/api/ivekit/media/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ purpose: 'video_service', room_name: 'room-json' })
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { purpose: 'video_service', room_name: 'room-json' });
});

test('standalone iveKit server preserves LiveKit webhook raw body', async (t) => {
  const db = createDatabase(':memory:');
  const rawPayload = '{"event":"participant_joined","room":{"name":"room-1"}}';
  const routedPaths: string[] = [];
  const server = createIveKitHttpServer({
    db,
    pg: null,
    routes: {
      media: async (_db, _method, path, _url, body, rawBody) => {
        assert.equal(body, rawPayload);
        assert.equal(rawBody, rawPayload);
        routedPaths.push(path);
        return { data: { received: true } };
      },
      chat: async () => undefined,
      collaboration: async () => undefined
    }
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  const port = await listenOnRandomPort(server);
  for (const path of ['/api/ivekit/media/webhooks/livekit', '/api/media/webhooks/livekit']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer signed-livekit-webhook',
        'content-type': 'application/webhook+json'
      },
      body: rawPayload
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true });
  }
  assert.deepEqual(routedPaths, [
    '/api/ivekit/media/webhooks/livekit',
    '/api/ivekit/media/webhooks/livekit'
  ]);
});

test('standalone iveKit server enters the tenant PostgreSQL context', async (t) => {
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'standalone-tenant-key';
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const server = createIveKitHttpServer({
    db,
    pg,
    routes: {
      media: async () => {
        assert.equal(getPgTenantContext().tenantId, 'tenant-standalone');
        return { data: { tenant_context: getPgTenantContext().tenantId } };
      },
      chat: async () => undefined,
      collaboration: async () => undefined
    }
  });
  t.after(async () => {
    if (previousApiKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previousApiKey;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  const port = await listenOnRandomPort(server);
  const response = await fetch(`http://127.0.0.1:${port}/api/ivekit/media/capabilities`, {
    headers: {
      'x-api-key': 'standalone-tenant-key',
      'x-tenant-id': 'tenant-standalone',
      'x-user-id': 'engineer-1'
    }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { tenant_context: 'tenant-standalone' });
});

test('standalone iveKit media calls receive the request-scoped PostgreSQL client', async (t) => {
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'standalone-scoped-pg-key';
  const db = createDatabase(':memory:');
  const queries: string[] = [];
  const client = {
    release: () => undefined,
    query: async (text: string) => {
      queries.push(text.replace(/\s+/g, ' ').trim());
      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
    }
  };
  const pool = {
    connect: async () => client,
    query: client.query
  } as unknown as PgQueryable;
  const server = createIveKitHttpServer({
    db,
    pg: pool,
    routes: {
      media: async (_db, _method, _path, _url, _body, _rawBody, _headers, options) => {
        assert.equal(options.pg, client);
        return {
          data: { scoped: true },
          afterCommit: () => {
            queries.push('AFTER_COMMIT');
          }
        };
      },
      chat: async () => undefined,
      collaboration: async () => undefined
    }
  });
  t.after(async () => {
    if (previousApiKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previousApiKey;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  const port = await listenOnRandomPort(server);
  const response = await fetch(`http://127.0.0.1:${port}/api/ivekit/media/capabilities`, {
    headers: {
      'x-api-key': 'standalone-scoped-pg-key',
      'x-tenant-id': 'tenant-scoped-pg',
      'x-user-id': 'engineer-scoped-pg'
    }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { scoped: true });
  assert.equal(queries.some((query) => query === 'BEGIN'), true);
  assert.equal(queries.some((query) => query.includes("set_config('app.current_tenant'")), true);
  assert.equal(queries.some((query) => query === 'COMMIT'), true);
  assert.equal(queries.indexOf('COMMIT') < queries.indexOf('AFTER_COMMIT'), true);
});

test('standalone iveKit server preserves HTML and binary responses', async (t) => {
  const db = createDatabase(':memory:');
  const server = createIveKitHttpServer({
    db,
    pg: null,
    routes: {
      media: async (_db, method, path) => {
        if (method === 'GET' && path.endsWith('/export')) {
          return {
            status: 200,
            data: Buffer.from('recording-bytes'),
            contentType: 'video/mp4',
            headers: { 'content-disposition': 'attachment; filename="recording.mp4"' }
          };
        }
        return undefined;
      },
      chat: async () => undefined,
      collaboration: async (_pg, method, path) => method === 'GET' && path === '/remote/rustdesk/launch'
        ? { html: '<!doctype html><h1>RustDesk launch</h1>' }
        : undefined
    }
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  const port = await listenOnRandomPort(server);
  const launch = await fetch(`http://127.0.0.1:${port}/remote/rustdesk/launch`);
  assert.equal(launch.status, 200);
  assert.match(launch.headers.get('content-type') || '', /^text\/html/);
  assert.match(await launch.text(), /RustDesk launch/);

  const recording = await fetch(`http://127.0.0.1:${port}/api/ivekit/media/recordings/rec-1/export`);
  assert.equal(recording.status, 200);
  assert.equal(recording.headers.get('content-type'), 'video/mp4');
  assert.equal(recording.headers.get('content-disposition'), 'attachment; filename="recording.mp4"');
  assert.equal(Buffer.from(await recording.arrayBuffer()).toString('utf8'), 'recording-bytes');
});

test('standalone iveKit server returns safe structured errors', async (t) => {
  const db = createDatabase(':memory:');
  const server = createIveKitHttpServer({
    db,
    pg: null,
    routes: {
      media: async (_db, _method, path) => {
        if (path.endsWith('/known-error')) {
          throw Object.assign(new Error('room is closed'), { status: 409 });
        }
        throw new Error('database password leaked');
      },
      chat: async () => undefined,
      collaboration: async () => undefined
    }
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  const port = await listenOnRandomPort(server);
  const known = await fetch(`http://127.0.0.1:${port}/api/ivekit/media/known-error`);
  assert.equal(known.status, 409);
  assert.deepEqual(await known.json(), { error: { message: 'room is closed', status: 409 } });

  const internal = await fetch(`http://127.0.0.1:${port}/api/ivekit/media/internal-error`);
  assert.equal(internal.status, 500);
  const internalBody = await internal.json() as { error: { message: string; status: number } };
  assert.deepEqual(internalBody, { error: { message: 'internal server error', status: 500 } });
  assert.doesNotMatch(JSON.stringify(internalBody), /password leaked/);
});

test('standalone iveKit server bounds every non-attachment request body', async (t) => {
  const previousLimit = process.env.OPC_IVEKIT_HTTP_BODY_MAX_BYTES;
  process.env.OPC_IVEKIT_HTTP_BODY_MAX_BYTES = '6';
  const db = createDatabase(':memory:');
  const server = createIveKitHttpServer({ db, pg: null });
  t.after(async () => {
    if (previousLimit === undefined) delete process.env.OPC_IVEKIT_HTTP_BODY_MAX_BYTES;
    else process.env.OPC_IVEKIT_HTTP_BODY_MAX_BYTES = previousLimit;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  const port = await listenOnRandomPort(server);
  for (const path of ['/api/ivekit/media/rooms', '/api/ivekit/media/webhooks/livekit']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}'
    });
    assert.equal(response.status, 413);
  }
});

test('standalone iveKit server rejects malformed JSON before routing', async (t) => {
  let routeCalls = 0;
  const db = createDatabase(':memory:');
  const server = createIveKitHttpServer({
    db,
    pg: null,
    routes: {
      media: async () => {
        routeCalls += 1;
        return { data: { unexpected: true } };
      },
      chat: async () => undefined,
      collaboration: async () => undefined
    }
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  const port = await listenOnRandomPort(server);
  const response = await fetch(`http://127.0.0.1:${port}/api/ivekit/media/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"broken"'
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { message: 'invalid_json', status: 400 } });
  assert.equal(routeCalls, 0);
});

test('standalone iveKit server handles configured browser CORS preflight', async (t) => {
  const previousOrigins = process.env.OPC_IVEKIT_ALLOWED_ORIGINS;
  process.env.OPC_IVEKIT_ALLOWED_ORIGINS = 'https://led.example.com';
  const db = createDatabase(':memory:');
  const server = createIveKitHttpServer({
    db,
    pg: null,
    routes: {
      media: async () => ({ data: { ok: true } }),
      chat: async () => undefined,
      collaboration: async () => undefined
    }
  });
  t.after(async () => {
    if (previousOrigins === undefined) delete process.env.OPC_IVEKIT_ALLOWED_ORIGINS;
    else process.env.OPC_IVEKIT_ALLOWED_ORIGINS = previousOrigins;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  const port = await listenOnRandomPort(server);
  const url = `http://127.0.0.1:${port}/api/ivekit/media/capabilities`;
  const preflight = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://led.example.com',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization,x-tenant-id'
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://led.example.com');
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /authorization/i);

  const allowed = await fetch(url, { headers: { origin: 'https://led.example.com' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://led.example.com');

  const rejected = await fetch(url, { headers: { origin: 'https://evil.example.com' } });
  assert.equal(rejected.status, 403);
});

test('standalone iveKit server injects standalone media hooks', async (t) => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const server = createIveKitHttpServer({
    db,
    pg,
    routes: {
      media: async (_db, _method, _path, _url, _body, _rawBody, _headers, options) => {
        assert.equal(typeof options.onRecordingStarted, 'function');
        assert.equal(typeof options.onRecordingCompleted, 'function');
        assert.equal(typeof options.onRecordingDeleted, 'function');
        assert.equal(typeof options.onRecordingAudit, 'function');
        assert.equal(typeof options.resolveRecordingObject, 'function');
        assert.equal(typeof options.resolveRecordingObjectStream, 'function');
        assert.equal(typeof options.deleteRecordingObject, 'function');
        return { data: { hooks: true } };
      },
      chat: async () => undefined,
      collaboration: async () => undefined
    }
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  const port = await listenOnRandomPort(server);
  const response = await fetch(`http://127.0.0.1:${port}/api/ivekit/media/capabilities`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { hooks: true });
});
