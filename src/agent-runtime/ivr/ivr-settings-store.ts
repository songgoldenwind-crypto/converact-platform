/**
 * IVR Settings Store — time groups, region groups, and group-call groups.
 *
 * These are referenced by IVR flow nodes:
 * - time_condition node → scheduleId references a TimeGroup
 * - queue node → queueName references a queue (already in call-queue)
 * - transfer node (group_call) → targetValue references a GroupCallGroup
 *
 * Each group is stored in its own table, managed via the IVR settings API.
 */

import { run, one, all, parseJson } from '../../db.js';
import { migrateIvrRuntimeTables } from '../../db-migrations/ivr-runtime-schema.js';

// --- Time Groups ---
export interface TimeGroupEntry {
  id: string;
  tenant_id: string;
  name: string;
  /** Keyed by weekday: { mon: [9, 18], tue: [9, 18], ... } */
  schedule: Record<string, [number, number]>;
  /** Holiday schedule: list of { date: 'MM-DD', closed: boolean } */
  holidays?: Array<{ date: string; closed: boolean }>;
  timezone?: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

// --- Region Groups ---
export interface RegionGroupEntry {
  id: string;
  tenant_id: string;
  name: string;
  /** List of geographic regions/area codes */
  regions: string[];
  description?: string;
  created_at: string;
  updated_at: string;
}

// --- Group Call Groups ---
export interface GroupCallEntry {
  id: string;
  tenant_id: string;
  name: string;
  /** Seat IDs in this group */
  member_seat_ids: string[];
  /** Ring strategy: simultaneous, random, round_robin */
  strategy: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

export class IvrSettingsStore {
  constructor(private db: unknown) {}

  ensureTables(): void {
    migrateIvrRuntimeTables(this.db);
  }

  // --- Time Groups ---
  listTimeGroups(tenantId: string): TimeGroupEntry[] {
    const rows = all(this.db, 'SELECT * FROM ivr_time_groups WHERE tenant_id = ? ORDER BY name', [tenantId]);
    return rows.map((r) => this.decodeTimeGroup(r));
  }

