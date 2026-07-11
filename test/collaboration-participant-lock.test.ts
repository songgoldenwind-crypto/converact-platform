import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withCollaborationParticipantLock } from '../src/agent-runtime/collaboration/collaboration-http.js';
import type { PgQueryable } from '../src/db-pg.js';

test('participant lock fails fast when PostgreSQL advisory lock is busy', async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  let callbackCalled = false;
  const pg = queryable(async (text, params) => {
    queries.push({ text, params });
    return [{ acquired: false }];
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
  assert.match(queries[0]?.text || '', /pg_try_advisory_xact_lock/);
  assert.deepEqual(queries[0]?.params, ['tenant-lock:session-lock', 'participant-lock']);
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
