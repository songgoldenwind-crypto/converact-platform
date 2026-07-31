import assert from 'node:assert/strict';
import test from 'node:test';

import { createIveKitHttpSdk } from '../sdk/converact/src/http-sdk.js';
import { routeIveKitChatApi } from '../src/agent-runtime/converact/chat-http.js';
import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';

const API_KEY = 'tinode-operations-test-key';

const snapshot = {
  tenant_id: 'tenant-tinode-ops',
  generated_at: '2026-07-15T00:00:00.000Z',
  delivery: {
    pending: 2, publishing: 1, retry_wait: 3, failed: 4,
    blocked_by_file_security: 5, blocked: 6,
    oldest_due_at: '2026-07-14T23:59:00.000Z', queue_lag_ms: 60_000
  },
  inbound: {
    cursors: 2, active: 1, error: 1, paused: 0, leased: 1,
    max_cursor_lag_sequences: 7,
    oldest_cursor_updated_at: '2026-07-14T23:58:00.000Z'
  },
  dead_letters: {
    open: 1, retryable: 1, terminal: 0,
    oldest_open_at: '2026-07-14T23:57:00.000Z'
  }
};

const deadLetter = {
  id: 'dead-1', binding_id: 'binding-1', event_id: 'event-1', event_kind: 'data',
  provider_sequence: 9, provider_delete_id: 0, error_code: 'provider_user_unmapped',
  error_message: 'provider user is not mapped', payload_hash: 'a'.repeat(64),
  retryable: true, retry_count: 1, next_retry_at: null, resolved_at: null,
  created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z'
};

const mutationDeadLetter = {
  id: 'mutation-dead-1', session_id: 'session-1', message_id: 'message-1', mutation_id: 'cmut-1',
  mutation_version: 1, action: 'edit' as const, attempt_count: 5, max_attempts: 5,
  error_code: 'provider_unavailable', error_message: 'socket reset',
  created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:01:00.000Z'
};

test('iveKit Tinode operations facade is admin-only, tenant-scoped, and emits replay audit events', async () => {
  const previousKey = process.env.OPC_API_KEY;
  const previousJwtSecret = process.env.OPC_JWT_SECRET;
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_JWT_SECRET = 'tinode-operations-jwt-secret-32-bytes';
  const calls: Array<Record<string, unknown>> = [];
  const events: Array<{ tenant: string; type: string; data: unknown }> = [];
  const options = {
    tinodeOperations: {
      snapshot: async (tenantId: string) => {
        assert.equal(tenantId, 'tenant-tinode-ops');
        return snapshot;
      },
      listDeadLetters: async (input: Record<string, unknown>) => {
        calls.push(input);
        return [deadLetter];
      },
      replayDeadLetter: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { dead_letter: deadLetter, replay_id: 'replay-1', replayed: false };
      },
      listMutationDeadLetters: async (input: Record<string, unknown>) => {
        calls.push(input);
        return [mutationDeadLetter];
      },
      replayMutationDeadLetter: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { dead_letter: mutationDeadLetter, replay_id: 'mutation-replay-1', replayed: false };
      }
    },
    publish: async (tenant: string, type: string, data: unknown) => {
      events.push({ tenant, type, data });
    }
  };
  const headers: Record<string, string> = {
    'X-API-Key': API_KEY,
    'X-Tenant-Id': 'tenant-tinode-ops'
  };
  try {
    const pg = new MemoryPg();
    const route = (
      method: string,
      path: string,
      requestHeaders: Record<string, string> = headers
    ) => routeIveKitChatApi(
      pg,
      method,
      path,
      new URL(`http://localhost${path}`),
      {},
      '',
      requestHeaders,
      options
    );
    const operations = await route('GET', '/api/ivekit/chat/operations/tinode') as { data: typeof snapshot };
    assert.deepEqual(operations.data, snapshot);

    const listed = await route(
      'GET',
      '/api/ivekit/chat/operations/tinode/dead-letters?state=open&limit=25'
    ) as { data: { items: typeof deadLetter[] } };
    assert.deepEqual(listed.data.items, [deadLetter]);
    assert.deepEqual(calls[0], { tenant_id: 'tenant-tinode-ops', state: 'open', limit: 25 });

    const replay = await route(
      'POST',
      '/api/ivekit/chat/operations/tinode/dead-letters/dead-1/replay',
      { ...headers, 'Idempotency-Key': 'manual-replay-1' }
    ) as { status: number; data: { replay_id: string }; afterCommit: () => Promise<void> };
    assert.equal(replay.status, 202);
    assert.equal(replay.data.replay_id, 'replay-1');
    assert.deepEqual(calls[1], {
      tenant_id: 'tenant-tinode-ops',
      dead_letter_id: 'dead-1',
      requested_by: 'system',
      idempotency_key: 'manual-replay-1'
    });
    await replay.afterCommit();
    assert.equal(events[0]?.type, 'collaboration.tinode.dead_letter.replay_requested');
    assert.equal(JSON.stringify(events).includes('payload'), false);

    const mutationListed = await route(
      'GET',
      '/api/ivekit/chat/operations/tinode/mutation-dead-letters?limit=10'
    ) as { data: { items: typeof mutationDeadLetter[] } };
    assert.deepEqual(mutationListed.data.items, [mutationDeadLetter]);
    assert.deepEqual(calls[2], { tenant_id: 'tenant-tinode-ops', limit: 10 });

    const mutationReplay = await route(
      'POST',
      '/api/ivekit/chat/operations/tinode/mutation-dead-letters/mutation-dead-1/replay',
      { ...headers, 'Idempotency-Key': 'mutation-replay-key' }
    ) as { status: number; afterCommit: () => Promise<void> };
    assert.equal(mutationReplay.status, 202);
    assert.deepEqual(calls[3], {
      tenant_id: 'tenant-tinode-ops',
      outbox_id: 'mutation-dead-1',
      requested_by: 'system',
      idempotency_key: 'mutation-replay-key'
    });
    await mutationReplay.afterCommit();
    assert.equal(events[1]?.type, 'collaboration.tinode.mutation_dead_letter.replay_requested');

    await assert.rejects(
      () => route(
        'GET',
        '/api/ivekit/chat/operations/tinode',
        {
          Authorization: `Bearer ${signAccessToken({
            sub: 'agent-1', tid: 'tenant-tinode-ops', role: 'operator'
          })}`
        }
      ),
      (error: unknown) => Number((error as { status?: unknown })?.status) === 403
    );
  } finally {
    if (previousKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previousKey;
    if (previousJwtSecret === undefined) delete process.env.OPC_JWT_SECRET;
    else process.env.OPC_JWT_SECRET = previousJwtSecret;
  }
});

