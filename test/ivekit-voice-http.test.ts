import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { createIveKitHttpServer } from '../src/agent-runtime/ivekit/index.js';
import {
  VoiceError,
  routeIveKitVoiceApi,
  type VoiceExtension,
  type VoiceHttpModule
} from '../src/agent-runtime/ivekit/voice/index.js';
import { createDatabase } from '../src/db.js';
import type { PgQueryable } from '../src/db-pg.js';
import { getPgTenantContext } from '../src/db-pg-tenant.js';
import { signAccessToken } from '../src/middleware/auth.js';
import { listenOnRandomPort } from './test-helpers.js';

const NOW = '2026-07-13T09:00:00.000Z';

test('standalone server routes Voice before collaboration and never trusts webhook tenant headers', async (t) => {
  const auth = installJwtAuth(t);
  const db = createDatabase(':memory:');
  const queries: string[] = [];
  const pool = recordingPool(queries);
  const routed: string[] = [];
  const server = createIveKitHttpServer({
    db,
    pg: pool,
    routes: {
      voice: async (_pg, _method, path) => {
        routed.push(`voice:${path}:${getPgTenantContext().tenantId || ''}`);
        return { data: { route: 'voice' } };
      },
      ivr: async (_pg, _method, path) => {
        routed.push(`ivr:${path}:${getPgTenantContext().tenantId || ''}`);
        return { data: { type: 'hangup' } };
      },
      media: async () => undefined,
      chat: async () => undefined,
      intelligence: async () => undefined,
      events: async () => undefined,
      collaboration: async (_pg, _method, path) => {
        routed.push(`collaboration:${path}`);
        return { data: { route: 'collaboration' } };
      }
    }
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  const normal = await fetch(`${baseUrl}/api/ivekit/voice/profiles`, {
    headers: { authorization: `Bearer ${auth.token}` }
  });
  assert.equal(normal.status, 200);
  assert.deepEqual(await normal.json(), { route: 'voice' });

  const webhook = await fetch(`${baseUrl}/api/ivekit/voice/providers/profile-a/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-attacker' },
    body: JSON.stringify({ event_id: 'event-a' })
  });
  assert.equal(webhook.status, 200);
  const ivrWebhook = await fetch(
    `${baseUrl}/api/ivekit/ivr/provider-webhooks/rustpbx/profile-a/step`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-attacker' },
      body: JSON.stringify({ profile_id: 'profile-a' })
    }
  );
  assert.equal(ivrWebhook.status, 200);
  assert.deepEqual(await ivrWebhook.json(), { type: 'hangup' });
  assert.equal(queries.filter((query) => query.includes("set_config('app.current_tenant'")).length, 1);
  assert.equal(queries.some((query) => query.includes('tenant-attacker')), false);
  assert.deepEqual(routed, [
    'voice:/api/ivekit/voice/profiles:tenant-auth',
    'voice:/api/ivekit/voice/providers/profile-a/events:',
    'ivr:/api/ivekit/ivr/provider-webhooks/rustpbx/profile-a/step:'
  ]);
});

test('standalone server preserves RustPBX recording spool parts as bounded binary input', async (t) => {
  const db = createDatabase(':memory:');
  const observed: Array<{ body: unknown; raw: string | Buffer }> = [];
  const server = createIveKitHttpServer({
    db,
    pg: null,
    routes: {
      voice: async (_pg, _method, _path, _url, body, raw) => {
        observed.push({ body, raw });
        return { data: { accepted: true } };
      },
      media: async () => undefined,
      chat: async () => undefined,
      intelligence: async () => undefined,
      events: async () => undefined,
      collaboration: async () => undefined
    }
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });
  const port = await listenOnRandomPort(server);
  const response = await fetch(
    `http://127.0.0.1:${port}/api/ivekit/voice/providers/profile-a/recording-spool/segments/vseg-a/parts/1`,
    { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('part') }
  );
  assert.equal(response.status, 200);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.body, null);
  assert.equal(Buffer.isBuffer(observed[0]?.raw), true);
  assert.equal((observed[0]?.raw as Buffer).toString(), 'part');
});

test('Voice HTTP uses the signed tenant and returns stable async command contracts', async (t) => {
  const auth = installJwtAuth(t);
  const observed: Array<Record<string, unknown>> = [];
  const module = {
    configuration: {
      async listProfiles(input: Record<string, unknown>) {
        observed.push({ operation: 'listProfiles', ...input });
        return { items: [{ id: 'profile-a', tenant_id: input.tenant_id }], next_cursor: null };
      }
    },
    calls: {
      async createOutbound(input: Record<string, unknown>) {
        observed.push({ operation: 'createOutbound', ...input });
        return {
          call: voiceCall(String(input.tenant_id)),
          command: voiceCommand('originate')
        };
      },
      async enqueueAction(input: Record<string, unknown>) {
        observed.push({ operation: 'enqueueAction', ...input });
        return voiceCommand(String(input.kind));
      }
    }
  } as unknown as VoiceHttpModule;
  const headers = { authorization: `Bearer ${auth.token}` };

  const listed = await routeIveKitVoiceApi(
    null, 'GET', '/api/ivekit/voice/profiles',
    new URL('http://localhost/api/ivekit/voice/profiles?limit=20'), {}, '', headers, { module }
  ) as { data: unknown };
  assert.deepEqual(listed.data, {
    items: [{ id: 'profile-a', tenant_id: 'tenant-auth' }], next_cursor: null
  });

  await assert.rejects(() => routeIveKitVoiceApi(
    null, 'POST', '/api/ivekit/voice/calls',
    new URL('http://localhost/api/ivekit/voice/calls'),
    outboundBody({ tenant_id: 'tenant-attacker' }), '',
    { ...headers, 'idempotency-key': 'call-key-a' }, { module }
  ), hasVoiceCode('validation_failed'));

  const created = await routeIveKitVoiceApi(
    null, 'POST', '/api/ivekit/voice/calls',
    new URL('http://localhost/api/ivekit/voice/calls'), outboundBody(), '',
    { ...headers, 'idempotency-key': 'call-key-a' }, { module }
  ) as { status: number; data: { command: { kind: string }; call: { to: { redacted: string } } } };
  assert.equal(created.status, 202);
  assert.equal(created.data.command.kind, 'originate');
  assert.equal(created.data.call.to.redacted, '+86******8000');
  assert.equal(JSON.stringify(created).includes('+8613800138000'), false);

  const action = await routeIveKitVoiceApi(
    null, 'POST', '/api/ivekit/voice/calls/call-a/actions',
    new URL('http://localhost/api/ivekit/voice/calls/call-a/actions'),
    { action: 'hold', payload: {} }, '',
    { ...headers, 'idempotency-key': 'action-key-a' }, { module }
  ) as { status: number; data: { kind: string; payload?: unknown } };
  assert.equal(action.status, 202);
  assert.equal(action.data.kind, 'hold');
  assert.equal('payload' in action.data, false);

  assert.deepEqual(observed.map((item) => [item.operation, item.tenant_id, item.actor]), [
    ['listProfiles', 'tenant-auth', undefined],
    ['createOutbound', 'tenant-auth', 'user-auth'],
    ['enqueueAction', 'tenant-auth', 'user-auth']
  ]);
});

test('Voice HTTP system credentials require an explicit tenant header', async (t) => {
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'voice-system-key';
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previousApiKey;
  });
  const observedTenants: string[] = [];
  const module = {
    configuration: {
      async listProfiles(input: { tenant_id: string }) {
        observedTenants.push(input.tenant_id);
        return { items: [], next_cursor: null };
      }
    }
  } as unknown as VoiceHttpModule;
  const path = '/api/ivekit/voice/profiles';
  const url = new URL(`http://localhost${path}`);

  await assert.rejects(() => routeIveKitVoiceApi(
    null, 'GET', path, url, { tenant_id: 'tenant-from-body' }, '',
    { 'x-api-key': 'voice-system-key' }, { module }
  ), hasVoiceCode('validation_failed'));
  assert.deepEqual(observedTenants, []);

  await routeIveKitVoiceApi(
    null, 'GET', path, url, {}, '',
    { 'x-api-key': 'voice-system-key', 'x-tenant-id': 'tenant-explicit' }, { module }
  );
  assert.deepEqual(observedTenants, ['tenant-explicit']);
});

