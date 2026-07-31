import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import {
  readPostgresMigrationPlan,
  runPostgresMigrationsOnClient,
  type PostgresMigration
} from '../src/postgres-migrations.js';

const LOCK_NAME = 'opc_schema_migrations';
const TARGET_VERSION = '106_ivekit_media_call_create_commands';

interface RecordedMigration {
  version: string;
  checksum: string;
}

export function validateProductionMediaHotfixMigrationState(
  plan: PostgresMigration[],
  recordedRows: Record<string, unknown>[]
): PostgresMigration {
  const targetIndex = plan.findIndex(
    (migration) => migration.version === TARGET_VERSION
  );
  if (targetIndex < 0 || targetIndex !== plan.length - 1) {
    throw new Error(
      'production media hotfix migration must be the final migration in the image'
    );
  }
  const recorded = new Map<string, RecordedMigration>();
  for (const row of recordedRows) {
    const version = String(row.version || '');
    const checksum = String(row.checksum || '');
    if (!version || !/^[a-f0-9]{64}$/.test(checksum)) {
      throw new Error(
        'schema_migrations contains an invalid or blank checksum'
      );
    }
    if (recorded.has(version)) {
      throw new Error('schema_migrations contains a duplicate version');
    }
    recorded.set(version, { version, checksum });
  }

  const target = plan[targetIndex];
  for (const migration of plan.slice(0, targetIndex)) {
    const current = recorded.get(migration.version);
    if (!current) {
      throw new Error(
        `historical migration is missing: ${migration.version}`
      );
    }
    if (current.checksum !== migration.checksum) {
      throw new Error(
        `historical migration checksum mismatch: ${migration.version}`
      );
    }
  }
  const targetRow = recorded.get(target.version);
  if (targetRow && targetRow.checksum !== target.checksum) {
    throw new Error(
      `target migration checksum mismatch: ${target.version}`
    );
  }
  return target;
}

async function main(): Promise<void> {
  const pool = new Pool({ max: 1 });
  const connection = await pool.connect();
  try {
    await connection.query(
      'SELECT pg_advisory_lock(hashtext($1))',
      [LOCK_NAME]
    );
    const plan = readPostgresMigrationPlan(
      resolve(process.cwd(), 'src/migrations')
    );
    const recorded = await connection.query<Record<string, unknown>>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version'
    );
    const target = validateProductionMediaHotfixMigrationState(
      plan,
      recorded.rows
    );
    await runPostgresMigrationsOnClient(connection, plan);
    const verified = await connection.query<Record<string, unknown>>(
      'SELECT version, checksum FROM schema_migrations WHERE version = $1',
      [target.version]
    );
    if (verified.rowCount !== 1 ||
        String(verified.rows[0]?.checksum || '') !== target.checksum) {
      throw new Error('target migration did not commit with the expected checksum');
    }
    await connection.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
          REVOKE ALL PRIVILEGES ON TABLE schema_migrations FROM opc_runtime;
        END IF;
      END
      $$
    `);
    process.stdout.write(
      `production media hotfix migration applied version=${target.version} ` +
      `checksum=${target.checksum}\n`
    );
  } finally {
    try {
      await connection.query(
        'SELECT pg_advisory_unlock(hashtext($1))',
        [LOCK_NAME]
      );
    } finally {
      connection.release();
      await pool.end();
    }
  }
}

if (process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error
        ? error.message
        : 'production media hotfix migration failed'}\n`
    );
    process.exitCode = 1;
  });
}
