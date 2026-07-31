import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api/client';

interface QueueRow {
  id: string;
  name: string;
  strategy: string;
  max_wait_sec: number;
  max_size: number;
  overflow_target: string | null;
  waiting_count?: number;
}

interface QueueStatus {
  waiting_count: number;
  available_agents: number;
  estimated_wait_sec: number;
  entries: Array<{ position: number; wait_sec: number }>;
}

export default function QueuesPage() {
  const [queues, setQueues] = useState<QueueRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function loadQueues() {
    setLoading(true);
    try {
      const data = await apiGet<QueueRow[]>('/api/call-center/queues');
      setQueues(data);
      if (!selectedId && data[0]) setSelectedId(data[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function loadStatus(queueId: string) {
    try {
      const data = await apiGet<QueueStatus>(`/api/call-center/queues/${queueId}/status`);
      setStatus(data);
    } catch {
      setStatus(null);
    }
  }

  useEffect(() => {
    void loadQueues();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void loadStatus(selectedId);
    const timer = setInterval(() => void loadStatus(selectedId), 5000);
    return () => clearInterval(timer);
  }, [selectedId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await apiPost('/api/call-center/queues', { name: name.trim(), strategy: 'longest_idle' });
      setName('');
      await loadQueues();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-900">呼入队列</h2>
        <p className="text-sm text-slate-500 mt-1">ACD 排队、等待时长与溢出策略</p>
      </div>

      {error && <div className="rounded-lg bg-red-50 text-red-700 px-4 py-3 text-sm">{error}</div>}

      <form onSubmit={handleCreate} className="flex gap-3 items-end bg-white p-4 rounded-xl border border-slate-200">
        <div className="flex-1">
          <label className="block text-sm font-medium text-slate-700 mb-1">新建队列</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如 sales / support"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <button type="submit" className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-medium hover:bg-blue-700">
          创建
        </button>
      </form>

      {loading ? (
        <p className="text-slate-500 text-sm">加载中…</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-4 py-3">名称</th>
                  <th className="text-left px-4 py-3">策略</th>
                  <th className="text-right px-4 py-3">容量</th>
                </tr>
              </thead>
              <tbody>
                {queues.map((q) => (
                  <tr
                    key={q.id}
                    onClick={() => setSelectedId(q.id)}
                    className={`border-t border-slate-100 cursor-pointer hover:bg-slate-50 ${
                      selectedId === q.id ? 'bg-blue-50' : ''
                    }`}
                  >
                    <td className="px-4 py-3 font-medium">{q.name}</td>
                    <td className="px-4 py-3 text-slate-600">{q.strategy}</td>
                    <td className="px-4 py-3 text-right">{q.max_size}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h3 className="font-semibold text-slate-900 mb-4">实时队列状态</h3>
            {status ? (
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-slate-500">排队人数</dt>
                  <dd className="text-2xl font-bold text-slate-900">{status.waiting_count}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">空闲坐席</dt>
                  <dd className="text-2xl font-bold text-emerald-600">{status.available_agents}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-slate-500">预估等待</dt>
                  <dd className="text-lg font-medium">{Math.ceil(status.estimated_wait_sec / 60)} 分钟</dd>
                </div>
                {status.entries.length > 0 && (
                  <div className="col-span-2">
                    <dt className="text-slate-500 mb-2">排队明细</dt>
                    <ul className="space-y-1">
                      {status.entries.map((entry, idx) => (
                        <li key={idx} className="flex justify-between text-slate-700">
                          <span>第 {entry.position} 位</span>
                          <span>已等 {entry.wait_sec}s</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </dl>
            ) : (
              <p className="text-slate-500 text-sm">选择队列查看状态</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
