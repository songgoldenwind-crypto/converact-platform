import { resolveBrandEnv } from '../../config/converact-env.js';
export interface AIWorkerClientOptions {
  baseUrl?: string | null;
  timeoutMs?: number;
}

export class AIWorkerClient {
  baseUrl: string | null;
  timeoutMs: number;

  constructor(options: AIWorkerClientOptions = {}) {
    this.baseUrl = options.baseUrl || resolveBrandEnv(process.env, 'AI_WORKER_URL') || null;
    this.timeoutMs = Number(options.timeoutMs || resolveBrandEnv(process.env, 'AI_WORKER_TIMEOUT_MS') || 4000);
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  async extractPainSignals(
    input: Record<string, unknown>,
    options: { runtimeConfig?: Record<string, unknown> } = {}
  ): Promise<Record<string, unknown>> {
    return this.post('/geo/pain-signals/extract', input, options.runtimeConfig);
  }

  async personalizeOutreach(
    input: Record<string, unknown>,
    options: { runtimeConfig?: Record<string, unknown> } = {}
  ): Promise<Record<string, unknown>> {
    return this.post('/geo/outreach/personalize', input, options.runtimeConfig);
  }

  async analyzePublicSourceSignals(
    input: Record<string, unknown>,
    options: { runtimeConfig?: Record<string, unknown> } = {}
  ): Promise<Record<string, unknown>> {
    return this.post('/signals/public-source/analyze', input, options.runtimeConfig);
  }

  async extractCrawlMarkdown(
    input: Record<string, unknown>,
    options: { runtimeConfig?: Record<string, unknown> } = {}
  ): Promise<Record<string, unknown>> {
    return this.post('/page/crawl-markdown', input, options.runtimeConfig);
  }

  async extractPageEvidence(
    input: Record<string, unknown>,
    options: { runtimeConfig?: Record<string, unknown> } = {}
  ): Promise<Record<string, unknown>> {
    return this.post('/page/evidence-extract', input, options.runtimeConfig);
  }

  async extractVisualPageFallback(
    input: Record<string, unknown>,
    options: { runtimeConfig?: Record<string, unknown> } = {}
  ): Promise<Record<string, unknown>> {
    return this.post('/page/visual-fallback', input, options.runtimeConfig);
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    runtimeConfig: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const baseUrl = resolveBaseUrl(runtimeConfig, this.baseUrl);
    if (!baseUrl) throw new Error('ai worker url is not configured');
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
      throw new Error(String(payload?.error || payload?.message || `ai worker failed with ${response.status}`));
    }
    return payload;
  }
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return { message: text };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function resolveBaseUrl(runtimeConfig: Record<string, unknown>, defaultUrl: string | null): string | null {
  const explicit = runtimeConfig.base_url || runtimeConfig.worker_url || defaultUrl;
  return typeof explicit === 'string' && explicit ? explicit : null;
}

function resolveTimeout(runtimeConfig: Record<string, unknown>, fallbackMs: number): number {
  return Number(runtimeConfig.request_timeout_ms || runtimeConfig.worker_timeout_ms || fallbackMs || 4000);
}

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, String(baseUrl).endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}
