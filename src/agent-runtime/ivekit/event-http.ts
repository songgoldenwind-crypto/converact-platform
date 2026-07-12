import type { PgQueryable } from '../../db-pg.js';
import { resolveAuthContext } from '../../middleware/auth.js';
import { IveKitTenantEventStore, iveKitEventReplayEnabled } from './tenant-event-store.js';

export async function routeIveKitEventApi(
  pg: PgQueryable | null,
  method: string,
  path: string,
  url: URL,
  headers: Record<string, string | string[] | undefined> = {}
): Promise<unknown | undefined> {
  if (path !== '/api/ivekit/events' || method !== 'GET') return undefined;
  if (!iveKitEventReplayEnabled()) {
    throw Object.assign(new Error('durable event replay is disabled'), { status: 503 });
  }
  if (!pg) throw Object.assign(new Error('PostgreSQL is required'), { status: 503 });

  const auth = resolveAuthContext(headers);
  if (!auth.authenticated || !auth.tenantId || !auth.userId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }

  const store = new IveKitTenantEventStore(pg);
  const cursor = String(url.searchParams.get('cursor') || '').trim();
  if (!cursor) {
    return {
      data: {
        items: [],
        next_cursor: await store.headCursor(auth.tenantId),
        has_more: false,
        snapshot_required: false
      }
    };
  }

  const page = await store.list({
    tenant_id: auth.tenantId,
    user_id: auth.userId,
    role: auth.role,
    cursor,
    limit: queryLimit(url.searchParams.get('limit'))
  });
  return page.snapshot_required ? { status: 409, data: page } : { data: page };
}

function queryLimit(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw Object.assign(new Error('limit must be between 1 and 200'), { status: 400 });
  }
  return parsed;
}
