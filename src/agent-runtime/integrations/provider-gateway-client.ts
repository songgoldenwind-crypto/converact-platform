export interface GatewayProxyRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeout_ms?: number;
}

export interface ProviderGatewayOptions {
  gatewayUrl?: string | null;
  timeoutMs?: number;
}

export class ProviderGatewayClient {
  gatewayUrl: string | null;
  timeoutMs: number;

  constructor(options: ProviderGatewayOptions = {}) {
    this.gatewayUrl = options.gatewayUrl || process.env.OPC_PROVIDER_GATEWAY_URL || null;
    this.timeoutMs = Number(options.timeoutMs || process.env.OPC_PROVIDER_GATEWAY_CLIENT_TIMEOUT_MS || 2000);
  }

  isConfigured(runtimeConfig: Record<string, unknown> = {}): boolean {
    return Boolean(resolveGatewayUrl(runtimeConfig, this.gatewayUrl));
  }

  async health(input: {
    integrationId: string;
    request: GatewayProxyRequest;
    runtimeConfig?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const gatewayUrl = resolveGatewayUrl(input.runtimeConfig || {}, this.gatewayUrl);
    if (!gatewayUrl) throw new Error('provider gateway url is not configured');
    return postJson(joinUrl(gatewayUrl, '/health-check'), {
      integration_id: input.integrationId,
      request: input.request
    }, resolveTimeout(input.runtimeConfig || {}, this.timeoutMs));
  }

  async execute(input: {
    integrationId: string;
    operation: string;
    request: GatewayProxyRequest;
    runtimeConfig?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const gatewayUrl = resolveGatewayUrl(input.runtimeConfig || {}, this.gatewayUrl);
    if (!gatewayUrl) throw new Error('provider gateway url is not configured');
    return postJson(joinUrl(gatewayUrl, '/execute'), {
      integration_id: input.integrationId,
      operation: input.operation,
      request: input.request
    }, resolveTimeout(input.runtimeConfig || {}, this.timeoutMs));
  }
}

function resolveGatewayUrl(runtimeConfig: Record<string, unknown>, defaultUrl: string | null): string | null {
  const explicit = runtimeConfig.provider_gateway_url || runtimeConfig.gateway_url || defaultUrl;
  return typeof explicit === 'string' && explicit ? explicit : null;
}

async function postJson(url: string, body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(String(payload?.error || payload?.message || `provider gateway request failed with ${response.status}`));
  }
  return payload;
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

function resolveTimeout(runtimeConfig: Record<string, unknown>, fallbackMs: number): number {
  return Number(runtimeConfig.provider_gateway_client_timeout_ms || runtimeConfig.gateway_timeout_ms || fallbackMs || 2000);
}

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, String(baseUrl).endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}
