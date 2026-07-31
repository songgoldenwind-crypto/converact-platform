import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IngressInfo, IngressInput } from 'livekit-server-sdk';

import { routeIveKitMediaApi } from '../src/agent-runtime/converact/media-http.js';
import { LiveKitSdkIngressProvider } from '../src/agent-runtime/livekit/livekit-ingress-provider.js';
import type {
  LiveKitIngressCreateCommand,
  LiveKitIngressRecord,
  LiveKitIngressProvider,
  LiveKitIngressUpdateCommand
} from '../src/agent-runtime/livekit/livekit-ingress-provider.js';
import { createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken, type AuthRole } from '../src/middleware/auth.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { createIveKitHttpSdk } from '../sdk/converact/src/http-sdk.js';

class FakeIngressProvider implements LiveKitIngressProvider {
  readonly records = new Map<string, LiveKitIngressRecord>();
  createCalls = 0;

  async create(input: LiveKitIngressCreateCommand): Promise<LiveKitIngressRecord> {
    this.createCalls += 1;
    const record: LiveKitIngressRecord = {
      ingress_id: `IN_${this.createCalls}`,
      name: input.name || '',
      stream_key: `stream-${this.createCalls}`,
      url: input.input_type === 'url' ? input.url || '' : `${input.input_type}://ingress.example.com/live`,
      input_type: input.input_type,
      enable_transcoding: input.enable_transcoding,
      room_name: input.room_name,
      participant_identity: input.participant_identity,
      participant_name: input.participant_name || '',
      participant_metadata: input.participant_metadata || {},
      reusable: true,
      enabled: true,
      state: null,
      ownership: input.ownership
    };
    this.records.set(record.ingress_id, record);
    return record;
  }

  async list(input: { room_name?: string; ingress_id?: string }): Promise<LiveKitIngressRecord[]> {
    return [...this.records.values()].filter((record) =>
      (!input.room_name || record.room_name === input.room_name) &&
      (!input.ingress_id || record.ingress_id === input.ingress_id)
    );
  }

  async update(input: LiveKitIngressUpdateCommand): Promise<LiveKitIngressRecord> {
    const current = this.records.get(input.ingress_id);
    assert.ok(current);
    const updated: LiveKitIngressRecord = {
      ...current,
      name: input.name,
      room_name: input.room_name,
      participant_identity: input.participant_identity,
      participant_name: input.participant_name,
      participant_metadata: input.participant_metadata,
      enable_transcoding: input.enable_transcoding,
      ownership: input.ownership
    };
    this.records.set(updated.ingress_id, updated);
    return updated;
  }

  async delete(ingressId: string): Promise<LiveKitIngressRecord> {
    const record = this.records.get(ingressId);
    assert.ok(record);
    this.records.delete(ingressId);
    return record;
  }
}

function headers(tenantId: string, role: AuthRole = 'owner', idempotencyKey?: string) {
  return {
    authorization: `Bearer ${signAccessToken({ sub: `${role}-user`, tid: tenantId, role })}`,
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
  };
}

async function route(
  db: unknown,
  pg: MemoryPg,
  provider: LiveKitIngressProvider,
  method: string,
  path: string,
  body: unknown,
  requestHeaders: Record<string, string>
) {
  return routeIveKitMediaApi(
    db,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    requestHeaders,
    { pg, ingressProvider: provider }
  );
}

