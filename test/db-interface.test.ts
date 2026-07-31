import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createSqliteClient, createPgClient, convertPlaceholders, type DbClient } from '../src/db-interface.js';

test('convertPlaceholders: converts ? to $1, $2, ...', () => {
  assert.equal(convertPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'),
    'SELECT * FROM t WHERE a = $1 AND b = $2');
  assert.equal(convertPlaceholders('SELECT 1'), 'SELECT 1');
  assert.equal(convertPlaceholders('INSERT INTO t VALUES (?, ?, ?)'),
    'INSERT INTO t VALUES ($1, $2, $3)');
});

test('SQLite adapter: query returns rows', async () => {
  const db = createDatabase(':memory:');
  db.exec('CREATE TABLE test_q (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO test_q VALUES (1, 'alice'), (2, 'bob')");

  const client: DbClient = createSqliteClient(db);
  const rows = await client.query<{ id: number; name: string }>('SELECT * FROM test_q WHERE name = ?', ['alice']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'alice');
});

test('SQLite adapter: queryOne returns single row or null', async () => {
  const db = createDatabase(':memory:');
  db.exec('CREATE TABLE test_qo (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO test_qo VALUES (1, 'alice')");

  const client = createSqliteClient(db);
  const found = await client.queryOne<{ id: number; name: string }>('SELECT * FROM test_qo WHERE id = ?', [1]);
  assert.equal(found?.name, 'alice');

  const notFound = await client.queryOne('SELECT * FROM test_qo WHERE id = ?', [999]);
  assert.equal(notFound, null);
});

test('SQLite adapter: exec runs INSERT/UPDATE/DELETE', async () => {
  const db = createDatabase(':memory:');
  db.exec('CREATE TABLE test_e (id INTEGER PRIMARY KEY, val TEXT)');

  const client = createSqliteClient(db);
  await client.exec('INSERT INTO test_e VALUES (?, ?)', [1, 'hello']);
  await client.exec('UPDATE test_e SET val = ? WHERE id = ?', ['world', 1]);

  const row = await client.queryOne<{ val: string }>('SELECT val FROM test_e WHERE id = ?', [1]);
  assert.equal(row?.val, 'world');
});

test('Postgres adapter: converts placeholders and calls pg.query', async () => {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const mockPg = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ sql: text, params });
      // Simulate a SELECT response
      if (text.includes('SELECT')) {
        return { rows: [{ id: 1, name: 'mock' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  };

  const client = createPgClient(mockPg);

  // query
  const rows = await client.query('SELECT * FROM t WHERE a = ? AND b = ?', ['x', 2]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'mock');
  assert.equal(calls[0].sql, 'SELECT * FROM t WHERE a = $1 AND b = $2');
  assert.deepEqual(calls[0].params, ['x', 2]);

  // queryOne
  const one = await client.queryOne('SELECT * FROM t WHERE id = ?', [1]);
  assert.equal(one?.id, 1);

  // exec
  await client.exec('INSERT INTO t VALUES (?, ?)', [1, 'test']);
  assert.equal(calls[2].sql, 'INSERT INTO t VALUES ($1, $2)');

  // empty result → null
  const emptyPg = { query: async () => ({ rows: [], rowCount: 0 }) };
  const emptyClient = createPgClient(emptyPg);
  const nothing = await emptyClient.queryOne('SELECT * FROM t WHERE id = ?', [999]);
  assert.equal(nothing, null);
});

test('Both adapters share the same interface shape', () => {
  const sqliteClient = createSqliteClient({} as any);
  const pgClient = createPgClient({ query: async () => ({ rows: [] }) });

  // Both should have query, queryOne, exec
  assert.equal(typeof sqliteClient.query, 'function');
  assert.equal(typeof sqliteClient.queryOne, 'function');
  assert.equal(typeof sqliteClient.exec, 'function');
  assert.equal(typeof pgClient.query, 'function');
  assert.equal(typeof pgClient.queryOne, 'function');
  assert.equal(typeof pgClient.exec, 'function');
});
