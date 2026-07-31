export interface PlacementPgQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<{
    rows: R[];
    rowCount?: number | null;
  }>;
}

interface PlacementPgClient extends PlacementPgQueryable {
  release?(): void;
}

interface PlacementPgPool extends PlacementPgQueryable {
  connect(): Promise<PlacementPgClient>;
}

export async function withPlacementPgTenant<T>(
  pg: PlacementPgQueryable,
  tenantId: string,
  fn: (client: PlacementPgQueryable) => Promise<T>
): Promise<T> {
  if (!tenantId) throw new Error('tenantId is required');
  const pool = pg as PlacementPgPool;
  const client = typeof pool.connect === 'function'
    ? await pool.connect()
    : pg as PlacementPgClient;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant', $1, true)`,
      [tenantId]
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (client !== pg) client.release?.();
  }
}
