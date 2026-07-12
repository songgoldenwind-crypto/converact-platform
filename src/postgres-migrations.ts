import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationQueryable {
  query(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface PostgresMigration {
  file: string;
  version: string;
  checksum: string;
  sql: string;
}

export function isPostgresMigrationFile(file: string): boolean {
  return /^\d{3}_[a-z0-9_]+\.sql$/.test(file);
}

export function readPostgresMigrationPlan(directory: string): PostgresMigration[] {
  return readdirSync(directory)
    .filter(isPostgresMigrationFile)
    .sort()
    .map((file) => {
      const sql = readFileSync(join(directory, file), 'utf8');
      return {
        file,
        version: file.replace(/\.sql$/, ''),
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql
      };
    });
}

export async function runPostgresMigrationsOnClient(
  pg: MigrationQueryable,
  plan: PostgresMigration[]
): Promise<void> {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL DEFAULT '',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pg.query(`
    ALTER TABLE schema_migrations
      ADD COLUMN IF NOT EXISTS checksum TEXT NOT NULL DEFAULT ''
  `);

  for (const migration of plan) {
    const existing = await pg.query(
      'SELECT version, checksum FROM schema_migrations WHERE version = $1',
      [migration.version]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      const recorded = String(existing.rows[0]?.checksum || '');
      if (!recorded) {
        await pg.query(
          'UPDATE schema_migrations SET checksum = $1 WHERE version = $2 AND checksum = $3',
          [migration.checksum, migration.version, '']
        );
        continue;
      }
      if (recorded !== migration.checksum) {
        throw new Error(
          `PostgreSQL migration checksum mismatch for ${migration.version}: ` +
          `recorded ${recorded}, current ${migration.checksum}`
        );
      }
      continue;
    }

    await pg.query('BEGIN');
    try {
      await pg.query(migration.sql);
      await pg.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum]
      );
      await pg.query('COMMIT');
    } catch (error) {
      await pg.query('ROLLBACK');
      throw error;
    }
  }
}
