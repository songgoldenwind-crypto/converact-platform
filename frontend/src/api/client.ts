import {
  readAuthStorage,
  removeAuthStorage,
  writeAuthStorage
} from '../auth-storage';

const API_BASE = '';

export interface AuthSession {
  token: string;
  user: { id: string; email: string; role: string; name: string | null };
  tenant: { id: string; name: string; plan: string };
  onboarding?: { default_spec_id: string; seat_id: string } | null;
}

function getAuthHeaders(): Record<string, string> {
  const token = readAuthStorage('token');
  if (token) return { Authorization: `Bearer ${token}` };
  const apiKey = readAuthStorage('api_key');
  if (apiKey) return { 'X-API-Key': apiKey };
  return {};
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message =
      json?.error?.message || json?.error || `API error: ${res.status}`;
    throw new Error(String(message));
  }
  if (json && typeof json === 'object' && 'data' in json) {
    return json.data as T;
  }
  return json as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: getAuthHeaders() });
  return parseJson<T>(res);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(body)
  });
  return parseJson<T>(res);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(body)
  });
  return parseJson<T>(res);
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: getAuthHeaders()
  });
  return parseJson<T>(res);
}

export function saveAuthSession(session: AuthSession): void {
  writeAuthStorage('token', session.token);
  writeAuthStorage('user_id', session.user.id);
  writeAuthStorage('tenant_id', session.tenant.id);
  writeAuthStorage('tenant_name', session.tenant.name);
  writeAuthStorage('user_email', session.user.email);
  if (session.onboarding?.default_spec_id) {
    writeAuthStorage('default_spec_id', session.onboarding.default_spec_id);
  }
  if (session.onboarding?.seat_id) {
    writeAuthStorage('seat_id', session.onboarding.seat_id);
  }
  window.dispatchEvent(new Event('auth-change'));
}

export function clearAuthSession(): void {
  removeAuthStorage('token');
  removeAuthStorage('user_id');
  removeAuthStorage('tenant_id');
  removeAuthStorage('tenant_name');
  removeAuthStorage('user_email');
  removeAuthStorage('default_spec_id');
  removeAuthStorage('seat_id');
  window.dispatchEvent(new Event('auth-change'));
}

export function getTenantId(): string {
  return readAuthStorage('tenant_id') || 'default';
}

export function getUserId(): string {
  return readAuthStorage('user_id') || '';
}

export function getWsUrl(): string {
  const token = readAuthStorage('token');
  if (!token) return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return `${protocol}//${host}/ws?token=${encodeURIComponent(token)}`;
}
