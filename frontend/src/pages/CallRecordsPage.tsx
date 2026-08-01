import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api/client';
import { readAuthStorage } from '../auth-storage';
import { useAuth } from '../hooks/useAuth';
import { useWebSocket } from '../hooks/useWebSocket';
import CallRecordRow, { type CallRecord } from '../components/CallRecordRow';

const PAGE_SIZE = 20;

interface OutboundTaskRow {
  id: string;
  phone_number: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  result?: { intent_score?: number };
}

function mapTaskToRecord(task: OutboundTaskRow): CallRecord {
  const start = task.started_at || task.created_at;
  const end = task.completed_at ? new Date(task.completed_at).getTime() : Date.now();
  const startMs = new Date(start).getTime();
  const duration_seconds = Math.max(0, Math.floor((end - startMs) / 1000));

  return {
    id: task.id,
    phone: task.phone_number,
    started_at: start,
    duration_seconds,
    status: task.status,
    intent_score: task.result?.intent_score,
    qm_score: undefined
  };
}

export default function CallRecordsPage() {
  const { tenantId } = useAuth();
  const [records, setRecords] = useState<CallRecord[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedLanguage] = useState<'zh' | 'en' | 'ja' | 'vi'>('zh');
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = statusFilter
        ? `?tenant_id=${tenantId}&status=${statusFilter}`
        : `?tenant_id=${tenantId}`;
      const rows = await apiGet<OutboundTaskRow[]>(`/api/call-center/outbound-tasks${query}`);
      setRecords(rows.map(mapTaskToRecord));
      setPage(0);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [tenantId, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useWebSocket((type) => {
    if (type === 'outbound_task.updated' || type === 'call.completed') {
      void load();
    }
  });

  const handleDial = useCallback(
    async (phone: string) => {
      const specId = readAuthStorage('default_spec_id') || '';
      await apiPost('/api/call-center/outbound-tasks', {
        tenant_id: tenantId,
        phone_number: phone,
        channel: 'pstn_voice',
        strategy: specId ? { agent_spec_id: specId, language: selectedLanguage } : { language: selectedLanguage }
      });
      await load();
    },
    [tenantId, load]
  );

  const paginated = records.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(records.length / PAGE_SIZE);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">通话记录</h2>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="text-sm border border-gray-300 rounded-md px-3 py-1.5"
        >
          <option value="">全部状态</option>
          <option value="completed">已完成</option>
          <option value="connected">通话中</option>
          <option value="dialing">拨号中</option>
          <option value="failed">失败</option>
          <option value="pending">待拨打</option>
        </select>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-600 mb-4">
          {error}
        </div>
      )}

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">时间</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">号码</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">时长</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">意向</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">QM</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400">
                  加载中…
                </td>
              </tr>
            ) : paginated.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400">
                  暂无记录
                </td>
              </tr>
            ) : (
              paginated.map((r) => (
                <CallRecordRow key={r.id} record={r} onDial={(phone) => void handleDial(phone)} />
              ))
            )}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
            <span className="text-sm text-gray-500">
              第 {page + 1} / {totalPages} 页（共 {records.length} 条）
            </span>
            <div className="flex gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1 text-sm rounded border border-gray-300 disabled:opacity-40"
              >
                上一页
              </button>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 text-sm rounded border border-gray-300 disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
