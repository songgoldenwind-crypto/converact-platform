import { useEffect, useState } from 'react';
import { apiGet } from '../api/client';
import { useAuth } from '../hooks/useAuth';

interface QmDashboard {
  score_distribution: { range: string; count: number }[];
  low_score_calls: { id: string; phone: string; score: number; reason: string }[];
  dimension_averages: { dimension: string; score: number }[];
  overall_average: number;
  total_evaluations: number;
  violation_count: number;
}

function ScoreBar({ label, count, max }: { label: string; count: number; max: number }) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-500 w-16 text-right">{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
        <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 w-8">{count}</span>
    </div>
  );
}

export default function QmDashboardPage() {
  const { tenantId } = useAuth();
  const [data, setData] = useState<QmDashboard | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet<QmDashboard>(`/api/qm/dashboard?tenant_id=${tenantId}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [tenantId]);

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-600">
        加载质检面板失败：{error}
      </div>
    );
  }

  if (!data) return <p className="text-slate-500 text-sm">加载中…</p>;

  const maxCount = Math.max(...data.score_distribution.map((d) => d.count), 1);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">质检管理</h2>
        <span className="text-sm text-gray-500">
          综合均分 <strong className="text-gray-900">{data.overall_average.toFixed(1)}</strong>
          <span className="ml-3">评估 {data.total_evaluations} 次</span>
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-700 mb-4">分数分布</h3>
          <div className="space-y-2">
            {data.score_distribution.map((d) => (
              <ScoreBar key={d.range} label={d.range} count={d.count} max={maxCount} />
            ))}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-700 mb-4">五维均分</h3>
          <div className="space-y-3">
            {data.dimension_averages.map((d) => (
              <div key={d.dimension} className="flex items-center gap-3">
                <span className="text-sm text-gray-700 w-36 truncate">{d.dimension}</span>
                <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full" style={{ width: `${d.score}%` }} />
                </div>
                <span className="text-sm font-medium w-12 text-right">{d.score.toFixed(0)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <h3 className="text-sm font-medium text-gray-700 px-5 pt-4 pb-2">
          低分通话（违规 {data.violation_count} 次）
        </h3>
        <table className="w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-5 py-2 text-left text-xs font-medium text-gray-500 uppercase">会话</th>
              <th className="px-5 py-2 text-left text-xs font-medium text-gray-500 uppercase">分数</th>
              <th className="px-5 py-2 text-left text-xs font-medium text-gray-500 uppercase">原因</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.low_score_calls.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-5 py-6 text-center text-sm text-gray-400">
                  暂无低分通话
                </td>
              </tr>
            ) : (
              data.low_score_calls.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-5 py-2.5 text-sm font-mono text-gray-900">{c.id}</td>
                  <td className="px-5 py-2.5 text-sm font-medium text-red-600">{c.score}</td>
                  <td className="px-5 py-2.5 text-sm text-gray-600">{c.reason}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
