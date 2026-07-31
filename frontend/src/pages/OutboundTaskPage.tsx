import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useWebSocket } from '../hooks/useWebSocket';

interface VoiceAgentSpec {
  id: string;
  tenant_id?: string;
  goal: string;
  status: string;
}

interface OutboundTask {
  id: string;
  phone_number: string;
  status: string;
  created_at: string;
}

export default function OutboundTaskPage() {
  const { tenantId } = useAuth();
  const [phones, setPhones] = useState('');
  const [specs, setSpecs] = useState<VoiceAgentSpec[]>([]);
  const [specId, setSpecId] = useState(localStorage.getItem('opc_default_spec_id') || '');
  const [selectedLanguage] = useState<'zh' | 'en' | 'ja' | 'vi'>('zh');
  const [tasks, setTasks] = useState<OutboundTask[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function loadTasks() {
    const rows = await apiGet<OutboundTask[]>(
      `/api/call-center/outbound-tasks?tenant_id=${tenantId}`
    );
    setTasks(rows);
  }

  useEffect(() => {
    void apiGet<VoiceAgentSpec[]>(`/api/voice-agents/specs?tenant_id=${tenantId}`)
      .then((rows) => {
        const owned = rows.filter((s) => s.status === 'published' || s.tenant_id === tenantId);
        setSpecs(owned);
        if (!specId && owned[0]) setSpecId(owned[0].id);
      })
      .catch((e) => setError(e.message));
    void loadTasks().catch((e) => setError(e.message));
  }, [tenantId]);

  useWebSocket((type) => {
    if (type === 'outbound_task.updated' || type === 'call.completed') {
      void loadTasks();
    }
  });

  async function startTasks() {
    setLoading(true);
    setError('');
    setMessage('');
    const numbers = phones
      .split(/[\n,;]+/)
      .map((n) => n.trim())
      .filter(Boolean);
    if (!numbers.length) {
      setError('请至少输入一个号码');
      setLoading(false);
      return;
    }
    if (!specId) {
      setError('请选择话术');
      setLoading(false);
      return;
    }

    try {
      for (const phone_number of numbers) {
        await apiPost('/api/call-center/outbound-tasks', {
          tenant_id: tenantId,
          phone_number,
          channel: 'pstn_voice',
          strategy: { agent_spec_id: specId, language: selectedLanguage }
        });
      }
      setMessage(`已创建 ${numbers.length} 个外呼任务，拨号器将自动开始拨打`);
      setPhones('');
      await loadTasks();
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h2 className="text-lg font-semibold text-gray-900">外呼任务</h2>

      {error && <p className="text-sm text-red-500">{error}</p>}
      {message && <p className="text-sm text-green-600">{message}</p>}

      <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">话术</label>
          <select
            value={specId}
            onChange={(e) => setSpecId(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
          >
            {specs.map((spec) => (
              <option key={spec.id} value={spec.id}>
                {spec.id} — {spec.goal.slice(0, 40)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            号码列表（每行一个，或逗号分隔）
          </label>
          <textarea
            value={phones}
            onChange={(e) => setPhones(e.target.value)}
            rows={5}
            placeholder="+8613800138000"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono"
          />
        </div>

        <button
          type="button"
          disabled={loading}
          onClick={() => void startTasks()}
          className="bg-blue-500 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-600 disabled:opacity-60"
        >
          {loading ? '创建中…' : '创建并启动外呼'}
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-medium text-gray-700">
          最近任务
        </div>
        <ul className="divide-y divide-gray-100">
          {tasks.slice(0, 10).map((task) => (
            <li key={task.id} className="px-4 py-3 flex justify-between text-sm">
              <span className="font-mono">{task.phone_number}</span>
              <span className="text-gray-500">{task.status}</span>
            </li>
          ))}
          {!tasks.length && (
            <li className="px-4 py-6 text-center text-sm text-gray-400">暂无任务</li>
          )}
        </ul>
      </div>
    </div>
  );
}
