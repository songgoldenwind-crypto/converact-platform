import type { AIWorkerClient } from '../ai/ai-worker-client.js';
import type { ProviderGatewayClient } from '../integrations/provider-gateway-client.js';
import type { VoiceMediaClient } from '../voice/voice-media-client.js';

export interface SidecarHealthInput {
  tenant_id?: string;
  workspace_id?: string;
  timeout_ms?: number;
}

export interface SidecarHealthItem {
  sidecar_id: string;
  language: 'go' | 'python' | 'rust';
  responsibility: string;
  configured: boolean;
  status: 'healthy' | 'degraded' | 'not_configured';
  url: string | null;
  source: string;
  http_status?: number;
  body?: Record<string, unknown>;
  error?: string;
}

export class SidecarHealthChecker {
  integrationConfigStore: unknown;
  providerGatewayClient: ProviderGatewayClient;
  aiWorkerClient: AIWorkerClient;
  voiceMediaClient: VoiceMediaClient;

  constructor({
    integrationConfigStore,
    providerGatewayClient,
    aiWorkerClient,
    voiceMediaClient
  }: {
    integrationConfigStore?: unknown;
    providerGatewayClient: ProviderGatewayClient;
    aiWorkerClient: AIWorkerClient;
    voiceMediaClient: VoiceMediaClient;
  }) {
    this.integrationConfigStore = integrationConfigStore || null;
    this.providerGatewayClient = providerGatewayClient;
    this.aiWorkerClient = aiWorkerClient;
    this.voiceMediaClient = voiceMediaClient;
  }

  async check(input: SidecarHealthInput = {}): Promise<{
    status: 'healthy' | 'degraded';
    tenant_id: string;
    workspace_id: string;
    sidecars: SidecarHealthItem[];
  }> {
    const tenantId = input.tenant_id || '';
    const workspaceId = input.workspace_id || 'default';
    const timeoutMs = Number(input.timeout_ms || 800);
    const sidecars = await Promise.all([
      this.checkHttpSidecar({
        sidecar_id: 'provider-gateway-go',
        language: 'go',
        responsibility: 'provider proxy / high-throughput external adapter execution',
        url: normalizeUrl(this.providerGatewayClient.gatewayUrl || process.env.OPC_PROVIDER_GATEWAY_URL || null),
        source: this.providerGatewayClient.gatewayUrl || process.env.OPC_PROVIDER_GATEWAY_URL ? 'runtime_env' : 'none',
        timeoutMs
      }),
      this.checkHttpSidecar({
        sidecar_id: 'ai-worker-py',
        language: 'python',
        responsibility: 'AI post-processing / pain signals / outreach personalization',
        ...this.resolveConfiguredUrl({
          tenantId,
          workspaceId,
          integrationId: 'opc-ai-worker',
          urlKeys: ['base_url', 'worker_url'],
          fallbackUrl: this.aiWorkerClient.baseUrl || process.env.OPC_AI_WORKER_URL || null,
          fallbackSource: 'runtime_env'
        }),
        timeoutMs
      }),
      this.checkHttpSidecar({
        sidecar_id: 'voice-media-rs',
        language: 'rust',
        responsibility: 'WebRTC / media boundary / voice session token issuance',
        ...this.resolveConfiguredUrl({
          tenantId,
          workspaceId,
          integrationId: 'opc-native-webrtc',
          urlKeys: ['media_service_url', 'media_url'],
          fallbackUrl: this.voiceMediaClient.baseUrl || process.env.OPC_VOICE_MEDIA_URL || null,
          fallbackSource: 'runtime_env'
        }),
        timeoutMs
      })
    ]);
    return {
      status: sidecars.some((sidecar) => sidecar.status === 'degraded') ? 'degraded' : 'healthy',
      tenant_id: tenantId,
      workspace_id: workspaceId,
      sidecars
    };
  }

  private resolveConfiguredUrl({
    tenantId,
    workspaceId,
    integrationId,
    urlKeys,
    fallbackUrl,
    fallbackSource
  }: {
    tenantId: string;
    workspaceId: string;
    integrationId: string;
    urlKeys: string[];
    fallbackUrl: string | null;
    fallbackSource: string;
  }): { url: string | null; source: string } {
    if (tenantId && isIntegrationConfigStore(this.integrationConfigStore)) {
      const config = this.integrationConfigStore.getConfig(tenantId, workspaceId, integrationId);
      if (config && config.status !== 'disabled') {
        const runtime = this.integrationConfigStore.resolveRuntimeConfig({
          tenant_id: tenantId,
          workspace_id: workspaceId,
          integration_id: integrationId
        });
        for (const key of urlKeys) {
          const value = runtime.runtime_config?.[key];
          if (typeof value === 'string' && value) return { url: normalizeUrl(value), source: 'tenant_config' };
        }
      }
    }
    return { url: normalizeUrl(fallbackUrl), source: fallbackUrl ? fallbackSource : 'none' };
  }

  private async checkHttpSidecar(input: {
    sidecar_id: string;
    language: SidecarHealthItem['language'];
    responsibility: string;
    url: string | null;
    source: string;
    timeoutMs: number;
  }): Promise<SidecarHealthItem> {
    if (!input.url) {
      return {
        sidecar_id: input.sidecar_id,
        language: input.language,
        responsibility: input.responsibility,
        configured: false,
        status: 'not_configured',
        url: null,
        source: input.source
      };
    }

    try {
      const response = await fetch(joinUrl(input.url, '/health'), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(input.timeoutMs)
      });
      const body = await parseJsonResponse(response);
      return {
        sidecar_id: input.sidecar_id,
        language: input.language,
        responsibility: input.responsibility,
        configured: true,
        status: response.ok ? 'healthy' : 'degraded',
        url: input.url,
        source: input.source,
        http_status: response.status,
        body
      };
    } catch (error) {
      return {
        sidecar_id: input.sidecar_id,
        language: input.language,
        responsibility: input.responsibility,
        configured: true,
        status: 'degraded',
        url: input.url,
        source: input.source,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

function isIntegrationConfigStore(value: unknown): value is {
  getConfig: (tenantId: string, workspaceId: string, integrationId: string) => { status?: string } | null;
  resolveRuntimeConfig: (input: {
    tenant_id: string;
    workspace_id: string;
    integration_id: string;
  }) => { runtime_config?: Record<string, unknown> };
} {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as { getConfig?: unknown }).getConfig === 'function'
    && typeof (value as { resolveRuntimeConfig?: unknown }).resolveRuntimeConfig === 'function';
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { message: text };
  }
}

function normalizeUrl(url: string | null): string | null {
  if (!url) return null;
  return String(url).replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, String(baseUrl).endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}
