import {
  createHttpAttachmentTextProvider,
  type AttachmentTextProvider,
  type HttpAttachmentTextProviderConfig
} from './attachment-text-provider.js';
import { createIntelligenceProviderRegistry } from './intelligence-provider-registry.js';

export interface HttpAsrProviderConfig
  extends Omit<HttpAttachmentTextProviderConfig, 'processor' | 'endpoint'> {
  endpoint?: string;
}

export function createHttpAsrProvider(config: HttpAsrProviderConfig): AttachmentTextProvider {
  return createHttpAttachmentTextProvider({
    ...config,
    processor: 'asr',
    endpoint: config.endpoint || '/v1/asr'
  });
}

export function configuredAsrProvider(
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetch?: typeof fetch } = {}
): AttachmentTextProvider | null {
  const registry = createIntelligenceProviderRegistry(env);
  const profile = registry.defaultProfile('asr');
  if (!profile) return null;
  return createHttpAsrProvider({
    mode: profile.mode,
    baseUrl: profile.base_url,
    endpoint: profile.endpoint,
    token: registry.resolveToken(profile),
    timeoutMs: profile.timeout_ms,
    name: profile.name,
    profileId: profile.id,
    fetch: deps.fetch
  });
}
