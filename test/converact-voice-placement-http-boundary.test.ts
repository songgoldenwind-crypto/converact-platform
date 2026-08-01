import assert from 'node:assert/strict';
import test from 'node:test';

import { createConveractFabricHttpServer } from '../src/agent-runtime/converact/http-server.js';
import { PlacementError } from '../src/agent-runtime/converact/placement/types.js';
import { prepareConveractFabricVoiceCallPlacement } from '../src/agent-runtime/converact/voice/http.js';
import type { VoiceCallPlacementPort } from '../src/agent-runtime/converact/voice/call-service.js';
import type { PgQueryable } from '../src/db-pg.js';
import { listenOnRandomPort } from './test-helpers.js';

test('voice HTTP reserves Cell capacity before opening the tenant PostgreSQL transaction', async (t) => {
  const previousApiKey = process.env.CONVERACT_API_KEY;
  process.env.CONVERACT_API_KEY = 'voice-placement-http-system-key';
  const events: string[] = [];
  const persisted = new Set<string>();
  const reservedIds: string[] = [];
  const routedIds: string[] = [];
  const placement: VoiceCallPlacementPort = {
    async reserve(input) {
      events.push(`reserve:${input.interaction_id}`);
      reservedIds.push(input.interaction_id);
      return {
        interaction_id: input.interaction_id,
        value: {} as never
      };
    },
    async hasPlacement(_pg, input) {
      return persisted.has(input.interaction_id);
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
  const pg = new RecordingPool(events);
  const server = createConveractFabricHttpServer({
    db: {},
    pg,
    voiceOptions: { placement },
    routes: {
      voice: async (_pg, method, path, _url, _body, _raw, _headers, options) => {
        if (method !== 'POST' || path !== '/api/ivekit/voice/calls') return undefined;
        const callId = options?.prepared_call_placement?.call_id || '';
        events.push(`route:${callId}`);
        routedIds.push(callId);
        persisted.add(callId);
        return {
          status: 202,
          data: { call_id: callId }
        };
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
    process.env.CONVERACT_API_KEY = previousApiKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const request = () => fetch(`http://127.0.0.1:${port}/api/ivekit/voice/calls`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'voice-placement-create-a',
        'x-api-key': 'voice-placement-http-system-key',
        'x-tenant-id': 'tenant-a',
        'x-user-id': 'agent-a'
      },
      body: JSON.stringify({
        profile_id: 'profile-a',
        from: { kind: 'extension', value: '1001' },
        to: { kind: 'e164', value: '+8613900139000' },
        business_ref: { type: 'service_order', id: 'order-a' }
      })
    });
  assert.equal((await request()).status, 202);
  assert.equal((await request()).status, 202);
  assert.match(events[0] || '', /^reserve:vcall_/);
  assert.equal(events[1], 'BEGIN');
  assert.equal(events[2], 'RLS');
  assert.match(events[3] || '', /^route:vcall_/);
  assert.equal(reservedIds.length, 1);
  assert.equal(routedIds.length, 2);
  assert.equal(routedIds[0], routedIds[1]);
  assert.equal(events.includes('release'), false);
});

test('RustPBX inbound router reserves the declared Cell owner before tenant persistence', async (t) => {
  const reservations: Array<Record<string, unknown>> = [];
  const routed: Array<Record<string, unknown>> = [];
  const placement: VoiceCallPlacementPort = {
    async reserve(input) {
      reservations.push(input);
      return {
        interaction_id: input.interaction_id,
        value: {} as never
      };
    },
    async persistReserved() {},
    async releaseUncommitted() {},
    async requestState() {},
    async reconcileOne() {
      return 'succeeded';
    },
    async resolveOwner() {
      throw new Error('not used');
    }
  };
  const server = createConveractFabricHttpServer({
    db: {},
    pg: new RecordingPool([]),
    voiceOptions: {
      placement,
      webhook_authenticator: {
        async authenticate() {
          return {
            tenant_id: 'tenant-a',
            profile_id: 'profile-a',
            adapter: 'rustpbx',
            secret_refs: {},
            method: 'service_key'
          };
        }
      } as never
    },
    routes: {
      voice: async (_pg, method, path, _url, _body, _raw, _headers, options) => {
        if (method !== 'POST' ||
            path !== '/api/ivekit/voice/providers/profile-a/router') {
          return undefined;
        }
        routed.push({
          source: options?.prepared_call_placement?.source,
          call_id: options?.prepared_call_placement?.call_id,
          reservation_id:
            options?.prepared_call_placement?.reservation?.interaction_id
        });
        return {
          status: 200,
          data: { action: 'forward' }
        };
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const response = await fetch(
    `http://127.0.0.1:${port}/api/ivekit/voice/providers/profile-a/router`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pbx-key': 'service-key'
      },
      body: JSON.stringify({
        call_id: 'provider-inbound-a',
        from: 'sip:+8613900139000@carrier.internal',
        to: 'sip:1001@pbx.internal',
        source_addr: '10.0.0.8:5060',
        direction: 'inbound',
        method: 'INVITE',
        uri: 'sip:1001@pbx.internal',
        ivekit_cell_id: 'cell-a',
        ivekit_owner_node_id: 'rustpbx-a'
      })
    }
  );

  assert.equal(response.status, 200);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0]?.preferred_cell_id, 'cell-a');
  assert.equal(reservations[0]?.preferred_owner_node_id, 'rustpbx-a');
  assert.match(String(reservations[0]?.interaction_id), /^vcall_[a-f0-9]{32}$/);
  assert.deepEqual(routed, [{
    source: 'rustpbx_inbound',
    call_id: reservations[0]?.interaction_id,
    reservation_id: reservations[0]?.interaction_id
  }]);
});

test('RustPBX snapshot admission prepares the same strict inbound owner reservation', async () => {
  const reservations: Array<Record<string, unknown>> = [];
  const placement: VoiceCallPlacementPort = {
    async reserve(input) {
      reservations.push(input);
      return {
        interaction_id: input.interaction_id,
        value: {} as never
      };
    },
    async persistReserved() {},
    async releaseUncommitted() {},
    async requestState() {},
    async reconcileOne() {
      return 'succeeded';
    },
    async resolveOwner() {
      throw new Error('not used');
    }
  };
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

  const prepared = await prepareConveractFabricVoiceCallPlacement(
    'POST',
    '/api/ivekit/voice/providers/profile-a/inbound-admission',
    body,
    { 'x-pbx-key': 'service-key' },
    {
      placement,
      webhook_authenticator: {
        async authenticate() {
          return {
            tenant_id: 'tenant-a',
            profile_id: 'profile-a',
            adapter: 'rustpbx',
            secret_refs: {},
            method: 'service_key'
          };
        }
      } as never
    },
    new RecordingPool([]),
    JSON.stringify(body)
  );

  assert.equal(prepared?.source, 'rustpbx_inbound');
  assert.equal(prepared?.reservation?.interaction_id, prepared?.call_id);
  assert.equal(reservations[0]?.preferred_cell_id, 'cell-a');
  assert.equal(reservations[0]?.preferred_owner_node_id, 'rustpbx-a');
});

test('voice HTTP preserves structured Cell placement failures', async (t) => {
  const placement: VoiceCallPlacementPort = {
    async reserve() {
      throw new PlacementError({
        code: 'placement_state_conflict',
        status: 409,
        retryable: false,
        details: { cell_id: 'cell-a' }
      });
    },
    async hasPlacement() {
      return false;
    },
    async persistReserved() {},
    async releaseUncommitted() {},
    async requestState() {},
    async reconcileOne() {
      return 'succeeded';
    },
    async resolveOwner() {
      throw new Error('not used');
    }
  };
  const server = createConveractFabricHttpServer({
    db: {},
    pg: new RecordingPool([]),
    voiceOptions: {
      placement,
      webhook_authenticator: {
        async authenticate() {
          return {
            tenant_id: 'tenant-a',
            profile_id: 'profile-a',
            adapter: 'rustpbx',
            secret_refs: {},
            method: 'service_key'
          };
        }
      } as never
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const response = await fetch(
    `http://127.0.0.1:${port}/api/ivekit/voice/providers/profile-a/inbound-admission`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pbx-key': 'service-key'
      },
      body: JSON.stringify({
        call_id: 'provider-placement-conflict-a',
        from: 'sip:+8613900139000@carrier.internal',
        to: 'sip:1001@pbx.internal',
        source_addr: '10.0.0.8:5060',
        direction: 'inbound',
        method: 'INVITE',
        uri: 'sip:1001@pbx.internal',
        ivekit_cell_id: 'cell-a',
        ivekit_owner_node_id: 'rustpbx-a'
      })
    }
  );

  assert.equal(response.status, 409);
  const payload = await response.json() as {
    error: {
      code: string;
      retryable: boolean;
      details: Record<string, unknown>;
    };
  };
  assert.equal(payload.error.code, 'placement_state_conflict');
  assert.equal(payload.error.retryable, false);
  assert.deepEqual(payload.error.details, { cell_id: 'cell-a' });
});

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
