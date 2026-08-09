import { runMigrations, type PgQueryable } from './db-pg.js';

export interface ConveractMigrationPoolConfig {
  connectionString?: string;
  max: 1;
}

export function converactMigrationPoolConfig(
  env: Readonly<Record<string, string | undefined>>,
): ConveractMigrationPoolConfig {
  const connectionString = env.DATABASE_URL?.trim();
  return connectionString ? { connectionString, max: 1 } : { max: 1 };
}

export interface ApplyConveractFabricMigrationsOptions {
  directory: string;
  advisoryLockName?: string;
}

export async function applyConveractFabricMigrations(
  pg: PgQueryable,
  options: ApplyConveractFabricMigrationsOptions
): Promise<void> {
  await runMigrations(pg, {
    directory: options.directory,
    advisoryLockName: options.advisoryLockName || 'ivekit_schema_migrations'
  });
  await pg.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
        REVOKE ALL PRIVILEGES ON TABLE schema_migrations FROM opc_runtime;
      END IF;
    END
    $$
  `);
}
