import { resolveFabricEnv } from './config/converact-env.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { applyConveractFabricMigrations } from './converact-migrations.js';

async function main(): Promise<void> {
  const migrationsDirectory = resolve(
    resolveFabricEnv(process.env, 'MIGRATIONS_DIR') ||
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
  );
  const pool = new Pool({ max: 1 });
  try {
    await pool.query('SELECT 1');
    await applyConveractFabricMigrations(pool, {
      directory: migrationsDirectory,
      advisoryLockName: 'ivekit_schema_migrations'
    });
    console.log('Converact Fabric PostgreSQL migrations applied');
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
