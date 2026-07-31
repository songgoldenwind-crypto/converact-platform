import { resolveBrandEnv } from '../../../config/converact-env.js';
import type { PgQueryable } from '../../../db-pg.js';
import { AuthStore } from '../../../auth-store.js';
import { ComplianceStore } from './compliance-store.js';

export type ComplianceBlockReason =
  | 'time_window'
  | 'frequency_limit'
  | 'dnc_blocked'
  | 'tenant_suspended';

export interface ComplianceCheckResult {
  allowed: boolean;
  reason?: ComplianceBlockReason;
  retryAfter?: string;
  callsToday?: number;
}

export interface ComplianceCheckInput {
  tenantId: string;
  phoneNumber: string;
  timezone?: string;
  now?: Date;
}

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const WINDOW_START_HOUR = 9;
const WINDOW_END_HOUR = 21;
const MAX_CALLS_PER_DAY = 3;

export class ComplianceGate {
  private readonly compliance: ComplianceStore;
  private readonly auth: AuthStore;

  constructor(pg: PgQueryable) {
    this.compliance = new ComplianceStore(pg);
    this.auth = new AuthStore(pg);
  }

  async checkOutbound(input: ComplianceCheckInput): Promise<ComplianceCheckResult> {
    const tenantId = input.tenantId;
    const phoneNumber = input.phoneNumber;
    const timezone = input.timezone || resolveBrandEnv(process.env, 'DEFAULT_TIMEZONE') || DEFAULT_TIMEZONE;
    const frozenNow = resolveBrandEnv(process.env, 'COMPLIANCE_NOW');
    const now = input.now ?? (frozenNow ? new Date(frozenNow) : new Date());

    const tenantStatus = await this.auth.getTenantStatus(tenantId);
    if (tenantStatus === 'suspended') {
      return { allowed: false, reason: 'tenant_suspended' };
    }
    if (tenantStatus === 'deleted') {
      return { allowed: false, reason: 'tenant_suspended' };
    }

    if (await this.compliance.isOnDncList(tenantId, phoneNumber)) {
      return { allowed: false, reason: 'dnc_blocked' };
    }

    const localHour = getLocalHour(timezone, now);
    if (localHour < WINDOW_START_HOUR || localHour >= WINDOW_END_HOUR) {
      return {
        allowed: false,
        reason: 'time_window',
        retryAfter: nextWindowStart(timezone, now).toISOString()
      };
    }

    const callsToday = await this.compliance.countCallsToday(tenantId, phoneNumber, timezone);
    if (callsToday >= MAX_CALLS_PER_DAY) {
      return {
        allowed: false,
        reason: 'frequency_limit',
        callsToday,
        retryAfter: nextLocalMidnight(timezone, now).toISOString()
      };
    }

    return { allowed: true, callsToday };
  }

  async recordDialAttempt(
    tenantId: string,
    phoneNumber: string,
    result: string
  ): Promise<void> {
    await this.compliance.logOutboundAttempt(tenantId, phoneNumber, result);
  }
}

function getLocalHour(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false
  }).formatToParts(at);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '0';
  return Number(hour);
}

function nextWindowStart(timezone: string, at: Date): Date {
  const local = new Date(at);
  const hour = getLocalHour(timezone, at);
  if (hour < WINDOW_START_HOUR) {
    return addLocalHours(timezone, at, WINDOW_START_HOUR - hour);
  }
  return addLocalHours(timezone, at, 24 - hour + WINDOW_START_HOUR);
}

function nextLocalMidnight(timezone: string, at: Date): Date {
  const hour = getLocalHour(timezone, at);
  return addLocalHours(timezone, at, 24 - hour);
}

function addLocalHours(timezone: string, at: Date, hours: number): Date {
  const target = new Date(at.getTime() + hours * 3_600_000);
  void timezone;
  return target;
}
