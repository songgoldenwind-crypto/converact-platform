import type { PgQueryable } from '../../db-pg.js';
import { resolveAuthContext } from '../../middleware/auth.js';
import {
  IntelligencePolicyStore,
  type IntelligencePolicy,
  type IntelligencePolicyUpdate
} from '../collaboration/intelligence-policy-store.js';
import {
  createIntelligenceProviderRegistry,
  type IntelligenceProviderRegistry
} from '../collaboration/intelligence-provider-registry.js';
import { wsBroadcast } from '../../ws.js';
import {
  IntelligenceProviderHealthService,
  type IntelligenceProviderHealthResult
} from '../collaboration/intelligence-provider-health.js';

export interface RouteIveKitIntelligenceApiOptions {
  registry?: IntelligenceProviderRegistry;
  health?: { probe(input: { profile_ids?: string[] }): Promise<IntelligenceProviderHealthResult[]> };
  publish?: (tenantId: string, type: string, data: unknown) => void | Promise<void>;
}

const POLICY_FIELDS = new Set([
  'ocr_enabled',
  'asr_enabled',
  'quality_review_enabled',
  'translation_enabled',
  'ocr_profile_id',
  'asr_profile_id',
  'quality_profile_id',
  'translation_profile_id',
  'allow_third_party',
  'auto_ocr',
  'auto_asr',
  'auto_quality_review',
  'auto_translation',
  'translation_target_languages',
  'min_ocr_confidence',
  'min_asr_confidence'
]);

export async function routeIveKitIntelligenceApi(
  pg: PgQueryable | null,
  method: string,
  path: string,
  _url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined> = {},
  options: RouteIveKitIntelligenceApiOptions = {}
): Promise<unknown | undefined> {
  const routePath = path.split('?')[0];
  if (!routePath.startsWith('/api/ivekit/intelligence')) return undefined;
  const ctx = requireAuth(headers);
  if (!pg) throw Object.assign(new Error('PostgreSQL is required'), { status: 503 });
  const registry = options.registry || createIntelligenceProviderRegistry();
  const store = new IntelligencePolicyStore(pg, registry);

  if (routePath === '/api/ivekit/intelligence/capabilities' && method === 'GET') {
    const policy = await store.getEffectivePolicy(ctx.tenantId);
    return { data: publicCapabilities(policy, registry) };
  }

  if (routePath === '/api/ivekit/intelligence/policy' && method === 'GET') {
    requireAdministrator(ctx.role);
    return { data: await store.getEffectivePolicy(ctx.tenantId) };
  }

  if (routePath === '/api/ivekit/intelligence/policy' && method === 'PUT') {
    requireAdministrator(ctx.role);
    const input = bodyRecord(body);
    const unsupported = Object.keys(input).find((field) => field !== 'version' && !POLICY_FIELDS.has(field));
    if (unsupported) throw Object.assign(new Error(`unsupported intelligence policy field: ${unsupported}`), { status: 400 });
    const expectedVersion = Number(input.version);
    const policy = Object.fromEntries(
      [...POLICY_FIELDS].map((field) => [field, input[field]])
    ) as unknown as IntelligencePolicyUpdate;
    const updated = await store.updatePolicy({
      tenant_id: ctx.tenantId,
      actor_identity: actorIdentity(ctx, headers),
      expected_version: expectedVersion,
      policy
    });
    const publish = options.publish || wsBroadcast;
    return {
      status: expectedVersion === 0 ? 201 : 200,
      data: updated,
      afterCommit: () => Promise.resolve(publish(
        ctx.tenantId,
        'collaboration.intelligence.policy_updated',
        {
          tenant_id: ctx.tenantId,
          version: updated.version,
          updated_by: updated.updated_by
        }
      ))
    };
  }

  if (routePath === '/api/ivekit/intelligence/providers' && method === 'GET') {
    requireAdministrator(ctx.role);
    return { data: { items: registry.listSafe() } };
  }

  if (routePath === '/api/ivekit/intelligence/providers/health' && method === 'POST') {
    requireAdministrator(ctx.role);
    const input = bodyRecord(body);
    const unsupported = Object.keys(input).find((field) => field !== 'profile_ids');
    if (unsupported) throw Object.assign(new Error(`unsupported provider health field: ${unsupported}`), { status: 400 });
    const profileIds = optionalProfileIds(input.profile_ids);
    const health = options.health || new IntelligenceProviderHealthService(registry);
    return { data: { items: await health.probe({ ...(profileIds ? { profile_ids: profileIds } : {}) }) } };
  }

  return undefined;
}

function publicCapabilities(
  policy: IntelligencePolicy,
  registry: IntelligenceProviderRegistry
): Record<string, unknown> {
  const safeProfiles = new Map(registry.listSafe().map((profile) => [profile.id, profile]));
  const capability = (
    enabled: boolean,
    automatic: boolean,
    profileId: string
  ) => {
    const profile = profileId ? safeProfiles.get(profileId) : undefined;
    return {
      enabled,
      automatic,
      available: Boolean(enabled && profile?.configured && profile.token_configured),
      provider_mode: profile?.mode || 'unconfigured',
      reason: !enabled
        ? 'policy_disabled'
        : !profile
          ? 'profile_unavailable'
          : !profile.token_configured
            ? 'credential_unavailable'
            : ''
    };
  };
  return {
    tenant_id: policy.tenant_id,
    policy_configured: policy.configured,
    policy_version: policy.version,
    capabilities: {
      ocr: capability(policy.ocr_enabled, policy.auto_ocr, policy.ocr_profile_id),
      asr: capability(policy.asr_enabled, policy.auto_asr, policy.asr_profile_id),
      quality_review: capability(
        policy.quality_review_enabled,
        policy.auto_quality_review,
        policy.quality_profile_id
      ),
      translation: capability(
        policy.translation_enabled,
        policy.auto_translation,
        policy.translation_profile_id
      )
    },
    translation_target_languages: policy.translation_target_languages,
    confidence_thresholds: {
      ocr: policy.min_ocr_confidence,
      asr: policy.min_asr_confidence
    }
  };
}

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

function requireAdministrator(role: string): void {
  if (role === 'system' || role === 'owner' || role === 'admin') return;
  throw Object.assign(new Error('intelligence policy administration requires owner or admin role'), { status: 403 });
}

function actorIdentity(
  ctx: ReturnType<typeof requireAuth>,
  headers: Record<string, string | string[] | undefined>
): string {
  if (ctx.role !== 'system') return ctx.userId;
  return headerValue(headers, 'x-user-id').trim() || ctx.userId;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = Array.isArray(found?.[1]) ? found?.[1][0] : found?.[1];
  return String(value || '');
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('JSON object body is required'), { status: 400 });
  }
  return value as Record<string, unknown>;
}

function optionalProfileIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw Object.assign(new Error('profile_ids must contain at most 20 items'), { status: 400 });
  }
  const ids = value.map((item) => String(item || '').trim());
  if (ids.some((id) => !id || !/^[a-z][a-z0-9_-]{0,63}$/.test(id))) {
    throw Object.assign(new Error('profile_ids contains an invalid profile id'), { status: 400 });
  }
  return [...new Set(ids)];
}