test('Voice provider webhook authenticates before tenant transaction and rechecks profile binding', async () => {
  const order: string[] = [];
  const pool = recordingPool(order);
  const ingested: Array<Record<string, unknown>> = [];
  const module = {
    configuration_repository: {
      async getProfile(tenantId: string, profileId: string) {
        order.push(`profile:${tenantId}:${profileId}`);
        return { id: profileId, tenant_id: tenantId, adapter: 'rustpbx', status: 'enabled' };
      }
    },
    rustpbx_events: {
      normalize(source: string, body: unknown) {
        order.push(`normalize:${source}`);
        const value = body as Record<string, unknown>;
        return {
          external_event_id: String(value.event_id), event_type: 'call.ringing',
          provider_state: 'ringing', provider_call_id: 'provider-call-a',
          occurred_at: null, safe_payload: { call_id: 'provider-call-a' }
        };
      }
    },
    provider_events: {
      async ingest(input: Record<string, unknown>) {
        order.push(`ingest:${input.tenant_id}`);
        ingested.push(input);
        return { event: { id: 'event-stored-a', processing_state: 'pending' }, replayed: false };
      }
    }
  } as unknown as VoiceHttpModule;
  const result = await routeIveKitVoiceApi(
    pool, 'POST', '/api/ivekit/voice/providers/profile-a/events',
    new URL('http://localhost/api/ivekit/voice/providers/profile-a/events'),
    { tenant_id: 'tenant-attacker', event_id: 'event-a' },
    '{"tenant_id":"tenant-attacker","event_id":"event-a"}',
    { 'x-pbx-key': 'service-key' },
    {
      create_module: () => module,
      webhook_authenticator: {
        async authenticate() {
          order.push('authenticate');
          return {
            tenant_id: 'tenant-secure', profile_id: 'profile-a', adapter: 'rustpbx',
            secret_refs: {}, method: 'service_key'
          };
        }
      } as never
    }
  ) as { status: number; data: { event_id: string; replayed: boolean } };

  assert.equal(result.status, 202);
  assert.deepEqual(result.data, { event_id: 'event-stored-a', state: 'pending', replayed: false });
  assert.equal(ingested[0]?.tenant_id, 'tenant-secure');
  assert.equal(ingested[0]?.profile_id, 'profile-a');
  assert.equal(order.indexOf('authenticate') < order.indexOf('BEGIN'), true);
  assert.equal(order.indexOf('BEGIN') < order.indexOf('profile:tenant-secure:profile-a'), true);

  order.length = 0;
  await assert.rejects(() => routeIveKitVoiceApi(
    pool, 'POST', '/api/ivekit/voice/providers/profile-a/events',
    new URL('http://localhost/api/ivekit/voice/providers/profile-a/events'), {}, '{}', {},
    {
      create_module: () => module,
      webhook_authenticator: {
        async authenticate() { order.push('authenticate'); throw new VoiceError({ code: 'webhook_auth_failed', status: 401 }); }
      } as never
    }
  ), hasVoiceCode('webhook_auth_failed'));
  assert.deepEqual(order, ['authenticate']);
});

