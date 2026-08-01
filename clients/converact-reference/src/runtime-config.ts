export interface ConveractFabricRuntimeConfig {
  baseUrl: string;
  tenantId: string;
  websocketUrl?: string;
}

declare global {
  interface Window {
    converactFabricHost?: {
      getAccessToken(): Promise<string> | string;
      getIdentity?(): Promise<string> | string;
      openExternal?(url: string): Promise<void> | void;
    };
    __CONVERACT_FABRIC_DEV_ACCESS_TOKEN__?: string;
    __CONVERACT_FABRIC_DEV_IDENTITY__?: string;
  }
}

export async function loadRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<ConveractFabricRuntimeConfig> {
  const response = await fetchImpl('/converact-config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`runtime config unavailable (${response.status})`);
  const value = await response.json() as Partial<ConveractFabricRuntimeConfig>;
  const baseUrl = required(value.baseUrl, 'baseUrl');
  const tenantId = required(value.tenantId, 'tenantId');
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('baseUrl must use http(s)');
  return { baseUrl: parsed.toString(), tenantId, websocketUrl: optional(value.websocketUrl) };
}

export async function requestAccessToken(): Promise<string> {
  const token = window.converactFabricHost
    ? await window.converactFabricHost.getAccessToken()
    : window.__CONVERACT_FABRIC_DEV_ACCESS_TOKEN__;
  return required(token, 'short-lived access token');
}

export async function requestIdentity(accessToken: string): Promise<string> {
  const hostIdentity = window.converactFabricHost?.getIdentity
    ? await window.converactFabricHost.getIdentity()
    : window.__CONVERACT_FABRIC_DEV_IDENTITY__;
  if (hostIdentity) return required(hostIdentity, 'identity');
  const payload = jwtPayload(accessToken);
  return required(payload?.sub || payload?.userId || payload?.user_id, 'authenticated identity');
}

export function accessTokenRefreshDelay(accessToken: string, now = Date.now()): number {
  const payload = jwtPayload(accessToken);
  const expiresAt = Number(payload?.exp || 0) * 1_000;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return 240_000;
  return Math.max(1_000, Math.min(240_000, expiresAt - now - 60_000));
}

export function startAccessTokenRefreshLoop<T = string>(input: {
  load: () => Promise<T>;
  onToken: (value: T) => void;
  onError?: (error: unknown) => void;
  refreshDelay?: (value: T) => number;
  retryDelayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timer: number) => void;
}): { stop(): void } {
  const setTimer = input.setTimer || ((callback, delay) => window.setTimeout(callback, delay));
  const clearTimer = input.clearTimer || ((timer) => window.clearTimeout(timer));
  const retryDelay = input.retryDelayMs ?? 5_000;
  let active = true;
  let timer: number | null = null;

  const schedule = (delay: number) => {
    if (!active) return;
    timer = setTimer(() => { void run(); }, delay);
  };
  const run = async () => {
    if (!active) return;
    try {
      const value = await input.load();
      if (!active) return;
      input.onToken(value);
      const delay = input.refreshDelay?.(value) ?? accessTokenRefreshDelay(String(value));
      schedule(delay);
    } catch (error) {
      if (!active) return;
      input.onError?.(error);
      schedule(retryDelay);
    }
  };
  void run();
  return {
    stop() {
      active = false;
      if (timer != null) clearTimer(timer);
      timer = null;
    }
  };
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
