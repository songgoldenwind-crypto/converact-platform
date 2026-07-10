/**
 * IVR Settings HTTP API — time groups, region groups, group-call groups.
 *
 * These settings are referenced by IVR flow nodes:
 * - GET/POST/DELETE /api/ivr/settings/time-groups
 * - GET/POST/DELETE /api/ivr/settings/region-groups
 * - GET/POST/DELETE /api/ivr/settings/group-call-groups
 */

import { resolveAuthContext } from '../../middleware/auth.js';
import { IvrSettingsStore } from './ivr-settings-store.js';

function pgId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function mapStoreError(err: unknown): { status: number; data: { error: string } } {
  const status =
    err && typeof err === 'object' && 'status' in err ? Number((err as { status: number }).status) : 500;
  return {
    status: Number.isFinite(status) && status >= 400 ? status : 500,
    data: { error: err instanceof Error ? err.message : String(err) },
  };
}

export function routeIvrSettingsApi(
  db: unknown,
  method: string,
  path: string,
  _url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): unknown {
  if (!path.startsWith('/api/ivr/settings/')) return undefined;

  const store = new IvrSettingsStore(db);
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  const tenantId = ctx.tenantId;
  const input = (body || {}) as Record<string, unknown>;

  // ===== Time Groups =====
  if (path === '/api/ivr/settings/time-groups' && method === 'GET') {
    return { data: store.listTimeGroups(tenantId) };
  }
  if (path === '/api/ivr/settings/time-groups' && method === 'POST') {
    const id = (input.id as string) || pgId('tg');
    try {
      return {
        data: store.upsertTimeGroup({
          id,
          tenant_id: tenantId,
          name: (input.name as string) || '未命名时间组',
          schedule:
            (input.schedule as Record<string, [number, number]>) || {
              mon: [9, 18],
              tue: [9, 18],
              wed: [9, 18],
              thu: [9, 18],
              fri: [9, 18],
            },
          holidays: input.holidays as Array<{ date: string; closed: boolean }> | undefined,
          timezone: (input.timezone as string) || 'Asia/Shanghai',
          description: input.description as string | undefined,
        }),
      };
    } catch (err) {
      return mapStoreError(err);
    }
  }
  const tgDelete = path.match(/^\/api\/ivr\/settings\/time-groups\/([^/]+)$/);
  if (tgDelete && method === 'DELETE') {
    return store.deleteTimeGroup(tenantId, tgDelete[1])
      ? { data: { ok: true } }
      : { status: 404, data: { error: 'time group not found' } };
  }
  const tgPreview = path.match(/^\/api\/ivr\/settings\/time-groups\/([^/]+)\/preview$/);
  if (tgPreview && method === 'GET') {
    const atParam = _url.searchParams.get('at');
    const at = atParam ? new Date(atParam) : new Date();
    if (Number.isNaN(at.getTime())) {
      return { status: 400, data: { error: 'invalid at parameter' } };
    }
    const group = store.getTimeGroup(tenantId, tgPreview[1]);
    if (!group) {
      return { status: 404, data: { error: 'time group not found' } };
    }
    return {
      data: {
        active: store.checkTimeGroupActive(tgPreview[1], tenantId, at),
        at: at.toISOString(),
        timezone: group.timezone,
      },
    };
  }

  // ===== Region Groups =====
  if (path === '/api/ivr/settings/region-groups' && method === 'GET') {
    return { data: store.listRegionGroups(tenantId) };
  }
  if (path === '/api/ivr/settings/region-groups' && method === 'POST') {
    const id = (input.id as string) || pgId('rg');
    try {
      return {
        data: store.upsertRegionGroup({
          id,
          tenant_id: tenantId,
          name: (input.name as string) || '未命名区域组',
          regions: (input.regions as string[]) || [],
          description: input.description as string | undefined,
        }),
      };
    } catch (err) {
      return mapStoreError(err);
    }
  }
  const rgDelete = path.match(/^\/api\/ivr\/settings\/region-groups\/([^/]+)$/);
  if (rgDelete && method === 'DELETE') {
    return store.deleteRegionGroup(tenantId, rgDelete[1])
      ? { data: { ok: true } }
      : { status: 404, data: { error: 'region group not found' } };
  }

  // ===== Group Call Groups =====
  if (path === '/api/ivr/settings/group-call-groups' && method === 'GET') {
    return { data: store.listGroupCallGroups(tenantId) };
  }
  if (path === '/api/ivr/settings/group-call-groups' && method === 'POST') {
    const id = (input.id as string) || pgId('gc');
    try {
      return {
        data: store.upsertGroupCallGroup({
          id,
          tenant_id: tenantId,
          name: (input.name as string) || '未命名群呼组',
          member_seat_ids: (input.member_seat_ids as string[]) || [],
          strategy: (input.strategy as string) || 'simultaneous',
          description: input.description as string | undefined,
        }),
      };
    } catch (err) {
      return mapStoreError(err);
    }
  }
  const gcDelete = path.match(/^\/api\/ivr\/settings\/group-call-groups\/([^/]+)$/);
  if (gcDelete && method === 'DELETE') {
    return store.deleteGroupCallGroup(tenantId, gcDelete[1])
      ? { data: { ok: true } }
      : { status: 404, data: { error: 'group-call group not found' } };
  }

  return undefined;
}