import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../api/client';

interface RecordingRow {
  id: string;
  call_session_id: string;
  storage_url: string;
  format: string;
  duration_ms: number | null;
  created_at: string;
}

export default function RecordingsPage() {
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      params.set('limit', '50');
      const query = params.toString() ? `?${params.toString()}` : '';
      const rows = await apiGet<RecordingRow[]>(`/api/call-center/recordings${query}`);
      setRecordings(rows);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">录音检索</h2>
        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="会话 ID / 存储路径"
            className="border border-gray-300 rounded-md px-3 py-2 text-sm w-64"
          />
          <button type="button" onClick={() => void load()} className="border border-gray-300 px-4 py-2 rounded-md text-sm">
            搜索
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading && <p className="text-sm text-gray-400">加载中…</p>}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left px-4 py-2">会话</th>
              <th className="text-left px-4 py-2">格式</th>
              <th className="text-left px-4 py-2">时长</th>
              <th className="text-left px-4 py-2">时间</th>
              <th className="text-left px-4 py-2">链接</th>
            </tr>
          </thead>
          <tbody>
            {recordings.map((row) => (
              <tr key={row.id} className="border-t border-gray-100">
                <td className="px-4 py-2 font-mono text-xs">{row.call_session_id}</td>
                <td className="px-4 py-2">{row.format}</td>
                <td className="px-4 py-2">
                  {row.duration_ms != null ? `${Math.round(row.duration_ms / 1000)}s` : '—'}
                </td>
                <td className="px-4 py-2">{new Date(row.created_at).toLocaleString()}</td>
                <td className="px-4 py-2">
                  {row.storage_url ? (
                    <a href={row.storage_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                      播放
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !recordings.length && (
          <p className="text-center text-gray-400 text-sm py-8">暂无录音</p>
        )}
      </div>
    </div>
  );
}
