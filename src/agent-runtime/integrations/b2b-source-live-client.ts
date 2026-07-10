export interface B2BSourceLiveClientOptions {
  baseUrl?: string | null;
  timeoutMs?: number;
}

export class B2BSourceLiveClient {
  baseUrl: string | null;
  timeoutMs: number;

  constructor(options: B2BSourceLiveClientOptions = {}) {
    this.baseUrl = options.baseUrl || process.env.OPC_B2B_SOURCE_ADAPTER_URL || process.env.OPC_PROVIDER_GATEWAY_URL || null;
    this.timeoutMs = Number(options.timeoutMs || process.env.OPC_B2B_SOURCE_ADAPTER_TIMEOUT_MS || 4000);
  }

  isConfigured(runtimeConfig: Record<string, unknown> = {}): boolean {
    return Boolean(resolveBaseUrl(runtimeConfig, this.baseUrl));
  }

  async normalizeCsv(
    input: Record<string, unknown>,
    options: { runtimeConfig?: Record<string, unknown> } = {}
  ): Promise<Record<string, unknown>> {
    return this.post('/b2b/normalize', input, options.runtimeConfig);
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    runtimeConfig: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const baseUrl = resolveBaseUrl(runtimeConfig, this.baseUrl);
    if (!baseUrl) throw new Error('b2b source adapter url is not configured');
    const response = await fetch(joinUrl(baseUrl, path), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(resolveTimeout(runtimeConfig, this.timeoutMs))
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(String(payload?.error || payload?.message || `b2b source adapter failed with ${response.status}`));
    }
    return payload;
  }
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const rawText = await response.text();
  if (!rawText) return {};
  try {
    return asRecord(JSON.parse(rawText));
  } catch {
    return { message: rawText };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function resolveBaseUrl(runtimeConfig: Record<string, unknown>, defaultUrl: string | null): string | null {
  const explicit = runtimeConfig.base_url || runtimeConfig.adapter_url || runtimeConfig.gateway_url || defaultUrl;
  return typeof explicit === 'string' && explicit ? explicit : null;
}

function resolveTimeout(runtimeConfig: Record<string, unknown>, fallbackMs: number): number {
  return Number(runtimeConfig.request_timeout_ms || runtimeConfig.adapter_timeout_ms || fallbackMs || 4000);
}

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, String(baseUrl).endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}
