import {
  createHttpAttachmentTextProvider,
  type AttachmentTextProvider,
  type HttpAttachmentTextProviderConfig
} from './attachment-text-provider.js';

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
  const baseUrl = String(env.OPC_OCR_BASE_URL || '').trim();
  if (!baseUrl) return null;
  return createHttpOcrProvider({
    mode: providerMode(env.OPC_OCR_PROVIDER_MODE, 'OCR'),
    baseUrl,
    endpoint: env.OPC_OCR_ENDPOINT || '/v1/ocr',
    token: env.OPC_OCR_TOKEN,
    timeoutMs: optionalTimeout(env.OPC_OCR_TIMEOUT_MS),
    name: env.OPC_OCR_PROVIDER_NAME || undefined,
    fetch: deps.fetch
  });
}

function providerMode(value: string | undefined, label: string): 'self_hosted' | 'third_party' {
  const mode = String(value || 'self_hosted').trim();
  if (mode === 'self_hosted' || mode === 'third_party') return mode;
  throw new Error(`OPC_${label}_PROVIDER_MODE must be self_hosted or third_party`);
}

function optionalTimeout(value: string | undefined): number | undefined {
  return value == null || !String(value).trim() ? undefined : Number(value);
}
