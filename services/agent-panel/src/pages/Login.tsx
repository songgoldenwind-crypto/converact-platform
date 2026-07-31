import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../lib/api';
import { useAgentStore } from '../store/agent-store';

export default function LoginPage() {
  const navigate = useNavigate();
  const setTenantId = useAgentStore((s) => s.setTenantId);
  const setSeatId = useAgentStore((s) => s.setSeatId);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const session = await login(email, password);
      setTenantId(session.tenant.id);
      if (session.onboarding?.seat_id) setSeatId(session.onboarding.seat_id);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={(e) => void onSubmit(e)} className="w-full max-w-sm bg-slate-800 border border-slate-700 rounded-xl p-6 space-y-4">
        <h1 className="text-xl font-semibold text-white">OPC 坐席面板</h1>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <input
          className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white"
          placeholder="邮箱"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded py-2 text-sm">
          登录
        </button>
      </form>
    </div>
  );
}