  getTimeGroup(tenantId: string, id: string): TimeGroupEntry | null {
    const row = one(this.db, 'SELECT * FROM ivr_time_groups WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    return row ? this.decodeTimeGroup(row) : null;
  }

  upsertTimeGroup(entry: Omit<TimeGroupEntry, 'created_at' | 'updated_at'>): TimeGroupEntry {
    const existing = one(this.db, 'SELECT id, tenant_id FROM ivr_time_groups WHERE id = ?', [entry.id]) as
      | { id: string; tenant_id: string }
      | null;
    if (existing && String(existing.tenant_id) !== entry.tenant_id) {
      throw Object.assign(new Error('time group belongs to another tenant'), { status: 403 });
    }
    const scheduleJson = JSON.stringify(entry.schedule);
    const holidaysJson = entry.holidays ? JSON.stringify(entry.holidays) : null;
    if (existing) {
      run(
        this.db,
        `UPDATE ivr_time_groups SET name=?, schedule=?, holidays=?, timezone=?, description=?, updated_at=datetime('now')
         WHERE id=? AND tenant_id=?`,
        [
          entry.name,
          scheduleJson,
          holidaysJson,
          entry.timezone || 'Asia/Shanghai',
          entry.description || null,
          entry.id,
          entry.tenant_id,
        ]
      );
    } else {
      run(this.db, `INSERT INTO ivr_time_groups (id, tenant_id, name, schedule, holidays, timezone, description) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.tenant_id, entry.name, scheduleJson, holidaysJson, entry.timezone || 'Asia/Shanghai', entry.description || null]);
    }
    return this.getTimeGroup(entry.tenant_id, entry.id)!;
  }

  deleteTimeGroup(tenantId: string, id: string): boolean {
    const r = run(this.db, 'DELETE FROM ivr_time_groups WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    return r.changes > 0;
  }

  // --- Region Groups ---
  listRegionGroups(tenantId: string): RegionGroupEntry[] {
    const rows = all(this.db, 'SELECT * FROM ivr_region_groups WHERE tenant_id = ? ORDER BY name', [tenantId]);
    return rows.map((r) => this.decodeRegionGroup(r));
  }

  upsertRegionGroup(entry: Omit<RegionGroupEntry, 'created_at' | 'updated_at'>): RegionGroupEntry {
    const existing = one(this.db, 'SELECT id, tenant_id FROM ivr_region_groups WHERE id = ?', [entry.id]) as
      | { id: string; tenant_id: string }
      | null;
    if (existing && String(existing.tenant_id) !== entry.tenant_id) {
      throw Object.assign(new Error('region group belongs to another tenant'), { status: 403 });
    }
    const regionsJson = JSON.stringify(entry.regions);
    if (existing) {
      run(
        this.db,
        `UPDATE ivr_region_groups SET name=?, regions=?, description=?, updated_at=datetime('now')
         WHERE id=? AND tenant_id=?`,
        [entry.name, regionsJson, entry.description || null, entry.id, entry.tenant_id]
      );
    } else {
      run(this.db, `INSERT INTO ivr_region_groups (id, tenant_id, name, regions, description) VALUES (?, ?, ?, ?, ?)`,
        [entry.id, entry.tenant_id, entry.name, regionsJson, entry.description || null]);
    }
    return this.decodeRegionGroup(
      one(this.db, 'SELECT * FROM ivr_region_groups WHERE id = ? AND tenant_id = ?', [entry.id, entry.tenant_id])
    );
  }

  deleteRegionGroup(tenantId: string, id: string): boolean {
    const r = run(this.db, 'DELETE FROM ivr_region_groups WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    return r.changes > 0;
  }

  getRegionGroup(tenantId: string, id: string): RegionGroupEntry | null {
    const row = one(this.db, 'SELECT * FROM ivr_region_groups WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    return row ? this.decodeRegionGroup(row) : null;
  }

  matchRegionGroup(groupId: string, tenantId: string, areaCode: string): boolean {
    const group = this.getRegionGroup(tenantId, groupId);
    if (!group) return true;
    if (!group.regions.length) return false;
    const digits = normalizeAreaDigits(areaCode);
    if (!digits) return false;
    return group.regions.some((region) => {
      const needle = normalizeAreaDigits(region);
      if (!needle || needle === '*') return true;
      return digits.startsWith(needle) || digits.includes(needle);
    });
  }

  // --- Group Call Groups ---
  listGroupCallGroups(tenantId: string): GroupCallEntry[] {
    const rows = all(this.db, 'SELECT * FROM ivr_group_call_groups WHERE tenant_id = ? ORDER BY name', [tenantId]);
    return rows.map((r) => this.decodeGroupCall(r));
  }

  upsertGroupCallGroup(entry: Omit<GroupCallEntry, 'created_at' | 'updated_at'>): GroupCallEntry {
    const existing = one(this.db, 'SELECT id, tenant_id FROM ivr_group_call_groups WHERE id = ?', [entry.id]) as
      | { id: string; tenant_id: string }
      | null;
    if (existing && String(existing.tenant_id) !== entry.tenant_id) {
      throw Object.assign(new Error('group call group belongs to another tenant'), { status: 403 });
    }
    const membersJson = JSON.stringify(entry.member_seat_ids);
    if (existing) {
      run(
        this.db,
        `UPDATE ivr_group_call_groups SET name=?, member_seat_ids=?, strategy=?, description=?, updated_at=datetime('now')
         WHERE id=? AND tenant_id=?`,
        [entry.name, membersJson, entry.strategy, entry.description || null, entry.id, entry.tenant_id]
      );
    } else {
      run(this.db, `INSERT INTO ivr_group_call_groups (id, tenant_id, name, member_seat_ids, strategy, description) VALUES (?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.tenant_id, entry.name, membersJson, entry.strategy, entry.description || null]);
    }
    return this.decodeGroupCall(
      one(this.db, 'SELECT * FROM ivr_group_call_groups WHERE id = ? AND tenant_id = ?', [entry.id, entry.tenant_id])
    );
  }

  deleteGroupCallGroup(tenantId: string, id: string): boolean {
    const r = run(this.db, 'DELETE FROM ivr_group_call_groups WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    return r.changes > 0;
  }

  getGroupCallGroup(tenantId: string, id: string): GroupCallEntry | null {
    const row = one(this.db, 'SELECT * FROM ivr_group_call_groups WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    return row ? this.decodeGroupCall(row) : null;
  }

  resolveGroupCallMembers(groupId: string, tenantId: string): string[] {
    return this.getGroupCallGroup(tenantId, groupId)?.member_seat_ids ?? [];
  }

  checkTimeGroupActive(scheduleId: string, tenantId: string, now: Date = new Date()): boolean {
    const group = this.getTimeGroup(tenantId, scheduleId);
    if (!group) return true;

    const tz = group.timezone || 'Asia/Shanghai';
    const { weekday, monthDay, hourFraction } = getTimePartsInZone(now, tz);

    if (group.holidays?.length) {
      const holiday = group.holidays.find((h) => h.date === monthDay);
      if (holiday?.closed) return false;
    }

    const hours = group.schedule[weekday];
    if (!hours) return false;
    return hourFraction >= hours[0] && hourFraction < hours[1];
  }

  // --- Decoders ---
  private decodeTimeGroup(row: Record<string, unknown>): TimeGroupEntry {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      name: row.name as string,
      schedule: parseJson(row.schedule as string, {} as Record<string, [number, number]>),
      holidays: row.holidays ? parseJson(row.holidays as string, []) : undefined,
      timezone: (row.timezone as string) || 'Asia/Shanghai',
      description: (row.description as string) || undefined,
      created_at: (row.created_at as string) || '',
      updated_at: (row.updated_at as string) || '',
    };
  }

  private decodeRegionGroup(row: Record<string, unknown>): RegionGroupEntry {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      name: row.name as string,
      regions: parseJson(row.regions as string, [] as string[]),
      description: (row.description as string) || undefined,
      created_at: (row.created_at as string) || '',
      updated_at: (row.updated_at as string) || '',
    };
  }

  private decodeGroupCall(row: Record<string, unknown>): GroupCallEntry {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      name: row.name as string,
      member_seat_ids: parseJson(row.member_seat_ids as string, [] as string[]),
      strategy: (row.strategy as string) || 'simultaneous',
      description: (row.description as string) || undefined,
      created_at: (row.created_at as string) || '',
      updated_at: (row.updated_at as string) || '',
    };
  }
}

function normalizeAreaDigits(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('86') && digits.length > 10) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function getTimePartsInZone(
  date: Date,
  timeZone: string
): { weekday: (typeof WEEKDAY_KEYS)[number]; monthDay: string; hourFraction: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayShort = get('weekday');
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayShort);
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  return {
    weekday: WEEKDAY_KEYS[weekdayIndex >= 0 ? weekdayIndex : 0],
    monthDay: `${get('month')}-${get('day')}`,
    hourFraction: hour + minute / 60,
  };
}