import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { withPgTenant } from '../src/db-pg-tenant.js';
import type { PgQueryable } from '../src/db-pg.js';

interface TraceEntry {
  sql: string;
  params: unknown[];
}

interface ContractCase {
  id: string;
  tenant_id: string;
  work_sql: string;
  work_outcome: 'ok' | 'error';
  expected_trace: TraceEntry[];
}

interface ContractFixture {
  current_sources: Array<{ path: string; sha256: string }>;
  cases: ContractCase[];
}

class RecordingClient implements PgQueryable {
  readonly trace: TraceEntry[] = [];
  released = false;

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = []
  ): Promise<QueryResult<R>> {
    this.trace.push({ sql, params });
    return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
  }

  release(): void {
    this.released = true;
  }
}

class RecordingPool implements PgQueryable {
  readonly client = new RecordingClient();

  async connect(): Promise<RecordingClient> {
    return this.client;
  }

  async query<R extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<R>> {
    throw new Error('pool query must not bypass the checked-out transaction client');
  }
}

const fixtureUrl = new URL(
  '../server-rs/tests/fixtures/postgres-tenant-transaction-v1.json',
  import.meta.url
);

async function loadFixture(): Promise<ContractFixture> {
  return JSON.parse(await readFile(fixtureUrl, 'utf8')) as ContractFixture;
}

test('PostgreSQL tenant transaction corpus is bound to the exact TypeScript source', async () => {
  const fixture = await loadFixture();
  for (const source of fixture.current_sources) {
    const bytes = await readFile(new URL(`../${source.path}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256, source.path);
  }
});

test('current TypeScript tenant transaction replays the frozen success and rollback traces', async () => {
  const fixture = await loadFixture();
  for (const contractCase of fixture.cases) {
    const pool = new RecordingPool();
    const run = withPgTenant(pool, contractCase.tenant_id, async (client) => {
      await client.query(contractCase.work_sql);
      if (contractCase.work_outcome === 'error') throw new Error('work_failed');
      return 'ok';
    });
    if (contractCase.work_outcome === 'error') {
      await assert.rejects(run, /work_failed/, contractCase.id);
    } else {
      assert.equal(await run, 'ok', contractCase.id);
    }
    assert.deepEqual(pool.client.trace, contractCase.expected_trace, contractCase.id);
    assert.equal(pool.client.released, true, contractCase.id);
  }
});

test('current TypeScript tenant transaction rejects an empty tenant before database work', async () => {
  const pool = new RecordingPool();
  await assert.rejects(() => withPgTenant(pool, '', async () => 'unreachable'), /tenantId is required/);
  assert.deepEqual(pool.client.trace, []);
  assert.equal(pool.client.released, false);
});
