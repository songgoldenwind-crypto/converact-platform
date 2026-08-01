import { AsyncLocalStorage } from 'node:async_hooks';
import type { PgQueryable } from './db-pg.js';
import { MemoryPg, withPgTransaction } from './db-pg.js';
import { resolveAuthContext } from './middleware/auth.js';

export interface PgTenantContext {
  tenantId?: string;
  bypassRls?: boolean;
}

export const pgTenantContextStorage = new AsyncLocalStorage<PgTenantContext>();

/** Current tenant context for PgSyncDatabase worker queries. */
export function getPgTenantContext(): PgTenantContext {
  return pgTenantContextStorage.getStore() ?? {};
}

export function runWithPgTenantContext<T>(ctx: PgTenantContext, fn: () => T): T {
  return pgTenantContextStorage.run(ctx, fn);
}

export async function runWithPgTenantContextAsync<T>(
  ctx: PgTenantContext,
  fn: () => T | Promise<T>
): Promise<T> {
  return pgTenantContextStorage.run(ctx, fn);
}

export function resolvePgTenantContextForRequest(
  _path: string,
  headers: Record<string, string | string[] | undefined>,
  _request: { url?: URL; body?: unknown } = {}
): PgTenantContext {
  try {
    const auth = resolveAuthContext(headers);
    if (auth.tenantId) {
      return { tenantId: auth.tenantId };
    }
  } catch {
    // Unauthenticated request — stores must pass tenant_id explicitly or use bypass.
  }

  return {};
}

export async function withPgBypass<T>(
  pg: PgQueryable,
  fn: (client: PgQueryable) => Promise<T>
): Promise<T> {
  if (pg instanceof MemoryPg) {
    return fn(pg);
  }
  return withPgTransaction(pg, async (client) => {
    await client.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
    const permission = await client.query<{ allowed: boolean }>(
      'SELECT opc_rls_bypass() AS allowed'
    );
    if (permission.rows[0]?.allowed !== true) {
      throw Object.assign(new Error('RLS bypass is not permitted for this database role'), {
        status: 403
      });
    }
    return fn(client);
  });
}

export async function withPgTenant<T>(
  pg: PgQueryable,
  tenantId: string,
  fn: (client: PgQueryable) => Promise<T>
): Promise<T> {
  if (!tenantId) {
    throw Object.assign(new Error('tenantId is required'), { status: 400 });
  }
  if (pg instanceof MemoryPg) {
    return fn(pg);
  }
  return withPgTransaction(pg, async (client) => {
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
    return fn(client);
  });
}

export function withPgRequestContext<T>(
  pg: PgQueryable,
  context: PgTenantContext,
  fn: (client: PgQueryable) => Promise<T>
): Promise<T> {
  if (context.bypassRls) return withPgBypass(pg, fn);
  if (context.tenantId) return withPgTenant(pg, context.tenantId, fn);
  return fn(pg);
}
