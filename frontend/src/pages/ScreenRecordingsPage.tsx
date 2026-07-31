import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../api/client';

interface ScreenRecordingRow {
  id: string;
  call_session_id: string | null;
  seat_id: string | null;
  storage_url: string;
  duration_sec: number | null;
  created_at: string;
}

export default function ScreenRecordingsPage() {
  const [rows, setRows] = useState<ScreenRecordingRow[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiGet<ScreenRecordingRow[]>('/api/call-center/screen-recordings?limit=100');
      setRows(data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">屏幕录制</h1>
          <p className="text-sm text-slate-500 mt-1">E10 · 坐席工作台录屏元数据与会话关联</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="px-3 py-2 border rounded text-sm hover:bg-slate-50"
        >
          刷新
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">{error}</div>
      )}

      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-4 py-2">时间</th>
              <th className="px-4 py-2">通话</th>
              <th className="px-4 py-2">坐席</th>
              <th className="px-4 py-2">时长</th>
              <th className="px-4 py-2">存储</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  暂无录屏记录。可在工作台通话中点击「开始录屏」。
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="px-4 py-2 text-slate-600">{new Date(row.created_at).toLocaleString()}</td>
                <td className="px-4 py-2 font-mono text-xs">{row.call_session_id || '—'}</td>
                <td className="px-4 py-2 font-mono text-xs">{row.seat_id || '—'}</td>
                <td className="px-4 py-2">{row.duration_sec != null ? `${row.duration_sec}s` : '—'}</td>
                <td className="px-4 py-2">
                  {row.storage_url.startsWith('blob:') || row.storage_url.startsWith('http') ? (
                    <a href={row.storage_url} className="text-blue-600 hover:underline" target="_blank" rel="noreferrer">
                      打开
                    </a>
                  ) : (
                    <span className="font-mono text-xs text-slate-500 truncate max-w-[200px] inline-block">
                      {row.storage_url}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
