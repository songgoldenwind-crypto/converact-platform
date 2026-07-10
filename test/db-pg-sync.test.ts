import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, one, all, run } from '../src/db.js';
import { PgSyncDatabase } from '../src/db-pg-sync.js';

// These tests prove that run/one/all (from db.ts, written for SQLite)
// work UNCHANGED when given a PgSyncDatabase instance (backed by Postgres).
// This is the key to zero-store-change migration.

test('PgSyncDatabase + run/one/all: INSERT and SELECT works', () => {
  // Use a real Postgres connection (local dev DB)
  if (!process.env.DATABASE_URL && !process.env.PG_TEST_URL) {
    // Skip if no Postgres available
    return;
  }

  const pgDb = new PgSyncDatabase();
  const tableName = `test_pg_sync_${Date.now()}`;

  try {
    // CREATE
    run(pgDb, `CREATE TABLE ${tableName} (id TEXT, name TEXT)`);

    // INSERT via run (SQLite-style ? placeholders)
    run(pgDb, `INSERT INTO ${tableName} VALUES (?, ?)`, ['1', 'alice']);
    run(pgDb, `INSERT INTO ${tableName} VALUES (?, ?)`, ['2', 'bob']);

    // SELECT via one (returns first row)
    const alice = one(pgDb, `SELECT * FROM ${tableName} WHERE id = ?`, ['1']);
    assert.equal(alice?.name, 'alice');

    // SELECT via all (returns all rows)
    const everyone = all(pgDb, `SELECT * FROM ${tableName} ORDER BY id`);
    assert.equal(everyone.length, 2);
    assert.equal(everyone[0].name, 'alice');
    assert.equal(everyone[1].name, 'bob');

    // UPDATE via run
    run(pgDb, `UPDATE ${tableName} SET name = ? WHERE id = ?`, ['alice2', '1']);
    const updated = one(pgDb, `SELECT name FROM ${tableName} WHERE id = ?`, ['1']);
    assert.equal(updated?.name, 'alice2');

    // DELETE via run
    run(pgDb, `DELETE FROM ${tableName} WHERE id = ?`, ['2']);
    const remaining = all(pgDb, `SELECT * FROM ${tableName}`);
    assert.equal(remaining.length, 1);
  } finally {
    // Cleanup
    try { run(pgDb, `DROP TABLE ${tableName}`); } catch {}
    pgDb.close();
  }
});

test('PgSyncDatabase: returns null for no-match one()', () => {
  if (!process.env.DATABASE_URL && !process.env.PG_TEST_URL) return;

  const pgDb = new PgSyncDatabase();
  const tableName = `test_pg_sync_null_${Date.now()}`;

  try {
    run(pgDb, `CREATE TABLE ${tableName} (id TEXT, name TEXT)`);
    run(pgDb, `INSERT INTO ${tableName} VALUES (?, ?)`, ['1', 'exists']);

    const found = one(pgDb, `SELECT * FROM ${tableName} WHERE id = ?`, ['1']);
    assert.ok(found);

    const notFound = one(pgDb, `SELECT * FROM ${tableName} WHERE id = ?`, ['nonexistent']);
    assert.equal(notFound, null); // SQLite returns null, our adapter should too
  } finally {
    try { run(pgDb, `DROP TABLE ${tableName}`); } catch {}
    pgDb.close();
  }
});
