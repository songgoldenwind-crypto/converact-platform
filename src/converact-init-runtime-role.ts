import { resolveBrandEnv } from './config/converact-env.js';
import { Pool } from 'pg';

import { initializeIveKitRuntimeRole } from './converact-runtime-role.js';

async function main(): Promise<void> {
  const password = String(resolveBrandEnv(process.env, 'RUNTIME_DB_PASSWORD') || '');
  if (!password) throw new Error('CONVERACT_RUNTIME_DB_PASSWORD is required');

  const pool = new Pool({ max: 1 });
  try {
    await initializeIveKitRuntimeRole(pool, password);
    console.log('iveKit PostgreSQL runtime role initialized');
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
