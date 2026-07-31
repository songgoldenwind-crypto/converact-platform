import { Pool } from 'pg';

import { runMigrations } from '../src/db-pg.js';

async function main(): Promise<void> {
  const pool = new Pool({ max: 1 });
  try {
    await pool.query('SELECT 1');
    await runMigrations(pool);
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
          REVOKE ALL PRIVILEGES ON TABLE schema_migrations FROM opc_runtime;
        END IF;
      END
      $$
    `);
    console.log('PostgreSQL migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
