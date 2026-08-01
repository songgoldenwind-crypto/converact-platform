import { createHash, randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../../../db-pg.js';
import { resolveAuthContext, type AuthContext } from '../../../../middleware/auth.js';
import { converactFabricCapabilityAllowed } from '../../authorization.js';
import {
  createPostgresConveractFabricAuditService,
  type ConveractFabricAuditService
} from '../audit/index.js';
import { ConveractFabricRetentionAdministrationService } from './administration-service.js';
import { ConveractFabricRetentionError } from './errors.js';
import { PostgresConveractFabricRetentionStore } from './postgres-store.js';
import type {
  ConveractFabricLegalHold,
  ConveractFabricRetentionCategory,
  ConveractFabricRetentionPolicy
} from './types.js';

export interface ConveractFabricRetentionHttpModule {
  listPolicies(tenantId: string): Promise<ConveractFabricRetentionPolicy[]>;
  putPolicy(input: {
    tenant_id: string; category: ConveractFabricRetentionCategory; enabled: boolean;
    retention_days: number; batch_size: number; interval_seconds: number;
    expected_revision: number; actor: string;
  }): Promise<ConveractFabricRetentionPolicy>;
  listLegalHolds(input: {
    tenant_id: string; category?: string; status?: 'active' | 'released';
  }): Promise<ConveractFabricLegalHold[]>;
  placeLegalHold(input: {
    tenant_id: string; category: ConveractFabricRetentionCategory; resource_type: string;
    resource_id: string; reason_code: string; idempotency_key: string; actor: string;
  }): Promise<{ hold: ConveractFabricLegalHold; created: boolean }>;
  releaseLegalHold(input: {
    tenant_id: string; hold_id: string; actor: string;
  }): Promise<ConveractFabricLegalHold>;
}

export interface RouteConveractFabricRetentionApiOptions {
  module?: ConveractFabricRetentionHttpModule;
  audit?: Pick<ConveractFabricAuditService, 'append'> | null;
  env?: NodeJS.ProcessEnv;
}

export async function routeConveractFabricRetentionApi(
  pg: PgQueryable | null,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
  options: RouteConveractFabricRetentionApiOptions = {}
): Promise<Record<string, unknown> | undefined> {
  const routePath = path.split('?')[0];
  if (!routePath.startsWith('/api/ivekit/retention')) return undefined;
  const auth = retentionAuth(headers);
  if (!converactFabricCapabilityAllowed(auth, 'retention.read')) throw denied(403);
  const module = options.module || createPostgresConveractFabricRetentionHttpModule(requiredPg(pg));

  if (routePath === '/api/ivekit/retention/capabilities' && method === 'GET') {
    return {
      data: {
        schema_version: 1,
        policy_categories: [
          'notifications', 'audit', 'rate_limit_buckets', 'secure_files',
          'media_recordings', 'tenant_events'
        ],
        legal_holds: true,
        distributed_worker: true,
        dry_run: false
      }
    };
  }

  if (routePath === '/api/ivekit/retention/policies' && method === 'GET') {
    return {
      data: {
        policies: (await module.listPolicies(auth.tenantId)).map(projectPolicy)
      }
    };
  }

  const policyMatch = routePath.match(/^\/api\/ivekit\/retention\/policies\/([^/]+)$/);
  if (policyMatch && method === 'PUT') {
    requireManage(auth);
    const input = record(body);
    const policy = await module.putPolicy({
      tenant_id: auth.tenantId,
      category: retentionCategory(decodeSegment(policyMatch[1])),
      enabled: requiredBoolean(input.enabled),
      retention_days: requiredInteger(input.retention_days),
      batch_size: requiredInteger(input.batch_size),
      interval_seconds: requiredInteger(input.interval_seconds),
      expected_revision: requiredInteger(input.expected_revision),
      actor: auth.userId
    });
    await appendRetentionAudit(pg, headers, options, auth, {
      action: 'retention.policy.update', resource_type: 'retention_policy',
      resource_id: policy.category,
      business_ref: { type: 'retention_policy', id: policy.category },
      metadata: {
        category: policy.category, enabled: policy.enabled,
        retention_days: policy.retention_days, batch_size: policy.batch_size,
        interval_seconds: policy.interval_seconds, revision: policy.revision
      }
    });
    return { data: { policy: projectPolicy(policy) } };
  }

  if (routePath === '/api/ivekit/retention/legal-holds' && method === 'GET') {
    const status = url.searchParams.get('status') || undefined;
    if (status !== undefined && status !== 'active' && status !== 'released') throw validationError();
    const holds = await module.listLegalHolds({
      tenant_id: auth.tenantId,
      category: url.searchParams.get('category') || undefined,
      status: status as 'active' | 'released' | undefined
    });
    return { data: { legal_holds: holds.map(projectLegalHold) } };
  }

  if (routePath === '/api/ivekit/retention/legal-holds' && method === 'POST') {
    requireManage(auth);
    const input = record(body);
    const result = await module.placeLegalHold({
      tenant_id: auth.tenantId,
      category: retentionCategory(requiredString(input.category, 100)),
      resource_type: requiredString(input.resource_type, 100),
      resource_id: requiredString(input.resource_id, 255),
      reason_code: requiredString(input.reason_code, 100),
      idempotency_key: idempotencyKey(headers),
      actor: auth.userId
    });
    await appendRetentionAudit(pg, headers, options, auth, {
      action: 'retention.legal_hold.place', resource_type: 'legal_hold',
      resource_id: result.hold.id,
      business_ref: { type: result.hold.resource_type, id: result.hold.resource_id },
      metadata: {
        category: result.hold.category, resource_type: result.hold.resource_type,
        reason_code: result.hold.reason_code, created: result.created
      }
    });
    return {
      status: result.created ? 201 : 200,
      data: { legal_hold: projectLegalHold(result.hold), created: result.created }
    };
  }

  const releaseMatch = routePath.match(
    /^\/api\/ivekit\/retention\/legal-holds\/([^/]+)\/release$/
  );
  if (releaseMatch && method === 'POST') {
    requireManage(auth);
    const hold = await module.releaseLegalHold({
      tenant_id: auth.tenantId,
      hold_id: decodeSegment(releaseMatch[1]),
      actor: auth.userId
    });
    await appendRetentionAudit(pg, headers, options, auth, {
      action: 'retention.legal_hold.release', resource_type: 'legal_hold',
      resource_id: hold.id,
      business_ref: { type: hold.resource_type, id: hold.resource_id },
      metadata: {
        category: hold.category, resource_type: hold.resource_type,
        reason_code: hold.reason_code, status: hold.status
      }
    });
    return { data: { legal_hold: projectLegalHold(hold) } };
  }

  return undefined;
}

export function createPostgresConveractFabricRetentionHttpModule(
  pg: PgQueryable
): ConveractFabricRetentionHttpModule {
  const service = new ConveractFabricRetentionAdministrationService(
    new PostgresConveractFabricRetentionStore(pg)
  );
  return {
    listPolicies: (tenantId) => service.listPolicies(tenantId),
    putPolicy: (input) => service.putPolicy(input),
    listLegalHolds: (input) => service.listLegalHolds(input),
    placeLegalHold: (input) => service.placeLegalHold(input),
    releaseLegalHold: (input) => service.releaseLegalHold(input)
  };
}

async function appendRetentionAudit(
  pg: PgQueryable | null,
  headers: Record<string, string | string[] | undefined>,
  options: RouteConveractFabricRetentionApiOptions,
  auth: AuthContext,
  input: {
    action: string; resource_type: string; resource_id: string;
    business_ref: { type: string; id: string }; metadata: Record<string, unknown>;
  }
): Promise<void> {
  const audit = options.audit === undefined
    ? (pg ? createPostgresConveractFabricAuditService(pg, options.env) : null)
    : options.audit;
  if (!audit) return;
  const requestId = requestIdFrom(headers);
  await audit.append({
    tenant_id: auth.tenantId, actor_id: auth.userId, actor_role: auth.role,
    action: input.action, resource_type: input.resource_type, resource_id: input.resource_id,
    business_ref: input.business_ref, metadata: input.metadata,
    request_id: requestId,
    idempotency_key: createHash('sha256').update(
      `${auth.tenantId}\n${requestId}\n${input.action}\n${input.resource_id}`
    ).digest('hex'),
    result: 'succeeded', policy_decision: 'allow',
    source_ip: headerValue(headers, 'x-opc-source-ip') || undefined
  });
}

function projectPolicy(policy: ConveractFabricRetentionPolicy): Record<string, unknown> {
  return {
    tenant_id: policy.tenant_id, category: policy.category, enabled: policy.enabled,
    retention_days: policy.retention_days, batch_size: policy.batch_size,
    interval_seconds: policy.interval_seconds, next_run_at: policy.next_run_at,
    lease_active: Boolean(policy.lease_expires_at), lease_expires_at: policy.lease_expires_at,
    revision: policy.revision, created_by: policy.created_by, updated_by: policy.updated_by,
    created_at: policy.created_at, updated_at: policy.updated_at
  };
}

function projectLegalHold(hold: ConveractFabricLegalHold): Record<string, unknown> {
  return {
    id: hold.id, tenant_id: hold.tenant_id, category: hold.category,
    resource_type: hold.resource_type, resource_id: hold.resource_id,
    reason_code: hold.reason_code, status: hold.status, placed_by: hold.placed_by,
    released_by: hold.released_by, placed_at: hold.placed_at, released_at: hold.released_at
  };
}

function retentionAuth(headers: Record<string, string | string[] | undefined>): AuthContext {
  try {
    const auth = resolveAuthContext(headers);
    if (!auth.tenantId || !auth.userId || (auth.role === 'system' && auth.tenantId === 'system')) {
      throw new Error('tenant identity required');
    }
    return auth;
  } catch {
    throw denied(401);
  }
}

function requireManage(auth: AuthContext): void {
  if (!converactFabricCapabilityAllowed(auth, 'retention.manage')) throw denied(403);
}

const CATEGORIES = new Set([
  'notifications', 'audit', 'rate_limit_buckets', 'secure_files',
  'media_recordings', 'tenant_events'
]);

function retentionCategory(value: string): ConveractFabricRetentionCategory {
  if (!CATEGORIES.has(value)) throw validationError();
  return value as ConveractFabricRetentionCategory;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError();
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw validationError();
  return value.trim();
}

function requiredInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number)) throw validationError();
  return number;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw validationError();
  return value;
}

function idempotencyKey(headers: Record<string, string | string[] | undefined>): string {
  return requiredString(headerValue(headers, 'idempotency-key'), 255);
}

function requestIdFrom(headers: Record<string, string | string[] | undefined>): string {
  const value = headerValue(headers, 'x-opc-request-id') || headerValue(headers, 'x-request-id');
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : randomUUID();
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string
): string {
  const found = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return String(Array.isArray(found?.[1]) ? found?.[1][0] : found?.[1] || '');
}

function decodeSegment(value: string | undefined): string {
  try {
    return requiredString(decodeURIComponent(String(value || '')), 255);
  } catch {
    throw validationError();
  }
}

function requiredPg(pg: PgQueryable | null): PgQueryable {
  if (!pg) throw new ConveractFabricRetentionError('retention_handler_unavailable', 503);
  return pg;
}

function validationError(): ConveractFabricRetentionError {
  return new ConveractFabricRetentionError('validation_failed', 422);
}

function denied(status: number): ConveractFabricRetentionError {
  return new ConveractFabricRetentionError('compliance_denied', status);
}
