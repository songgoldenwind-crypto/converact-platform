import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

interface IvrFlowRecord {
  id: string;
  name: string;
  status: 'draft' | 'published' | 'needs_repair';
  version: number;
  graph: { nodes: unknown[]; edges: unknown[] };
  updated_at: string;
}

interface ValidationSummary {
  summary: { publishBlocked: number; needsRepair: number };
  flows: Array<{ id: string; publishBlocked: boolean }>;
}

export default function IvrFlowListPage() {
  const navigate = useNavigate();
  const [flows, setFlows] = useState<IvrFlowRecord[]>([]);
  const [validation, setValidation] = useState<ValidationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function loadFlows() {
    setLoading(true);
    try {
      const res = await fetch('/api/ivr/flows');
      const json = await res.json();
      setFlows(json.data || json || []);
      const reportRes = await fetch('/api/ivr/flows/validation-report');
      const reportJson = await reportRes.json();
      setValidation(reportJson.data || reportJson || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadFlows(); }, []);

  async function deleteFlow(id: string) {
    if (!confirm('确认删除此流程？')) return;
    try {
      await fetch(`/api/ivr/flows/${id}`, { method: 'DELETE' });
      void loadFlows();
    } catch (e) {
      alert('删除失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function publishFlow(id: string) {
    try {
      const res = await fetch(`/api/ivr/flows/${id}/publish`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        const data = json.data || json;
        alert('发布失败: ' + (data.error || '校验未通过，请先在设计器中补全缺边'));
        return;
      }
      void loadFlows();
    } catch (e) {
      alert('发布失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  const blockedIds = new Set(
    (validation?.flows ?? []).filter((f) => f.publishBlocked).map((f) => f.id)
  );

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">IVR 流程管理</h2>
          <p className="text-sm text-gray-500">已保存的 IVR 流程列表</p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/ivr-designer')}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-md hover:bg-blue-700"
        >
          + 新建流程
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">{error}</div>}

      {validation && validation.summary.publishBlocked > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
          {validation.summary.publishBlocked} 个流程存在校验问题，发布前请在设计器中使用「补全缺边」或手动连线。
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400 text-center py-8">加载中…</p>
      ) : flows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
          <p className="text-sm text-gray-400 mb-4">暂无 IVR 流程</p>
          <button
            type="button"
            onClick={() => navigate('/ivr-designer')}
            className="text-sm text-blue-600 hover:underline"
          >
            前往设计器创建第一个流程 →
          </button>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-600">流程名称</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">状态</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">节点数</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">更新时间</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600">操作</th>
              </tr>
            </thead>
            <tbody>
              {flows.map((flow) => (
                <tr key={flow.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-medium text-gray-800">{flow.name}</td>
                  <td className="px-4 py-2.5">
                    {flow.status === 'published' ? (
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">已发布</span>
                    ) : flow.status === 'needs_repair' ? (
                      <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">需修复</span>
                    ) : (
                      <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">草稿</span>
                    )}
                    {blockedIds.has(flow.id) && (
                      <span className="ml-1 text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">待修复</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-gray-500">{flow.graph?.nodes?.length || 0}</td>
                  <td className="px-4 py-2.5 text-gray-400 text-xs">{flow.updated_at}</td>
                  <td className="px-4 py-2.5 text-right space-x-2">
                    <button
                      type="button"
                      onClick={() => navigate(`/ivr-designer?flow=${flow.id}`)}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      编辑
                    </button>
                    {flow.status !== 'published' && (
                      <button
                        type="button"
                        onClick={() => void publishFlow(flow.id)}
                        className="text-xs text-green-600 hover:underline"
                      >
                        发布
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void deleteFlow(flow.id)}
                      className="text-xs text-red-500 hover:underline"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}