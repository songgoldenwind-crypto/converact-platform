import { useEffect, useState } from 'react';

interface IvrSessionRow {
  callSessionId: string;
  flowId: string;
  terminated: boolean;
  stepCount: number;
  currentNodeId: string | null;
  updatedAt: string;
}

interface IvrStepRow {
  stepIndex: number;
  nodeId: string | null;
  actionKind: string;
  action: Record<string, unknown>;
  createdAt: string;
}

export default function IvrMonitorPage() {
  const [sessions, setSessions] = useState<IvrSessionRow[]>([]);
  const [activeOnly, setActiveOnly] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [steps, setSteps] = useState<IvrStepRow[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadSessions() {
    setLoading(true);
    try {
      const res = await fetch(`/api/ivr/sessions?active=${activeOnly ? '1' : '0'}`);
      const json = await res.json();
      setSessions(json.data || []);
    } finally {
      setLoading(false);
    }
  }

  async function loadSteps(callSessionId: string) {
    const res = await fetch(`/api/ivr/sessions/${callSessionId}/steps`);
    const json = await res.json();
    setSteps(json.data || []);
    setSelectedId(callSessionId);
  }

  async function deleteSession(callSessionId: string) {
    if (!confirm('删除此 IVR 会话？')) return;
    await fetch(`/api/ivr/sessions/${callSessionId}`, { method: 'DELETE' });
    if (selectedId === callSessionId) {
      setSelectedId(null);
      setSteps([]);
    }
    void loadSessions();
  }

  useEffect(() => {
    void loadSessions();
    const timer = setInterval(() => void loadSessions(), 10000);
    return () => clearInterval(timer);
  }, [activeOnly]);

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">IVR 会话监控</h2>
          <p className="text-sm text-gray-500">实时查看入站 IVR 会话与步骤轨迹</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          仅活跃会话
        </label>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b bg-gray-50 text-sm font-medium text-gray-700">会话列表</div>
          {loading ? (
            <p className="p-4 text-sm text-gray-400">加载中…</p>
          ) : sessions.length === 0 ? (
            <p className="p-4 text-sm text-gray-400">暂无会话</p>
          ) : (
            <ul className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
              {sessions.map((s) => (
                <li key={s.callSessionId} className="px-4 py-2.5 flex items-center justify-between hover:bg-gray-50">
                  <button type="button" className="text-left flex-1" onClick={() => void loadSteps(s.callSessionId)}>
                    <p className="text-sm font-medium text-gray-800 truncate">{s.callSessionId}</p>
                    <p className="text-xs text-gray-400">
                      {s.flowId} · 节点 {s.currentNodeId || '—'} · {s.stepCount} 步
                      {s.terminated ? ' · 已结束' : ' · 进行中'}
                    </p>
                  </button>
                  <button type="button" onClick={() => void deleteSession(s.callSessionId)} className="text-xs text-red-500 ml-2">删除</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b bg-gray-50 text-sm font-medium text-gray-700">
            步骤轨迹 {selectedId ? `· ${selectedId}` : ''}
          </div>
          {!selectedId ? (
            <p className="p-4 text-sm text-gray-400">选择左侧会话查看步骤</p>
          ) : steps.length === 0 ? (
            <p className="p-4 text-sm text-gray-400">暂无步骤记录</p>
          ) : (
            <ol className="p-4 space-y-2 max-h-96 overflow-y-auto text-sm">
              {steps.map((st) => (
                <li key={st.stepIndex} className="border border-gray-100 rounded-md px-3 py-2">
                  <p className="font-medium text-gray-800">
                    #{st.stepIndex} · {st.actionKind}
                    {st.nodeId ? ` @ ${st.nodeId}` : ''}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{st.createdAt}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
