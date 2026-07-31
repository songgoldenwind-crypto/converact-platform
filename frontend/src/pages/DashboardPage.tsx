import { useEffect, useState } from 'react';
import { apiGet } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import StatsCard from '../components/StatsCard';
import { useWebSocket } from '../hooks/useWebSocket';

interface DashboardData {
  today: { total_outbound: number; connected: number; pending: number };
  seats: { online: number; idle: number; busy: number };
  queue: { pending_tasks: number; in_progress: number };
}

export default function DashboardPage() {
  const { tenantId, tenantName } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  async function load() {
    try {
      const res = await apiGet<DashboardData>(`/api/call-center/dashboard?tenant_id=${tenantId}`);
      setData(res);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }

  useEffect(() => {
    void load();
  }, [tenantId]);

  useWebSocket((type) => {
    if (type === 'outbound_task.updated' || type === 'call.completed') {
      void load();
    }
  });

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-600">
        无法加载仪表盘：{error}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-gray-900">仪表盘</h2>
        {tenantName && <p className="text-sm text-gray-500">{tenantName}</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {data ? (
          <>
            <StatsCard title="今日外呼" value={data.today.total_outbound} />
            <StatsCard title="已接通" value={data.today.connected} />
            <StatsCard title="排队中" value={data.queue.pending_tasks} />
            <StatsCard title="在线坐席" value={data.seats.online} />
          </>
        ) : (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-white rounded-lg shadow-sm border p-5 animate-pulse h-24" />
          ))
        )}
      </div>
    </div>
  );
}
