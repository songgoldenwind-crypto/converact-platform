import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../api/client';

interface VoicemailRow {
  id: string;
  from_number: string;
  mailbox: string;
  status: string;
  duration_sec: number | null;
  transcript: string | null;
  recording_url: string | null;
  created_at: string;
}

export default function VoicemailsPage() {
  const [rows, setRows] = useState<VoicemailRow[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const query = status ? `?status=${status}` : '';
      const data = await apiGet<VoicemailRow[]>(`/api/call-center/voicemails${query}`);
      setRows(data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">语音信箱</h2>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm"
        >
          <option value="">全部</option>
          <option value="new">未读</option>
          <option value="read">已读</option>
          <option value="archived">已归档</option>
        </select>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="space-y-3">
        {rows.map((vm) => (
          <div key={vm.id} className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex justify-between text-sm">
              <span className="font-mono font-medium">{vm.from_number}</span>
              <span className="text-gray-500">{new Date(vm.created_at).toLocaleString()}</span>
            </div>
            <div className="flex gap-3 mt-2 text-xs text-gray-500">
              <span>信箱：{vm.mailbox}</span>
              <span>状态：{vm.status}</span>
              {vm.duration_sec != null && <span>{vm.duration_sec}s</span>}
            </div>
            {vm.transcript && <p className="text-sm text-gray-700 mt-2">{vm.transcript}</p>}
            {vm.recording_url && (
              <a href={vm.recording_url} target="_blank" rel="noreferrer" className="text-blue-600 text-sm mt-2 inline-block">
                播放留言
              </a>
            )}
          </div>
        ))}
        {!rows.length && <p className="text-sm text-gray-400 text-center py-12">暂无留言</p>}
      </div>
    </div>
  );
}
