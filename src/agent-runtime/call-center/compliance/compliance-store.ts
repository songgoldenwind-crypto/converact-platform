import type { PgQueryable } from '../../../db-pg.js';
import { pgId } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';

export interface DncEntry {
  id: string;
  tenant_id: string;
  phone_number: string;
  reason: string | null;
  added_at: string;
}

export class ComplianceStore {
  constructor(private readonly pg: PgQueryable) {}

  async isOnDncList(tenantId: string, phoneNumber: string): Promise<boolean> {
    return withPgTenant(this.pg, tenantId, async (client) => {
      const normalized = normalizePhone(phoneNumber);
      const result = await client.query<{ id: string }>(
        `SELECT id FROM compliance_dnc_list WHERE tenant_id = $1 AND phone_number = $2`,
        [tenantId, normalized]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async addToDncList(tenantId: string, phoneNumber: string, reason: string | null): Promise<DncEntry> {
    return withPgTenant(this.pg, tenantId, async (client) => {
      const normalized = normalizePhone(phoneNumber);
      const id = pgId('dnc');
      await client.query(
        `INSERT INTO compliance_dnc_list (id, tenant_id, phone_number, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, phone_number) DO UPDATE SET reason = EXCLUDED.reason`,
        [id, tenantId, normalized, reason]
      );
      const rows = await this.listDncOn(client, tenantId);
      const entry = rows.find((r) => r.phone_number === normalized);
      if (!entry) {
        throw Object.assign(new Error('failed to persist DNC entry'), { status: 500 });
      }
      return entry;
    });
  }

  async removeFromDncList(tenantId: string, phoneNumber: string): Promise<boolean> {
    return withPgTenant(this.pg, tenantId, async (client) => {
      const normalized = normalizePhone(phoneNumber);
      const result = await client.query(
        `DELETE FROM compliance_dnc_list WHERE phone_number = $1 AND tenant_id = $2`,
        [normalized, tenantId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async listDnc(tenantId: string): Promise<DncEntry[]> {
    return withPgTenant(this.pg, tenantId, (client) => this.listDncOn(client, tenantId));
  }

  private async listDncOn(pg: PgQueryable, tenantId: string): Promise<DncEntry[]> {
    const result = await pg.query<DncEntry>(
      `SELECT id, phone_number, reason, added_at::text AS added_at
       FROM compliance_dnc_list
       WHERE tenant_id = $1
       ORDER BY added_at DESC`,
      [tenantId]
    );
    return result.rows.map((row) => ({ ...row, tenant_id: tenantId }));
  }

  async countCallsToday(tenantId: string, phoneNumber: string, timezone: string): Promise<number> {
    return withPgTenant(this.pg, tenantId, async (client) => {
      const normalized = normalizePhone(phoneNumber);
      const dayStart = startOfLocalDay(timezone);
      const result = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM compliance_call_log
         WHERE tenant_id = $1 AND phone_number = $2 AND called_at >= $3
           AND result IN ('connected', 'answered')`,
        [tenantId, normalized, dayStart.toISOString()]
      );
      return result.rows[0]?.count ?? 0;
    });
  }

  async logOutboundAttempt(
    tenantId: string,
    phoneNumber: string,
    result: string
  ): Promise<void> {
    await withPgTenant(this.pg, tenantId, async (client) => {
      await client.query(
        `INSERT INTO compliance_call_log (id, tenant_id, phone_number, result)
         VALUES ($1, $2, $3, $4)`,
        [pgId('clog'), tenantId, normalizePhone(phoneNumber), result]
      );
    });
  }

  async recordConsent(input: {
    callSessionId: string;
    tenantId: string;
    consentType: 'recording' | 'ai_disclosure';
    status: 'granted' | 'denied' | 'pending';
  }): Promise<void> {
    await withPgTenant(this.pg, input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO compliance_consent (id, call_session_id, tenant_id, consent_type, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [pgId('consent'), input.callSessionId, input.tenantId, input.consentType, input.status]
      );
    });
  }

  async getConsentStatus(
    callSessionId: string,
    consentType: 'recording' | 'ai_disclosure',
    tenantId: string
  ): Promise<'granted' | 'denied' | 'pending' | null> {
    return withPgTenant(this.pg, tenantId, async (client) => {
      const result = await client.query<{ status: string }>(
        `SELECT status FROM compliance_consent
         WHERE call_session_id = $1 AND consent_type = $2 AND tenant_id = $3
         ORDER BY recorded_at DESC
         LIMIT 1`,
        [callSessionId, consentType, tenantId]
      );
      const status = result.rows[0]?.status;
      if (status === 'granted' || status === 'denied' || status === 'pending') return status;
      return null;
    });
  }
}

export function normalizePhone(phone: string): string {
  return String(phone || '').replace(/[\s\-()]/g, '').trim();
}

export function startOfLocalDay(timezone: string, now: Date = new Date()): Date {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(now);
    const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
    const month = parts.find((p) => p.type === 'month')?.value ?? '01';
    const day = parts.find((p) => p.type === 'day')?.value ?? '01';
    const isoLocal = `${year}-${month}-${day}T00:00:00`;
    const utcGuess = new Date(`${isoLocal}Z`);
    const offsetMs = localOffsetMs(timezone, now);
    return new Date(utcGuess.getTime() - offsetMs);
  } catch {
    const utc = new Date(now);
    utc.setUTCHours(0, 0, 0, 0);
    return utc;
  }
}

function localOffsetMs(timezone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = dtf.formatToParts(at);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return asUtc - at.getTime();
}
