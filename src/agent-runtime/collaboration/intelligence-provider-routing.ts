import type { PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import type {
  AttachmentProviderResolution,
  AttachmentProviderResolver
} from './attachment-processing.js';
import type { AttachmentTextProvider } from './attachment-text-provider.js';
import type { CollaborationAttachmentProcessor } from './types.js';
import { createHttpAsrProvider } from './asr-provider.js';
import { IntelligencePolicyStore } from './intelligence-policy-store.js';
import { IntelligenceProviderGovernanceStore } from './intelligence-provider-governance-store.js';
import type {
  IntelligenceProviderCapability,
  IntelligenceProviderProfile,
  IntelligenceProviderRegistry
} from './intelligence-provider-registry.js';
import {
  executeIntelligenceProviderRoute,
  type IntelligenceProviderRouteCandidate,
  type IntelligenceProviderRouteEventHandler,
  type IntelligenceProviderRouteResult
} from './intelligence-provider-route.js';
import { createHttpOcrProvider } from './ocr-provider.js';
import {
  createHttpQualityReviewProvider,
  type QualityProviderResolution,
  type QualityReviewProvider,
  type QualityReviewProviderResolver
} from './quality-review.js';
import {
  createHttpTranslationProvider,
  type TranslationProvider
} from './translation-provider.js';
import type {
  TranslationProviderResolution,
  TranslationProviderResolver
} from './translation-service.js';

export function createPolicyAttachmentProviderResolver(input: {
  pg: PgQueryable;
  registry: IntelligenceProviderRegistry;
  fetch?: typeof fetch;
  governance?: IntelligenceProviderGovernanceStore;
  onEvent?: IntelligenceProviderRouteEventHandler;
}): AttachmentProviderResolver {
  const governance = input.governance || new IntelligenceProviderGovernanceStore(input.pg);
  return async ({ tenant_id, processor }) => {
    const capability = attachmentProviderCapability(processor);
    const policy = await withPgTenant(input.pg, tenant_id, (pg) =>
      new IntelligencePolicyStore(pg, input.registry).getEffectivePolicy(tenant_id)
    );
    const enabled = capability === 'ocr' ? policy.ocr_enabled : policy.asr_enabled;
    const automatic = capability === 'ocr' ? policy.auto_ocr : policy.auto_asr;
    const profileIds = capability === 'ocr' ? policy.ocr_profile_ids : policy.asr_profile_ids;
    if (!enabled) return unavailable(false, automatic, profileIds[0] || '', 'policy_disabled');
    if (!profileIds.length) return unavailable(true, automatic, '', 'provider_unavailable');
    const candidates = createCandidates(
      input.registry,
      profileIds,
      capability,
      policy.allow_third_party,
      (profile, token) => {
        const config = providerConfig(profile, token, input.fetch);
        return capability === 'ocr' ? createHttpOcrProvider(config) : createHttpAsrProvider(config);
      }
    );
    const available = candidates.find((candidate) => candidate.provider);
    if (!available) {
      return unavailable(
        true, automatic, profileIds[0], candidates[0]?.unavailable_reason || 'provider_unavailable'
      );
    }
    const provider = routedAttachmentProvider({
      tenant_id, processor, candidates, governance, initial: available, onEvent: input.onEvent
    });
    return { enabled: true, automatic, profile_id: provider.profile_id || '', provider, error_code: '' };
  };
}

export function createPolicyQualityReviewProviderResolver(input: {
  pg: PgQueryable;
  registry: IntelligenceProviderRegistry;
  fetch?: typeof fetch;
  governance?: IntelligenceProviderGovernanceStore;
  onEvent?: IntelligenceProviderRouteEventHandler;
}): QualityReviewProviderResolver {
  const governance = input.governance || new IntelligenceProviderGovernanceStore(input.pg);
  return async ({ tenant_id }) => {
    const policy = await withPgTenant(input.pg, tenant_id, (pg) =>
      new IntelligencePolicyStore(pg, input.registry).getEffectivePolicy(tenant_id)
    );
    if (!policy.quality_review_enabled) {
      return unavailableQuality(
        false, policy.auto_quality_review, policy.quality_profile_ids[0] || '', 'policy_disabled'
      );
    }
    if (!policy.quality_profile_ids.length) {
      return unavailableQuality(true, policy.auto_quality_review, '', 'provider_unavailable');
    }
    const candidates = createCandidates(
      input.registry,
      policy.quality_profile_ids,
      'quality_review',
      policy.allow_third_party,
      (profile, token) => createHttpQualityReviewProvider(providerConfig(profile, token, input.fetch))
    );
    const available = candidates.find((candidate) => candidate.provider);
    if (!available) {
      return unavailableQuality(
        true,
        policy.auto_quality_review,
        policy.quality_profile_ids[0],
        candidates[0]?.unavailable_reason || 'provider_unavailable'
      );
    }
    const provider = routedQualityProvider({
      tenant_id, candidates, governance, initial: available, onEvent: input.onEvent
    });
    return {
      enabled: true,
      automatic: policy.auto_quality_review,
      profile_id: provider.profile_id || '',
      provider,
      error_code: ''
    };
  };
}

export function createPolicyTranslationProviderResolver(input: {
  pg: PgQueryable;
  registry: IntelligenceProviderRegistry;
  fetch?: typeof fetch;
  governance?: IntelligenceProviderGovernanceStore;
  onEvent?: IntelligenceProviderRouteEventHandler;
}): TranslationProviderResolver {
  const governance = input.governance || new IntelligenceProviderGovernanceStore(input.pg);
  return async ({ tenant_id }) => {
    const policy = await withPgTenant(input.pg, tenant_id, (pg) =>
      new IntelligencePolicyStore(pg, input.registry).getEffectivePolicy(tenant_id)
    );
    if (!policy.translation_enabled) {
      return unavailableTranslation(
        false, policy.auto_translation, policy.translation_profile_ids[0] || '', 'policy_disabled'
      );
    }
    if (!policy.translation_profile_ids.length) {
      return unavailableTranslation(true, policy.auto_translation, '', 'provider_unavailable');
    }
    const candidates = createCandidates(
      input.registry,
      policy.translation_profile_ids,
      'translation',
      policy.allow_third_party,
      (profile, token) => createHttpTranslationProvider(providerConfig(profile, token, input.fetch))
    );
    const available = candidates.find((candidate) => candidate.provider);
    if (!available) {
      return unavailableTranslation(
        true,
        policy.auto_translation,
        policy.translation_profile_ids[0],
        candidates[0]?.unavailable_reason || 'provider_unavailable'
      );
    }
    const provider = routedTranslationProvider({
      tenant_id, candidates, governance, initial: available, onEvent: input.onEvent
    });
    return {
      enabled: true,
      automatic: policy.auto_translation,
      profile_id: provider.profile_id || '',
      provider,
      error_code: ''
    };
  };
}

function createCandidates<TProvider>(
  registry: IntelligenceProviderRegistry,
  profileIds: string[],
  capability: IntelligenceProviderCapability,
  allowThirdParty: boolean,
  createProvider: (profile: IntelligenceProviderProfile, token: string | undefined) => TProvider
): Array<IntelligenceProviderRouteCandidate<TProvider>> {
  const candidates: Array<IntelligenceProviderRouteCandidate<TProvider>> = [];
  for (const profileId of profileIds) {
    const profile = registry.profile(profileId);
    if (!profile || profile.capability !== capability) continue;
    if (profile.mode === 'third_party' && !allowThirdParty) {
      candidates.push({ profile, provider: null, unavailable_reason: 'third_party_not_allowed' });
      continue;
    }
    const token = registry.resolveToken(profile);
    if (profile.token_env && !token) {
      candidates.push({ profile, provider: null, unavailable_reason: 'provider_credential_unavailable' });
      continue;
    }
    candidates.push({ profile, provider: createProvider(profile, token) });
  }
  return candidates;
}

function routedAttachmentProvider(input: {
  tenant_id: string;
  processor: CollaborationAttachmentProcessor;
  candidates: Array<IntelligenceProviderRouteCandidate<AttachmentTextProvider>>;
  governance: IntelligenceProviderGovernanceStore;
  initial: IntelligenceProviderRouteCandidate<AttachmentTextProvider>;
  onEvent?: IntelligenceProviderRouteEventHandler;
}): AttachmentTextProvider {
  const capability = attachmentProviderCapability(input.processor);
  const provider: AttachmentTextProvider = {
    processor: capability,
    name: input.initial.profile.name,
    mode: input.initial.profile.mode,
    profile_id: input.initial.profile.id,
    async extract(request) {
      const result = await executeIntelligenceProviderRoute({
        tenant_id: input.tenant_id,
        capability,
        candidates: input.candidates,
        governance: input.governance,
        onEvent: input.onEvent,
        invoke: (candidate) => candidate.extract(request)
      });
      selectProvider(provider, result);
      return {
        ...result.output,
        metadata: routeMetadata(result.output.metadata, result)
      };
    }
  };
  return provider;
}

function attachmentProviderCapability(
  processor: CollaborationAttachmentProcessor
): 'ocr' | 'asr' {
  return processor === 'video_frame_ocr' ? 'ocr' : processor;
}

function routedQualityProvider(input: {
  tenant_id: string;
  candidates: Array<IntelligenceProviderRouteCandidate<QualityReviewProvider>>;
  governance: IntelligenceProviderGovernanceStore;
  initial: IntelligenceProviderRouteCandidate<QualityReviewProvider>;
  onEvent?: IntelligenceProviderRouteEventHandler;
}): QualityReviewProvider {
  const provider: QualityReviewProvider = {
    name: input.initial.profile.name,
    mode: input.initial.profile.mode,
    profile_id: input.initial.profile.id,
    async review(request) {
      const result = await executeIntelligenceProviderRoute({
        tenant_id: input.tenant_id,
        capability: 'quality_review',
        candidates: input.candidates,
        governance: input.governance,
        onEvent: input.onEvent,
        invoke: (candidate) => candidate.review(request)
      });
      selectProvider(provider, result);
      return { ...result.output, metadata: routeMetadata(result.output.metadata, result) };
    }
  };
  return provider;
}

function routedTranslationProvider(input: {
  tenant_id: string;
  candidates: Array<IntelligenceProviderRouteCandidate<TranslationProvider>>;
  governance: IntelligenceProviderGovernanceStore;
  initial: IntelligenceProviderRouteCandidate<TranslationProvider>;
  onEvent?: IntelligenceProviderRouteEventHandler;
}): TranslationProvider {
  const provider: TranslationProvider = {
    name: input.initial.profile.name,
    mode: input.initial.profile.mode,
    profile_id: input.initial.profile.id,
    async translate(request) {
      const result = await executeIntelligenceProviderRoute({
        tenant_id: input.tenant_id,
        capability: 'translation',
        candidates: input.candidates,
        governance: input.governance,
        onEvent: input.onEvent,
        invoke: (candidate) => candidate.translate(request)
      });
      selectProvider(provider, result);
      return { ...result.output, metadata: routeMetadata(result.output.metadata, result) };
    }
  };
  return provider;
}

function selectProvider(
  provider: { name: string; mode: 'self_hosted' | 'third_party'; profile_id?: string },
  result: IntelligenceProviderRouteResult<unknown>
): void {
  provider.name = result.selected_profile.name;
  provider.mode = result.selected_profile.mode;
  provider.profile_id = result.selected_profile.id;
}

function routeMetadata(
  metadata: Record<string, unknown> | undefined,
  result: IntelligenceProviderRouteResult<unknown>
): Record<string, unknown> {
  return {
    ...(metadata || {}),
    ivekit_route_attempt_count: result.attempt_count,
    ivekit_route_failed_over: result.failed_over,
    ivekit_route_attempts: result.attempts,
    ...(result.governance_completion_pending
      ? { ivekit_governance_completion_pending: true }
      : {})
  };
}

function providerConfig(
  profile: IntelligenceProviderProfile,
  token: string | undefined,
  fetchImpl: typeof fetch | undefined
) {
  return {
    mode: profile.mode,
    baseUrl: profile.base_url,
    endpoint: profile.endpoint,
    token,
    timeoutMs: profile.timeout_ms,
    name: profile.name,
    profileId: profile.id,
    fetch: fetchImpl
  };
}

function unavailable(
  enabled: boolean,
  automatic: boolean,
  profileId: string,
  errorCode: string
): AttachmentProviderResolution {
  return { enabled, automatic, profile_id: profileId, provider: null, error_code: errorCode };
}

function unavailableQuality(
  enabled: boolean,
  automatic: boolean,
  profileId: string,
  errorCode: string
): QualityProviderResolution {
  return { enabled, automatic, profile_id: profileId, provider: null, error_code: errorCode };
}

function unavailableTranslation(
  enabled: boolean,
  automatic: boolean,
  profileId: string,
  errorCode: string
): TranslationProviderResolution {
  return { enabled, automatic, profile_id: profileId, provider: null, error_code: errorCode };
}
