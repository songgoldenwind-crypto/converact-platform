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
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return { rows: [{ version: 'already_applied' }], rowCount: 1 };
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
