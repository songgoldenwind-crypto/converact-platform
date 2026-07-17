import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';

import type { ChatGateway } from '../src/agent-runtime/collaboration/chat-gateway.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { routeIveKitChatApi } from '../src/agent-runtime/ivekit/chat-http.js';
import { createIveKitHttpServer } from '../src/agent-runtime/ivekit/http-server.js';
import type {
  ComponentPlacementAdapter,
  ComponentPlacementReservation
} from '../src/agent-runtime/ivekit/placement/component-placement.js';
import { MemoryPg, type PgQueryable } from '../src/db-pg.js';
import { createDatabase } from '../src/db.js';
import { createServer as createOpcServer } from '../src/http.js';
import { listenOnRandomPort } from './test-helpers.js';

type TinodePlacement = Pick<
  ComponentPlacementAdapter,
  | 'reserve'
  | 'hasPlacement'
  | 'persistReserved'
  | 'releaseUncommitted'
  | 'requestState'
  | 'reconcileOne'
  | 'resolveOwner'
>;

test('chat HTTP reserves Tinode capacity before opening the tenant transaction', async (t) => {
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'chat-placement-http-key';
  const events: string[] = [];
  const reservation = placementReservation('collab-a');
  const placement: TinodePlacement = {
    async reserve(input) {
      events.push(`reserve:${input.interaction_id}`);
      return reservation;
    },
    async hasPlacement() {
      return false;
    },
    async persistReserved() {},
    async releaseUncommitted() {
      events.push('release');
    },
    async requestState() {},
    async reconcileOne() {
      return 'succeeded';
    },
    async resolveOwner() {
      throw new Error('not used');
    }
  };
  const server = createIveKitHttpServer({
    db: {},
    pg: new RecordingPool(events),
    chatOptions: { tinodePlacement: placement },
    routes: {
      chat: async (_pg, method, path, _url, _body, _raw, _headers, options) => {
        if (method !== 'POST' || path !== '/api/ivekit/chat/sessions/collab-a/bind') {
          return undefined;
        }
        events.push(`route:${options.preparedTinodePlacement?.session_id || ''}`);
        options.preparedTinodePlacement!.persisted = true;
        return { status: 201, data: { id: 'binding-a' } };
      }
    }
  });
  let port: number;
  try {
    port = await listenOnRandomPort(server);
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) {
      t.skip('loopback listener unavailable');
      return;
    }
    throw error;
  }
  t.after(async () => {
    process.env.OPC_API_KEY = previousApiKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const response = await fetch(
    `http://127.0.0.1:${port}/api/ivekit/chat/sessions/collab-a/bind`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'chat-placement-http-key',
        'x-tenant-id': 'tenant-a',
        'x-user-id': 'agent-a'
      },
      body: '{}'
    }
  );

  assert.equal(response.status, 201);
  assert.deepEqual(events.slice(0, 4), [
    'reserve:collab-a',
    'BEGIN',
    'RLS',
    'route:collab-a'
  ]);
  assert.equal(events.includes('release'), false);
});