test('RustPBX recording spool provider routes derive tenant from auth and keep binary parts fenced', async () => {
  const order: string[] = [];
  const pool = recordingPool(order);
  const calls: Array<Record<string, unknown>> = [];
  const module = {
    configuration_repository: {
      async getProfile(tenantId: string, profileId: string) {
        order.push(`profile:${tenantId}:${profileId}`);
        return {
          id: profileId, tenant_id: tenantId, adapter: 'rustpbx', status: 'enabled'
        };
      }
    }
  } as unknown as VoiceHttpModule;
  const recordingSpool = {
    async initialize(input: Record<string, unknown>) {
      calls.push({ operation: 'initialize', ...input });
      return { state: 'uploading', segment: { id: 'vseg-a' }, parts: [] };
    },
    async uploadPart(input: Record<string, unknown>) {
      calls.push({ operation: 'uploadPart', ...input, content: Buffer.from(input.content as Buffer).toString() });
      return { part_number: input.part_number, size_bytes: 4, sha256: input.sha256 };
    },
    async listParts(input: Record<string, unknown>) {
      calls.push({ operation: 'listParts', ...input });
      return [];
    },
    async complete(input: Record<string, unknown>) {
      calls.push({ operation: 'complete', ...input });
      return { segment: { id: 'vseg-a', state: 'uploaded' }, upload: { state: 'completed' } };
    },
    async finalize(input: Record<string, unknown>) {
      calls.push({ operation: 'finalize', ...input });
      return { id: 'vrec-a', state: 'uploaded_unverified' };
    }
  };
  const options = {
    create_module: () => module,
    recording_spool_intake: recordingSpool,
    webhook_authenticator: {
      async authenticate() {
        order.push('authenticate');
        return {
          tenant_id: 'tenant-secure', profile_id: 'profile-a', adapter: 'rustpbx',
          secret_refs: {}, method: 'service_key'
        };
      }
    } as never
  };

  const initialized = await routeIveKitVoiceApi(
    pool, 'POST', '/api/ivekit/voice/providers/profile-a/recording-spool/segments',
    new URL('http://localhost/api/ivekit/voice/providers/profile-a/recording-spool/segments'),
    {
      tenant_id: 'tenant-attacker', segment: { segment_id: 'vseg-a' },
      whole_file: { size_bytes: 4, sha256: 'b'.repeat(64) },
      worker_id: 'sidecar-a', lease_token: 'a'.repeat(64),
      lease_ms: 60_000, part_size_bytes: 8 * 1024 * 1024
    },
    '{"tenant_id":"tenant-attacker"}',
    { 'x-pbx-key': 'service-key' },
    options as never
  ) as { status: number };
  assert.equal(initialized.status, 201);

  const binary = Buffer.from('part');
  const uploaded = await routeIveKitVoiceApi(
    pool, 'PUT', '/api/ivekit/voice/providers/profile-a/recording-spool/segments/vseg-a/parts/1',
    new URL('http://localhost/api/ivekit/voice/providers/profile-a/recording-spool/segments/vseg-a/parts/1'),
    null,
    binary,
    {
      'x-pbx-key': 'service-key',
      'x-ivekit-recording-worker-id': 'sidecar-a',
      'x-ivekit-recording-owner-epoch': '7',
      'x-ivekit-recording-lease-token': 'a'.repeat(64),
      'x-ivekit-content-sha256': createHash('sha256').update(binary).digest('hex')
    },
    options as never
  ) as { data: { part_number: number } };
  assert.equal(uploaded.data.part_number, 1);

  const completion = {
    schema_version: 1, recording_id: 'vrec-a', interaction_id: 'call-a',
    reservation_id: 'reservation-a', owner_epoch: '7', region_id: 'region-a',
    zone_id: 'zone-a', cell_id: 'cell-a', recorder_node_id: 'rustpbx-a',
    segment_count: 1, last_segment_sequence: 1, ended_at: Date.now()
  };
  const finalized = await routeIveKitVoiceApi(
    pool, 'POST',
    '/api/ivekit/voice/providers/profile-a/recording-spool/recordings/vrec-a/complete',
    new URL('http://localhost/api/ivekit/voice/providers/profile-a/recording-spool/recordings/vrec-a/complete'),
    completion,
    JSON.stringify(completion),
    { 'x-pbx-key': 'service-key' },
    options as never
  ) as { data: { state: string } };
  assert.equal(finalized.data.state, 'uploaded_unverified');

  assert.equal(calls[0]?.tenant_id, 'tenant-secure');
  assert.equal(calls[0]?.profile_id, 'profile-a');
  assert.deepEqual(calls[1], {
    operation: 'uploadPart', tenant_id: 'tenant-secure', segment_id: 'vseg-a',
    owner_epoch: '7', worker_id: 'sidecar-a',
    lease_token_hash: createHash('sha256').update('a'.repeat(64)).digest('hex'),
    part_number: 1,
    content: 'part',
    sha256: createHash('sha256').update(binary).digest('hex')
  });
  assert.equal(calls[2]?.operation, 'finalize');
  assert.equal(calls[2]?.tenant_id, 'tenant-secure');
  assert.equal(calls[2]?.profile_id, 'profile-a');
  assert.equal(order.indexOf('authenticate') < order.indexOf('BEGIN'), true);
});

