import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, apiPut } from '../api/client';
import { useAuth } from '../hooks/useAuth';

interface Widget {
  widget_type: string;
  title: string;
  position: number;
  config?: Record<string, unknown>;
}

interface DashboardData {
  today: { total_outbound: number; connected: number; pending: number };
  seats: { online: number; idle: number; busy: number };
  queue: { pending_tasks: number; in_progress: number };
}

interface WallboardResponse {
  snapshot: {
    seats: { total: number; idle: number; busy: number; away: number };
    queues: Array<{ queue_name: string; waiting_count: number }>;
    sla: { answered_today: number; abandoned_today: number };
    calls: { active_inbound: number; active_outbound: number };
  };
  alerts: Array<{ type: string; message: string }>;
}

interface QmDashboard {
  overall_average: number;
  total_evaluations: number;
}

const WIDGET_CATALOG: Array<{ type: string; title: string; description: string }> = [
  { type: 'call_volume', title: '通话量', description: '今日应答与放弃' },
  { type: 'qm_score', title: '质检均分', description: 'QM 综合评分' },
  { type: 'seat_status', title: '坐席状态', description: '在线/空闲/忙碌分布' },
  { type: 'queue_depth', title: '队列深度', description: '当前排队总数' },
  { type: 'intent_alerts', title: '高意向预警', description: 'Wallboard 告警数' }
];

function widgetValue(
  type: string,
  dash: DashboardData | null,
  wall: WallboardResponse | null,
  qm: QmDashboard | null
): string {
  if (!wall && !dash && !qm) return '—';
  switch (type) {
    case 'call_volume': {
      const answered = wall?.snapshot.sla.answered_today ?? 0;
      const abandoned = wall?.snapshot.sla.abandoned_today ?? 0;
      const outbound = dash?.today.connected ?? 0;
      return `${answered + outbound} / 弃 ${abandoned}`;
    }
    case 'qm_score':
      return qm ? qm.overall_average.toFixed(1) : '—';
    case 'seat_status': {
      const s = wall?.snapshot.seats;
      if (!s) return '—';
      return `闲 ${s.idle} / 忙 ${s.busy}`;
    }
    case 'queue_depth': {
      const total = wall?.snapshot.queues.reduce((sum, q) => sum + q.waiting_count, 0) ?? 0;
      return String(total);
    }
    case 'intent_alerts':
      return String(wall?.alerts.length ?? 0);
    default:
      return '—';
  }
}

export default function CustomDashboardPage() {
  const { tenantId } = useAuth();
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [wall, setWall] = useState<WallboardResponse | null>(null);
  const [qm, setQm] = useState<QmDashboard | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const [layout, dashboard, wallboard, qmDash] = await Promise.all([
      apiGet<Widget[]>('/api/call-center/dashboard/custom'),
      apiGet<DashboardData>(`/api/call-center/dashboard?tenant_id=${tenantId}`).catch(() => null),
      apiGet<WallboardResponse>('/api/call-center/wallboard').catch(() => null),
      apiGet<QmDashboard>(`/api/qm/dashboard?tenant_id=${tenantId}`).catch(() => null)
    ]);
    setWidgets(layout.sort((a, b) => a.position - b.position));
    setDash(dashboard);
    setWall(wallboard);
    setQm(qmDash);
  }, [tenantId]);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const subtitle = useMemo(() => {
    const parts: string[] = [];
    if (wall) parts.push(`活跃呼入 ${wall.snapshot.calls.active_inbound}`);
    if (qm) parts.push(`QM ${qm.total_evaluations} 次`);
    return parts.join(' · ');
  }, [wall, qm]);

  function addWidget(type: string) {
    const meta = WIDGET_CATALOG.find((w) => w.type === type);
    if (!meta) return;
    if (widgets.some((w) => w.widget_type === type)) return;
    setWidgets([
      ...widgets,
      { widget_type: type, title: meta.title, position: widgets.length, config: { range: '7d' } }
    ]);
  }

  function removeWidget(type: string) {
    setWidgets(
      widgets.filter((w) => w.widget_type !== type).map((w, i) => ({ ...w, position: i }))
    );
  }

  function moveWidget(index: number, direction: -1 | 1) {
    const next = [...widgets];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setWidgets(next.map((w, i) => ({ ...w, position: i })));
  }

  async function save() {
    await apiPut('/api/call-center/dashboard/custom', { widgets });
    setMessage('仪表盘布局已保存');
    await load();
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">自定义仪表盘</h1>
          {subtitle && <p className="text-sm text-slate-500 mt-1">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={() => void save()}
          className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
        >
          保存布局
        </button>
      </div>
      {message && <p className="text-sm text-green-600">{message}</p>}

      <section className="bg-white border rounded-lg p-4">
        <h2 className="font-medium mb-3">已选 Widget（可上下调整顺序）</h2>
        {widgets.length === 0 && <p className="text-sm text-slate-400">从下方添加 Widget</p>}
        <ul className="space-y-2">
          {widgets.map((w, index) => (
            <li key={w.widget_type} className="flex items-center gap-2 border rounded px-3 py-2 text-sm">
              <span className="flex-1 font-medium">{w.title}</span>
              <span className="text-slate-400">{w.widget_type}</span>
              <button type="button" className="px-2 py-1 border rounded" onClick={() => moveWidget(index, -1)}>↑</button>
              <button type="button" className="px-2 py-1 border rounded" onClick={() => moveWidget(index, 1)}>↓</button>
              <button type="button" className="px-2 py-1 text-red-600" onClick={() => removeWidget(w.widget_type)}>移除</button>
            </li>
          ))}
        </ul>
      </section>

      <section className="bg-white border rounded-lg p-4">
        <h2 className="font-medium mb-3">Widget 库</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {WIDGET_CATALOG.map((item) => (
            <div key={item.type} className="border rounded p-3">
              <div className="font-medium text-sm">{item.title}</div>
              <div className="text-xs text-slate-500 mt-1">{item.description}</div>
              <button
                type="button"
                disabled={widgets.some((w) => w.widget_type === item.type)}
                onClick={() => addWidget(item.type)}
                className="mt-2 text-xs text-blue-600 disabled:text-slate-300"
              >
                + 添加
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {widgets.map((w) => (
          <div key={w.widget_type} className="bg-slate-50 border rounded-lg p-4 min-h-[120px]">
            <div className="text-xs text-slate-400 uppercase">{w.widget_type}</div>
            <div className="font-semibold mt-1">{w.title}</div>
            <div className="text-2xl font-bold text-slate-700 mt-3">
              {widgetValue(w.widget_type, dash, wall, qm)}
            </div>
            <div className="text-xs text-slate-400 mt-1">租户 {tenantId}</div>
          </div>
        ))}
      </section>
    </div>
  );
}
