import { performance } from 'node:perf_hooks';

export interface PlatformClock {
  wallNow(): Date;
  monotonicNowMs(): number;
}

export interface PlatformDeadline {
  started_wall_at: string;
  expires_wall_at: string;
  monotonic_started_ms: number;
  duration_ms: number;
}

export type PlatformDeadlineState =
  | 'active'
  | 'expired'
  | 'restart_reauthorization_required'
  | 'clock_invalid';

export class SystemPlatformClock implements PlatformClock {
  wallNow(): Date {
    return new Date();
  }

  monotonicNowMs(): number {
    return systemMonotonicNowMs();
  }
}

export function systemMonotonicNowMs(): number {
  return performance.now();
}

export function createPlatformDeadline(
  clock: PlatformClock,
  durationMs: number,
  maxDurationMs: number
): PlatformDeadline {
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1
    || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > maxDurationMs) {
    throw new Error('platform_deadline_duration_invalid');
  }
  const wallNow = clock.wallNow();
  const wallMs = wallNow.getTime();
  const monotonicNow = clock.monotonicNowMs();
  if (!Number.isFinite(wallMs) || !validMonotonic(monotonicNow)) {
    throw new Error('platform_clock_invalid');
  }
  return {
    started_wall_at: wallNow.toISOString(),
    expires_wall_at: new Date(wallMs + durationMs).toISOString(),
    monotonic_started_ms: monotonicNow,
    duration_ms: durationMs
  };
}

export function platformDeadlineState(
  clock: PlatformClock,
  deadline: PlatformDeadline
): PlatformDeadlineState {
  const monotonicNow = clock.monotonicNowMs();
  if (!validMonotonic(monotonicNow) || !validMonotonic(deadline.monotonic_started_ms)
    || !Number.isSafeInteger(deadline.duration_ms) || deadline.duration_ms < 1) {
    return 'clock_invalid';
  }
  if (monotonicNow < deadline.monotonic_started_ms) {
    return 'restart_reauthorization_required';
  }
  return monotonicNow - deadline.monotonic_started_ms >= deadline.duration_ms
    ? 'expired'
    : 'active';
}

function validMonotonic(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