test('RustPBX router webhook creates the authoritative inbound call before routing', async () => {
  const order: string[] = [];
  const inbound: Array<Record<string, unknown>> = [];
  const module = {
    configuration_repository: {
      async getProfile(tenantId: string, profileId: string) {
        return {
          id: profileId,
          tenant_id: tenantId,
          adapter: 'rustpbx',
          status: 'enabled'
        };
      }
    },
    calls: {
      async createInbound(input: Record<string, unknown>) {
        order.push('create-inbound');
        inbound.push(input);
        return { id: 'call-inbound-a' };
      }
    },
    router: {
      async decide() {
        order.push('route');
        return {
          action: 'forward',
          targets: ['sip:1001@pbx.internal'],
          strategy: 'sequential',
          record: false,
          timeout: 30,
          max_ring_time: 30,
          headers: {}
        };
      }
    }
  } as unknown as VoiceHttpModule;
  const body = {
    call_id: 'provider-inbound-a',
    from: 'sip:+8613900139000@carrier.internal',
    to: 'sip:1001@pbx.internal',
    source_addr: '10.0.0.8:5060',
    direction: 'inbound',
    method: 'INVITE',
    uri: 'sip:1001@pbx.internal'
  };

  const result = await routeIveKitVoiceApi(
    recordingPool([]),
    'POST',
    '/api/ivekit/voice/providers/profile-a/router',
    new URL('http://localhost/api/ivekit/voice/providers/profile-a/router'),
    body,
    JSON.stringify(body),
    { 'x-pbx-key': 'service-key' },
    {
      create_module: () => module,
      webhook_authenticator: {
        async authenticate() {
          return {
            tenant_id: 'tenant-secure',
            profile_id: 'profile-a',
            adapter: 'rustpbx',
            secret_refs: {},
            method: 'service_key'
          };
        }
      } as never
    }
  ) as { data: { action: string } };

  assert.equal(result.data.action, 'forward');
  assert.deepEqual(order, ['create-inbound', 'route']);
  assert.deepEqual(inbound, [{
    tenant_id: 'tenant-secure',
    profile_id: 'profile-a',
    provider_call_id: 'provider-inbound-a',
    external_event_id: 'router:provider-inbound-a',
    from: {
      kind: 'sip_uri',
      value: 'sip:+8613900139000@carrier.internal'
    },
    to: {
      kind: 'sip_uri',
      value: 'sip:1001@pbx.internal'
    },
    business_ref: {
      type: 'inbound_sip',
      id: 'provider-inbound-a'
    },
    metadata: {
      source: 'rustpbx_router'
    }
  }]);
});

