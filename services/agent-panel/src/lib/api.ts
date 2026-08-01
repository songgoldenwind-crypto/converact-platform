import { readAgentAuthStorage, writeAgentAuthStorage } from './auth-storage';

const API_BASE = '';

function authHeaders(): Record<string, string> {
  const token = readAgentAuthStorage('token');
  if (token) return { Authorization: `Bearer ${token}` };
  const apiKey = readAgentAuthStorage('api_key');
  const headers: Record<string, string> = {};
  if (apiKey) headers['X-API-Key'] = apiKey;
  const tenantId = readAgentAuthStorage('tenant_id');
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  return headers;
}

async function parseJson<T>(res: Response): Promise<T> {
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || json?.error || res.statusText);
  return (json.data ?? json) as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  return parseJson<T>(res);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body)
  });
  return parseJson<T>(res);
}

export interface AuthSession {
  token: string;
  tenant: { id: string; name: string };
  user: { id: string; email: string };
  onboarding?: { seat_id?: string } | null;
}

export async function login(email: string, password: string): Promise<AuthSession> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || '登录失败');
  const session = json.data as AuthSession;
  writeAgentAuthStorage('token', session.token);
  writeAgentAuthStorage('tenant_id', session.tenant.id);
  writeAgentAuthStorage('user_id', session.user.id);
  if (session.onboarding?.seat_id) writeAgentAuthStorage('seat_id', session.onboarding.seat_id);
  return session;
}
