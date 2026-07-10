export interface VoiceMediaClientOptions {
  baseUrl?: string | null;
  timeoutMs?: number;
}

export class VoiceMediaClient {
  baseUrl: string | null;
  timeoutMs: number;

  constructor(options: VoiceMediaClientOptions = {}) {
    this.baseUrl = options.baseUrl || process.env.OPC_VOICE_MEDIA_URL || null;
    this.timeoutMs = Number(options.timeoutMs || process.env.OPC_VOICE_MEDIA_TIMEOUT_MS || 2000);
  }

  isConfigured(runtimeConfig: Record<string, unknown> = {}): boolean {
    return Boolean(resolveMediaUrl(runtimeConfig, this.baseUrl));
  }

  async issueWebrtcSession(input: {
    runtimeConfig?: Record<string, unknown>;
    tenant_id: string;
    call_session_id?: string | null;
    endpoint_id?: string;
    token?: string;
    ttl_seconds?: number;
    status?: string;
    expires_at?: string;
    ice_servers?: unknown[];
  }): Promise<Record<string, unknown>> {
    return this.postJson('/webrtc/session/create', input, input.runtimeConfig || {});
  }

  async archiveRecording(input: {
    runtimeConfig?: Record<string, unknown>;
    tenant_id: string;
    recording_id: string;
    provider_recording_id?: string;
    recording_url?: string;
    archive_url?: string;
    archive_url_base?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    return this.postJson('/recordings/archive', input, input.runtimeConfig || {});
  }

  async purgeRecording(input: {
    runtimeConfig?: Record<string, unknown>;
    tenant_id: string;
    recording_id: string;
    provider_recording_id?: string;
    recording_url?: string;
    archived_recording_url?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    return this.postJson('/recordings/purge', input, input.runtimeConfig || {});
  }

  private async postJson(path: string, input: Record<string, unknown>, runtimeConfig: Record<string, unknown>): Promise<Record<string, unknown>> {
    const mediaUrl = resolveMediaUrl(runtimeConfig, this.baseUrl);
    if (!mediaUrl) throw new Error('voice media url is not configured');
    const response = await fetch(joinUrl(mediaUrl, path), {
      method: 'POST',
      headers: resolveHeaders(runtimeConfig),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(resolveTimeout(runtimeConfig, this.timeoutMs))
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(String(payload?.error || payload?.message || `voice media service failed with ${response.status}`));
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

function resolveMediaUrl(runtimeConfig: Record<string, unknown>, defaultUrl: string | null): string | null {
  const explicit = runtimeConfig.media_service_url || runtimeConfig.media_url || defaultUrl;
  return typeof explicit === 'string' && explicit ? explicit : null;
}

function resolveTimeout(runtimeConfig: Record<string, unknown>, fallbackMs: number): number {
  return Number(runtimeConfig.request_timeout_ms || runtimeConfig.media_timeout_ms || fallbackMs || 2000);
}

function resolveHeaders(runtimeConfig: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json'
  };
  const token = runtimeConfig.media_api_token || runtimeConfig.auth_token || runtimeConfig.api_token;
  if (typeof token === 'string' && token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, String(baseUrl).endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}
