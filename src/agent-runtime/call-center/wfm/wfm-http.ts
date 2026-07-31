import { WfmStore } from './wfm-store.js';
import { forecastVolume } from './forecast.js';
import { generateSchedule } from './scheduler.js';
import { AgentSeatStore } from '../seat-store.js';
import type { HistoricalVolume } from './forecast.js';
import type { SchedulerConstraints } from './scheduler.js';
import { resolveAuthContext } from '../../../middleware/auth.js';

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

export async function routeWfmApi(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  const store = new WfmStore(db);

  if (path === '/api/wfm/forecast' && method === 'GET') {
    const tenantId = url.searchParams.get('tenant_id');
    const date = url.searchParams.get('date');
    if (!tenantId || !date) return { status: 400, data: { error: 'tenant_id and date are required' } };
    return store.getForecastsForDate(tenantId, date);
  }

  if (path === '/api/wfm/forecast' && method === 'POST') {
    const input = body as { tenant_id?: string; target_date?: string; historical_data?: HistoricalVolume[] };
    if (!input?.tenant_id || !input?.target_date || !input?.historical_data) {
      return { status: 400, data: { error: 'tenant_id, target_date, and historical_data are required' } };
    }

    const results = forecastVolume(input.historical_data, input.target_date);
    for (const r of results) {
      store.saveForecast({
        tenant_id: input.tenant_id,
        date: r.date,
        hour: r.hour,
        predicted_volume: r.predicted_volume
      });
    }
    return store.getForecastsForDate(input.tenant_id, input.target_date);
  }

  if (path === '/api/wfm/schedules' && method === 'GET') {
    const tenantId = url.searchParams.get('tenant_id');
    const date = url.searchParams.get('date');
    if (!tenantId || !date) return { status: 400, data: { error: 'tenant_id and date are required' } };
    return store.listSchedules(tenantId, date);
  }

  if (path === '/api/wfm/schedule' && method === 'POST') {
    const input = body as { tenant_id?: string; target_date?: string; constraints?: Partial<SchedulerConstraints> };
    if (!input?.tenant_id || !input?.target_date) {
      return { status: 400, data: { error: 'tenant_id and target_date are required' } };
    }

    let forecasts = store.getForecastsForDate(input.tenant_id, input.target_date);
    if (forecasts.length === 0) {
      return { status: 404, data: { error: 'no forecast found for target date; generate forecast first' } };
    }

    const seatStore = new AgentSeatStore(db);
    const seats = seatStore.listSeats(input.tenant_id);
    const availableAgents = seats.map((seat) => ({
      seat_id: seat.id,
      skills: seat.skills,
      max_hours: 8
    }));

    if (availableAgents.length === 0) {
      return { status: 400, data: { error: 'no agent seats available for scheduling' } };
    }

    const constraints: SchedulerConstraints = {
      minAgentsPerShift: input.constraints?.minAgentsPerShift ?? 1,
      maxConsecutiveHours: input.constraints?.maxConsecutiveHours ?? 8,
      minBreakMinutes: input.constraints?.minBreakMinutes ?? 30,
      agentsPerVolumeUnit: input.constraints?.agentsPerVolumeUnit ?? 5
    };

    const forecastedVolume = forecasts.map((f) => ({
      date: f.date,
      hour: f.hour,
      predicted_volume: f.predicted_volume
    }));

    const proposal = generateSchedule({
      targetDate: input.target_date,
      forecastedVolume,
      availableAgents,
      constraints
    });

    // Clear existing schedules for this tenant+date before generating new ones
    // (prevents duplicate accumulation on repeated generation).
    store.deleteSchedulesByDate(input.tenant_id, input.target_date);

    for (const sched of proposal.schedules) {
      store.createSchedule({
        tenant_id: input.tenant_id,
        agent_seat_id: sched.agent_seat_id,
        date: input.target_date,
        shift_start: sched.shift_start,
        shift_end: sched.shift_end,
        break_minutes: sched.break_minutes
      });
    }

    return {
      schedules: store.listSchedules(input.tenant_id, input.target_date),
      coverage: proposal.coverage,
      warnings: proposal.warnings
    };
  }

  const scheduleIdMatch = path.match(/^\/api\/wfm\/schedules\/([^/]+)$/);
  if (scheduleIdMatch && method === 'PUT') {
    const ctx = requireAuth(headers);
    const scheduleId = scheduleIdMatch[1];
    const update = body as { shift_start?: string; shift_end?: string; status?: string } | null;
    if (!update) return { status: 400, data: { error: 'request body is required' } };
    // Verify schedule belongs to caller's tenant before updating.
    const existing = store.getSchedule(scheduleId);
    if (!existing || existing.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'schedule not found' } };
    }
    const updated = store.updateSchedule(scheduleId, update);
    if (!updated) return { status: 404, data: { error: 'schedule not found' } };
    return updated;
  }

  if (scheduleIdMatch && method === 'DELETE') {
    const ctx = requireAuth(headers);
    const scheduleId = scheduleIdMatch[1];
    const existing = store.getSchedule(scheduleId);
    if (!existing || existing.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'schedule not found' } };
    }
    store.deleteSchedule(scheduleId);
    return { ok: true };
  }

  if (path === '/api/wfm/adherence' && method === 'GET') {
    const ctx = requireAuth(headers);
    const tenantId = ctx.tenantId!;
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    const { computeScheduleAdherence } = await import('./adherence.js');
    const seatStore = new AgentSeatStore(db);
    return {
      data: computeScheduleAdherence(db, seatStore, store, tenantId, date)
    };
  }

  if (path === '/api/wfm/shift-swaps' && method === 'GET') {
    const ctx = requireAuth(headers);
    const tenantId = ctx.tenantId!;
    const { listShiftSwapRequests } = await import('./adherence.js');
    const status = url.searchParams.get('status') as 'pending' | 'approved' | 'rejected' | null;
    return { data: listShiftSwapRequests(db, tenantId, status) };
  }

  if (path === '/api/wfm/shift-swaps' && method === 'POST') {
    const input = body as {
      tenant_id?: string;
      requester_seat_id?: string;
      schedule_id?: string;
      target_seat_id?: string;
      reason?: string;
    };
    if (!input.tenant_id || !input.requester_seat_id || !input.schedule_id || !input.reason) {
      return { status: 400, data: { error: 'tenant_id, requester_seat_id, schedule_id, reason required' } };
    }
    const { createShiftSwapRequest } = await import('./adherence.js');
    return { status: 201, data: createShiftSwapRequest(db, input as any) };
  }

  const swapResolveMatch = path.match(/^\/api\/wfm\/shift-swaps\/([^/]+)\/resolve$/);
  if (swapResolveMatch && method === 'POST') {
    const input = body as {
      tenant_id?: string;
      reviewer_user_id?: string;
      status?: 'approved' | 'rejected';
      resolution_notes?: string;
    };
    if (!input.tenant_id || !input.reviewer_user_id || !input.status) {
      return { status: 400, data: { error: 'tenant_id, reviewer_user_id, status required' } };
    }
    const { resolveShiftSwapRequest } = await import('./adherence.js');
    const resolved = resolveShiftSwapRequest(
      db,
      swapResolveMatch[1],
      input.tenant_id,
      input.reviewer_user_id,
      input.status,
      input.resolution_notes || null
    );
    if (!resolved) return { status: 404, data: { error: 'swap request not found' } };
    return { data: resolved };
  }

  return undefined;
}
