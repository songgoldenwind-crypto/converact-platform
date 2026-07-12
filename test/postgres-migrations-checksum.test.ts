import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readPostgresMigrationPlan,
  runPostgresMigrationsOnClient,
  type MigrationQueryable
} from '../src/postgres-migrations.js';

class MigrationPg implements MigrationQueryable {
  readonly versions = new Map<string, string>();
  readonly executedSql: string[] = [];

  async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('SELECT version, checksum FROM schema_migrations')) {
      const checksum = this.versions.get(String(params[0]));
      return checksum === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ version: params[0], checksum }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE schema_migrations SET checksum')) {
      this.versions.set(String(params[1]), String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO schema_migrations')) {
      this.versions.set(String(params[0]), String(params[1]));
      return { rows: [], rowCount: 1 };
    }
    if (!/^(?:CREATE TABLE IF NOT EXISTS schema_migrations|ALTER TABLE schema_migrations|BEGIN|COMMIT|ROLLBACK)/.test(sql)) {
      this.executedSql.push(text);
    }
    return { rows: [], rowCount: 0 };
  }
}

test('migration executor records checksums, skips exact replay, and rejects drift', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-migrations-'));
  const file = join(directory, '100_example.sql');
  writeFileSync(file, 'CREATE TABLE example (id TEXT PRIMARY KEY);\n');
  const pg = new MigrationPg();
  try {
    const plan = readPostgresMigrationPlan(directory);
    assert.equal(plan.length, 1);
    assert.match(plan[0].checksum, /^[a-f0-9]{64}$/);

    await runPostgresMigrationsOnClient(pg, plan);
    assert.equal(pg.executedSql.length, 1);
    assert.equal(pg.versions.get('100_example'), plan[0].checksum);

    await runPostgresMigrationsOnClient(pg, plan);
    assert.equal(pg.executedSql.length, 1);

    writeFileSync(file, 'CREATE TABLE example_changed (id TEXT PRIMARY KEY);\n');
    await assert.rejects(
      () => runPostgresMigrationsOnClient(pg, readPostgresMigrationPlan(directory)),
      /checksum mismatch.*100_example/i
    );
    assert.equal(pg.executedSql.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migration executor backfills a legacy blank checksum without rerunning SQL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-migrations-legacy-'));
  writeFileSync(join(directory, '101_legacy.sql'), 'CREATE TABLE legacy (id TEXT PRIMARY KEY);\n');
  const pg = new MigrationPg();
  pg.versions.set('101_legacy', '');
  try {
    const plan = readPostgresMigrationPlan(directory);
    await runPostgresMigrationsOnClient(pg, plan);
    assert.equal(pg.executedSql.length, 0);
    assert.equal(pg.versions.get('101_legacy'), plan[0].checksum);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
