import assert from 'node:assert/strict';
import test from 'node:test';

import { createIveKitHttpServer } from '../src/agent-runtime/ivekit/http-server.js';
import type { MediaCallCreateCommand } from '../src/agent-runtime/livekit/media-call-create-command-store.js';
import type {
  MediaCallPlacementPort,
  MediaCallPlacementReservation
} from '../src/agent-runtime/livekit/media-call-service.js';
import type { MediaCallCreateCommandStorePort } from '../src/agent-runtime/ivekit/media-http.js';
import type { PgQueryable } from '../src/db-pg.js';
import { listenOnRandomPort } from './test-helpers.js';

test('media HTTP reserves Cell capacity before opening the tenant PostgreSQL transaction', async (t) => {
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'placement-http-system-key';
  const events: string[] = [];
  const placement: MediaCallPlacementPort = {
    async reserve(input): Promise<MediaCallPlacementReservation> {
      events.push(`reserve:${input.interaction_id}`);
      return {
        interaction_id: input.interaction_id,
        value: { interaction_id: input.interaction_id }
      };
    },
    async persistReserved() {},
    async releaseUncommitted() {
      events.push('release');
    },
    async requestState() {},
    async reconcileOne() {
      return { outcome: 'succeeded' };
    },
    async resolveOwner() {
      throw new Error('not used');
    }
  };
  const pg = new RecordingPool(events);
  const commandStore = mediaCallCreateCommandStoreFixture();
  const server = createIveKitHttpServer({
    db: {},
    pg,
    mediaOptions: {
      placement,
      mediaCallCreateCommandStoreFactory: () => commandStore
    },
    routes: {
      media: async (_db, method, path, _url, _body, _raw, _headers, options) => {
        if (method !== 'POST' || path !== '/api/ivekit/media/calls') return undefined;
        events.push(`route:${options?.preparedMediaCallPlacement?.call_id || ''}`);
        return {
          status: 201,
          data: { call_id: options?.preparedMediaCallPlacement?.call_id }
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
    process.env.OPC_API_KEY = previousApiKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const response = await fetch(`http://127.0.0.1:${port}/api/ivekit/media/calls`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'placement-http-system-key',
      'x-tenant-id': 'tenant-a',
      'x-user-id': 'host-a',
      'idempotency-key': 'placement-http-boundary'
    },
    body: JSON.stringify({
      media: 'video',
      participant_identities: ['guest-a'],
      business_ref: { type: 'service_order', id: 'order-a' }
    })
  });
  assert.equal(response.status, 201);
  assert.match(events[0] || '', /^reserve:mcall_/);
  assert.equal(events[1], 'BEGIN');
  assert.match(events[3] || '', /^route:mcall_/);
  assert.equal(events.includes('release'), false);
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

function mediaCallCreateCommandStoreFixture(): MediaCallCreateCommandStorePort {
  const timestamp = '2026-07-30T02:00:00.000Z';
  const command: MediaCallCreateCommand = {
    tenant_id: 'tenant-a',
    call_id: 'mcall_http_boundary',
    idempotency_key_hash: '1'.repeat(64),
    payload_hash: '2'.repeat(64),
    requester_identity_hash: '3'.repeat(64),
    state: 'pending',
    attempt_generation: 1,
    lease_until: '2026-07-30T02:00:30.000Z',
    result_snapshot: null,
    error_code: '',
    error_status: 0,
    error_retryable: false,
    next_retry_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
    expires_at: '2026-07-31T02:00:00.000Z'
  };
  return {
    async claim() {
      return {
        command,
        replayed: false,
        attempt: {
          generation: 1,
          token: 'test-attempt-token-0000000000000000',
          lease_until: command.lease_until || timestamp
        }
      };
    },
    async findByIdempotencyKey() {
      return command;
    },
    async markSucceeded(input) {
      return {
        ...command,
        state: 'succeeded',
        result_snapshot: input.result_snapshot,
        completed_at: timestamp
      };
    },
    async markFailed(input) {
      return {
        ...command,
        state: input.retryable ? 'retryable_failed' : 'terminal_failed',
        error_code: input.error_code,
        error_status: input.error_status,
        error_retryable: input.retryable
      };
    }
  };
}
