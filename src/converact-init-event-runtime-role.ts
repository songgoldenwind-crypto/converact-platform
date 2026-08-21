import { resolveBrandEnv } from './config/converact-env.js';
import { Pool } from 'pg';

import { activateConveractEventRuntimeRole } from './converact-runtime-role.js';

async function main(): Promise<void> {
  const password = String(resolveBrandEnv(process.env, 'EVENT_RUNTIME_DB_PASSWORD') || '');
  if (!password) throw new Error('CONVERACT_EVENT_RUNTIME_DB_PASSWORD is required');

  const pool = new Pool({ max: 1 });
  try {
    await activateConveractEventRuntimeRole(pool, password);
    console.log('Converact Platform Event PostgreSQL runtime role activated');
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