test('iveKit SDK maps Tinode operations and both dead-letter families', async () => {
  const calls: Array<{ method: string; path: string; query: string; idempotency: string | null }> = [];
  const responses = [snapshot, { items: [deadLetter] }, {
    dead_letter: deadLetter, replay_id: 'replay-1', replayed: false
  }, { items: [mutationDeadLetter] }, {
    dead_letter: mutationDeadLetter, replay_id: 'mutation-replay-1', replayed: false
  }];
  const sdk = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example.com',
    tenantId: 'tenant-tinode-ops',
    apiKey: API_KEY,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({
        method: init.method || 'GET',
        path: url.pathname,
        query: url.search,
        idempotency: new Headers(init.headers).get('idempotency-key')
      });
      return Response.json(responses.shift());
    }
  });

  assert.deepEqual(await sdk.chat.getTinodeOperations(), snapshot);
  assert.deepEqual(await sdk.chat.listTinodeDeadLetters({ state: 'open', limit: 25 }), [deadLetter]);
  assert.equal((await sdk.chat.replayTinodeDeadLetter(
    'dead/1', { idempotencyKey: 'manual-replay-1' }
  )).replay_id, 'replay-1');
  assert.deepEqual(await sdk.chat.listTinodeMutationDeadLetters({ limit: 10 }), [mutationDeadLetter]);
  assert.equal((await sdk.chat.replayTinodeMutationDeadLetter(
    'mutation/dead/1', { idempotencyKey: 'mutation-replay-key' }
  )).replay_id, 'mutation-replay-1');
  assert.deepEqual(calls, [
    { method: 'GET', path: '/api/ivekit/chat/operations/tinode', query: '', idempotency: null },
    {
      method: 'GET', path: '/api/ivekit/chat/operations/tinode/dead-letters',
      query: '?state=open&limit=25', idempotency: null
    },
    {
      method: 'POST', path: '/api/ivekit/chat/operations/tinode/dead-letters/dead%2F1/replay',
      query: '', idempotency: 'manual-replay-1'
    },
    {
      method: 'GET', path: '/api/ivekit/chat/operations/tinode/mutation-dead-letters',
      query: '?limit=10', idempotency: null
    },
    {
      method: 'POST', path: '/api/ivekit/chat/operations/tinode/mutation-dead-letters/mutation%2Fdead%2F1/replay',
      query: '', idempotency: 'mutation-replay-key'
    }
  ]);
});