test('the OPC main HTTP server uses the same Tinode placement boundary', async (t) => {
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'opc-chat-placement-key';
  const events: string[] = [];
  const pg = new RecordingMemoryPool(events);
  const session = await new CollaborationStore(pg).openSession({
    tenant_id: 'tenant-opc-placement',
    business_ref: {
      tenant_id: 'tenant-opc-placement',
      type: 'service_order',
      id: 'order-opc-placement'
    }
  });
  events.length = 0;
  const placement = placementFixture(events);
  placement.hasPlacement = async () => false;
  const db = createDatabase(':memory:');
  const server = createOpcServer(db, pg, {
    ivekitChat: {
      tinodePlacement: placement,
      placementWorkerId: 'opc-chat-placement-test'
    }
  });
  placement.reserve = async (input) => {
    events.push(`reserve:${input.interaction_id}`);
    return placementReservation(input.interaction_id);
  };
  let port: number;
  try {
    port = await listenOnRandomPort(server);
  } catch (error) {
    db.close();
    if (['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) {
      t.skip('loopback listener unavailable');
      return;
    }
    throw error;
  }
  t.after(async () => {
    restoreEnv('OPC_API_KEY', previousApiKey);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  const response = await fetch(
    `http://127.0.0.1:${port}/api/ivekit/chat/sessions/${session.id}/bind`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'opc-chat-placement-key',
        'x-tenant-id': 'tenant-opc-placement',
        'x-user-id': 'agent-opc-placement'
      },
      body: '{}'
    }
  );

  assert.equal(response.status, 201);
  assert.deepEqual(events.slice(0, 5), [
    `reserve:${session.id}`,
    'BEGIN',
    'RLS',
    `persist:${session.id}`,
    `state:${session.id}:active`
  ]);
});

test('Tinode binding persists and activates the prepared placement in the request transaction', async () => {
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'chat-placement-route-key';
  const pg = new MemoryPg();
  const events: string[] = [];
  const reservation = placementReservation('collab-binding');
  const placement = placementFixture(events);
  const gateway = tinodeGatewayFixture((input) => {
    const placement = input.trusted?.ivekit_placement as Record<string, unknown>;
    events.push(
      `ensure:${input.provider_endpoint}:${String(placement?.reservation_id || '')}`
    );
  });
  const session = await new CollaborationStore(pg).openSession({
    tenant_id: 'tenant-binding',
    business_ref: {
      tenant_id: 'tenant-binding',
      type: 'service_order',
      id: 'order-binding'
    }
  });
  reservation.interaction_id = session.id;
  reservation.value.record.interaction_id = session.id;
  const prepared = {
    tenant_id: 'tenant-binding',
    session_id: session.id,
    reservation,
    persisted: false
  };

  const result = await routeIveKitChatApi(
    pg,
    'POST',
    `/api/ivekit/chat/sessions/${session.id}/bind`,
    new URL(`http://localhost/api/ivekit/chat/sessions/${session.id}/bind`),
    {},
    '',
    {
      'x-api-key': 'chat-placement-route-key',
      'x-tenant-id': 'tenant-binding',
      'x-user-id': 'agent-binding'
    },
    {
      chatGateway: gateway,
      tinodePlacement: placement,
      preparedTinodePlacement: prepared,
      placementWorkerId: 'chat-placement-test'
    }
  ) as {
    status: number;
    data: { provider: string };
    afterCommit?: () => Promise<void>;
  };

  assert.equal(result.status, 201);
  assert.equal(result.data.provider, 'tinode');
  assert.equal(prepared.persisted, true);
  assert.deepEqual(events, [
    `persist:${session.id}`,
    'ensure:https://tinode-owner.internal:reservation-tinode-owner',
    `state:${session.id}:active`
  ]);
  await result.afterCommit?.();
  assert.deepEqual(events, [
    `persist:${session.id}`,
    'ensure:https://tinode-owner.internal:reservation-tinode-owner',
    `state:${session.id}:active`,
    `reconcile:${session.id}:chat-placement-test`
  ]);
});

test('Tinode client plan uses the active Cell owner websocket endpoint', async () => {
  const previousApiKey = process.env.OPC_API_KEY;
  const previousPublicWs = process.env.TINODE_PUBLIC_WS_URL;
  const previousApiKeyValue = process.env.TINODE_API_KEY;
  process.env.OPC_API_KEY = 'chat-owner-route-key';
  process.env.TINODE_PUBLIC_WS_URL = 'wss://global-chat.invalid/v0/channels';
  process.env.TINODE_API_KEY = 'owner-api-key';
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const session = await store.openSession({
    tenant_id: 'tenant-owner',
    business_ref: {
      tenant_id: 'tenant-owner',
      type: 'service_order',
      id: 'order-owner'
    }
  });
  await store.addParticipant({
    tenant_id: 'tenant-owner',
    session_id: session.id,
    identity: 'customer-owner',
    role: 'customer'
  });
  const placement = placementFixture([]);
  const gateway = tinodeGatewayFixture();

  try {
    const result = await routeIveKitChatApi(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${session.id}/client-plan`,
      new URL(`http://localhost/api/ivekit/chat/sessions/${session.id}/client-plan`),
      { identity: 'customer-owner' },
      '',
      {
        'x-api-key': 'chat-owner-route-key',
        'x-tenant-id': 'tenant-owner',
        'x-user-id': 'customer-owner'
      },
      {
        chatGateway: gateway,
        tinodePlacement: placement
      }
    ) as { status: number; data: { ws_url: string } };

    assert.equal(result.status, 201);
    assert.equal(
      result.data.ws_url,
      'wss://tinode-owner.internal/v0/channels?apikey=owner-api-key'
    );
  } finally {
    restoreEnv('OPC_API_KEY', previousApiKey);
    restoreEnv('TINODE_PUBLIC_WS_URL', previousPublicWs);
    restoreEnv('TINODE_API_KEY', previousApiKeyValue);
  }
});

test('unconsumed Tinode reservations are released after a rejected chat request', async (t) => {
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'chat-placement-release-key';
  const events: string[] = [];
  const placement = placementFixture(events);
  placement.hasPlacement = async () => false;
  placement.releaseUncommitted = async (reservation) => {
    events.push(`release:${reservation.interaction_id}`);
  };
  const server = createIveKitHttpServer({
    db: {},
    pg: new RecordingPool([]),
    chatOptions: { tinodePlacement: placement },
    routes: {
      chat: async () => ({
        status: 404,
        data: { error: 'collaboration session not found' }
      })
    }
  });
  let port: number;
  try {
    port = await listenOnRandomPort(server);
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) {
      t.skip('loopback listener unavailable');
      return;
    }
    throw error;
  }
  t.after(async () => {
    process.env.OPC_API_KEY = previousApiKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const response = await fetch(
    `http://127.0.0.1:${port}/api/ivekit/chat/sessions/missing-session/bind`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'chat-placement-release-key',
        'x-tenant-id': 'tenant-release',
        'x-user-id': 'agent-release'
      },
      body: '{}'
    }
  );

  assert.equal(response.status, 404);
  assert.deepEqual(events, ['release:missing-session']);
});

