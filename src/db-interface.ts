/**
 * Unified database client interface.
 *
 * This abstraction allows stores to be migrated from SQLite (db.ts: run/one/all,
 * synchronous) to Postgres (db-pg.ts: pg.query, async) one at a time, without
 * changing the store's call sites in a single big-bang migration.
 *
 * Migration strategy:
 * 1. Stores continue importing run/one/all from db.ts (unchanged)
 * 2. New stores or migrated stores use DbClient instead
 * 3. Eventually all stores use DbClient, then SQLite path is removed
 *
 * Design:
 * - All methods are async (Postgres is async; SQLite adapter wraps sync in Promise)
 * - Placeholder: stores use ? in SQL; both adapters handle ? internally
 *   (SQLite passes through; Postgres converts ? → $1, $2, ...)
 */

export interface DbRow {
  [key: string]: unknown;
}

export interface DbClient {
  /** Run a query that returns rows (SELECT). */
  query<T = DbRow>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Run a query that returns a single row (SELECT ... LIMIT 1). Returns null if no row. */
  queryOne<T = DbRow>(sql: string, params?: unknown[]): Promise<T | null>;

  /** Run a statement that doesn't return rows (INSERT/UPDATE/DELETE/DDL). */
  exec(sql: string, params?: unknown[]): Promise<void>;
}

/**
 * Create a DbClient backed by SQLite (wraps db.ts run/one/all).
 * Used in dev/test where createDatabase() provides the SQLite handle.
 */
export function createSqliteClient(db: unknown): DbClient {
  return {
    async query<T = DbRow>(sql: string, params: unknown[] = []): Promise<T[]> {
      const { all } = await import('./db.js');
      return all(db, sql, params as any[]) as T[];
    },
    async queryOne<T = DbRow>(sql: string, params: unknown[] = []): Promise<T | null> {
      const { one } = await import('./db.js');
      const row = one(db, sql, params as any[]);
      return (row ?? null) as T | null;
    },
    async exec(sql: string, params: unknown[] = []): Promise<void> {
      const { run } = await import('./db.js');
      run(db, sql, params as any[]);
    }
  };
}

/**
 * Convert SQL with ? placeholders to Postgres $1, $2, ... style.
 * Handles edge case: ?? (escaping literal ?) — but our codebase doesn't use that.
 */
export function convertPlaceholders(sql: string): string {
  let paramIndex = 0;
  return sql.replace(/\?/g, () => `$${++paramIndex}`);
}

/**
 * Create a DbClient backed by Postgres (wraps db-pg.ts PgQueryable).
 * Converts ? placeholders to $1, $2, ... automatically.
 */
export function createPgClient(pg: {
  query: (text: string, params?: unknown[]) => Promise<{ rows: DbRow[]; rowCount?: number }>;
}): DbClient {
  return {
    async query<T = DbRow>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await pg.query(convertPlaceholders(sql), params);
      return result.rows as T[];
    },
    async queryOne<T = DbRow>(sql: string, params: unknown[] = []): Promise<T | null> {
      const result = await pg.query(convertPlaceholders(sql), params);
      return (result.rows[0] as T) ?? null;
    },
    async exec(sql: string, params: unknown[] = []): Promise<void> {
      await pg.query(convertPlaceholders(sql), params);
    }
  };
}