test('RustPBX snapshot inbound admission creates the call without invoking dynamic routing', async () => {
  const order: string[] = [];
  const inbound: Array<Record<string, unknown>> = [];
  const reconciled: Array<Record<string, unknown>> = [];
  const module = {
    configuration_repository: {
      async getProfile(tenantId: string, profileId: string) {
        return {
          id: profileId,
          tenant_id: tenantId,
          adapter: 'rustpbx',
          status: 'enabled'
        };
      }
    },
    calls: {
      async createInbound(input: Record<string, unknown>) {
        order.push('create-inbound');
        inbound.push(input);
        return { id: String(input.call_id), state: 'ringing' };
      }
    },
    router: {
      async decide() {
        order.push('route');
        throw new Error('snapshot admission must not invoke dynamic routing');
      }
    }
  } as unknown as VoiceHttpModule;
  const body = {
    call_id: 'provider-snapshot-a',
    from: 'sip:+8613900139000@carrier.internal',
    to: 'sip:1001@pbx.internal',
    source_addr: '10.0.0.8:5060',
    direction: 'inbound',
    method: 'INVITE',
    uri: 'sip:1001@pbx.internal',
    ivekit_cell_id: 'cell-a',
    ivekit_owner_node_id: 'rustpbx-a'
  };
  const result = await routeIveKitVoiceApi(
    recordingPool([]),
    'POST',
    '/api/ivekit/voice/providers/profile-a/inbound-admission',
    new URL('http://localhost/api/ivekit/voice/providers/profile-a/inbound-admission'),
    body,
    JSON.stringify(body),
    { 'x-pbx-key': 'service-key' },
    {
      create_module: () => module,
      webhook_authenticator: {
        async authenticate() {
          return {
            tenant_id: 'tenant-secure',
            profile_id: 'profile-a',
            adapter: 'rustpbx',
            secret_refs: {},
            method: 'service_key'
          };
        }
      } as never,
      placement: {
        async reconcileOne(input) {
          reconciled.push(input);
          return 'succeeded';
        },
        async resolveOwner() {
          return {
            interaction_kind: 'sip_voice',
            owner_component: 'rustpbx',
            region_id: 'region-a',
            zone_id: 'zone-a',
            cell_id: 'cell-a',
            owner_node_id: 'rustpbx-a',
            owner_epoch: '12884901889',
            reservation_id: 'reservation-voice-a',
            profile_id: 'cell-10k-v1',
            snapshot_version: 7,
            provider_endpoint: 'http://rustpbx-a.internal'
          };
        }
      } as never,
      prepared_call_placement: {
        source: 'rustpbx_inbound',
        tenant_id: 'tenant-secure',
        call_id: 'vcall-snapshot-a',
        reservation: { interaction_id: 'vcall-snapshot-a', value: {} } as never,
        provider_authentication: {
          tenant_id: 'tenant-secure',
          profile_id: 'profile-a',
          adapter: 'rustpbx',
          secret_refs: {},
          method: 'service_key'
        }
      }
    }
  ) as {
    status: number;
    data: {
      accepted: boolean;
      call_id: string;
      provider_call_id: string;
      reservation_id: string;
      owner_epoch: string;
      cell_id: string;
      owner_node_id: string;
    };
    afterCommit?: () => Promise<void>;
  };

  assert.equal(result.status, 201);
  assert.deepEqual(result.data, {
    accepted: true,
    call_id: 'vcall-snapshot-a',
    provider_call_id: 'provider-snapshot-a',
    reservation_id: 'reservation-voice-a',
    owner_epoch: '12884901889',
    cell_id: 'cell-a',
    owner_node_id: 'rustpbx-a'
  });
  assert.deepEqual(order, ['create-inbound']);
  assert.equal(inbound[0]?.metadata &&
    (inbound[0].metadata as Record<string, unknown>).source,
  'rustpbx_snapshot_admission');
  assert.equal(inbound[0]?.placement_prepared, true);
  await result.afterCommit?.();
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.tenant_id, 'tenant-secure');
  assert.equal(reconciled[0]?.interaction_id, 'vcall-snapshot-a');
  assert.match(String(reconciled[0]?.worker_id), /^voice:[a-f0-9]{32}$/);
});

