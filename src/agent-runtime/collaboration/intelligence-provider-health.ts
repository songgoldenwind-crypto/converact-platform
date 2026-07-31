import type {
  IntelligenceProviderCapability,
  IntelligenceProviderMode,
  IntelligenceProviderRegistry
} from './intelligence-provider-registry.js';

export type IntelligenceProviderHealthStatus = 'healthy' | 'degraded' | 'unavailable';
export type IntelligenceProviderHttpClass = '2xx' | '3xx' | '4xx' | '5xx' | 'timeout' | 'network' | 'not_run';

export interface IntelligenceProviderHealthResult {
  profile_id: string;
  capability: IntelligenceProviderCapability;
  mode: IntelligenceProviderMode;
  configured: boolean;
  status: IntelligenceProviderHealthStatus;
  http_class: IntelligenceProviderHttpClass;
  latency_ms: number;
  checked_at: string;
}

export interface IntelligenceProviderHealthServiceOptions {
  fetch?: typeof fetch;
  timeout_ms?: number;
  clock?: () => number;
}

export class IntelligenceProviderHealthService {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly clock: () => number;

  constructor(
    private readonly registry: IntelligenceProviderRegistry,
    options: IntelligenceProviderHealthServiceOptions = {}
  ) {
    this.fetchImpl = options.fetch || fetch;
    this.timeoutMs = boundedInteger(options.timeout_ms ?? 10_000, 10, 30_000, 'health timeout_ms');
    this.clock = options.clock || Date.now;
  }

  async probe(input: { profile_ids?: string[] } = {}): Promise<IntelligenceProviderHealthResult[]> {
    const profiles = this.selectedProfiles(input.profile_ids);
    const results: IntelligenceProviderHealthResult[] = [];
    for (const profile of profiles) {
      const checkedAtMs = this.clock();
      const checkedAt = new Date(checkedAtMs).toISOString();
      const token = this.registry.resolveToken(profile);
      if (profile.token_env && !token) {
        results.push({
          profile_id: profile.id,
          capability: profile.capability,
          mode: profile.mode,
          configured: false,
          status: 'unavailable',
          http_class: 'not_run',
          latency_ms: 0,
          checked_at: checkedAt
        });
        continue;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, profile.timeout_ms));
      const startedAt = this.clock();
      try {
        const response = await this.fetchImpl(healthUrl(profile.base_url, profile.health_endpoint), {
          method: 'GET',
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
          redirect: 'manual',
          signal: controller.signal
        });
        void response.body?.cancel().catch(() => undefined);
        const httpClass = statusClass(response.status);
        results.push({
          profile_id: profile.id,
          capability: profile.capability,
          mode: profile.mode,
          configured: true,
          status: healthStatus(response.status),
          http_class: httpClass,
          latency_ms: boundedLatency(this.clock() - startedAt),
          checked_at: checkedAt
        });
      } catch {
        results.push({
          profile_id: profile.id,
          capability: profile.capability,
          mode: profile.mode,
          configured: true,
          status: 'unavailable',
          http_class: controller.signal.aborted ? 'timeout' : 'network',
          latency_ms: boundedLatency(this.clock() - startedAt),
          checked_at: checkedAt
        });
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  }

  private selectedProfiles(ids: string[] | undefined) {
    if (ids === undefined) return this.registry.list();
    if (!Array.isArray(ids) || ids.length > 20) {
      throw Object.assign(new Error('profile_ids must contain at most 20 items'), { status: 400 });
    }
    const unique = [...new Set(ids.map((id) => String(id || '').trim()))];
    if (unique.some((id) => !id)) {
      throw Object.assign(new Error('profile_ids contains an invalid profile id'), { status: 400 });
    }
    return unique.map((id) => {
      const profile = this.registry.profile(id);
      if (!profile) throw Object.assign(new Error(`provider profile not found: ${id}`), { status: 404 });
      return profile;
    });
  }
}

function healthUrl(baseUrl: string, endpoint: string): string {
  return new URL(endpoint.replace(/^\//, ''), `${baseUrl.replace(/\/$/, '')}/`).toString();
}

function statusClass(status: number): IntelligenceProviderHttpClass {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  return '5xx';
}

function healthStatus(status: number): IntelligenceProviderHealthStatus {
  if (status >= 200 && status < 300) return 'healthy';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'degraded';
  return 'unavailable';
}

function boundedLatency(value: number): number {
  return Math.max(0, Math.min(600_000, Math.round(Number.isFinite(value) ? value : 0)));
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}
