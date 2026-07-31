import assert from 'node:assert/strict';
import { test } from 'node:test';

import { postgresConnectionConfigFromEnv } from '../src/db-pg.js';

test('PostgreSQL config separates runtime and migration connections', () => {
  assert.deepEqual(postgresConnectionConfigFromEnv({
    DATABASE_URL: 'postgresql://opc_runtime:runtime@postgres:5432/opc',
    DATABASE_MIGRATION_URL: 'postgresql://opc_admin:admin@postgres:5432/opc'
  }), {
    runtimeUrl: 'postgresql://opc_runtime:runtime@postgres:5432/opc',
    migrationUrl: 'postgresql://opc_admin:admin@postgres:5432/opc'
  });
  assert.deepEqual(postgresConnectionConfigFromEnv({
    DATABASE_URL: 'postgresql://opc:password@postgres:5432/opc'
  }), {
    runtimeUrl: 'postgresql://opc:password@postgres:5432/opc',
    migrationUrl: 'postgresql://opc:password@postgres:5432/opc'
  });
  assert.deepEqual(postgresConnectionConfigFromEnv({
    PGHOST: 'postgres',
    PGPORT: '5432',
    PGDATABASE: 'opc',
    PGUSER: 'opc_runtime',
    PGPASSWORD: 'p@ss:/#%word',
    CONVERACT_SCHEMA_MANAGED_BY_MIGRATIONS: '1'
  }), {
    runtimeUrl: 'postgresql://opc_runtime:p%40ss%3A%2F%23%25word@postgres:5432/opc',
    migrationUrl: null
  });
  assert.equal(postgresConnectionConfigFromEnv({}), null);
});
