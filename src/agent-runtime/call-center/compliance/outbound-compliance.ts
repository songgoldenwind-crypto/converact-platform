import { resolveBrandEnv } from '../../../config/converact-env.js';
import { getPostgresOrNull } from '../../../db-pg.js';
import { ComplianceGate } from './compliance-gate.js';
import { WINDOW_START_HOUR, WINDOW_END_HOUR, DEFAULT_TIMEZONE, getLocalHour } from './time-window.js';

export interface OutboundComplianceResult {
  allowed: boolean;
  reason?: string;
  retry_after?: string;
}

export { DEFAULT_TIMEZONE };

export async function checkOutboundCompliance(
  tenantId: string,
  phoneNumber: string,
  timezone = resolveBrandEnv(process.env, 'DEFAULT_TIMEZONE') || DEFAULT_TIMEZONE
): Promise<OutboundComplianceResult> {
  const pg = getPostgresOrNull();
  if (pg) {
    const gate = new ComplianceGate(pg);
    const result = await gate.checkOutbound({ tenantId, phoneNumber, timezone });
    return {
      allowed: result.allowed,
      reason: result.reason,
      retry_after: result.retryAfter
    };
  }

  // Fail-closed: when Postgres (DNC + frequency + tenant status) is unavailable,
  // we CANNOT safely allow outbound calls. Only time-window can be checked
  // locally, but DNC and frequency limits require the compliance database.
  // Returning allowed:true here would bypass DNC and frequency enforcement.
  const hour = getLocalHour(timezone, new Date());
  if (hour < WINDOW_START_HOUR || hour >= WINDOW_END_HOUR) {
    return { allowed: false, reason: 'time_window' };
  }
  return {
    allowed: false,
    reason: 'compliance_database_unavailable'
  };
}

export async function recordOutboundDialCompliance(
  tenantId: string,
  phoneNumber: string,
  callSessionId: string
): Promise<void> {
  const pg = getPostgresOrNull();
  if (!pg) return;
  const gate = new ComplianceGate(pg);
  // Record as 'dialed' — the attempt was made. countCallsToday only counts
  // 'connected'/'answered' results for frequency limiting, so unanswered
  // attempts don't trigger the daily limit.
  await gate.recordDialAttempt(tenantId, phoneNumber, 'dialed');
}

