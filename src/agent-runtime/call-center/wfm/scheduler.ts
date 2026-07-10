import type { ForecastResult } from './forecast.js';

export interface SchedulerInput {
  targetDate: string;
  forecastedVolume: ForecastResult[];
  availableAgents: { seat_id: string; skills: string[]; max_hours: number }[];
  constraints: SchedulerConstraints;
}

export interface SchedulerConstraints {
  minAgentsPerShift: number;
  maxConsecutiveHours: number;
  minBreakMinutes: number;
  agentsPerVolumeUnit: number;
}

export interface ScheduleProposal {
  schedules: { agent_seat_id: string; shift_start: string; shift_end: string; break_minutes: number }[];
  coverage: { hour: number; agents_needed: number; agents_assigned: number }[];
  warnings: string[];
}

const DEFAULT_CONSTRAINTS: SchedulerConstraints = {
  minAgentsPerShift: 1,
  maxConsecutiveHours: 8,
  minBreakMinutes: 30,
  agentsPerVolumeUnit: 5
};

export function generateSchedule(input: SchedulerInput): ScheduleProposal {
  const constraints = { ...DEFAULT_CONSTRAINTS, ...input.constraints };
  const { forecastedVolume, availableAgents } = input;

  const agentsNeeded: { hour: number; needed: number }[] = forecastedVolume.map((f) => ({
    hour: f.hour,
    needed: Math.max(constraints.minAgentsPerShift, Math.ceil(f.predicted_volume / constraints.agentsPerVolumeUnit))
  }));

  const agentAssignments = new Map<string, number[]>();
  for (const agent of availableAgents) {
    agentAssignments.set(agent.seat_id, []);
  }

  const sortedHours = [...agentsNeeded].sort((a, b) => b.needed - a.needed);
  const hourAssignedCount = new Map<number, number>();

  for (const { hour, needed } of sortedHours) {
    let assigned = hourAssignedCount.get(hour) ?? 0;

    const candidates = availableAgents
      .filter((agent) => {
        const hours = agentAssignments.get(agent.seat_id)!;
        if (hours.length >= agent.max_hours) return false;
        if (hours.includes(hour)) return false;
        const consecutive = countConsecutiveWith(hours, hour);
        return consecutive < constraints.maxConsecutiveHours;
      })
      .sort((a, b) => {
        const aAdj = hasAdjacentHour(agentAssignments.get(a.seat_id)!, hour) ? 0 : 1;
        const bAdj = hasAdjacentHour(agentAssignments.get(b.seat_id)!, hour) ? 0 : 1;
        return aAdj - bAdj;
      });

    for (const agent of candidates) {
      if (assigned >= needed) break;
      agentAssignments.get(agent.seat_id)!.push(hour);
      assigned++;
    }
    hourAssignedCount.set(hour, assigned);
  }

  const schedules: ScheduleProposal['schedules'] = [];
  for (const [seatId, hours] of agentAssignments) {
    if (hours.length === 0) continue;
    const sorted = [...hours].sort((a, b) => a - b);
    const shifts = mergeIntoShifts(sorted, constraints.maxConsecutiveHours);

    for (const shift of shifts) {
      const shiftLength = shift.end - shift.start + 1;
      const breakMinutes = shiftLength >= 4 ? constraints.minBreakMinutes : 0;
      schedules.push({
        agent_seat_id: seatId,
        shift_start: formatHour(shift.start),
        shift_end: formatHour(shift.end + 1),
        break_minutes: breakMinutes
      });
    }
  }

  const coverage: ScheduleProposal['coverage'] = agentsNeeded.map(({ hour, needed }) => ({
    hour,
    agents_needed: needed,
    agents_assigned: hourAssignedCount.get(hour) ?? 0
  }));

  const warnings: string[] = [];
  for (const c of coverage) {
    if (c.agents_assigned < c.agents_needed) {
      warnings.push(`Hour ${c.hour}: need ${c.agents_needed} agents but only ${c.agents_assigned} assigned`);
    }
  }

  return { schedules, coverage, warnings };
}

function countConsecutiveWith(hours: number[], candidate: number): number {
  const all = [...hours, candidate].sort((a, b) => a - b);
  let maxRun = 1;
  let currentRun = 1;
  for (let i = 1; i < all.length; i++) {
    if (all[i] === all[i - 1] + 1) {
      currentRun++;
      maxRun = Math.max(maxRun, currentRun);
    } else {
      currentRun = 1;
    }
  }
  return maxRun;
}

function hasAdjacentHour(hours: number[], candidate: number): boolean {
  return hours.includes(candidate - 1) || hours.includes(candidate + 1);
}

function mergeIntoShifts(sortedHours: number[], maxLength: number): { start: number; end: number }[] {
  if (sortedHours.length === 0) return [];
  const shifts: { start: number; end: number }[] = [];
  let start = sortedHours[0];
  let end = sortedHours[0];

  for (let i = 1; i < sortedHours.length; i++) {
    if (sortedHours[i] === end + 1 && (sortedHours[i] - start + 1) <= maxLength) {
      end = sortedHours[i];
    } else {
      shifts.push({ start, end });
      start = sortedHours[i];
      end = sortedHours[i];
    }
  }
  shifts.push({ start, end });
  return shifts;
}

function formatHour(hour: number): string {
  // Wrap around midnight for night shifts (e.g., hour 24 → 00:00).
  return `${String(hour % 24).padStart(2, '0')}:00`;
}
