import { all, id, one, run } from '../../../db.js';

export interface WfmSchedule {
  id: string;
  tenant_id: string;
  agent_seat_id: string;
  date: string;
  shift_start: string;
  shift_end: string;
  break_minutes: number;
  status: 'scheduled' | 'confirmed' | 'cancelled';
}

export interface WfmForecast {
  id: string;
  tenant_id: string;
  date: string;
  hour: number;
  predicted_volume: number;
  actual_volume: number | null;
  model_version: string;
}

export interface CreateScheduleInput {
  tenant_id: string;
  agent_seat_id: string;
  date: string;
  shift_start: string;
  shift_end: string;
  break_minutes?: number;
  status?: 'scheduled' | 'confirmed' | 'cancelled';
}

export interface CreateForecastInput {
  tenant_id: string;
  date: string;
  hour: number;
  predicted_volume: number;
  actual_volume?: number | null;
  model_version?: string;
}

export class WfmStore {
  constructor(private readonly db: unknown) {
    (db as { exec(sql: string): void }).exec(`
      CREATE TABLE IF NOT EXISTS wfm_schedules (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_seat_id TEXT NOT NULL,
        date TEXT NOT NULL,
        shift_start TEXT NOT NULL,
        shift_end TEXT NOT NULL,
        break_minutes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'scheduled',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_wfm_tenant_date ON wfm_schedules(tenant_id, date);

      CREATE TABLE IF NOT EXISTS wfm_forecasts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        date TEXT NOT NULL,
        hour INTEGER NOT NULL,
        predicted_volume REAL NOT NULL DEFAULT 0,
        actual_volume REAL,
        model_version TEXT NOT NULL DEFAULT 'ses_v1',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_forecast_tenant_date ON wfm_forecasts(tenant_id, date);
    `);
  }

  createSchedule(input: CreateScheduleInput): WfmSchedule {
    const schedId = id('sched');
    run(
      this.db,
      `INSERT INTO wfm_schedules (id, tenant_id, agent_seat_id, date, shift_start, shift_end, break_minutes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        schedId,
        input.tenant_id,
        input.agent_seat_id,
        input.date,
        input.shift_start,
        input.shift_end,
        input.break_minutes ?? 0,
        input.status ?? 'scheduled'
      ]
    );
    return this.getSchedule(schedId)!;
  }

  getSchedule(scheduleId: string): WfmSchedule | null {
    const row = one(this.db, 'SELECT * FROM wfm_schedules WHERE id = ?', [scheduleId]);
    return row ? decodeSchedule(row) : null;
  }

  listSchedules(tenantId: string, date: string): WfmSchedule[] {
    return all(
      this.db,
      'SELECT * FROM wfm_schedules WHERE tenant_id = ? AND date = ? ORDER BY shift_start ASC',
      [tenantId, date]
    ).map(decodeSchedule);
  }

  updateSchedule(
    scheduleId: string,
    update: { shift_start?: string; shift_end?: string; status?: string }
  ): WfmSchedule | null {
    const existing = this.getSchedule(scheduleId);
    if (!existing) return null;

    const shiftStart = update.shift_start ?? existing.shift_start;
    const shiftEnd = update.shift_end ?? existing.shift_end;
    const status = update.status ?? existing.status;

    run(
      this.db,
      `UPDATE wfm_schedules SET shift_start = ?, shift_end = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [shiftStart, shiftEnd, status, scheduleId]
    );
    return this.getSchedule(scheduleId);
  }

  deleteSchedule(scheduleId: string): void {
    run(this.db, 'DELETE FROM wfm_schedules WHERE id = ?', [scheduleId]);
  }

  /** Delete all schedules for a tenant on a given date (for re-generation). */
  deleteSchedulesByDate(tenantId: string, date: string): void {
    run(this.db, 'DELETE FROM wfm_schedules WHERE tenant_id = ? AND date = ?', [tenantId, date]);
  }

  saveForecast(input: CreateForecastInput): WfmForecast {
    const fcstId = id('fcst');
    run(
      this.db,
      `INSERT INTO wfm_forecasts (id, tenant_id, date, hour, predicted_volume, actual_volume, model_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        fcstId,
        input.tenant_id,
        input.date,
        input.hour,
        input.predicted_volume,
        input.actual_volume ?? null,
        input.model_version ?? 'ses_v1'
      ]
    );
    return this.getForecast(fcstId)!;
  }

  getForecastsForDate(tenantId: string, date: string): WfmForecast[] {
    return all(
      this.db,
      'SELECT * FROM wfm_forecasts WHERE tenant_id = ? AND date = ? ORDER BY hour ASC',
      [tenantId, date]
    ).map(decodeForecast);
  }

  recordActualVolume(tenantId: string, date: string, hour: number, volume: number): void {
    run(
      this.db,
      `UPDATE wfm_forecasts SET actual_volume = ? WHERE tenant_id = ? AND date = ? AND hour = ?`,
      [volume, tenantId, date, hour]
    );
  }

  private getForecast(fcstId: string): WfmForecast | null {
    const row = one(this.db, 'SELECT * FROM wfm_forecasts WHERE id = ?', [fcstId]);
    return row ? decodeForecast(row) : null;
  }
}

function decodeSchedule(row: Record<string, unknown>): WfmSchedule {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    agent_seat_id: String(row.agent_seat_id),
    date: String(row.date),
    shift_start: String(row.shift_start),
    shift_end: String(row.shift_end),
    break_minutes: Number(row.break_minutes),
    status: String(row.status) as WfmSchedule['status']
  };
}

function decodeForecast(row: Record<string, unknown>): WfmForecast {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    date: String(row.date),
    hour: Number(row.hour),
    predicted_volume: Number(row.predicted_volume),
    actual_volume: row.actual_volume != null ? Number(row.actual_volume) : null,
    model_version: String(row.model_version)
  };
}
