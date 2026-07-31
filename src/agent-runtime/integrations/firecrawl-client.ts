export interface FirecrawlClientOptions {
  baseUrl?: string | null;
  timeoutMs?: number;
  apiKey?: string | null;
}

export class FirecrawlClient {
  baseUrl: string | null;
  timeoutMs: number;
  apiKey: string | null;

  constructor(options: FirecrawlClientOptions = {}) {
    this.baseUrl = options.baseUrl || process.env.OPC_FIRECRAWL_URL || process.env.OPC_PROVIDER_GATEWAY_URL || null;
    this.timeoutMs = Number(options.timeoutMs || process.env.OPC_FIRECRAWL_TIMEOUT_MS || 10000);
    this.apiKey = options.apiKey || process.env.OPC_FIRECRAWL_API_KEY || null;
  }

  isConfigured(runtimeConfig: Record<string, unknown> = {}): boolean {
    return Boolean(resolveBaseUrl(runtimeConfig, this.baseUrl));
  }

  async scrapePage(
    input: Record<string, unknown>,
    options: { runtimeConfig?: Record<string, unknown> } = {}
  ): Promise<Record<string, unknown>> {
    return this.post('/scrape', input, options.runtimeConfig);
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    runtimeConfig: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const baseUrl = resolveBaseUrl(runtimeConfig, this.baseUrl);
    if (!baseUrl) throw new Error('firecrawl provider url is not configured');
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json'
    };
    const apiKey = resolveApiKey(runtimeConfig, this.apiKey);
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetch(joinUrl(baseUrl, path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(resolveTimeout(runtimeConfig, this.timeoutMs))
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(String(payload?.error || payload?.message || `firecrawl provider failed with ${response.status}`));
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
  const explicit = runtimeConfig.base_url || runtimeConfig.provider_url || runtimeConfig.gateway_url || runtimeConfig.worker_url || defaultUrl;
  return typeof explicit === 'string' && explicit ? explicit : null;
}

function resolveApiKey(runtimeConfig: Record<string, unknown>, defaultApiKey: string | null): string | null {
  const explicit = runtimeConfig.api_key || runtimeConfig.apiKey || defaultApiKey;
  if (typeof explicit !== 'string' || !explicit || explicit === '[REDACTED_CONFIG_SECRET]') return null;
  return explicit;
}

function resolveTimeout(runtimeConfig: Record<string, unknown>, fallbackMs: number): number {
  return Number(runtimeConfig.request_timeout_ms || runtimeConfig.provider_timeout_ms || fallbackMs || 10000);
}

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, String(baseUrl).endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}