test('iveKit LiveKit Ingress API is tenant fenced, idempotent and complete', async () => {
  const jwtSecret = process.env.CONVERACT_JWT_SECRET;
  process.env.CONVERACT_JWT_SECRET = 'ingress-api-test-secret';
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const provider = new FakeIngressProvider();
  const tenantA = createTenant(db, { name: 'Ingress tenant A' }).id;
  const tenantB = createTenant(db, { name: 'Ingress tenant B' }).id;
  try {
    await route(db, pg, provider, 'POST', '/api/ivekit/media/rooms', {
      room_name: 'ingress-room-a', purpose: 'video_service'
    }, headers(tenantA));

    const created = await route(db, pg, provider, 'POST', '/api/ivekit/media/ingresses', {
      input_type: 'rtmp',
      room_name: 'ingress-room-a',
      participant_identity: 'encoder-a',
      participant_name: 'Encoder A',
      participant_metadata: { source: 'led-camera' },
      enable_transcoding: true
    }, headers(tenantA, 'owner', 'create-ingress-a')) as {
      status: number;
      data: LiveKitIngressRecord & { replayed: boolean };
    };
    assert.equal(created.status, 201);
    assert.equal(created.data.ingress_id, 'IN_1');
    assert.equal(created.data.replayed, false);
    assert.equal(created.data.ownership, undefined);
    assert.deepEqual(created.data.participant_metadata, { source: 'led-camera' });

    const replay = await route(db, pg, provider, 'POST', '/api/ivekit/media/ingresses', {
      input_type: 'rtmp',
      room_name: 'ingress-room-a',
      participant_identity: 'encoder-a',
      participant_name: 'Encoder A',
      participant_metadata: { source: 'led-camera' },
      enable_transcoding: true
    }, headers(tenantA, 'owner', 'create-ingress-a')) as {
      status: number;
      data: LiveKitIngressRecord & { replayed: boolean };
    };
    assert.equal(replay.status, 200);
    assert.equal(replay.data.ingress_id, 'IN_1');
    assert.equal(replay.data.replayed, true);
    assert.equal(provider.createCalls, 1);

    await assert.rejects(
      () => route(db, pg, provider, 'POST', '/api/ivekit/media/ingresses', {
        input_type: 'rtmp', room_name: 'ingress-room-a',
        participant_identity: 'different-encoder', enable_transcoding: true
      }, headers(tenantA, 'owner', 'create-ingress-a')),
      (error: any) => error?.status === 409
    );

    const listed = await route(
      db, pg, provider, 'GET',
      '/api/ivekit/media/ingresses?room_name=ingress-room-a', null, headers(tenantA)
    ) as { data: LiveKitIngressRecord[] };
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0]?.ingress_id, 'IN_1');

    await assert.rejects(
      () => route(db, pg, provider, 'GET', '/api/ivekit/media/ingresses/IN_1', null, headers(tenantB)),
      (error: any) => error?.status === 404
    );

    const updated = await route(db, pg, provider, 'PATCH', '/api/ivekit/media/ingresses/IN_1', {
      name: 'Updated encoder', participant_name: 'Encoder A2'
    }, headers(tenantA)) as { data: LiveKitIngressRecord };
    assert.equal(updated.data.name, 'Updated encoder');
    assert.equal(updated.data.participant_name, 'Encoder A2');

    await assert.rejects(
      () => route(db, pg, provider, 'POST', '/api/ivekit/media/ingresses', {
        input_type: 'whip', room_name: 'ingress-room-a', participant_identity: 'viewer-encoder'
      }, headers(tenantA, 'viewer', 'viewer-create')),
      (error: any) => error?.status === 403
    );

    const deleted = await route(
      db, pg, provider, 'DELETE', '/api/ivekit/media/ingresses/IN_1', null, headers(tenantA)
    ) as { data: LiveKitIngressRecord };
    assert.equal(deleted.data.ingress_id, 'IN_1');
    assert.equal(provider.records.size, 0);
  } finally {
    db.close();
    if (jwtSecret === undefined) delete process.env.CONVERACT_JWT_SECRET;
    else process.env.CONVERACT_JWT_SECRET = jwtSecret;
  }
});

