import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  validateProductionMediaHotfixMigrationState
} from '../scripts/run-production-media-hotfix-migration.js';
import type { PostgresMigration } from '../src/postgres-migrations.js';

const history = migration('105_history', 'a');
const target = migration(
  '106_ivekit_media_call_create_commands',
  'b'
);
const extra = {
  version: '106_tinode_open_session_mutation_queue',
  checksum: 'c'.repeat(64)
};

test('migration guard permits only the exact target gap and ignores newer foreign rows', () => {
  assert.equal(
    validateProductionMediaHotfixMigrationState(
      [history, target],
      [{
        version: history.version,
        checksum: history.checksum
      }, extra]
    ),
    target
  );
  assert.equal(
    validateProductionMediaHotfixMigrationState(
      [history, target],
      [{
        version: history.version,
        checksum: history.checksum
      }, {
        version: target.version,
        checksum: target.checksum
      }, extra]
    ),
    target
  );
});

test('migration guard rejects a historical gap, checksum drift, blank checksum, or later image migration', () => {
  assert.throws(
    () => validateProductionMediaHotfixMigrationState(
      [history, target],
      []
    ),
    /historical migration is missing/
  );
  assert.throws(
    () => validateProductionMediaHotfixMigrationState(
      [history, target],
      [{ version: history.version, checksum: 'd'.repeat(64) }]
    ),
    /historical migration checksum mismatch/
  );
  assert.throws(
    () => validateProductionMediaHotfixMigrationState(
      [history, target],
      [{ version: history.version, checksum: '' }]
    ),
    /blank checksum/
  );
  assert.throws(
    () => validateProductionMediaHotfixMigrationState(
      [history, target, migration('107_later', 'e')],
      [{ version: history.version, checksum: history.checksum }]
    ),
    /final migration/
  );
});

test('migration runner holds the canonical advisory lock around validation and execution', () => {
  const source = readFileSync(
    'scripts/run-production-media-hotfix-migration.ts',
    'utf8'
  );
  assert.match(source, /opc_schema_migrations/);
  assert.match(source, /SELECT pg_advisory_lock\(hashtext\(\$1\)\)/);
  assert.match(source, /validateProductionMediaHotfixMigrationState/);
  assert.match(source, /runPostgresMigrationsOnClient\(connection, plan\)/);
  assert.match(source, /SELECT pg_advisory_unlock\(hashtext\(\$1\)\)/);
  assert.doesNotMatch(source, /runMigrations\(/);
});

function migration(
  version: string,
  fill: string
): PostgresMigration {
  return {
    file: `${version}.sql`,
    version,
    checksum: fill.repeat(64),
    sql: 'SELECT 1'
  };
}
