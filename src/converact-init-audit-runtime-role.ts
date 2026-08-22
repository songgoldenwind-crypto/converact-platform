import { resolveBrandEnv } from './config/converact-env.js';
import { Pool } from 'pg';

import { activateConveractAuditRuntimeRole } from './converact-audit-runtime-role.js';

async function main(): Promise<void> {
  const password = String(resolveBrandEnv(process.env, 'AUDIT_RUNTIME_DB_PASSWORD') || '');
  if (!password) throw new Error('CONVERACT_AUDIT_RUNTIME_DB_PASSWORD is required');

  const pool = new Pool({ max: 1 });
  try {
    await activateConveractAuditRuntimeRole(pool, password);
    console.log('Converact Audit PostgreSQL runtime role activated');
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