test('Voice HTTP exposes the complete configuration call evidence and bridge route matrix', async (t) => {
  const auth = installJwtAuth(t);
  const operations: string[] = [];
  const module = completeVoiceModule(operations);
  const authHeaders = { authorization: `Bearer ${auth.token}` };
  const idempotentHeaders = { ...authHeaders, 'idempotency-key': 'operation-key-a' };
  const invoke = (
    method: string,
    path: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = authHeaders
  ) => routeIveKitVoiceApi(
    null, method, path, new URL(`http://localhost${path}`), body, JSON.stringify(body), headers, { module }
  ) as Promise<{ status?: number; data: unknown }>;

  assert.equal((await invoke('POST', '/api/ivekit/voice/profiles', {
    name: 'PBX', adapter: 'rustpbx', base_url: 'https://pbx.internal',
    desired_version: '1', config: {}, secret_refs: {}
  })).status, 201);
  await invoke('PATCH', '/api/ivekit/voice/profiles/profile-a', { revision: 1, patch: { name: 'PBX 2' } });
  await invoke('POST', '/api/ivekit/voice/profiles/profile-a/preflight');
  await invoke('GET', '/api/ivekit/voice/profiles/profile-a/capabilities');

  assert.equal((await invoke('POST', '/api/ivekit/voice/trunks', {
    profile_id: 'profile-a', name: 'Primary', direction: 'both', transport: 'tls',
    codecs: ['PCMU'], max_channels: 10, credential_secret_ref: 'env://SIP_AUTH', desired_state: {}
  })).status, 201);
  await invoke('PATCH', '/api/ivekit/voice/trunks/trunk-a', { revision: 1, patch: { max_channels: 20 } });
  assert.equal((await invoke('POST', '/api/ivekit/voice/trunks/trunk-a/apply', {}, idempotentHeaders)).status, 202);
  assert.equal((await invoke('POST', '/api/ivekit/voice/trunks/trunk-a/test', {}, idempotentHeaders)).status, 202);

  assert.equal((await invoke('POST', '/api/ivekit/voice/dids', {
    trunk_id: 'trunk-a', route_id: null, e164: '+8613800138000', metadata: {}
  })).status, 201);
  await invoke('PATCH', '/api/ivekit/voice/dids/did-a', { revision: 1, patch: { status: 'disabled' } });
  assert.equal((await invoke(
    'POST', '/api/ivekit/voice/dids/did-a/apply', {}, idempotentHeaders
  )).status, 202);

  assert.equal((await invoke('POST', '/api/ivekit/voice/extensions', {
    profile_id: 'profile-a', identity: 'agent-a', extension: '1001', display_name: 'Agent A',
    credential_secret_ref: 'env://EXTENSION_AUTH', permissions: {}, webrtc_enabled: true
  })).status, 201);
  await invoke('PATCH', '/api/ivekit/voice/extensions/extension-a', {
    revision: 1, patch: { display_name: 'Agent A2' }
  });
  assert.equal((await invoke(
    'POST', '/api/ivekit/voice/extensions/extension-a/apply', {}, idempotentHeaders
  )).status, 202);
  assert.equal((await invoke(
    'POST', '/api/ivekit/voice/extensions/extension-a/session', {}, idempotentHeaders
  )).status, 201);

  assert.equal((await invoke('POST', '/api/ivekit/voice/routes', {
    profile_id: 'profile-a', name: 'Inbound', direction: 'inbound',
    draft_rules: { action: 'reject', code: 404 }
  })).status, 201);
  await invoke('PATCH', '/api/ivekit/voice/routes/route-a', {
    revision: 1, patch: { name: 'Inbound 2' }
  });
  const validation = await invoke('POST', '/api/ivekit/voice/routes/route-a/validate');
  assert.equal((validation.data as { valid: boolean }).valid, true);
  assert.equal((await invoke(
    'POST', '/api/ivekit/voice/routes/route-a/publish', { revision: 1 }, idempotentHeaders
  )).status, 202);
  await invoke('GET', '/api/ivekit/voice/routes/route-a/versions');

  await invoke('PATCH', '/api/ivekit/voice/policy', {
    revision: 1, require_outbound_consent: true, recording_mode: 'consent_required',
    recording_retention_days: 30, require_ai_disclosure: true,
    allowed_calling_windows: [], masking_policy: {}, status: 'active'
  });
  assert.equal((await invoke('POST', '/api/ivekit/voice/consents', {
    subject_ref_type: 'order', subject_ref_id: 'order-a',
    business_ref_type: 'order', business_ref_id: 'order-a', consent_type: 'outbound_call',
    status: 'granted', evidence_ref: 'evidence-a', expires_at: null
  })).status, 201);

  await invoke('GET', '/api/ivekit/voice/calls/call-a/events');
  await invoke('GET', '/api/ivekit/voice/parking-slots?profile_id=profile-a&state=parked');
  await invoke('GET', '/api/ivekit/voice/calls/call-a/recordings');
  await invoke('GET', '/api/ivekit/voice/calls/call-a/bridges');
  await invoke('GET', '/api/ivekit/voice/calls/call-a/participants');
  assert.equal((await invoke(
    'POST', '/api/ivekit/voice/calls/call-a/livekit-bridge',
    { sip_trunk_id: 'trunk-livekit-a' }, idempotentHeaders
  )).status, 202);
  await invoke('GET', '/api/ivekit/voice/recordings');

  assert.deepEqual(operations, [
    'profile:create', 'profile:update', 'profile:preflight', 'profile:capabilities',
    'trunk:create', 'trunk:update', 'trunk:get', 'operation:apply', 'trunk:get', 'operation:test',
    'did:create', 'did:update', 'did:get', 'trunk:get', 'operation:apply',
    'extension:create', 'extension:update', 'extension:get', 'operation:apply',
    'extension:get', 'extension:session',
    'route:create', 'route:update', 'route:get', 'route:publish', 'route:versions',
    'policy:upsert', 'consent:create', 'event:list', 'parking:list', 'recording:list', 'bridge:list',
    'participant:list', 'call:livekit_bridge_create', 'recording:list'
  ]);

  await assert.rejects(
    () => invoke('PATCH', '/api/ivekit/voice/trunks/trunk-a', { patch: { max_channels: 20 } }),
    hasVoiceCode('validation_failed')
  );
  await assert.rejects(
    () => invoke('POST', '/api/ivekit/voice/calls/call-a/actions', { action: 'hold', payload: {} }),
    hasVoiceCode('validation_failed')
  );
});

