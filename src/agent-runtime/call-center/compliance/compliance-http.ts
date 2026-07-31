import { resolveBrandEnv } from '../../../config/converact-env.js';
import type { PgQueryable } from '../../../db-pg.js';
import { resolveAuthContext, type AuthRole } from '../../../middleware/auth.js';
import { ComplianceAuditStore, listActivityStream } from './audit-store.js';
import { ComplianceGate } from './compliance-gate.js';
import { ComplianceStore } from './compliance-store.js';
import { completeDisclosure, getDisclosureConfig } from './disclosure-enforcer.js';
import { ConsentTracker } from './consent-tracker.js';
import {
  enforceRetentionPolicy,
  getComplianceSettings,
  purgeCustomerPii,
  upsertComplianceSettings
} from './retention-policy.js';

function requirePostgres(pg: PgQueryable | null | undefined): PgQueryable {
  if (!pg) {
    throw Object.assign(new Error('postgres is required — set DATABASE_URL or CONVERACT_USE_MEMORY_PG=1'), {
      status: 503
    });
  }
  return pg;
}

function requireRole(role: AuthRole, allowed: AuthRole[]): void {
  if (!allowed.includes(role)) {
    throw Object.assign(new Error('forbidden'), { status: 403 });
  }
}

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

function requireAdmin(ctx: ReturnType<typeof resolveAuthContext>): void {
  if (ctx.role !== 'owner' && ctx.role !== 'admin' && ctx.role !== 'system') {
    throw Object.assign(new Error('admin role required'), { status: 403 });
  }
}

