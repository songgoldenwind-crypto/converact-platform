import type { PgQueryable } from './db-pg.js';
import { AuthStore } from './auth-store.js';
import {
  resolveAuthContext,
  signAccessToken,
  type AuthContext,
  type AuthRole
} from './middleware/auth.js';
import { onboardCallCenterTenant } from './tenant-onboarding.js';
import { runWithPgTenantContextAsync } from './db-pg-tenant.js';
import { auditCallCenterAction } from './agent-runtime/call-center/compliance/compliance-http.js';
import { getPublicSsoConfig, getSsoConfig, upsertSsoConfig } from './sso-config-store.js';
import {
  buildAuthorizationUrl,
  createSsoState,
  exchangeAuthorizationCode,
  fetchOidcDiscovery,
  parseIdTokenClaims,
  verifySsoState
} from './oidc-client.js';

function requirePostgres(pg: PgQueryable | null | undefined): PgQueryable {
  if (!pg) {
    throw Object.assign(new Error('postgres is required for auth — set DATABASE_URL or OPC_USE_MEMORY_PG=1'), {
      status: 503
    });
  }
  return pg;
}

function formatUserResponse(user: {
  user_id: string;
  email: string;
  role: string;
  name: string | null;
  tenant_id: string;
  tenant_name: string;
  plan_code: string;
}) {
  return {
    token: signAccessToken({
      sub: user.user_id,
      tid: user.tenant_id,
      role: user.role as AuthRole
    }),
    user: {
      id: user.user_id,
      email: user.email,
      role: user.role,
      name: user.name
    },
    tenant: {
      id: user.tenant_id,
      name: user.tenant_name,
      plan: user.plan_code
    }
  };
}

function permissionsForRole(role: AuthRole): string[] {
  switch (role) {
    case 'owner':
      return ['*'];
    case 'admin':
      return ['manage:settings', 'manage:billing', 'manage:agents', 'read:reports'];
    case 'operator':
      return ['use:call-center', 'read:own-calls'];
    case 'viewer':
      return ['read:dashboard', 'read:reports'];
    case 'system':
      return ['system:*'];
    default:
      return [];
  }
}

