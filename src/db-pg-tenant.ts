import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';
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
  path: string,
  headers: Record<string, string | string[] | undefined>,
  request: { url?: URL; body?: unknown } = {}
): PgTenantContext {
  const mediaContext = resolveMediaServiceTenantContext(path, headers, request);
  if (mediaContext) return mediaContext;

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

function resolveMediaServiceTenantContext(
  path: string,
  headers: Record<string, string | string[] | undefined>,
  request: { url?: URL; body?: unknown }
): PgTenantContext | null {
  if (!path.startsWith('/api/media/livekit/')) return null;
  const expected = String(process.env.OPC_MEDIA_API_TOKEN || process.env.LIVEKIT_MEDIA_API_TOKEN || '');
  const authorization = headerValue(headers, 'authorization');
  if (expected) {
    if (!safeEqual(authorization, `Bearer ${expected}`)) return null;
  } else if (process.env.NODE_ENV === 'production') {
    return null;
  }
  const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
  const tenantId = String(
    headerValue(headers, 'x-tenant-id') ||
    request.url?.searchParams.get('tenant_id') ||
    body.tenant_id ||
    ''
  ).trim();
  return tenantId ? { tenantId } : null;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string
): string {
  const found = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase());
  const value = Array.isArray(found?.[1]) ? found?.[1][0] : found?.[1];
  return String(value || '');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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
