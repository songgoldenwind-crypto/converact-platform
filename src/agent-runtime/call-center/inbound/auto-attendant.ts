import { one, run } from '../../../db.js';
import type { AfterHoursRouteType } from './types.js';

export interface AutoAttendantConfig {
  tenant_id: string;
  timezone: string;
  business_hours: Record<string, [number, number]>;
  after_hours_route_type: AfterHoursRouteType;
  after_hours_route_target: string | null;
  announcement_text: string;
}

const DEFAULT_CONFIG: Omit<AutoAttendantConfig, 'tenant_id'> = {
  timezone: 'Asia/Shanghai',
  business_hours: {
    mon: [9, 18],
    tue: [9, 18],
    wed: [9, 18],
    thu: [9, 18],
    fri: [9, 18]
  },
  after_hours_route_type: 'announcement',
  after_hours_route_target: null,
  announcement_text: '您好，当前为非工作时间，请在工作日 9:00-18:00 来电。'
};

function decodeConfig(tenantId: string, row: Record<string, unknown> | null): AutoAttendantConfig {
  if (!row) return { tenant_id: tenantId, ...DEFAULT_CONFIG };
  let businessHours = DEFAULT_CONFIG.business_hours;
  try {
    businessHours = JSON.parse(String(row.business_hours || '{}')) as Record<string, [number, number]>;
  } catch {
    businessHours = DEFAULT_CONFIG.business_hours;
  }
  return {
    tenant_id: tenantId,
    timezone: String(row.timezone || DEFAULT_CONFIG.timezone),
    business_hours: businessHours,
    after_hours_route_type: String(row.after_hours_route_type || 'announcement') as AfterHoursRouteType,
    after_hours_route_target: row.after_hours_route_target ? String(row.after_hours_route_target) : null,
    announcement_text: String(row.announcement_text || DEFAULT_CONFIG.announcement_text)
  };
}

export class AutoAttendantService {
  constructor(private readonly db: unknown) {}

  getConfig(tenantId: string): AutoAttendantConfig {
    const row = one(this.db, 'SELECT * FROM auto_attendant_config WHERE tenant_id = ?', [tenantId]);
    return decodeConfig(tenantId, row as Record<string, unknown> | null);
  }

  upsertConfig(tenantId: string, patch: Partial<Omit<AutoAttendantConfig, 'tenant_id'>>): AutoAttendantConfig {
    const existing = this.getConfig(tenantId);
    const next = { ...existing, ...patch, tenant_id: tenantId };
    run(
      this.db,
      `INSERT INTO auto_attendant_config
        (tenant_id, timezone, business_hours, after_hours_route_type, after_hours_route_target, announcement_text, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(tenant_id) DO UPDATE SET
         timezone = excluded.timezone,
         business_hours = excluded.business_hours,
         after_hours_route_type = excluded.after_hours_route_type,
         after_hours_route_target = excluded.after_hours_route_target,
         announcement_text = excluded.announcement_text,
         updated_at = CURRENT_TIMESTAMP`,
      [
        tenantId,
        next.timezone,
        JSON.stringify(next.business_hours),
        next.after_hours_route_type,
        next.after_hours_route_target,
        next.announcement_text
      ]
    );
    return this.getConfig(tenantId);
  }

  isWithinBusinessHours(tenantId: string, now: Date = new Date()): boolean {
    const config = this.getConfig(tenantId);
    const timezone = config.timezone || 'Asia/Shanghai';
    // Use Intl.DateTimeFormat to get the correct hour in the configured timezone,
    // not the server's local timezone. Previously used now.getHours() which
    // ignored config.timezone entirely.
    const localParts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }).formatToParts(now);
    const weekdayMap: Record<string, string> = {
      Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat'
    };
    const weekday = weekdayMap[localParts.find((p) => p.type === 'weekday')?.value || ''] || 'sun';
    const hours = config.business_hours[weekday];
    if (!hours) return false;
    const [startHour, endHour] = hours;
    const hour = Number(localParts.find((p) => p.type === 'hour')?.value || now.getHours());
    const minute = Number(localParts.find((p) => p.type === 'minute')?.value || 0);
    const hourFloat = hour + minute / 60;
    return hourFloat >= startHour && hourFloat < endHour;
  }
}
