export interface RenderedPageReadClientOptions {
  baseUrl?: string | null;
  timeoutMs?: number;
}

export class RenderedPageReadClient {
  baseUrl: string | null;
  timeoutMs: number;

  constructor(options: RenderedPageReadClientOptions = {}) {
    this.baseUrl = options.baseUrl || process.env.OPC_RENDERED_PAGE_READ_URL || process.env.OPC_PROVIDER_GATEWAY_URL || null;
    this.timeoutMs = Number(options.timeoutMs || process.env.OPC_RENDERED_PAGE_READ_TIMEOUT_MS || 7000);
  }

  isConfigured(runtimeConfig: Record<string, unknown> = {}): boolean {
    return Boolean(resolveBaseUrl(runtimeConfig, this.baseUrl));
  }

  async readPage(
    input: Record<string, unknown>,
    options: { runtimeConfig?: Record<string, unknown> } = {}
  ): Promise<Record<string, unknown>> {
    return this.post('/page/rendered-read', input, options.runtimeConfig);
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    runtimeConfig: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const baseUrl = resolveBaseUrl(runtimeConfig, this.baseUrl);
    if (!baseUrl) throw new Error('rendered page read adapter url is not configured');
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
      throw new Error(String(payload?.error || payload?.message || `rendered page read adapter failed with ${response.status}`));
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
  const explicit = runtimeConfig.base_url || runtimeConfig.adapter_url || runtimeConfig.worker_url || runtimeConfig.gateway_url || defaultUrl;
  return typeof explicit === 'string' && explicit ? explicit : null;
}

function resolveTimeout(runtimeConfig: Record<string, unknown>, fallbackMs: number): number {
  return Number(runtimeConfig.request_timeout_ms || runtimeConfig.adapter_timeout_ms || fallbackMs || 7000);
}

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, String(baseUrl).endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}
