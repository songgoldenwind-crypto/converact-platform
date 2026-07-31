import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withPgTransaction, type PgQueryable } from '../src/db-pg.js';

test('withPgTransaction reuses an existing PoolClient instead of connecting it again', async () => {
  let connectCalls = 0;
  let callbackCalls = 0;
  const client = {
    connect: async () => {
      connectCalls += 1;
      throw new Error('Client has already been connected. You cannot reuse a client.');
    },
    release: () => undefined,
    query: async () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] })
  } as unknown as PgQueryable;

  const result = await withPgTransaction(client, async (current) => {
    callbackCalls += 1;
    assert.equal(current, client);
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(callbackCalls, 1);
  assert.equal(connectCalls, 0);
});
