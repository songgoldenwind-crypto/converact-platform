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
import {
  IntelligenceProviderGovernanceStore,
  type IntelligenceProviderRuntimeSnapshot
} from '../collaboration/intelligence-provider-governance-store.js';
import {
  IntelligenceSourceService,
  type IntelligenceSourceSnapshot
} from '../collaboration/intelligence-source-service.js';
import { createLiveKitMediaModule } from '../livekit/index.js';
import { PolicyFindingStore } from '../collaboration/policy-finding-store.js';
import { CollaborationStore } from '../collaboration/collaboration-store.js';
import type { CollaborationPolicyFinding, PolicyEvidenceRef } from '../collaboration/types.js';

export interface RouteIveKitIntelligenceApiOptions {
  registry?: IntelligenceProviderRegistry;
  health?: { probe(input: { profile_ids?: string[] }): Promise<IntelligenceProviderHealthResult[]> };
  governance?: { listRuntime(tenantId: string): Promise<IntelligenceProviderRuntimeSnapshot[]> };
  db?: unknown;
  source?: Pick<IntelligenceSourceService, 'importSource' | 'getSource' | 'retrySource'>;
  publish?: (tenantId: string, type: string, data: unknown) => void | Promise<void>;
}

const POLICY_FIELDS = new Set([
  'ocr_enabled',
  'asr_enabled',
  'quality_review_enabled',
  'translation_enabled',
  'realtime_speech_enabled',
  'tts_enabled',
  'model_gateway_enabled',
  'ocr_profile_id',
  'asr_profile_id',
  'quality_profile_id',
  'translation_profile_id',
  'realtime_speech_profile_id',
  'tts_profile_id',
  'model_gateway_profile_id',
  'ocr_profile_ids',
  'asr_profile_ids',
  'quality_profile_ids',
  'translation_profile_ids',
  'realtime_speech_profile_ids',
  'tts_profile_ids',
  'model_gateway_profile_ids',
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
  url: URL,
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

  if (routePath === '/api/ivekit/intelligence/findings' && method === 'GET') {
    requireReviewer(ctx.role);
    const page = await new PolicyFindingStore(pg).listTenantReviewQueue({
      tenant_id: ctx.tenantId,
      session_id: url.searchParams.get('session_id') || undefined,
      source: (url.searchParams.get('source') || undefined) as
        | 'text' | 'ocr' | 'asr' | 'ai' | 'aggregate' | undefined,
      severity: (url.searchParams.get('severity') || undefined) as
        | 'low' | 'medium' | 'high' | undefined,
      review_status: (url.searchParams.get('review_status') || undefined) as
        | 'pending' | 'confirmed' | 'false_positive' | 'resolved' | 'escalated' | undefined,
      created_from: url.searchParams.get('created_from') || undefined,
      created_to: url.searchParams.get('created_to') || undefined,
      cursor: url.searchParams.get('cursor') || undefined,
      limit: queryLimit(url.searchParams.get('limit'))
    });
    return {
      data: {
        items: page.items.map(projectReviewQueueFinding),
        next_cursor: page.next_cursor
      }
    };
  }

  const findingMatch = routePath.match(/^\/api\/ivekit\/intelligence\/findings\/([^/]+)(?:\/(review))?$/);
  if (findingMatch && (method === 'GET' || (method === 'POST' && findingMatch[2] === 'review'))) {
    requireReviewer(ctx.role);
    const findings = new PolicyFindingStore(pg);
    const findingId = decodeURIComponent(findingMatch[1]);
    const existing = await findings.getFinding({ tenant_id: ctx.tenantId, finding_id: findingId });
    if (!existing || !(await findingVisible(pg, existing))) {
      return { status: 404, data: { error: 'policy finding not found' } };
    }
    if (method === 'GET') {
      return { data: {
        session_id: existing.session_id,
        finding: projectReviewQueueFinding(existing),
        reviews: await findings.listReviews({ tenant_id: ctx.tenantId, finding_id: findingId })
      } };
    }

    const input = bodyRecord(body);
    const unsupported = Object.keys(input).find((field) => !['review_status', 'note', 'metadata'].includes(field));
    if (unsupported) throw Object.assign(new Error(`unsupported finding review field: ${unsupported}`), { status: 400 });
    const reviewStatus = String(input.review_status || '').trim();
    if (!['confirmed', 'false_positive', 'resolved', 'escalated'].includes(reviewStatus)) {
      throw Object.assign(new Error('unsupported finding review_status'), { status: 400 });
    }
    const reviewChanged = existing.review_status !== reviewStatus;
    const finding = await findings.reviewFinding({
      tenant_id: ctx.tenantId,
      finding_id: findingId,
      review_status: reviewStatus as 'confirmed' | 'false_positive' | 'resolved' | 'escalated',
      reviewed_by: actorIdentity(ctx, headers),
      note: input.note == null ? undefined : String(input.note),
      metadata: recordValue(input.metadata)
    });
    const reviews = await findings.listReviews({ tenant_id: ctx.tenantId, finding_id: findingId });
    const publish = options.publish || wsBroadcast;
    return {
      status: reviewChanged ? 201 : 200,
      data: { session_id: finding.session_id, finding: projectReviewQueueFinding(finding), reviews },
      afterCommit: () => reviewChanged
        ? Promise.resolve(publish(ctx.tenantId, 'collaboration.policy.finding_reviewed', {
          session_id: finding.session_id,
          finding_id: finding.id,
          review_status: finding.review_status,
          reviewed_at: finding.reviewed_at
        }))
        : Promise.resolve()
    };
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

  if (routePath === '/api/ivekit/intelligence/providers/runtime' && method === 'GET') {
    requireAdministrator(ctx.role);
    const governance = options.governance || new IntelligenceProviderGovernanceStore(pg);
    return { data: { items: await governance.listRuntime(ctx.tenantId) } };
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

  const sourceCreateMatch = routePath.match(
    /^\/api\/ivekit\/intelligence\/sessions\/([^/]+)\/sources$/
  );
  if (sourceCreateMatch && method === 'POST') {
    requireAdministrator(ctx.role);
    const input = bodyRecord(body);
    const unsupported = Object.keys(input).find((field) => !['source_type', 'source_ref_id'].includes(field));
    if (unsupported) throw Object.assign(new Error(`unsupported intelligence source field: ${unsupported}`), { status: 400 });
    const idempotencyKey = headerValue(headers, 'idempotency-key').trim();
    if (!idempotencyKey) throw Object.assign(new Error('Idempotency-Key is required'), { status: 400 });
    const sourceService = intelligenceSourceService(pg, registry, options);
    const created = await sourceService.importSource({
      tenant_id: ctx.tenantId,
      session_id: decodeURIComponent(sourceCreateMatch[1]),
      source_type: String(input.source_type || '') as 'media_recording' | 'remote_recording',
      source_ref_id: String(input.source_ref_id || ''),
      actor_identity: actorIdentity(ctx, headers),
      idempotency_key: idempotencyKey
    });
    const publish = options.publish || wsBroadcast;
    return {
      status: created.replayed ? 200 : 201,
      data: projectSourceSnapshot(created),
      afterCommit: () => Promise.resolve(publish(
        ctx.tenantId,
        'collaboration.intelligence.source_created',
        {
          session_id: created.source.session_id,
          source_id: created.source.id,
          message_id: created.source.message_id,
          attachment_id: created.source.attachment_id,
          status: created.source.status,
          replayed: created.replayed
        }
      ))
    };
  }

  const sourceMatch = routePath.match(
    /^\/api\/ivekit\/intelligence\/sessions\/([^/]+)\/sources\/([^/]+)(?:\/(retry))?$/
  );
  if (sourceMatch && (method === 'GET' || (method === 'POST' && sourceMatch[3] === 'retry'))) {
    requireAdministrator(ctx.role);
    const sourceService = intelligenceSourceService(pg, registry, options);
    const sourceInput = {
      tenant_id: ctx.tenantId,
      session_id: decodeURIComponent(sourceMatch[1]),
      source_id: decodeURIComponent(sourceMatch[2])
    };
    const snapshot = method === 'GET'
      ? await sourceService.getSource(sourceInput)
      : await sourceService.retrySource(sourceInput);
    if (!snapshot) throw Object.assign(new Error('intelligence source not found'), { status: 404 });
    return { data: projectSourceSnapshot(snapshot) };
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
    profileIds: string[]
  ) => {
    const providers = profileIds.map((profileId) => {
      const profile = safeProfiles.get(profileId);
      const available = Boolean(profile?.configured && profile.token_configured);
      return {
        profile_id: profileId,
        mode: profile?.mode || 'unconfigured',
        available,
        reason: !profile
          ? 'profile_unavailable'
          : !profile.token_configured
            ? 'credential_unavailable'
            : ''
      };
    });
    const primary = providers[0];
    const available = Boolean(enabled && providers.some((provider) => provider.available));
    return {
      enabled,
      automatic,
      available,
      provider_mode: primary?.mode || 'unconfigured',
      provider_profile_ids: [...profileIds],
      providers,
      reason: !enabled
        ? 'policy_disabled'
        : !providers.length || providers.every((provider) => provider.reason === 'profile_unavailable')
          ? 'profile_unavailable'
          : !available
            ? 'credential_unavailable'
            : ''
    };
  };
  return {
    tenant_id: policy.tenant_id,
    policy_configured: policy.configured,
    policy_version: policy.version,
    capabilities: {
      ocr: capability(policy.ocr_enabled, policy.auto_ocr, policy.ocr_profile_ids),
      asr: capability(policy.asr_enabled, policy.auto_asr, policy.asr_profile_ids),
      quality_review: capability(
        policy.quality_review_enabled,
        policy.auto_quality_review,
        policy.quality_profile_ids
      ),
      translation: capability(
        policy.translation_enabled,
        policy.auto_translation,
        policy.translation_profile_ids
      ),
      realtime_speech: capability(
        policy.realtime_speech_enabled,
        false,
        policy.realtime_speech_profile_ids
      ),
      tts: capability(
        policy.tts_enabled,
        false,
        policy.tts_profile_ids
      ),
      model_gateway: capability(
        policy.model_gateway_enabled,
        false,
        policy.model_gateway_profile_ids
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

function requireReviewer(role: string): void {
  if (role === 'system' || role === 'owner' || role === 'admin' || role === 'operator') return;
  throw Object.assign(new Error('intelligence finding review requires operator or admin role'), { status: 403 });
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

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function findingVisible(pg: PgQueryable, finding: CollaborationPolicyFinding): Promise<boolean> {
  if (!finding.message_id) return true;
  const message = await new CollaborationStore(pg).getMessage({
    tenant_id: finding.tenant_id,
    message_id: finding.message_id
  });
  return Boolean(message && !message.deleted_at);
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

function queryLimit(value: string | null): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw Object.assign(new Error('limit must be an integer'), { status: 400 });
  return parsed;
}

function projectReviewQueueFinding(finding: CollaborationPolicyFinding): Record<string, unknown> {
  return {
    id: finding.id,
    tenant_id: finding.tenant_id,
    session_id: finding.session_id,
    message_id: finding.message_id,
    source: finding.source,
    source_ref_id: finding.source_ref_id,
    policy_type: finding.policy_type,
    severity: finding.severity,
    action: finding.action,
    confidence: finding.confidence,
    rationale: finding.rationale,
    evidence_refs: finding.evidence_refs.slice(0, 20).map(projectEvidenceRef),
    review_status: finding.review_status,
    reviewed_by: finding.reviewed_by,
    reviewed_at: finding.reviewed_at,
    review_note: finding.review_note,
    created_at: finding.created_at,
    updated_at: finding.updated_at,
    resolved_at: finding.resolved_at
  };
}

function projectEvidenceRef(ref: PolicyEvidenceRef): Record<string, unknown> {
  return Object.fromEntries(
    ['type', 'id', 'kind', 'processor', 'checksum']
      .filter((key) => typeof ref[key] === 'string')
      .map((key) => [key, String(ref[key]).slice(0, 200)])
  );
}

function intelligenceSourceService(
  pg: PgQueryable,
  registry: IntelligenceProviderRegistry,
  options: RouteIveKitIntelligenceApiOptions
): Pick<IntelligenceSourceService, 'importSource' | 'getSource' | 'retrySource'> {
  if (options.source) return options.source;
  const media = options.db ? createLiveKitMediaModule({ db: options.db }) : null;
  return new IntelligenceSourceService({
    pg,
    registry,
    getMediaRecording: media ? (recordingId) => media.recordings.getRecording(recordingId) : undefined
  });
}

function projectSourceSnapshot(snapshot: IntelligenceSourceSnapshot): Record<string, unknown> {
  const {
    idempotency_key: _idempotencyKey,
    request_hash: _requestHash,
    ...publicSource
  } = snapshot.source;
  return {
    source: publicSource,
    message_id: snapshot.message.id,
    replayed: snapshot.replayed,
    attachment: {
      id: snapshot.attachment.id,
      kind: snapshot.attachment.kind,
      filename: snapshot.attachment.filename,
      content_type: snapshot.attachment.content_type,
      size_bytes: snapshot.attachment.size_bytes,
      checksum: snapshot.attachment.checksum,
      processing_status: snapshot.attachment.processing_status,
      processing_error_code: snapshot.attachment.processing_error_code,
      processed_at: snapshot.attachment.processed_at
    },
    job: snapshot.job
  };
}
