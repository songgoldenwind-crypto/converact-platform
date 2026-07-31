import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost, type AuthSession } from '../api/client';
import { useAuth } from '../hooks/useAuth';

type Mode = 'login' | 'register';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [ssoTenantId, setSsoTenantId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { loginWithSession, loginWithApiKey } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const tenantId = params.get('tenant_id');
    if (!code || !state || !tenantId) return;
    setLoading(true);
    void apiPost<AuthSession>('/api/auth/sso/callback', { tenant_id: tenantId, code, state })
      .then((session) => {
        loginWithSession(session);
        navigate('/', { replace: true });
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'SSO 登录失败'))
      .finally(() => setLoading(false));
  }, [loginWithSession, navigate]);

  async function startSso() {
    if (!ssoTenantId.trim()) {
      setError('请输入租户 ID');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const result = await apiGet<{ authorization_url: string }>(
        `/api/auth/sso/authorize?tenant_id=${encodeURIComponent(ssoTenantId.trim())}`
      );
      window.location.href = result.authorization_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法启动 SSO');
      setLoading(false);
    }
  }

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const path = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body =
        mode === 'register'
          ? { email, password, name, tenantName }
          : { email, password };
      const session = await apiPost<AuthSession>(path, body);
      loginWithSession(session);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  function handleApiKey(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError('请输入 API Key');
      return;
    }
    loginWithApiKey(apiKey.trim());
    navigate('/', { replace: true });
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-gray-200 p-8">
        <h1 className="text-2xl font-bold text-gray-900 text-center">OPC 呼叫中心</h1>
        <p className="text-sm text-gray-500 text-center mt-1 mb-6">注册或登录以管理外呼任务</p>

        <div className="flex rounded-lg border border-gray-200 mb-6 overflow-hidden">
          <button
            type="button"
            onClick={() => setMode('login')}
            className={`flex-1 py-2 text-sm font-medium ${mode === 'login' ? 'bg-blue-50 text-blue-600' : 'text-gray-600'}`}
          >
            登录
          </button>
          <button
            type="button"
            onClick={() => setMode('register')}
            className={`flex-1 py-2 text-sm font-medium ${mode === 'register' ? 'bg-blue-50 text-blue-600' : 'text-gray-600'}`}
          >
            注册
          </button>
        </div>

        <form onSubmit={handleCredentials} className="space-y-4">
          {mode === 'register' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">公司名称</label>
                <input
                  value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">您的姓名</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
            </>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              required
            />
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-500 text-white py-2 rounded-md text-sm font-medium hover:bg-blue-600 disabled:opacity-60"
          >
            {loading ? '处理中…' : mode === 'register' ? '注册并进入' : '登录'}
          </button>
        </form>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-200" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-white px-2 text-gray-400">或</span>
          </div>
        </div>

        <form onSubmit={handleApiKey} className="space-y-3">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="开发者 API Key"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <button
            type="submit"
            className="w-full border border-gray-300 py-2 rounded-md text-sm text-gray-700 hover:bg-gray-50"
          >
            使用 API Key 登录
          </button>
        </form>

        <div className="mt-6 space-y-2">
          <input
            value={ssoTenantId}
            onChange={(e) => setSsoTenantId(e.target.value)}
            placeholder="企业 SSO 租户 ID"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <button
            type="button"
            disabled={loading}
            onClick={() => void startSso()}
            className="w-full border border-indigo-300 text-indigo-700 py-2 rounded-md text-sm hover:bg-indigo-50 disabled:opacity-60"
          >
            企业 SSO 登录
          </button>
        </div>
      </div>
    </div>
  );
}
