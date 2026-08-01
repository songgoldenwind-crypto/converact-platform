import { resolveConveractEnv } from '../src/config/converact-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  routeCollaborationApi,
  type PreparedRustDeskSessionPlacement,
  type RustDeskSessionPlacementPort
} from '../src/agent-runtime/collaboration/collaboration-http.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { RustDeskGatewaySessionStore } from '../src/agent-runtime/collaboration/rustdesk-gateway-session-store.js';
import { createConveractFabricHttpServer } from '../src/agent-runtime/converact/http-server.js';
import type { ComponentPlacementReservation } from '../src/agent-runtime/converact/placement/component-placement.js';
import { MemoryPg, type PgQueryable } from '../src/db-pg.js';
import { listenOnRandomPort } from './test-helpers.js';

test('RustDesk gateway HTTP reserves Cell capacity before the tenant transaction', async (t) => {
  const previousApiKey = process.env.CONVERACT_API_KEY;
  process.env.CONVERACT_API_KEY = 'rustdesk-placement-http-key';
  const events: string[] = [];
  const placement = rustDeskPlacementFixture(events);
  placement.hasPlacement = async () => false;
  const server = createConveractFabricHttpServer({
    db: {},
    pg: new RecordingPool(events),
    collaborationOptions: {
      rustdeskPlacement: placement
    },
    routes: {
      collaboration: async (_pg, method, path, _url, _body, _raw, _headers, options) => {
        if (method !== 'POST' || path !== '/api/ivekit/rustdesk/gateway-sessions') {
          return undefined;
        }
        events.push(`route:${options.preparedRustDeskPlacement?.remote_session_id || ''}`);
        options.preparedRustDeskPlacement!.persisted = true;
        return { status: 201, data: { id: 'remote-tool-a' } };
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
    restoreEnv('CONVERACT_API_KEY', previousApiKey);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const response = await fetch(
    `http://127.0.0.1:${port}/api/ivekit/rustdesk/gateway-sessions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'rustdesk-placement-http-key',
        'x-tenant-id': 'tenant-rustdesk',
        'x-user-id': 'agent-rustdesk'
      },
      body: JSON.stringify({
        remote_session_id: 'remote-a',
        device_id: 'device-a',
        permissions: ['view_screen']
      })
    }
  );

  assert.equal(response.status, 201);
  assert.deepEqual(events.slice(0, 4), [
    'reserve:remote-a',
    'BEGIN',
    'RLS',
    'route:remote-a'
  ]);
});

test('RustDesk gateway persists owner runtime and closes placement with the session', async () => {
  const env = snapshotEnv([
    'CONVERACT_API_KEY',
    'CONVERACT_BASE_URL',
    'CONVERACT_RUSTDESK_LAUNCH_SECRET',
    'CONVERACT_FABRIC_RUSTDESK_OWNER_RUNTIME_JSON'
  ]);
  process.env.CONVERACT_API_KEY = 'rustdesk-placement-route-key';
  process.env.CONVERACT_BASE_URL = 'https://fabric.converact.example.com';
  process.env.CONVERACT_RUSTDESK_LAUNCH_SECRET = 'rustdesk-placement-launch-secret';
  process.env.CONVERACT_FABRIC_RUSTDESK_OWNER_RUNTIME_JSON = JSON.stringify({
    'rustdesk-owner': {
      id_server: 'id-cell-a.example.com',
      relay_server: 'relay-cell-a.example.com',
      api_server: 'https://api-cell-a.example.com',
      server_key_fingerprint: 'sha256:0123456789abcdef'
    }
  });
  const pg = new MemoryPg();
  const tenantId = 'tenant-rustdesk-owner';
  const events: string[] = [];
  const placement = rustDeskPlacementFixture(events);
  const prepared = await setupRemoteFixture(pg, tenantId, placement);
  events.length = 0;

  try {
    const created = await route(
      pg,
      'POST',
      '/api/ivekit/rustdesk/gateway-sessions',
      {
        remote_session_id: prepared.remote_session_id,
        device_id: prepared.device_id,
        actor_identity: 'agent-rustdesk-owner',
        permissions: ['view_screen']
      },
      tenantId,
      {
        rustdeskPlacement: placement,
        rustdeskOwnerBindings: {
          async prepare(input) {
            events.push(
              `bind:${input.interaction_id}:${input.target_id}:${input.owner.reservation_id}`
            );
            return {
              target_id: input.target_id,
              interaction_id: input.interaction_id,
              reservation_id: input.owner.reservation_id,
              owner_node_id: input.owner.owner_node_id,
              owner_epoch: input.owner.owner_epoch,
              status: 'pending',
              expires_at: '2099-01-01T00:00:00.000Z'
            };
          }
        },
        preparedRustDeskPlacement: prepared.placement,
        placementWorkerId: 'rustdesk-placement-test'
      }
    ) as {
      status: number;
      data: { external_id: string };
      afterCommit?: () => Promise<void>;
    };

    assert.equal(created.status, 201);
    assert.equal(prepared.placement.persisted, true);
    assert.deepEqual(events, [
      `persist:${prepared.remote_session_id}`,
      `state:${prepared.remote_session_id}:active`,
      `bind:${prepared.remote_session_id}:123456789:reservation-rustdesk-owner`
    ]);
    const gateway = await new RustDeskGatewaySessionStore(pg).getSession(created.data.external_id);
    assert.ok(gateway);
    assert.equal(gateway.metadata.id_server, 'id-cell-a.example.com');
    assert.equal(gateway.metadata.relay_server, 'relay-cell-a.example.com');
    assert.equal(gateway.metadata.api_server, 'https://api-cell-a.example.com');
    assert.equal(gateway.metadata.ivekit_cell_id, 'cell-a');
    assert.equal(gateway.metadata.ivekit_owner_node_id, 'rustdesk-owner');
    assert.equal(gateway.metadata.ivekit_reservation_id, 'reservation-rustdesk-owner');

    await created.afterCommit?.();
    assert.equal(events.at(-1), `reconcile:${prepared.remote_session_id}:rustdesk-placement-test`);

    const launch = await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${created.data.external_id}/launch`,
      null,
      tenantId,
      { rustdeskPlacement: placement }
    ) as {
      data: {
        runtime: {
          id_server: string;
          relay_server: string;
          api_server: string;
          server_key_fingerprint: string;
        };
      };
    };
    assert.deepEqual(launch.data.runtime, {
      rustdesk_id: '123456789',
      id_server: 'id-cell-a.example.com',
      relay_server: 'relay-cell-a.example.com',
      api_server: 'https://api-cell-a.example.com',
      server_key_fingerprint: 'sha256:0123456789abcdef',
      public_key_configured: 'false',
      public_key_source: 'none'
    });

    const ended = await route(
      pg,
      'DELETE',
      `/api/ivekit/rustdesk/gateway-sessions/${created.data.external_id}`,
      { actor_identity: 'agent-rustdesk-owner' },
      tenantId,
      {
        rustdeskPlacement: placement,
        placementWorkerId: 'rustdesk-close-test'
      }
    ) as { status: number; afterCommit?: () => Promise<void> };
    assert.equal(ended.status, 204);
    assert.equal(events.at(-1), `state:${prepared.remote_session_id}:closed`);
    await ended.afterCommit?.();
    assert.equal(events.at(-1), `reconcile:${prepared.remote_session_id}:rustdesk-close-test`);
  } finally {
    restoreSnapshot(env);
  }
});

async function setupRemoteFixture(
  pg: MemoryPg,
  tenantId: string,
  placement: RustDeskSessionPlacementPort
): Promise<{
  remote_session_id: string;
  device_id: string;
  placement: PreparedRustDeskSessionPlacement;
}> {
  const collaboration = await new CollaborationStore(pg).openSession({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order-rustdesk-owner'
    }
  });
  const remote = await route(
    pg,
    'POST',
    '/api/collaboration/remote-assistance/sessions',
    {
      collaboration_session_id: collaboration.id,
      mode: 'remote_desktop_gateway',
      adapter_provider: 'rustdesk'
    },
    tenantId
  ) as { data: { id: string } };
  await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remote.data.id}/consent/grant`,
    {
      actor_identity: 'customer-rustdesk-owner',
      scopes: ['view_screen'],
      expires_at: '2099-01-01T00:00:00.000Z'
    },
    tenantId
  );
  const device = await route(
    pg,
    'POST',
    '/api/ivekit/rustdesk/devices',
    {
      business_ref: { type: 'service_order', id: 'order-rustdesk-owner' },
      rustdesk_id: '123456789',
      display_name: 'RustDesk Cell target'
    },
    tenantId
  ) as { data: { id: string } };
  return {
    remote_session_id: remote.data.id,
    device_id: device.data.id,
    placement: {
      tenant_id: tenantId,
      remote_session_id: remote.data.id,
      reservation: await placement.reserve({
        tenant_id: tenantId,
        interaction_id: remote.data.id,
        routing_partition_key: remote.data.id,
        idempotency_key: `rustdesk-session:${remote.data.id}`
      }),
      persisted: false
    }
  };
}

function rustDeskPlacementFixture(events: string[]): RustDeskSessionPlacementPort {
  return {
    async reserve(input) {
      events.push(`reserve:${input.interaction_id}`);
      return placementReservation(input.interaction_id);
    },
    async hasPlacement() {
      return true;
    },
    async persistReserved(_pg, reservation) {
      events.push(`persist:${reservation.interaction_id}`);
    },
    async releaseUncommitted(reservation) {
      events.push(`release:${reservation.interaction_id}`);
    },
    async requestState(_pg, input) {
      events.push(`state:${input.interaction_id}:${input.desired_state}`);
    },
    async reconcileOne(input) {
      events.push(`reconcile:${input.interaction_id}:${input.worker_id}`);
      return 'succeeded';
    },
    async resolveOwner() {
      return {
        interaction_kind: 'rustdesk_remote',
        owner_component: 'rustdesk',
        region_id: 'region-a',
        zone_id: 'zone-a',
        cell_id: 'cell-a',
        owner_node_id: 'rustdesk-owner',
        owner_epoch: '12884901889',
        reservation_id: 'reservation-rustdesk-owner',
        profile_id: 'cell-10k-v1',
        snapshot_version: 7,
        provider_endpoint: 'https://rustdesk-owner.internal'
      };
    }
  };
}

function placementReservation(interactionId: string): ComponentPlacementReservation {
  return {
    interaction_id: interactionId,
    value: {
      request: {} as never,
      owner_component: 'rustdesk',
      decision: {} as never,
      signed_placement_token: 'placement-token',
      record: {
        interaction_id: interactionId,
        interaction_kind: 'rustdesk_remote',
        owner_component: 'rustdesk',
        region_id: 'region-a',
        zone_id: 'zone-a',
        cell_id: 'cell-a',
        owner_node_id: 'rustdesk-owner',
        owner_epoch: '12884901889',
        reservation_id: 'reservation-rustdesk-owner',
        profile_id: 'cell-10k-v1',
        snapshot_version: 7,
        provider_endpoint: 'https://rustdesk-owner.internal'
      } as never
    }
  };
}

async function route(
  pg: MemoryPg,
  method: string,
  path: string,
  body: unknown,
  tenantId: string,
  options: Parameters<typeof routeCollaborationApi>[7] = {}
) {
  return routeCollaborationApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    {
      'x-api-key': 'rustdesk-placement-route-key',
      'x-tenant-id': tenantId,
      'x-user-id': 'agent-rustdesk-owner'
    },
    options
  );
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

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, resolveConveractEnv(process.env, key)]));
}

function restoreSnapshot(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) restoreEnv(key, value);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