test('Voice extension sessions bind operators to active WebRTC-enabled extensions', async (t) => {
  installJwtAuth(t);
  const issued: string[] = [];
  let extension: VoiceExtension = {
    id: 'extension-a', tenant_id: 'tenant-auth', profile_id: 'profile-a', identity: 'agent-a',
    extension: '1001', display_name: 'Agent A', credential_secret_ref: 'env://EXTENSION_AUTH',
    permissions: {}, webrtc_enabled: true, status: 'active', revision: 1,
    created_at: NOW, updated_at: NOW
  };
  const module = {
    configuration: {
      async getExtension() { return extension; }
    },
    extension_sessions: {
      async create(input: { actor: string }) {
        issued.push(input.actor);
        return extensionSessionPlan();
      }
    }
  } as unknown as VoiceHttpModule;
  const invoke = (token: string) => routeIveKitVoiceApi(
    null, 'POST', '/api/ivekit/voice/extensions/extension-a/session',
    new URL('http://localhost/api/ivekit/voice/extensions/extension-a/session'), {}, '',
    { authorization: `Bearer ${token}`, 'idempotency-key': 'session-key-a' }, { module }
  ) as Promise<{ status: number; data: { session_id: string } }>;

  const ownerToken = signAccessToken({ sub: 'agent-a', tid: 'tenant-auth', role: 'operator' });
  const issuedSession = await invoke(ownerToken);
  assert.equal(issuedSession.status, 201);
  assert.equal(issuedSession.data.session_id, 'webrtc-session-a');

  const otherToken = signAccessToken({ sub: 'agent-b', tid: 'tenant-auth', role: 'operator' });
  await assert.rejects(() => invoke(otherToken), hasVoiceCode('compliance_denied'));

  extension = { ...extension, status: 'disabled' };
  await assert.rejects(() => invoke(ownerToken), hasVoiceCode('capability_unavailable'));
  extension = { ...extension, status: 'active', webrtc_enabled: false };
  await assert.rejects(() => invoke(ownerToken), hasVoiceCode('capability_unavailable'));
  assert.deepEqual(issued, ['agent-a']);
});

test('standalone Voice errors use the stable secret-safe envelope', async (t) => {
  const db = createDatabase(':memory:');
  const server = createIveKitHttpServer({
    db,
    pg: null,
    routes: {
      voice: async () => {
        throw new VoiceError({
          code: 'revision_conflict', status: 409,
          message: 'database password and +8613800138000 must not escape',
          details: { authorization: 'Bearer secret' }
        });
      },
      media: async () => undefined,
      chat: async () => undefined,
      intelligence: async () => undefined,
      events: async () => undefined,
      collaboration: async () => undefined
    }
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });
  const port = await listenOnRandomPort(server);
  const response = await fetch(`http://127.0.0.1:${port}/api/ivekit/voice/profiles/profile-a`, {
    headers: { 'x-request-id': 'request-safe-a' }
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'revision_conflict', message: 'voice resource revision changed', retryable: false,
      request_id: 'request-safe-a', details: {}
    }
  });
  assert.equal(response.headers.get('x-request-id'), 'request-safe-a');
});

function installJwtAuth(t: import('node:test').TestContext): { token: string } {
  const previousSecret = process.env.OPC_JWT_SECRET;
  const previousIssuer = process.env.OPC_AUTH_ISSUER;
  process.env.OPC_JWT_SECRET = 'voice-http-test-secret';
  delete process.env.OPC_AUTH_ISSUER;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.OPC_JWT_SECRET;
    else process.env.OPC_JWT_SECRET = previousSecret;
    if (previousIssuer === undefined) delete process.env.OPC_AUTH_ISSUER;
    else process.env.OPC_AUTH_ISSUER = previousIssuer;
  });
  return { token: signAccessToken({ sub: 'user-auth', tid: 'tenant-auth', role: 'admin' }) };
}

function recordingPool(order: string[]): PgQueryable {
  const client = {
    release() { order.push('RELEASE'); },
    async query(text: string, values?: unknown[]) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      order.push(values?.length ? `${normalized}:${values.join(',')}` : normalized);
      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
    }
  };
  return {
    async connect() { return client; },
    query: client.query
  } as unknown as PgQueryable;
}

function outboundBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profile_id: 'profile-rustpbx',
    from: { kind: 'extension', value: '1001' },
    to: { kind: 'e164', value: '+8613800138000' },
    business_ref: { type: 'order', id: 'order-a' },
    metadata: {},
    ...patch
  };
}

function voiceCall(tenantId: string) {
  return {
    id: 'call-a', tenant_id: tenantId, business_ref: { type: 'order', id: 'order-a' },
    provider_profile_id: 'profile-rustpbx', provider_call_id: '', provider_dialog_id: '',
    media_call_id: null, direction: 'outbound', state: 'planned',
    from: { kind: 'extension', redacted: '**01' }, to: { kind: 'e164', redacted: '+86******8000' },
    idempotency_key: 'call-key-a', initiated_by: 'user-auth', metadata: {}, ringing_at: null,
    answered_at: null, ended_at: null, termination_reason: '', revision: 1,
    created_at: NOW, updated_at: NOW
  };
}

function voiceCommand(kind: string) {
  return {
    id: `command-${kind}`, tenant_id: 'tenant-auth', call_id: 'call-a', kind,
    state: 'pending', idempotency_key: `key-${kind}`, payload_hash: 'a'.repeat(64),
    payload: { protected: 'must-not-return' }, attempt_count: 0, max_attempts: 5,
    next_attempt_at: null, lease_until: null, worker_id: '', provider_command_id: '', result: {},
    error_code: '', error_message: '', created_at: NOW, updated_at: NOW, completed_at: null
  };
}

