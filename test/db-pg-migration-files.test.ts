import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPostgresMigrationFile, runMigrations, type PgQueryable } from '../src/db-pg.js';

test('PostgreSQL migration discovery rejects macOS metadata and unrelated SQL files', () => {
  assert.equal(isPostgresMigrationFile('001_init.sql'), true);
  assert.equal(isPostgresMigrationFile('030_collaboration_message_state.sql'), true);
  assert.equal(isPostgresMigrationFile('._001_init.sql'), false);
  assert.equal(isPostgresMigrationFile('.001_init.sql'), false);
  assert.equal(isPostgresMigrationFile('001-init.sql'), false);
  assert.equal(isPostgresMigrationFile('notes.sql'), false);
  assert.equal(isPostgresMigrationFile('001_init.SQL'), false);
});

test('PostgreSQL migrations hold one advisory lock for the whole migration pass', async () => {
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT version, checksum FROM schema_migrations')) {
        return { rows: [{ version: 'already_applied', checksum: '' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => queries.push('RELEASE_CLIENT')
  };
  const pool = {
    query: async () => {
      throw new Error('migration queries must use the advisory-lock client');
    },
    connect: async () => client
  } as unknown as PgQueryable;

  await runMigrations(pool);

  assert.match(queries[0], /pg_advisory_lock/);
  assert.match(queries.at(-2) || '', /pg_advisory_unlock/);
  assert.equal(queries.at(-1), 'RELEASE_CLIENT');
});

test('fresh PostgreSQL migrations define RLS helpers before policy execution', async () => {
  const availableFunctions = new Set<string>();
  const appliedVersions: string[] = [];
  const pg = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('SELECT version, checksum FROM schema_migrations')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO schema_migrations')) {
        appliedVersions.push(String(params[0]));
      } else {
        assertRlsHelpersAvailable(sql, availableFunctions);
      }
      return { rows: [], rowCount: 0 };
    }
  } as PgQueryable;

  await runMigrations(pg);

  assert.equal(appliedVersions.includes('005_full_schema'), true);
  assert.equal(appliedVersions.includes('009_tenant_rls'), true);
  assert.deepEqual([...availableFunctions].sort(), ['opc_current_tenant', 'opc_rls_bypass']);
});

function assertRlsHelpersAvailable(sql: string, availableFunctions: Set<string>): void {
  const events: Array<{ index: number; kind: 'definition' | 'policy'; value: string }> = [];
  for (const match of sql.matchAll(
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(opc_(?:rls_bypass|current_tenant))\s*\(/gi
  )) {
    events.push({ index: match.index, kind: 'definition', value: match[1].toLowerCase() });
  }
  for (const match of sql.matchAll(/CREATE\s+POLICY\b[\s\S]*?(?:;|$)/gi)) {
    events.push({ index: match.index, kind: 'policy', value: match[0] });
  }
  events.sort((left, right) => left.index - right.index);

  for (const event of events) {
    if (event.kind === 'definition') {
      availableFunctions.add(event.value);
      continue;
    }
    for (const functionName of ['opc_rls_bypass', 'opc_current_tenant']) {
      if (new RegExp(`\\b${functionName}\\s*\\(`, 'i').test(event.value)) {
        assert.equal(
          availableFunctions.has(functionName),
          true,
          `${functionName} must be defined before CREATE POLICY executes`
        );
      }
    }
  }
}