export async function routeComplianceApi(
  db: unknown,
  pg: PgQueryable | null,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  const auditStore = new ComplianceAuditStore(db);

  // --- Sprint 1: outbound compliance (Postgres) ---
  if (path === '/api/compliance/check' && method === 'POST') {
    const pool = requirePostgres(pg);
    const ctx = requireAuth(headers);
    const input = body as {
      phone_number?: string;
      timezone?: string;
    };
    const tenantId = ctx.tenantId!;
    if (!input.phone_number) {
      return { status: 400, error: 'phone_number required' };
    }
    const gate = new ComplianceGate(pool);
    const result = await gate.checkOutbound({
      tenantId,
      phoneNumber: input.phone_number,
      timezone: input.timezone
    });
    return {
      allowed: result.allowed,
      reason: result.reason,
      retry_after: result.retryAfter,
      calls_today: result.callsToday
    };
  }

  if (path === '/api/compliance/dnc' && method === 'GET') {
    const pool = requirePostgres(pg);
    const ctx = requireAuth(headers);
    requireRole(ctx.role, ['owner', 'admin', 'system']);
    const store = new ComplianceStore(pool);
    return { data: await store.listDnc(ctx.tenantId!) };
  }

  if (path === '/api/compliance/dnc' && method === 'POST') {
    const pool = requirePostgres(pg);
    const ctx = requireAuth(headers);
    requireRole(ctx.role, ['owner', 'admin', 'system']);
    const input = body as { phone_number?: string; reason?: string };
    if (!input.phone_number) {
      return { status: 400, data: { error: 'phone_number required' } };
    }
    const store = new ComplianceStore(pool);
    const entry = await store.addToDncList(ctx.tenantId!, input.phone_number, input.reason || null);
    auditStore.record({
      tenant_id: ctx.tenantId!,
      actor_id: ctx.userId,
      action: 'compliance.dnc_added',
      object_type: 'phone',
      object_id: entry.phone_number,
      metadata: { reason: input.reason || null }
    });
    return { data: entry };
  }

  const dncDeleteMatch = path.match(/^\/api\/compliance\/dnc\/([^/]+)$/);
  if (dncDeleteMatch && method === 'DELETE') {
    const pool = requirePostgres(pg);
    const ctx = requireAuth(headers);
    requireRole(ctx.role, ['owner', 'admin', 'system']);
    const store = new ComplianceStore(pool);
    const rows = await store.listDnc(ctx.tenantId!);
    const entry = rows.find((r) => r.id === dncDeleteMatch[1]);
    if (!entry) {
      return { status: 404, data: { error: 'not found' } };
    }
    await store.removeFromDncList(ctx.tenantId!, entry.phone_number);
    auditStore.record({
      tenant_id: ctx.tenantId!,
      actor_id: ctx.userId,
      action: 'compliance.dnc_removed',
      object_type: 'phone',
      object_id: entry.phone_number,
      metadata: {}
    });
    return { data: { removed: true } };
  }

  const disclosureMatch = path.match(/^\/api\/compliance\/calls\/([^/]+)\/disclosure-complete$/);
  if (disclosureMatch && method === 'POST') {
    const pool = requirePostgres(pg);
    verifyOpcOrAuth(headers);
    const callSessionId = disclosureMatch[1];
    const input = body as { tenant_id?: string };
    const state = completeDisclosure(callSessionId);
    const tenantId = input.tenant_id || state.tenantId;
    const tracker = new ConsentTracker(pool);
    await tracker.recordAiDisclosureGranted(callSessionId, tenantId);
    return { data: { completed: true, call_session_id: callSessionId } };
  }

  if (path === '/api/compliance/disclosure-config' && method === 'GET') {
    const language = url.searchParams.get('language') || 'zh';
    return { data: getDisclosureConfig(language) };
  }

  // --- Sprint 11: audit, retention, GDPR (SQLite) ---
  if (path === '/api/compliance/audit-logs' && method === 'GET') {
    const ctx = requireAuth(headers);
    requireAdmin(ctx);
    const actionPrefix = url.searchParams.get('action_prefix');
    const actorId = url.searchParams.get('actor_id');
    const limit = Number(url.searchParams.get('limit') || 100);
    return {
      data: auditStore.list(ctx.tenantId!, {
        action_prefix: actionPrefix,
        actor_id: actorId,
        limit
      })
    };
  }

  if (path === '/api/compliance/activity' && method === 'GET') {
    const ctx = requireAuth(headers);
    const limit = Number(url.searchParams.get('limit') || 50);
    return { data: listActivityStream(db, ctx.tenantId!, limit) };
  }

  if (path === '/api/compliance/settings' && method === 'GET') {
    const ctx = requireAuth(headers);
    requireAdmin(ctx);
    return { data: getComplianceSettings(db, ctx.tenantId!) };
  }

  if (path === '/api/compliance/settings' && method === 'PUT') {
    const ctx = requireAuth(headers);
    requireAdmin(ctx);
    const input = body as {
      recording_retention_days?: number;
      audit_log_retention_days?: number;
      omni_retention_days?: number;
      auto_purge_enabled?: boolean;
    };
    const updated = upsertComplianceSettings(db, ctx.tenantId!, input);
    auditStore.record({
      tenant_id: ctx.tenantId!,
      actor_id: ctx.userId,
      action: 'compliance.settings_updated',
      object_type: 'tenant',
      object_id: ctx.tenantId!,
      metadata: input as Record<string, unknown>
    });
    return { data: updated };
  }

  if (path === '/api/compliance/retention/enforce' && method === 'POST') {
    const ctx = requireAuth(headers);
    requireAdmin(ctx);
    const result = enforceRetentionPolicy(db, ctx.tenantId!, ctx.userId);
    return { data: result };
  }

  if (path === '/api/compliance/gdpr/purge' && method === 'POST') {
    const ctx = requireAuth(headers);
    requireAdmin(ctx);
    const input = body as { phone?: string; email?: string; customer_id?: string; confirm?: boolean };
    if (!input.confirm) {
      return { status: 400, data: { error: 'confirm: true required for GDPR purge' } };
    }
    if (!input.phone && !input.email && !input.customer_id) {
      return { status: 400, data: { error: 'phone, email, or customer_id required' } };
    }
    const result = purgeCustomerPii(db, ctx.tenantId!, input, ctx.userId);
    return { data: result };
  }

  return undefined;
}

function verifyOpcOrAuth(headers: Record<string, string | string[] | undefined>): void {
  const apiKey = String(headers['X-API-Key'] || headers['x-api-key'] || '');
  const expectedKey = resolveBrandEnv(process.env, 'API_KEY');
  if (apiKey && expectedKey && apiKey === expectedKey) return;
  requireAuth(headers);
}

export function auditCallCenterAction(
  db: unknown,
  input: {
    tenant_id: string;
    actor_id: string;
    action: string;
    object_type: string;
    object_id: string;
    metadata?: Record<string, unknown>;
  }
): void {
  new ComplianceAuditStore(db).record(input);
}
