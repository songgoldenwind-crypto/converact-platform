import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api/client';

interface DidRow {
  id: string;
  number: string;
  label: string | null;
  route_type: string;
  route_target: string | null;
  is_active: boolean;
}

export default function DidNumbersPage() {
  const [dids, setDids] = useState<DidRow[]>([]);
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function loadDids() {
    setLoading(true);
    try {
      const data = await apiGet<DidRow[]>('/api/call-center/did-numbers');
      setDids(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDids();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!number.trim()) return;
    try {
      await apiPost('/api/call-center/did-numbers', {
        number: number.trim(),
        label: label.trim() || undefined,
        route_type: 'queue',
        route_target: 'default'
      });
      setNumber('');
      setLabel('');
      await loadDids();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-900">DID 号码</h2>
        <p className="text-sm text-slate-500 mt-1">呼入号码与路由目标（队列 / AI / 语音信箱）</p>
      </div>

      {error && <div className="rounded-lg bg-red-50 text-red-700 px-4 py-3 text-sm">{error}</div>}

      <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-white p-4 rounded-xl border border-slate-200">
        <input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="+86138..."
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="标签（可选）"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-medium hover:bg-blue-700">
          添加号码
        </button>
      </form>

      {loading ? (
        <p className="text-slate-500 text-sm">加载中…</p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-4 py-3">号码</th>
                <th className="text-left px-4 py-3">标签</th>
                <th className="text-left px-4 py-3">路由</th>
                <th className="text-left px-4 py-3">目标</th>
              </tr>
            </thead>
            <tbody>
              {dids.map((did) => (
                <tr key={did.id} className="border-t border-slate-100">
                  <td className="px-4 py-3 font-mono">{did.number}</td>
                  <td className="px-4 py-3">{did.label || '—'}</td>
                  <td className="px-4 py-3">{did.route_type}</td>
                  <td className="px-4 py-3 text-slate-600">{did.route_target || 'default'}</td>
                </tr>
              ))}
              {!dids.length && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                    暂无 DID，注册租户时会自动创建默认号码
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