test('closing a Tinode session closes and reconciles its Cell placement', async () => {
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'chat-placement-close-key';
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const events: string[] = [];
  const session = await store.openSession({
    tenant_id: 'tenant-close',
    business_ref: {
      tenant_id: 'tenant-close',
      type: 'service_order',
      id: 'order-close'
    }
  });
  await store.addParticipant({
    tenant_id: 'tenant-close',
    session_id: session.id,
    identity: 'agent-close',
    role: 'agent'
  });
  await store.ensureChatBinding({
    tenant_id: 'tenant-close',
    session_id: session.id,
    provider: 'tinode',
    provider_topic_id: 'grp-close'
  });
  const placement = placementFixture(events);

  const result = await routeIveKitChatApi(
    pg,
    'POST',
    `/api/ivekit/chat/sessions/${session.id}/close`,
    new URL(`http://localhost/api/ivekit/chat/sessions/${session.id}/close`),
    {},
    '',
    {
      'x-api-key': 'chat-placement-close-key',
      'x-tenant-id': 'tenant-close',
      'x-user-id': 'agent-close'
    },
    {
      chatGateway: tinodeGatewayFixture(),
      tinodePlacement: placement,
      placementWorkerId: 'chat-close-test'
    }
  ) as {
    status: number;
    data: { status: string };
    afterCommit?: () => Promise<void>;
  };

  assert.equal(result.status, 200);
  assert.equal(result.data.status, 'closed');
  assert.deepEqual(events, [`state:${session.id}:closed`]);
  await result.afterCommit?.();
  assert.deepEqual(events, [
    `state:${session.id}:closed`,
    `reconcile:${session.id}:chat-close-test`
  ]);
  restoreEnv('OPC_API_KEY', previousApiKey);
});

