import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import { shouldRecordCall } from '../src/recording-policy.js';

test('recording policy catches asynchronous consent lookup failure and remains fail-open', async () => {
  const pg: PgQueryable = {
    async query() {
      throw new Error('consent store unavailable');
    }
  };

  assert.equal(await shouldRecordCall(pg, 'call-a', { tenant_id: 'tenant-a' }), true);
});
