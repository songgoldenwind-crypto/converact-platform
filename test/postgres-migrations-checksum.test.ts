import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  prepareSipEffectStaleNonterminalIndex,
  prepareVoiceCdrConcurrentIndex,
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

class FailOnceMigrationPg extends MigrationPg {
  failed = false;

  override async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    if (!this.failed && text.includes('CREATE TABLE recoverable')) {
      this.failed = true;
      throw new Error('simulated migration failure');
    }
    return super.query(text, params);
  }
}

class ConcurrentIndexPg implements MigrationQueryable {
  readonly queries: string[] = [];

  constructor(
    private readonly indexRows: Record<string, unknown>[],
    private readonly constraintRows: Record<string, unknown>[] = []
  ) {}

  async query(text: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, ' ').trim();
    this.queries.push(sql);
    if (sql.includes('FROM pg_constraint')) {
      return {
        rows: structuredClone(this.constraintRows),
        rowCount: this.constraintRows.length
      };
    }
    if (sql.includes('FROM pg_index')) {
      return { rows: structuredClone(this.indexRows), rowCount: this.indexRows.length };
    }
    return { rows: [], rowCount: 0 };
  }
}

test('migration executor records checksums, skips exact replay, and rejects drift', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'converact-migrations-'));
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
  const directory = mkdtempSync(join(tmpdir(), 'converact-migrations-legacy-'));
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

test('failed migration rolls back without a ledger entry and succeeds on forward retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'converact-migrations-recovery-'));
  writeFileSync(join(directory, '102_recoverable.sql'), 'CREATE TABLE recoverable (id TEXT PRIMARY KEY);\n');
  const pg = new FailOnceMigrationPg();
  try {
    const plan = readPostgresMigrationPlan(directory);
    await assert.rejects(
      () => runPostgresMigrationsOnClient(pg, plan),
      /simulated migration failure/
    );
    assert.equal(pg.versions.has('102_recoverable'), false);

    await runPostgresMigrationsOnClient(pg, plan);
    assert.equal(pg.versions.get('102_recoverable'), plan[0].checksum);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('voice CDR migration preflight creates a missing concurrent unique index', async () => {
  const pg = new ConcurrentIndexPg([]);

  await prepareVoiceCdrConcurrentIndex(pg);

  assert.equal(
    pg.queries.some((query) =>
      query.includes('CREATE UNIQUE INDEX CONCURRENTLY uq_ivekit_tenant_events_tenant_id')
    ),
    true
  );
  assert.equal(pg.queries.some((query) => query.includes('DROP INDEX CONCURRENTLY')), false);
});

test('voice CDR migration preflight rebuilds a malformed named index', async () => {
  const pg = new ConcurrentIndexPg([{
    indisunique: true,
    indisvalid: false,
    indisready: true,
    no_predicate: true,
    no_expressions: true,
    indnkeyatts: 2,
    indnatts: 2,
    key_columns: ['id', 'tenant_id']
  }]);

  await prepareVoiceCdrConcurrentIndex(pg);

  const drop = pg.queries.findIndex((query) =>
    query.includes('DROP INDEX CONCURRENTLY public.uq_ivekit_tenant_events_tenant_id')
  );
  const create = pg.queries.findIndex((query) =>
    query.includes('CREATE UNIQUE INDEX CONCURRENTLY uq_ivekit_tenant_events_tenant_id')
  );
  assert.ok(drop >= 0);
  assert.ok(create > drop);
});

test('voice CDR migration preflight preserves a valid concurrent index or constraint', async () => {
  const valid = {
    indisunique: true,
    indisvalid: true,
    indisready: true,
    no_predicate: true,
    no_expressions: true,
    indnkeyatts: 2,
    indnatts: 2,
    key_columns: ['tenant_id', 'id']
  };
  const indexed = new ConcurrentIndexPg([valid]);
  const constrained = new ConcurrentIndexPg([], [{
    ...valid,
    constraint_type: 'u'
  }]);

  await prepareVoiceCdrConcurrentIndex(indexed);
  await prepareVoiceCdrConcurrentIndex(constrained);

  for (const pg of [indexed, constrained]) {
    assert.equal(
      pg.queries.some((query) =>
        query.includes('CREATE UNIQUE INDEX CONCURRENTLY') ||
        query.includes('DROP INDEX CONCURRENTLY')
      ),
      false
    );
  }
});

test('voice CDR migration preflight rejects a malformed named constraint', async () => {
  const malformed = new ConcurrentIndexPg([], [{
    constraint_type: 'u',
    indisunique: true,
    indisvalid: true,
    indisready: true,
    no_predicate: true,
    no_expressions: true,
    indnkeyatts: 1,
    indnatts: 1,
    key_columns: ['id']
  }]);

  await assert.rejects(
    () => prepareVoiceCdrConcurrentIndex(malformed),
    /named unique constraint is invalid/i
  );
  assert.equal(
    malformed.queries.some((query) =>
      query.includes('CREATE UNIQUE INDEX CONCURRENTLY') ||
      query.includes('DROP INDEX CONCURRENTLY')
    ),
    false
  );
});

test('voice CDR migration uses a bounded transaction lock timeout', async () => {
  const pg = new MigrationPg();
  await runPostgresMigrationsOnClient(pg, [{
    file: '103_ivekit_voice_cdr_convergence.sql',
    version: '103_ivekit_voice_cdr_convergence',
    checksum: 'a'.repeat(64),
    sql: 'SELECT 103'
  }]);

  assert.equal(
    pg.executedSql.some((sql) =>
      /SET LOCAL lock_timeout = '5s'/i.test(sql)
    ),
    true
  );
});

test('SIP stale-nonterminal migration preflight creates its partial index concurrently', async () => {
  const pg = new ConcurrentIndexPg([]);

  await prepareSipEffectStaleNonterminalIndex(pg);

  assert.equal(
    pg.queries.some((query) =>
      query.includes(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ivekit_sip_effect_stale_nonterminal'
      )
    ),
    true
  );
  assert.equal(
    pg.queries.some((query) => query.includes('DROP INDEX CONCURRENTLY')),
    false
  );
});

test('SIP stale-nonterminal migration preflight preserves only the exact index', async () => {
  const valid = {
    indisunique: false,
    indisvalid: true,
    indisready: true,
    no_expressions: true,
    indnkeyatts: 5,
    indnatts: 5,
    key_columns: [
      'tenant_id',
      'protocol_session_id',
      'protocol_session_generation',
      'updated_at',
      'protocol_effect_id'
    ],
    predicate: "(state = ANY (ARRAY['send_attempted'::text, 'transport_accepted'::text]))"
  };
  const exact = new ConcurrentIndexPg([valid]);
  const malformed = new ConcurrentIndexPg([{
    ...valid,
    key_columns: ['tenant_id', 'updated_at', 'protocol_effect_id'],
    indnkeyatts: 3,
    indnatts: 3
  }]);

  await prepareSipEffectStaleNonterminalIndex(exact);
  await prepareSipEffectStaleNonterminalIndex(malformed);

  assert.equal(
    exact.queries.some((query) =>
      query.includes('CREATE INDEX CONCURRENTLY') ||
      query.includes('DROP INDEX CONCURRENTLY')
    ),
    false
  );
  const drop = malformed.queries.findIndex((query) =>
    query.includes(
      'DROP INDEX CONCURRENTLY public.idx_ivekit_sip_effect_stale_nonterminal'
    )
  );
  const create = malformed.queries.findIndex((query) =>
    query.includes(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ivekit_sip_effect_stale_nonterminal'
    )
  );
  assert.ok(drop >= 0);
  assert.ok(create > drop);
});
