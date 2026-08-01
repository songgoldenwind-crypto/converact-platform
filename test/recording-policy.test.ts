import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import { shouldRecordCall } from '../src/recording-policy.js';

test('recording policy denies new recording when consent lookup fails', async () => {
  const pg: PgQueryable = {
    async query() {
      throw new Error('consent store unavailable');
    }
  };

  assert.equal(await shouldRecordCall(pg, 'call-a', { tenant_id: 'tenant-a' }), false);
});

test('recording policy requires a tenant-scoped durable consent store', async () => {
  assert.equal(await shouldRecordCall(null, 'call-a', { tenant_id: 'tenant-a' }), false);
  assert.equal(await shouldRecordCall(consentPg('granted'), 'call-a', {}), false);
});

test('recording policy allows only explicitly granted consent', async () => {
  assert.equal(await shouldRecordCall(consentPg('granted'), 'call-a', { tenant_id: 'tenant-a' }), true);
  assert.equal(await shouldRecordCall(consentPg('pending'), 'call-a', { tenant_id: 'tenant-a' }), false);
  assert.equal(await shouldRecordCall(consentPg('denied'), 'call-a', { tenant_id: 'tenant-a' }), false);
  assert.equal(await shouldRecordCall(consentPg(null), 'call-a', { tenant_id: 'tenant-a' }), false);
});

function consentPg(status: 'granted' | 'pending' | 'denied' | null): PgQueryable {
  return {
    async query<R>(sql: string) {
      const rows = (String(sql).includes('SELECT status FROM compliance_consent') && status
        ? [{ status }]
        : []) as R[];
      return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
    }
  };
}
