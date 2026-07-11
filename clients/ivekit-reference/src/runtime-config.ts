export interface IveKitRuntimeConfig {
  baseUrl: string;
  tenantId: string;
  websocketUrl?: string;
}

declare global {
  interface Window {
    iveKitHost?: {
      getAccessToken(): Promise<string> | string;
      getIdentity?(): Promise<string> | string;
    };
    __IVEKIT_DEV_ACCESS_TOKEN__?: string;
    __IVEKIT_DEV_IDENTITY__?: string;
  }
}

export async function loadRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<IveKitRuntimeConfig> {
  const response = await fetchImpl('/ivekit-config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`runtime config unavailable (${response.status})`);
  const value = await response.json() as Partial<IveKitRuntimeConfig>;
  const baseUrl = required(value.baseUrl, 'baseUrl');
  const tenantId = required(value.tenantId, 'tenantId');
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('baseUrl must use http(s)');
  return { baseUrl: parsed.toString(), tenantId, websocketUrl: optional(value.websocketUrl) };
}

export async function requestAccessToken(): Promise<string> {
  const token = window.iveKitHost
    ? await window.iveKitHost.getAccessToken()
    : window.__IVEKIT_DEV_ACCESS_TOKEN__;
  return required(token, 'short-lived access token');
}

export async function requestIdentity(accessToken: string): Promise<string> {
  const hostIdentity = window.iveKitHost?.getIdentity
    ? await window.iveKitHost.getIdentity()
    : window.__IVEKIT_DEV_IDENTITY__;
  if (hostIdentity) return required(hostIdentity, 'identity');
  const payload = jwtPayload(accessToken);
  return required(payload?.sub || payload?.userId || payload?.user_id, 'authenticated identity');
}

function required(value: unknown, name: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optional(value: unknown): string | undefined {
  return String(value || '').trim() || undefined;
}

function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return null;
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(normalized)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