export async function routeAuthApi(
  pg: PgQueryable | null | undefined,
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  if (!path.startsWith('/api/auth/')) return undefined;

  const pool = requirePostgres(pg);
  const store = new AuthStore(pool);

  if (path === '/api/auth/register' && method === 'POST') {
    const input = body as {
      email?: string;
      password?: string;
      name?: string;
      tenantName?: string;
    };
    const user = await store.register({
      email: String(input?.email || ''),
      password: String(input?.password || ''),
      name: String(input?.name || ''),
      tenantName: String(input?.tenantName || '')
    });
    const onboarding = db
      ? await runWithPgTenantContextAsync({ tenantId: user.tenant_id }, () =>
          onboardCallCenterTenant(db, {
            tenantId: user.tenant_id,
            tenantName: user.tenant_name,
            userId: user.user_id,
            userName: user.name
          })
        )
      : null;
    if (db) {
      auditCallCenterAction(db, {
        tenant_id: user.tenant_id,
        actor_id: user.user_id,
        action: 'auth.register',
        object_type: 'user',
        object_id: user.user_id,
        metadata: { email: user.email }
      });
    }
    return {
      status: 201,
      data: {
        ...formatUserResponse(user),
        onboarding
      }
    };
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const input = body as { email?: string; password?: string };
    const user = await store.login({
      email: String(input?.email || ''),
      password: String(input?.password || '')
    });
    if (db) {
      auditCallCenterAction(db, {
        tenant_id: user.tenant_id,
        actor_id: user.user_id,
        action: 'auth.login',
        object_type: 'user',
        object_id: user.user_id,
        metadata: { email: user.email }
      });
    }
    return { status: 200, data: formatUserResponse(user) };
  }

  if (path === '/api/auth/me' && method === 'GET') {
    const ctx = resolveAuthContext(headers);
    if (!ctx.authenticated || !ctx.tenantId || !ctx.userId) {
      throw Object.assign(new Error('authentication required'), { status: 401 });
    }
    const user = await store.findByUserId(ctx.userId, ctx.tenantId);
    if (!user) {
      throw Object.assign(new Error('user not found'), { status: 404 });
    }
    return {
      status: 200,
      data: {
        user: {
          id: user.user_id,
          email: user.email,
          role: user.role,
          name: user.name
        },
        tenant: {
          id: user.tenant_id,
          name: user.tenant_name,
          plan: user.plan_code
        },
        permissions: permissionsForRole(ctx.role)
      }
    };
  }

  if (path === '/api/auth/sso/config' && method === 'GET') {
    if (!db) return { status: 503, data: { error: 'database unavailable' } };
    const tenantId = url.searchParams.get('tenant_id');
    if (!tenantId) return { status: 400, data: { error: 'tenant_id is required' } };
    const config = getPublicSsoConfig(db, tenantId);
    if (!config) return { status: 404, data: { error: 'SSO not configured' } };
    return { data: config };
  }

  if (path === '/api/auth/sso/config' && method === 'PUT') {
    if (!db) return { status: 503, data: { error: 'database unavailable' } };
    const ctx = resolveAuthContext(headers);
    if (!ctx.authenticated || !ctx.tenantId) {
      throw Object.assign(new Error('authentication required'), { status: 401 });
    }
    if (ctx.role !== 'owner' && ctx.role !== 'admin' && ctx.role !== 'system') {
      throw Object.assign(new Error('admin role required'), { status: 403 });
    }
    const input = body as {
      enabled?: boolean;
      issuer_url?: string;
      client_id?: string;
      client_secret?: string;
      redirect_uri?: string;
      scopes?: string;
      default_role?: 'owner' | 'admin' | 'operator' | 'viewer';
    };
    const updated = upsertSsoConfig(db, ctx.tenantId, input);
    auditCallCenterAction(db, {
      tenant_id: ctx.tenantId,
      actor_id: ctx.userId,
      action: 'auth.sso_config_updated',
      object_type: 'tenant',
      object_id: ctx.tenantId,
      metadata: { enabled: updated.enabled, issuer_url: updated.issuer_url }
    });
    const { client_secret: _secret, ...publicConfig } = updated;
    return { data: publicConfig };
  }

  if (path === '/api/auth/sso/authorize' && method === 'GET') {
    if (!db) return { status: 503, data: { error: 'database unavailable' } };
    const tenantId = url.searchParams.get('tenant_id');
    if (!tenantId) return { status: 400, data: { error: 'tenant_id is required' } };
    const config = getSsoConfig(db, tenantId);
    if (!config?.enabled) return { status: 404, data: { error: 'SSO not enabled' } };
    const secret = process.env.OPC_JWT_SECRET;
    if (!secret) return { status: 503, data: { error: 'OPC_JWT_SECRET not configured' } };
    const discovery = await fetchOidcDiscovery(config.issuer_url);
    const { state, nonce } = createSsoState(tenantId, secret);
    void nonce;
    const authorization_url = buildAuthorizationUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      clientId: config.client_id,
      redirectUri: config.redirect_uri,
      scopes: config.scopes,
      state,
      nonce
    });
    return { data: { authorization_url, state } };
  }

  if (path === '/api/auth/sso/callback' && method === 'POST') {
    if (!db) return { status: 503, data: { error: 'database unavailable' } };
    const input = body as { tenant_id?: string; code?: string; state?: string };
    const tenantId = String(input.tenant_id || '');
    const code = String(input.code || '');
    const state = String(input.state || '');
    if (!tenantId || !code || !state) {
      return { status: 400, data: { error: 'tenant_id, code, and state are required' } };
    }
    const secret = process.env.OPC_JWT_SECRET;
    if (!secret) return { status: 503, data: { error: 'OPC_JWT_SECRET not configured' } };
    verifySsoState(state, tenantId, secret);
    const config = getSsoConfig(db, tenantId);
    if (!config?.enabled) return { status: 404, data: { error: 'SSO not enabled' } };
    const discovery = await fetchOidcDiscovery(config.issuer_url);
    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: discovery.token_endpoint,
      clientId: config.client_id,
      clientSecret: config.client_secret,
      redirectUri: config.redirect_uri,
      code
    });
    const claims = parseIdTokenClaims(tokens.id_token);
    const email = String(claims.email || claims.preferred_username || '');
    if (!email) {
      return { status: 400, data: { error: 'id_token missing email claim' } };
    }
    const user = await store.provisionOidcUser({
      tenantId,
      email,
      name: claims.name || null,
      externalSub: claims.sub,
      role: config.default_role
    });
    if (db) {
      auditCallCenterAction(db, {
        tenant_id: tenantId,
        actor_id: user.user_id,
        action: 'auth.sso_login',
        object_type: 'user',
        object_id: user.user_id,
        metadata: { email: user.email, sub: claims.sub }
      });
    }
    return { status: 200, data: formatUserResponse(user) };
  }

  return { status: 404, data: { error: 'not found' } };
}

export function authContextFromHeaders(
  headers: Record<string, string | string[] | undefined>
): AuthContext {
  return resolveAuthContext(headers);
}