test('iveKit LiveKit Ingress SDK sends complete lifecycle requests', async () => {
  const calls: Array<{ method: string; path: string; idempotencyKey: string }> = [];
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    calls.push({
      method: init.method || 'GET',
      path: `${new URL(String(input)).pathname}${new URL(String(input)).search}`,
      idempotencyKey: new Headers(init.headers).get('idempotency-key') || ''
    });
    return new Response(JSON.stringify({ ingress_id: 'IN_sdk' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const sdk = createIveKitHttpSdk({
    baseUrl: 'https://opc.example.com', tenantId: 'tenant-sdk', apiKey: 'key', fetch
  });

  await sdk.media.createIngress({
    input_type: 'whip', room_name: 'room-sdk', participant_identity: 'encoder-sdk'
  }, { idempotencyKey: 'ingress-sdk-create' });
  await sdk.media.listIngresses({ room_name: 'room-sdk' });
  await sdk.media.getIngress('IN_sdk');
  await sdk.media.updateIngress('IN_sdk', { name: 'updated' });
  await sdk.media.deleteIngress('IN_sdk');

  assert.deepEqual(calls, [
    { method: 'POST', path: '/api/ivekit/media/ingresses', idempotencyKey: 'ingress-sdk-create' },
    { method: 'GET', path: '/api/ivekit/media/ingresses?room_name=room-sdk', idempotencyKey: '' },
    { method: 'GET', path: '/api/ivekit/media/ingresses/IN_sdk', idempotencyKey: '' },
    { method: 'PATCH', path: '/api/ivekit/media/ingresses/IN_sdk', idempotencyKey: '' },
    { method: 'DELETE', path: '/api/ivekit/media/ingresses/IN_sdk', idempotencyKey: '' }
  ]);
});

test('LiveKit SDK Ingress provider preserves trusted ownership and maps the complete admin lifecycle', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const ownership = {
    tenant_id: 'tenant-provider',
    actor_id: 'operator-provider',
    idempotency_key_hash: 'key-hash',
    request_hash: 'request-hash'
  };
  const info = (metadata: string, overrides: Partial<IngressInfo> = {}) => new IngressInfo({
    ingressId: 'IN_provider',
    name: 'Provider source',
    streamKey: 'provider-stream-key',
    url: 'https://media.example.com/live.m3u8',
    inputType: IngressInput.URL_INPUT,
    enableTranscoding: true,
    roomName: 'provider-room',
    participantIdentity: 'provider-source',
    participantName: 'Provider Source',
    participantMetadata: metadata,
    reusable: true,
    enabled: true,
    ...overrides
  });
  let currentMetadata = '';
  const provider = new LiveKitSdkIngressProvider({
    async createIngress(inputType: IngressInput, options: { participantMetadata?: string }) {
      calls.push({ operation: 'create', value: { inputType, options } });
      currentMetadata = options.participantMetadata || '';
      return info(currentMetadata);
    },
    async listIngress(options: unknown) {
      calls.push({ operation: 'list', value: options });
      return [info(currentMetadata)];
    },
    async updateIngress(ingressId: string, options: { participantMetadata?: string }) {
      calls.push({ operation: 'update', value: { ingressId, options } });
      currentMetadata = options.participantMetadata || '';
      return info(currentMetadata, { name: 'Updated provider source' });
    },
    async deleteIngress(ingressId: string) {
      calls.push({ operation: 'delete', value: ingressId });
      return info(currentMetadata);
    }
  } as never);

  const created = await provider.create({
    input_type: 'url',
    room_name: 'provider-room',
    participant_identity: 'provider-source',
    participant_name: 'Provider Source',
    participant_metadata: { source: 'trusted-cdn' },
    enable_transcoding: true,
    url: 'https://media.example.com/live.m3u8',
    ownership
  });
  assert.equal(created.input_type, 'url');
  assert.deepEqual(created.participant_metadata, { source: 'trusted-cdn' });
  assert.deepEqual(created.ownership, ownership);
  const encoded = JSON.parse(currentMetadata) as Record<string, unknown>;
  assert.deepEqual(encoded.application, { source: 'trusted-cdn' });
  assert.deepEqual(encoded.ivekit, { version: 1, ...ownership });

  const listed = await provider.list({ room_name: 'provider-room', ingress_id: 'IN_provider' });
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0]?.ownership, ownership);
  const updated = await provider.update({
    ingress_id: 'IN_provider',
    name: 'Updated provider source',
    room_name: 'provider-room',
    participant_identity: 'provider-source',
    participant_name: 'Provider Source 2',
    participant_metadata: { source: 'trusted-cdn-v2' },
    enable_transcoding: true,
    ownership
  });
  assert.equal(updated.name, 'Updated provider source');
  assert.deepEqual(updated.participant_metadata, { source: 'trusted-cdn-v2' });
  await provider.delete('IN_provider');

  assert.deepEqual(calls.map((call) => call.operation), ['create', 'list', 'update', 'delete']);
  assert.equal(
    (calls[0]?.value as { inputType: IngressInput }).inputType,
    IngressInput.URL_INPUT
  );
});

