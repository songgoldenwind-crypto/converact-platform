import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { applyIveKitMigrations } from './ivekit-migrations.js';

async function main(): Promise<void> {
  const migrationsDirectory = resolve(
    process.env.OPC_IVEKIT_MIGRATIONS_DIR ||
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
  );
  const pool = new Pool({ max: 1 });
  try {
    await pool.query('SELECT 1');
    await applyIveKitMigrations(pool, {
      directory: migrationsDirectory,
      advisoryLockName: 'ivekit_schema_migrations'
    });
    console.log('iveKit PostgreSQL migrations applied');
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
