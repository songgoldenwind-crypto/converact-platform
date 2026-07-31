import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  withCollaborationParticipantLock,
  withCollaborationSessionLock
} from '../src/agent-runtime/collaboration/collaboration-lock.js';
import type { PgQueryable } from '../src/db-pg.js';

test('participant lock fails fast when PostgreSQL advisory lock is busy', async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  let callbackCalled = false;
  const pg = queryable(async (text, params) => {
    queries.push({ text, params });
    return [{ acquired: queries.length === 1 }];
  });

  await assert.rejects(
    () => withCollaborationParticipantLock(pg, {
      tenantId: 'tenant-lock',
      sessionId: 'session-lock',
      identity: 'participant-lock'
    }, async () => {
      callbackCalled = true;
    }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.equal((error as { code?: string }).code, 'collaboration_participant_busy');
      assert.equal((error as { retryable?: boolean }).retryable, true);
      return true;
    }
  );

  assert.equal(callbackCalled, false);
  assert.match(queries[0]?.text || '', /pg_try_advisory_xact_lock_shared/);
  assert.deepEqual(queries[0]?.params, [
    'opc.collaboration.session.v1',
    'tenant-lock',
    'session-lock'
  ]);
  assert.match(queries[1]?.text || '', /pg_try_advisory_xact_lock/);
  assert.deepEqual(queries[1]?.params, [
    'opc.collaboration.participant.v1',
    'tenant-lock',
    'session-lock',
    'participant-lock'
  ]);
});

test('participant lock runs the operation after PostgreSQL lock acquisition', async () => {
  const pg = queryable(async () => [{ acquired: true }]);
  const result = await withCollaborationParticipantLock(pg, {
    tenantId: 'tenant-lock',
    sessionId: 'session-lock',
    identity: 'participant-lock'
  }, async (lockedPg) => {
    assert.equal(lockedPg, pg);
    return 'locked';
  });

  assert.equal(result, 'locked');
});

test('exclusive session lock fails fast while the session is busy', async () => {
  let callbackCalled = false;
  const pg = queryable(async () => [{ acquired: false }]);

  await assert.rejects(
    () => withCollaborationSessionLock(pg, {
      tenantId: 'tenant-lock',
      sessionId: 'session-lock',
      mode: 'exclusive'
    }, async () => {
      callbackCalled = true;
    }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.equal((error as { code?: string }).code, 'collaboration_session_busy');
      assert.equal((error as { retryable?: boolean }).retryable, true);
      return true;
    }
  );
  assert.equal(callbackCalled, false);
});

test('shared session lock uses a transaction-scoped advisory read lock', async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const pg = queryable(async (text, params) => {
    queries.push({ text, params });
    return [{ acquired: true }];
  });

  const result = await withCollaborationSessionLock(pg, {
    tenantId: 'tenant-lock',
    sessionId: 'session-lock',
    mode: 'shared'
  }, async () => 'shared');

  assert.equal(result, 'shared');
  assert.match(queries[0]?.text || '', /pg_try_advisory_xact_lock_shared/);
  assert.deepEqual(queries[0]?.params, [
    'opc.collaboration.session.v1',
    'tenant-lock',
    'session-lock'
  ]);
});

test('session lock owns BEGIN and COMMIT when called with a PostgreSQL pool', async () => {
  const statements: string[] = [];
  let released = false;
  const client = {
    query: async (text: string) => {
      statements.push(text.replace(/\s+/g, ' ').trim());
      return {
        rows: text.includes('pg_try_advisory_xact_lock') ? [{ acquired: true }] : [],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: []
      };
    },
    release: () => {
      released = true;
    }
  };
  const pool = {
    query: async () => {
      throw new Error('pool.query must not be used inside the lock transaction');
    },
    connect: async () => client
  } as unknown as PgQueryable;

  const result = await withCollaborationSessionLock(pool, {
    tenantId: 'tenant-pool-lock',
    sessionId: 'session-pool-lock',
    mode: 'exclusive'
  }, async (lockedPg) => {
    assert.equal(lockedPg, client);
    return 'committed';
  });

  assert.equal(result, 'committed');
  assert.deepEqual(statements.map((statement) => statement.split(' ')[0]), [
    'BEGIN',
    'SELECT',
    'COMMIT'
  ]);
  assert.equal(released, true);
});

function queryable(
  run: (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>
): PgQueryable {
  return {
    query: async (text: string, params: unknown[] = []) => ({
      rows: await run(text, params),
      rowCount: 1,
      command: '',
      oid: 0,
      fields: []
    })
  } as PgQueryable;
}