function placementFixture(events: string[]): TinodePlacement {
  return {
    async reserve(input) {
      return placementReservation(input.interaction_id);
    },
    async hasPlacement() {
      return true;
    },
    async persistReserved(_pg, reservation) {
      events.push(`persist:${reservation.interaction_id}`);
    },
    async releaseUncommitted() {},
    async requestState(_pg, input) {
      events.push(`state:${input.interaction_id}:${input.desired_state}`);
    },
    async reconcileOne(input) {
      events.push(`reconcile:${input.interaction_id}:${input.worker_id}`);
      return 'succeeded';
    },
    async resolveOwner() {
      return {
        interaction_kind: 'tinode_im',
        owner_component: 'tinode',
        region_id: 'region-a',
        zone_id: 'zone-a',
        cell_id: 'cell-a',
        owner_node_id: 'tinode-owner',
        owner_epoch: '12884901889',
        reservation_id: 'reservation-tinode-owner',
        profile_id: 'cell-10k-v1',
        snapshot_version: 7,
        provider_endpoint: 'https://tinode-owner.internal'
      };
    }
  };
}

function placementReservation(interactionId: string): ComponentPlacementReservation {
  return {
    interaction_id: interactionId,
    value: {
      request: {} as never,
      owner_component: 'tinode',
      decision: {} as never,
      signed_placement_token: 'placement-token',
      record: {
        interaction_id: interactionId,
        provider_endpoint: 'https://tinode-owner.internal',
        owner_node_id: 'tinode-owner',
        owner_epoch: '12884901889',
        reservation_id: 'reservation-tinode-owner'
      } as never
    }
  };
}

function tinodeGatewayFixture(
  onEnsure?: (input: Parameters<ChatGateway['ensureTopic']>[0]) => void
): ChatGateway {
  return {
    provider: 'tinode',
    async ensureTopic(input) {
      onEnsure?.(input);
      return {
        provider: 'tinode',
        provider_topic_id: `grp-${input.session_id}`,
        provider_status: 'bound',
        metadata: {}
      };
    },
    async ensureUser() {
      return {
        provider_user_id: 'usr-customer-owner',
        provider_auth_token: 'customer-owner-token',
        metadata: {}
      };
    },
    async addParticipant() {},
    async removeParticipant() {},
    async publishMessage(input) {
      return {
        provider: 'tinode',
        provider_topic_id: input.provider_topic_id,
        provider_message_id: '1',
        provider_sync_status: 'published',
        metadata: {}
      };
    }
  };
}

class RecordingPool implements PgQueryable {
  constructor(private readonly events: string[]) {}

  async connect() {
    const events = this.events;
    return {
      async query(text: string) {
        const sql = text.replace(/\s+/g, ' ').trim();
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          events.push(sql);
        } else if (sql.startsWith("SELECT set_config('app.current_tenant'")) {
          events.push('RLS');
        }
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
      },
      release() {}
    };
  }

  async query() {
    return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
  }
}

class RecordingMemoryPool implements PgQueryable {
  private readonly memory = new MemoryPg();

  constructor(private readonly events: string[]) {
  }

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<R>> {
    return this.memory.query<R>(text, params);
  }

  async connect() {
    const pool = this;
    return {
      async query(text: string, params?: unknown[]) {
        const sql = text.replace(/\s+/g, ' ').trim();
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          pool.events.push(sql);
          return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
        }
        if (sql.startsWith("SELECT set_config('app.current_tenant'")) {
          pool.events.push('RLS');
          return { rows: [], rowCount: 1, command: '', oid: 0, fields: [] };
        }
        return pool.memory.query(text, params);
      },
      release() {}
    };
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
