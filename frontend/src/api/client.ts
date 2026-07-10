const API_BASE = '';

export interface AuthSession {
  token: string;
  user: { id: string; email: string; role: string; name: string | null };
  tenant: { id: string; name: string; plan: string };
  onboarding?: { default_spec_id: string; seat_id: string } | null;
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('opc_token');
  if (token) return { Authorization: `Bearer ${token}` };
  const apiKey = localStorage.getItem('opc_api_key');
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
  localStorage.setItem('opc_token', session.token);
  localStorage.setItem('opc_user_id', session.user.id);
  localStorage.setItem('opc_tenant_id', session.tenant.id);
  localStorage.setItem('opc_tenant_name', session.tenant.name);
  localStorage.setItem('opc_user_email', session.user.email);
  if (session.onboarding?.default_spec_id) {
    localStorage.setItem('opc_default_spec_id', session.onboarding.default_spec_id);
  }
  if (session.onboarding?.seat_id) {
    localStorage.setItem('opc_seat_id', session.onboarding.seat_id);
  }
  window.dispatchEvent(new Event('auth-change'));
}

export function clearAuthSession(): void {
  localStorage.removeItem('opc_token');
  localStorage.removeItem('opc_user_id');
  localStorage.removeItem('opc_tenant_id');
  localStorage.removeItem('opc_tenant_name');
  localStorage.removeItem('opc_user_email');
  localStorage.removeItem('opc_default_spec_id');
  window.dispatchEvent(new Event('auth-change'));
}

export function getTenantId(): string {
  return localStorage.getItem('opc_tenant_id') || 'default';
}

export function getUserId(): string {
  return localStorage.getItem('opc_user_id') || '';
}

export function getWsUrl(): string {
  const token = localStorage.getItem('opc_token');
  if (!token) return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return `${protocol}//${host}/ws?token=${encodeURIComponent(token)}`;
}
