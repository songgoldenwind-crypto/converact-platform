import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { runMigrations } from './db-pg.js';

async function main(): Promise<void> {
  const migrationsDirectory = resolve(
    process.env.OPC_IVEKIT_MIGRATIONS_DIR ||
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
  );
  const pool = new Pool({ max: 1 });
  try {
    await pool.query('SELECT 1');
    await runMigrations(pool, {
      directory: migrationsDirectory,
      advisoryLockName: 'ivekit_schema_migrations'
    });
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
          REVOKE ALL PRIVILEGES ON TABLE schema_migrations FROM opc_runtime;
        END IF;
      END
      $$
    `);
    console.log('iveKit PostgreSQL migrations applied');
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
