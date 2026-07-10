import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import IvrNodeEditor, { type IvrNode } from '../components/IvrNodeEditor';

interface VoiceAgentSpec {
  id: string;
  tenant_id: string;
  language: string;
  goal: string;
  status: string;
  compliance?: Record<string, unknown>;
  runtime?: { system_prompt?: string; greeting?: string };
  nodes?: IvrNode[];
}

const TEMPLATE_GOAL = '了解客户需求并促成下一步行动（预约、回电或转人工）';

export default function SpecEditorPage() {
  const { tenantId } = useAuth();
  const [specs, setSpecs] = useState<VoiceAgentSpec[]>([]);
  const [goal, setGoal] = useState(TEMPLATE_GOAL);
  const [nodes, setNodes] = useState<IvrNode[]>([]);
  const [selectedLanguage, setSelectedLanguage] = useState<'zh' | 'en' | 'ja' | 'vi'>('zh');
  const [selectedId, setSelectedId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function loadSpecs() {
    const rows = await apiGet<VoiceAgentSpec[]>(`/api/voice-agents/specs?tenant_id=${tenantId}`);
    setSpecs(rows);
    if (!selectedId && rows.length) {
      const owned = rows.find((s) => s.tenant_id === tenantId) || rows[0];
      setSelectedId(owned.id);
      setGoal(owned.goal);
      setNodes(owned.nodes || []);
      setSelectedLanguage((owned.language as 'zh' | 'en' | 'ja' | 'vi') || 'zh');
    }
  }

  useEffect(() => {
    void loadSpecs().catch((e) => setError(e.message));
  }, [tenantId]);

  async function createFromTemplate() {
    setLoading(true);
    setError('');
    try {
      const template = specs.find((s) => s.id === 'default-outbound-zh') || specs[0];
      const created = await apiPost<VoiceAgentSpec>('/api/voice-agents/specs', {
        tenant_id: tenantId,
        language: template?.language || selectedLanguage,
        goal,
        status: 'draft',
        tools: [
          'check_compliance',
          'disclosure_complete',
          'check_intent',
          'transfer_human',
          'schedule_callback'
        ],
        compliance: template?.compliance || { ai_disclosure: '本次为 AI 智能外呼服务' },
        runtime: template?.runtime || {
          system_prompt: '你是一位专业、礼貌的中文外呼 AI 助手。',
          greeting: '您好，我是智能客服助手。本次为 AI 外呼服务。'
        },
        nodes: []
      });
      setMessage(`已创建话术草稿：${created.id}`);
      await loadSpecs();
      setSelectedId(created.id);
      setNodes(created.nodes || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">话术管理</h2>

      {error && <p className="text-sm text-red-500 mb-3">{error}</p>}
      {message && <p className="text-sm text-green-600 mb-3">{message}</p>}

      <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">已有话术</label>
          <select
            value={selectedId}
            onChange={(e) => {
              setSelectedId(e.target.value);
              const spec = specs.find((s) => s.id === e.target.value);
              if (spec) {
                setGoal(spec.goal);
                setNodes(spec.nodes || []);
                setSelectedLanguage((spec.language as 'zh' | 'en' | 'ja' | 'vi') || 'zh');
              }
            }}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
          >
            {specs.map((spec) => (
              <option key={spec.id} value={spec.id}>
                {spec.id} ({spec.status})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">对话语言</label>
          <select
            value={selectedLanguage}
            onChange={(e) => setSelectedLanguage(e.target.value as 'zh' | 'en' | 'ja' | 'vi')}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm"
          >
            <option value="zh">中文</option>
            <option value="ja">日本語</option>
            <option value="en">English</option>
            <option value="vi">Tiếng Việt</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">外呼目标</label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={4}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
          />
        </div>

        <button
          type="button"
          disabled={loading}
          onClick={() => void createFromTemplate()}
          className="bg-blue-500 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-600 disabled:opacity-60"
        >
          从模板创建新话术
        </button>

        {selectedId && (
          <div className="border-t border-gray-200 pt-4">
            <IvrNodeEditor nodes={nodes} onChange={setNodes} />
            <button
              type="button"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                setError('');
                try {
                  await apiPost(`/api/voice-agents/specs/${selectedId}`, {
                    tenant_id: tenantId,
                    nodes
                  });
                  setMessage('IVR 节点已保存');
                } catch (e) {
                  setError(e instanceof Error ? e.message : '保存失败');
                } finally {
                  setLoading(false);
                }
              }}
              className="mt-3 bg-green-500 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-green-600 disabled:opacity-60"
            >
              保存节点
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
