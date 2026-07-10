import {
  createHttpAttachmentTextProvider,
  type AttachmentTextProvider,
  type HttpAttachmentTextProviderConfig
} from './attachment-text-provider.js';

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
  const baseUrl = String(env.OPC_ASR_BASE_URL || '').trim();
  if (!baseUrl) return null;
  return createHttpAsrProvider({
    mode: providerMode(env.OPC_ASR_PROVIDER_MODE),
    baseUrl,
    endpoint: env.OPC_ASR_ENDPOINT || '/v1/asr',
    token: env.OPC_ASR_TOKEN,
    timeoutMs: optionalTimeout(env.OPC_ASR_TIMEOUT_MS),
    name: env.OPC_ASR_PROVIDER_NAME || undefined,
    fetch: deps.fetch
  });
}

function providerMode(value: string | undefined): 'self_hosted' | 'third_party' {
  const mode = String(value || 'self_hosted').trim();
  if (mode === 'self_hosted' || mode === 'third_party') return mode;
  throw new Error('OPC_ASR_PROVIDER_MODE must be self_hosted or third_party');
}

function optionalTimeout(value: string | undefined): number | undefined {
  return value == null || !String(value).trim() ? undefined : Number(value);
}
