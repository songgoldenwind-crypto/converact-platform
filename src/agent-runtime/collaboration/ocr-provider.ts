import {
  createHttpAttachmentTextProvider,
  type AttachmentTextProvider,
  type HttpAttachmentTextProviderConfig
} from './attachment-text-provider.js';
import { createIntelligenceProviderRegistry } from './intelligence-provider-registry.js';

export interface HttpOcrProviderConfig
  extends Omit<HttpAttachmentTextProviderConfig, 'processor' | 'endpoint'> {
  endpoint?: string;
}

export function createHttpOcrProvider(config: HttpOcrProviderConfig): AttachmentTextProvider {
  return createHttpAttachmentTextProvider({
    ...config,
    processor: 'ocr',
    endpoint: config.endpoint || '/v1/ocr'
  });
}

export function configuredOcrProvider(
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetch?: typeof fetch } = {}
): AttachmentTextProvider | null {
  const registry = createIntelligenceProviderRegistry(env);
  const profile = registry.defaultProfile('ocr');
  if (!profile) return null;
  return createHttpOcrProvider({
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
