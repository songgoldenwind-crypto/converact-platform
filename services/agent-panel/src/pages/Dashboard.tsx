import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { useHeartbeat } from '../hooks/useHeartbeat';
import { useAgentStore } from '../store/agent-store';

export default function DashboardPage() {
  const seatId = useAgentStore((s) => s.seatId);
  const status = useAgentStore((s) => s.status);
  const queue = useAgentStore((s) => s.queue);
  const setSeatId = useAgentStore((s) => s.setSeatId);
  const setStatus = useAgentStore((s) => s.setStatus);
  const setQueue = useAgentStore((s) => s.setQueue);

  useSSE(seatId);
  useHeartbeat(seatId);

  useEffect(() => {
    void apiGet<Array<{ id: string }>>(`/api/call-center/seats?tenant_id=${localStorage.getItem('opc_tenant_id')}`)
      .then((seats) => {
        if (!seatId && seats[0]) setSeatId(seats[0].id);
      })
      .catch(() => undefined);
    void apiGet<Array<Record<string, unknown>>>('/api/call-center/transfer-queue')
      .then((items) =>
        setQueue(
          items.map((item) => ({
            id: String(item.id),
            call_session_id: String(item.call_session_id),
            room_name: String(item.room_name || ''),
            customer_name: String(item.customer_name || ''),
            customer_phone: String(item.customer_phone || ''),
            customer_summary: String(item.customer_summary || ''),
            intent_score: Number(item.intent_score || 0),
            waitingSince: String(item.enqueued_at || '')
          }))
        )
      )
      .catch(() => undefined);
  }, [seatId, setSeatId, setQueue]);

  async function accept(itemId: string) {
    if (!seatId) return;
    await apiPost(`/api/call-center/seats/${seatId}/accept`, { queue_entry_id: itemId });
  }

  async function changeStatus(next: string) {
    if (!seatId) return;
    await apiPost(`/api/call-center/seats/${seatId}/status`, { status: next });
    setStatus(next as typeof status);
  }

  return (
    <div className="min-h-screen text-slate-100">
      <header className="border-b border-slate-700 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">坐席面板</h1>
          <p className="text-xs text-slate-400">Seat {seatId || '—'} · {status}</p>
        </div>
        <select
          value={status}
          onChange={(e) => void changeStatus(e.target.value)}
          className="bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm"
        >
          <option value="idle">在线</option>
          <option value="away">离开</option>
          <option value="break">休息</option>
          <option value="wrap_up">后处理</option>
          <option value="offline">离线</option>
        </select>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-0 min-h-[calc(100vh-64px)]">
        <aside className="border-r border-slate-700 p-4 space-y-3">
          <h2 className="text-sm font-medium text-slate-300">等待队列</h2>
          {queue.length === 0 && <p className="text-xs text-slate-500">暂无排队</p>}
          {queue.map((item) => (
            <div key={item.id} className="border border-slate-700 rounded-lg p-3 bg-slate-800/60">
              <div className="font-medium text-sm">{item.customer_name || item.customer_phone || '客户'}</div>
              <div className="text-xs text-slate-400 mt-1">意向 {Math.round(item.intent_score * 100)}%</div>
              <p className="text-xs text-slate-500 mt-2 line-clamp-2">{item.customer_summary || '无摘要'}</p>
              <button
                type="button"
                onClick={() => void accept(item.id)}
                className="mt-3 w-full bg-green-600 hover:bg-green-700 rounded py-1.5 text-xs"
              >
                接听
              </button>
            </div>
          ))}
        </aside>

        <main className="p-6">
          <p className="text-sm text-slate-400">通话中请进入 <Link className="text-blue-400 underline" to="/call">通话房间</Link></p>
        </main>
      </div>
    </div>
  );
}
