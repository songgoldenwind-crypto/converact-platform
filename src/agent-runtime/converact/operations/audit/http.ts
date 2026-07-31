import type { PgQueryable } from '../../../../db-pg.js';
import { resolveAuthContext, type AuthContext } from '../../../../middleware/auth.js';
import { iveKitCapabilityAllowed } from '../../authorization.js';
import { IveKitOperationsError } from './errors.js';
import { PostgresIveKitAuditStore } from './postgres-store.js';
import { IveKitAuditService } from './service.js';
import type { IveKitAuditListInput, IveKitAuditPage } from './types.js';

export interface IveKitAuditHttpModule {
  list(input: IveKitAuditListInput): Promise<IveKitAuditPage>;
  exportJsonl(input: IveKitAuditListInput & { max_events?: number }): Promise<string>;
}

export interface RouteIveKitAuditApiOptions {
  module?: IveKitAuditHttpModule;
  env?: NodeJS.ProcessEnv;
}

export async function routeIveKitAuditApi(
  pg: PgQueryable | null,
  method: string,
  path: string,
  url: URL,
  headers: Record<string, string | string[] | undefined>,
  options: RouteIveKitAuditApiOptions = {}
): Promise<Record<string, unknown> | undefined> {
  const routePath = path.split('?')[0];
  if (!routePath.startsWith('/api/ivekit/audit')) return undefined;
  const auth = auditAuth(headers);
  if (!iveKitCapabilityAllowed(auth, 'audit.read')) {
    throw new IveKitOperationsError('compliance_denied', 403);
  }
  const module = options.module || createPostgresIveKitAuditHttpModule(requiredPg(pg), options.env);

  if (routePath === '/api/ivekit/audit/capabilities' && method === 'GET') {
    return {
      data: {
        schema_version: 1,
        tenant_scoped: true,
        immutable: true,
        hash_chained: true,
        jsonl_export: true,
        raw_source_ip_stored: false
      }
    };
  }

  if (routePath === '/api/ivekit/audit/events' && method === 'GET') {
    return { data: await module.list(listInput(auth.tenantId, url)) };
  }

  if (routePath === '/api/ivekit/audit/export' && method === 'GET') {
    if (!iveKitCapabilityAllowed(auth, 'audit.export')) {
      throw new IveKitOperationsError('compliance_denied', 403);
    }
    return {
      data: await module.exportJsonl({
        ...listInput(auth.tenantId, url),
        max_events: queryInteger(url, 'max_events')
      }),
      contentType: 'application/x-ndjson; charset=utf-8'
    };
  }

  return undefined;
}

export function createPostgresIveKitAuditHttpModule(
  pg: PgQueryable,
  env: NodeJS.ProcessEnv = process.env
): IveKitAuditHttpModule {
  const service = createPostgresIveKitAuditService(pg, env);
  return {
    list: (input) => service.list(input),
    exportJsonl: (input) => service.exportJsonl(input)
  };
}

export function createPostgresIveKitAuditService(
  pg: PgQueryable,
  env: NodeJS.ProcessEnv = process.env
): IveKitAuditService {
  return new IveKitAuditService({
    repository: new PostgresIveKitAuditStore(pg),
    ip_hmac_key: requiredAuditIpHmacKey(env)
  });
}

export function requiredAuditIpHmacKey(env: NodeJS.ProcessEnv = process.env): string {
  const value = String(env.OPC_IVEKIT_AUDIT_IP_HMAC_KEY || '');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64').replace(/=+$/, '')
    !== value.replace(/=+$/, '')) {
    throw new IveKitOperationsError('validation_failed', 500, {
      configuration: 'OPC_IVEKIT_AUDIT_IP_HMAC_KEY'
    });
  }
  return value;
}

function listInput(tenantId: string, url: URL): IveKitAuditListInput {
  return {
    tenant_id: tenantId,
    limit: queryInteger(url, 'limit'),
    cursor: queryText(url, 'cursor', 4096),
    action: queryText(url, 'action', 255),
    resource_type: queryText(url, 'resource_type', 100),
    resource_id: queryText(url, 'resource_id', 255)
  };
}

function auditAuth(headers: Record<string, string | string[] | undefined>): AuthContext {
  try {
    const auth = resolveAuthContext(headers);
    if (!auth.tenantId || !auth.userId || (auth.role === 'system' && auth.tenantId === 'system')) {
      throw new Error('tenant identity required');
    }
    return auth;
  } catch {
    throw new IveKitOperationsError('compliance_denied', 401);
  }
}

function queryText(url: URL, key: string, max: number): string | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  if (!value.trim() || value.length > max) throw validationError();
  return value.trim();
}

function queryInteger(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw validationError();
  return number;
}

function requiredPg(pg: PgQueryable | null): PgQueryable {
  if (!pg) throw new IveKitOperationsError('audit_append_failed', 503);
  return pg;
}

function validationError(): IveKitOperationsError {
  return new IveKitOperationsError('validation_failed', 422);
}
