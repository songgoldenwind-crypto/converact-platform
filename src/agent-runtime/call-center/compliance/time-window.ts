/**
 * Shared compliance time-window constants and helpers.
 *
 * Extracted from duplicate definitions in compliance-gate.ts and
 * outbound-compliance.ts (DRY fix, P2).
 */

export const WINDOW_START_HOUR = 9;
export const WINDOW_END_HOUR = 21;
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** Get the current hour (0-23) in the given timezone, using Intl. */
export function getLocalHour(timezone: string, date: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false
    }).formatToParts(date);
    const hourPart = parts.find((p) => p.type === 'hour');
    return Number(hourPart?.value || '0') % 24;
  } catch {
    // Invalid timezone falls back to server-local hour.
    return date.getHours();
  }
}

/** Check if the given time is within the outbound call time window. */
export function isWithinCallWindow(timezone: string, at: Date = new Date()): boolean {
  const hour = getLocalHour(timezone, at);
  return hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR;
}
