const API_BASE = '';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('opc_token');
  if (token) return { Authorization: `Bearer ${token}` };
  const apiKey = localStorage.getItem('opc_api_key');
  const headers: Record<string, string> = {};
  if (apiKey) headers['X-API-Key'] = apiKey;
  const tenantId = localStorage.getItem('opc_tenant_id');
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
  localStorage.setItem('opc_token', session.token);
  localStorage.setItem('opc_tenant_id', session.tenant.id);
  localStorage.setItem('opc_user_id', session.user.id);
  if (session.onboarding?.seat_id) localStorage.setItem('opc_seat_id', session.onboarding.seat_id);
  return session;
}
