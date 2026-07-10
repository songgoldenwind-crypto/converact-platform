import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api/client';
import { useAuth } from '../hooks/useAuth';

interface WallboardSnapshot {
  generated_at: string;
  seats: { total: number; idle: number; busy: number; away: number; wrap_up: number; offline: number };
  queues: Array<{
    queue_name: string;
    waiting_count: number;
    available_agents: number;
    estimated_wait_sec: number;
  }>;
  calls: { active_inbound: number; active_outbound: number };
  sla: {
    service_level_pct: number;
    avg_wait_sec: number;
    answered_today: number;
    abandoned_today: number;
  };
}

interface WallboardResponse {
  snapshot: WallboardSnapshot;
  alerts: Array<{ type: string; message: string }>;
}

export default function WallboardPage() {
  const { tenantId } = useAuth();
  const [data, setData] = useState<WallboardResponse | null>(null);
  const [error, setError] = useState('');
  const [monitorCallId, setMonitorCallId] = useState('');
  const [monitorMode, setMonitorMode] = useState('listen');
  const [monitorResult, setMonitorResult] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const result = await apiGet<WallboardResponse>('/api/call-center/wallboard');
        setData(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败');
      }
    }
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [tenantId]);

  if (error) {
    return <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg p-4">{error}</div>;
  }

  if (!data) return <p className="text-slate-500 text-sm">加载 Wallboard…</p>;

  const { snapshot, alerts } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold text-slate-900">实时 Wallboard</h2>
        <span className="text-xs text-slate-500">刷新于 {new Date(snapshot.generated_at).toLocaleTimeString()}</span>
      </div>

      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert, idx) => (
            <div key={idx} className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-2">
              {alert.message}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="空闲坐席" value={snapshot.seats.idle} tone="emerald" />
        <StatCard label="通话中" value={snapshot.seats.busy} tone="blue" />
        <StatCard label="排队总数" value={snapshot.queues.reduce((s, q) => s + q.waiting_count, 0)} tone="amber" />
        <StatCard label="服务水平" value={`${snapshot.sla.service_level_pct}%`} tone="slate" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h3 className="font-medium text-slate-800 mb-4">队列状态</h3>
          <div className="space-y-3">
            {snapshot.queues.map((queue) => (
              <div key={queue.queue_name} className="flex justify-between text-sm border-b border-slate-100 pb-2">
                <span className="font-medium">{queue.queue_name}</span>
                <span className="text-slate-600">
                  等待 {queue.waiting_count} · 坐席 {queue.available_agents} · ~{queue.estimated_wait_sec}s
                </span>
              </div>
            ))}
            {!snapshot.queues.length && <p className="text-slate-400 text-sm">暂无队列</p>}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h3 className="font-medium text-slate-800 mb-4">今日 SLA</h3>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-slate-500">接通数</dt>
              <dd className="text-2xl font-bold">{snapshot.sla.answered_today}</dd>
            </div>
            <div>
              <dt className="text-slate-500">放弃数</dt>
              <dd className="text-2xl font-bold text-red-600">{snapshot.sla.abandoned_today}</dd>
            </div>
            <div>
              <dt className="text-slate-500">平均等待</dt>
              <dd className="text-lg font-medium">{snapshot.sla.avg_wait_sec}s</dd>
            </div>
            <div>
              <dt className="text-slate-500">活跃通话</dt>
              <dd className="text-lg font-medium">
                入 {snapshot.calls.active_inbound} / 出 {snapshot.calls.active_outbound}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="font-medium text-slate-800 mb-4">主管监听</h3>
        <div className="flex flex-wrap gap-3 items-end">
          <input
            value={monitorCallId}
            onChange={(e) => setMonitorCallId(e.target.value)}
            placeholder="call_session_id"
            className="border border-slate-300 rounded-md px-3 py-2 text-sm min-w-[240px]"
          />
          <select
            value={monitorMode}
            onChange={(e) => setMonitorMode(e.target.value)}
            className="border border-slate-300 rounded-md px-3 py-2 text-sm"
          >
            <option value="listen">监听</option>
            <option value="whisper">耳语</option>
            <option value="barge">强插</option>
          </select>
          <button
            type="button"
            onClick={() => {
              void apiPost('/api/call-center/supervisor/monitor', {
                call_session_id: monitorCallId.trim(),
                mode: monitorMode
              })
                .then((result) => setMonitorResult(JSON.stringify(result)))
                .catch((e) => setMonitorResult(e instanceof Error ? e.message : '失败'));
            }}
            className="bg-slate-800 text-white px-4 py-2 rounded-md text-sm"
          >
            加入监控
          </button>
        </div>
        {monitorResult && <pre className="text-xs text-slate-600 mt-3 bg-slate-50 p-3 rounded overflow-auto">{monitorResult}</pre>}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone
}: {
  label: string;
  value: string | number;
  tone: 'emerald' | 'blue' | 'amber' | 'slate';
}) {
  const colors = {
    emerald: 'text-emerald-600',
    blue: 'text-blue-600',
    amber: 'text-amber-600',
    slate: 'text-slate-900'
  };
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-3xl font-bold mt-1 ${colors[tone]}`}>{value}</p>
    </div>
  );
}
