export interface IveKitRuntimeConfig {
  baseUrl: string;
  tenantId: string;
  websocketUrl?: string;
}

declare global {
  interface Window {
    iveKitHost?: { getAccessToken(): Promise<string> | string };
    __IVEKIT_DEV_ACCESS_TOKEN__?: string;
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

function required(value: unknown, name: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optional(value: unknown): string | undefined {
  return String(value || '').trim() || undefined;
}