function completeVoiceModule(operations: string[]): VoiceHttpModule {
  const configurationCommand = (operation: string) => ({
    id: `configuration-${operation}`, tenant_id: 'tenant-auth', profile_id: 'profile-a',
    resource_type: 'sip_trunk', resource_id: 'trunk-a', operation, state: 'pending',
    idempotency_key: 'operation-key-a', payload_hash: 'a'.repeat(64), payload: {},
    attempt_count: 0, max_attempts: 5, next_attempt_at: null, lease_until: null,
    worker_id: '', provider_command_id: '', result: {}, error_code: '', error_message: '',
    created_at: NOW, updated_at: NOW, completed_at: null
  });
  const extension = {
    id: 'extension-a', tenant_id: 'tenant-auth', profile_id: 'profile-a', identity: 'agent-a',
    extension: '1001', display_name: 'Agent A', credential_secret_ref: 'env://EXTENSION_AUTH',
    permissions: {}, webrtc_enabled: true, status: 'active', revision: 1,
    created_at: NOW, updated_at: NOW
  };
  return {
    configuration: {
      async createProfile(input: unknown) { operations.push('profile:create'); return input; },
      async updateProfile(input: unknown) { operations.push('profile:update'); return input; },
      async getProfile() { return { id: 'profile-a' }; },
      async listProfiles() { return { items: [], next_cursor: null }; },
      async createTrunk(input: unknown) { operations.push('trunk:create'); return input; },
      async updateTrunk(input: unknown) { operations.push('trunk:update'); return input; },
      async getTrunk() {
        operations.push('trunk:get');
        return { id: 'trunk-a', profile_id: 'profile-a', revision: 1 };
      },
      async listTrunks() { return { items: [], next_cursor: null }; },
      async enqueueOperation(input: { operation: string }) {
        operations.push(`operation:${input.operation}`);
        return configurationCommand(input.operation);
      },
      async createDid(input: unknown) { operations.push('did:create'); return input; },
      async updateDid(input: unknown) { operations.push('did:update'); return input; },
      async getDid() {
        operations.push('did:get');
        return { id: 'did-a', trunk_id: 'trunk-a', revision: 1 };
      },
      async listDids() { return { items: [], next_cursor: null }; },
      async createExtension(input: unknown) { operations.push('extension:create'); return input; },
      async updateExtension(input: unknown) { operations.push('extension:update'); return input; },
      async getExtension() { operations.push('extension:get'); return extension; },
      async listExtensions() { return { items: [], next_cursor: null }; },
      async createRoute(input: unknown) { operations.push('route:create'); return input; },
      async updateRoute(input: unknown) { operations.push('route:update'); return input; },
      async getRoute() {
        operations.push('route:get');
        return { id: 'route-a', draft_rules: { action: 'reject', code: 404 } };
      },
      async listRoutes() { return { items: [], next_cursor: null }; },
      async publishRoute() {
        operations.push('route:publish');
        return {
          route: { id: 'route-a' }, version: { id: 'route-version-a' },
          command: configurationCommand('apply')
        };
      },
      async getPolicy() { return { id: 'policy-a' }; },
      async upsertPolicy(input: unknown) { operations.push('policy:upsert'); return input; },
      async listConsents() { return { items: [], next_cursor: null }; },
      async createConsent(input: unknown) { operations.push('consent:create'); return input; }
    } as never,
    profiles: {
      async preflight() { operations.push('profile:preflight'); return { status: 'ready' }; },
      async getCapabilities() { operations.push('profile:capabilities'); return null; }
    } as never,
    calls: {
      async getCall() { return voiceCall('tenant-auth'); },
      async listCalls() { return { items: [], next_cursor: null }; },
      async listParkingSlots() { operations.push('parking:list'); return { items: [], next_cursor: null }; },
      async enqueueAction(input: { kind: string }) {
        operations.push(`call:${input.kind}`);
        return voiceCommand(input.kind);
      }
    } as never,
    configuration_repository: {
      async listRouteVersions() { operations.push('route:versions'); return []; }
    } as never,
    call_repository: {
      async listParticipants() { operations.push('participant:list'); return []; }
    } as never,
    provider_event_repository: {
      async listForCall() { operations.push('event:list'); return { items: [], next_cursor: null }; }
    } as never,
    recordings: {
      async listRecordings() { operations.push('recording:list'); return { items: [], next_cursor: null }; },
      async listBridgesForCall() { operations.push('bridge:list'); return []; }
    } as never,
    provider_events: {} as never,
    rustpbx_events: {} as never,
    router: {} as never,
    extension_sessions: {
      async create() { operations.push('extension:session'); return extensionSessionPlan(); }
    }
  };
}

function extensionSessionPlan() {
  return {
    session_id: 'webrtc-session-a', extension_id: 'extension-a', transport: 'wss' as const,
    websocket_url: 'wss://pbx.example/ws', address_of_record: 'sip:1001@pbx.example',
    authorization_username: 'webrtc-session-a', authorization_password: 'ephemeral-session-secret',
    display_name: 'Agent A', expires_at: '2099-07-13T09:05:00.000Z',
    register_expires_seconds: 300, ice_servers: [{ urls: 'stun:stun.example:3478' }],
    capabilities: {
      incoming: true, outgoing: true, dtmf: true, hold: true, transfer: false,
      audio_input: true, audio_output: true
    }
  };
}

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof VoiceError && error.code === code;
}
