import type { PgQueryable } from '../../db-pg.js';
import type {
  AttachmentProviderResolution,
  AttachmentProviderResolver
} from './attachment-processing.js';
import { createHttpAsrProvider } from './asr-provider.js';
import { IntelligencePolicyStore } from './intelligence-policy-store.js';
import type { IntelligenceProviderRegistry } from './intelligence-provider-registry.js';
import { createHttpOcrProvider } from './ocr-provider.js';

export function createPolicyAttachmentProviderResolver(input: {
  pg: PgQueryable;
  registry: IntelligenceProviderRegistry;
  fetch?: typeof fetch;
}): AttachmentProviderResolver {
  const policies = new IntelligencePolicyStore(input.pg, input.registry);
  return async ({ tenant_id, processor }) => {
    const policy = await policies.getEffectivePolicy(tenant_id);
    const enabled = processor === 'ocr' ? policy.ocr_enabled : policy.asr_enabled;
    const automatic = processor === 'ocr' ? policy.auto_ocr : policy.auto_asr;
    const profileId = processor === 'ocr' ? policy.ocr_profile_id : policy.asr_profile_id;
    if (!enabled) return unavailable(false, automatic, profileId, 'policy_disabled');
    if (!profileId) return unavailable(true, automatic, '', 'provider_unavailable');
    const profile = input.registry.requireProfile(profileId, processor);
    if (profile.mode === 'third_party' && !policy.allow_third_party) {
      return unavailable(false, automatic, profile.id, 'third_party_not_allowed');
    }
    const token = input.registry.resolveToken(profile);
    if (profile.token_env && !token) {
      return unavailable(true, automatic, profile.id, 'provider_credential_unavailable');
    }
    const config = {
      mode: profile.mode,
      baseUrl: profile.base_url,
      endpoint: profile.endpoint,
      token,
      timeoutMs: profile.timeout_ms,
      name: profile.name,
      profileId: profile.id,
      fetch: input.fetch
    };
    return {
      enabled: true,
      automatic,
      profile_id: profile.id,
      provider: processor === 'ocr' ? createHttpOcrProvider(config) : createHttpAsrProvider(config),
      error_code: ''
    };
  };
}

function unavailable(
  enabled: boolean,
  automatic: boolean,
  profileId: string,
  errorCode: string
): AttachmentProviderResolution {
  return {
    enabled,
    automatic,
    profile_id: profileId,
    provider: null,
    error_code: errorCode
  };
}