test('URL ingress fails closed on transport, allowlist and private-address policy', async () => {
  const previous = {
    jwtSecret: process.env.CONVERACT_JWT_SECRET,
    allowlist: process.env.CONVERACT_LIVEKIT_INGRESS_PULL_HOST_ALLOWLIST,
    allowHttp: process.env.CONVERACT_LIVEKIT_INGRESS_ALLOW_HTTP_URL
  };
  process.env.CONVERACT_JWT_SECRET = 'ingress-url-policy-test-secret';
  delete process.env.CONVERACT_LIVEKIT_INGRESS_PULL_HOST_ALLOWLIST;
  delete process.env.CONVERACT_LIVEKIT_INGRESS_ALLOW_HTTP_URL;
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const provider = new FakeIngressProvider();
  const tenantId = createTenant(db, { name: 'Ingress URL tenant' }).id;
  const createUrlIngress = (url: string, idempotencyKey: string) => route(
    db,
    pg,
    provider,
    'POST',
    '/api/ivekit/media/ingresses',
    {
      input_type: 'url',
      room_name: 'ingress-url-room',
      participant_identity: 'url-source',
      enable_transcoding: true,
      url
    },
    headers(tenantId, 'owner', idempotencyKey)
  );

  try {
    await route(db, pg, provider, 'POST', '/api/ivekit/media/rooms', {
      room_name: 'ingress-url-room', purpose: 'video_service'
    }, headers(tenantId));

    await assert.rejects(
      () => createUrlIngress('https://media.example.com/live.m3u8', 'url-no-allowlist'),
      (error: any) => error?.status === 400 && /allowlisted/.test(error.message)
    );

    process.env.CONVERACT_LIVEKIT_INGRESS_PULL_HOST_ALLOWLIST = '*.example.com,127.0.0.1';
    await assert.rejects(
      () => createUrlIngress('http://media.example.com/live.m3u8', 'url-http'),
      (error: any) => error?.status === 400 && /https/.test(error.message)
    );
    await assert.rejects(
      () => createUrlIngress('https://127.0.0.1/live.m3u8', 'url-private'),
      (error: any) => error?.status === 400 && /private IP literal/.test(error.message)
    );
    await assert.rejects(
      () => createUrlIngress('https://user:secret@media.example.com/live.m3u8', 'url-credentials'),
      (error: any) => error?.status === 400 && /credentials/.test(error.message)
    );

    const accepted = await createUrlIngress(
      'https://media.example.com/live.m3u8',
      'url-allowlisted'
    ) as { status: number; data: LiveKitIngressRecord };
    assert.equal(accepted.status, 201);
    assert.equal(accepted.data.url, 'https://media.example.com/live.m3u8');
    assert.equal(provider.createCalls, 1);
  } finally {
    db.close();
    if (previous.jwtSecret === undefined) delete process.env.CONVERACT_JWT_SECRET;
    else process.env.CONVERACT_JWT_SECRET = previous.jwtSecret;
    if (previous.allowlist === undefined) delete process.env.CONVERACT_LIVEKIT_INGRESS_PULL_HOST_ALLOWLIST;
    else process.env.CONVERACT_LIVEKIT_INGRESS_PULL_HOST_ALLOWLIST = previous.allowlist;
    if (previous.allowHttp === undefined) delete process.env.CONVERACT_LIVEKIT_INGRESS_ALLOW_HTTP_URL;
    else process.env.CONVERACT_LIVEKIT_INGRESS_ALLOW_HTTP_URL = previous.allowHttp;
  }
});
