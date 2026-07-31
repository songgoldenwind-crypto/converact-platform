import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../api/client';
import { useAuth } from '../hooks/useAuth';

interface Campaign {
  id: string;
  name: string;
  dial_mode: 'preview' | 'progressive' | 'predictive';
  status: string;
  agent_spec_id_a: string;
  agent_spec_id_b: string;
  ab_enabled: boolean;
}

interface CampaignStats {
  total_contacts: number;
  completed: number;
  failed: number;
  answer_rate: number;
  conversion_rate: number;
  variant_a: { completed: number; total: number };
  variant_b: { completed: number; total: number };
}

interface VoiceAgentSpec {
  id: string;
  goal: string;
}

export default function CampaignPage() {
  const { tenantId } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [specs, setSpecs] = useState<VoiceAgentSpec[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [name, setName] = useState('');
  const [dialMode, setDialMode] = useState<Campaign['dial_mode']>('predictive');
  const [specA, setSpecA] = useState('');
  const [specB, setSpecB] = useState('');
  const [abEnabled, setAbEnabled] = useState(false);
  const [phones, setPhones] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadCampaigns = useCallback(async () => {
    const rows = await apiGet<Campaign[]>('/api/call-center/campaigns');
    setCampaigns(rows);
    if (!selectedId && rows[0]) setSelectedId(rows[0].id);
  }, [selectedId]);

  const loadDetail = useCallback(async () => {
    if (!selectedId) return;
    const detail = await apiGet<{ campaign: Campaign; stats: CampaignStats }>(
      `/api/call-center/campaigns/${selectedId}`
    );
    setStats(detail.stats);
  }, [selectedId]);

  useEffect(() => {
    void apiGet<VoiceAgentSpec[]>(`/api/voice-agents/specs?tenant_id=${tenantId}`)
      .then((rows) => {
        setSpecs(rows);
        if (!specA && rows[0]) setSpecA(rows[0].id);
      })
      .catch((e) => setError(e.message));
    void loadCampaigns().catch((e) => setError(e.message));
  }, [tenantId, loadCampaigns, specA]);

  useEffect(() => {
    void loadDetail().catch(() => undefined);
  }, [loadDetail]);

  async function createCampaign() {
    if (!name.trim() || !specA) return;
    await apiPost('/api/call-center/campaigns', {
      name: name.trim(),
      dial_mode: dialMode,
      agent_spec_id_a: specA,
      agent_spec_id_b: abEnabled ? specB : undefined,
      ab_enabled: abEnabled
    });
    setName('');
    setMessage('Campaign 已创建');
    await loadCampaigns();
  }

  async function importContacts() {
    if (!selectedId) return;
    const contacts = phones
      .split(/[\n,;]+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((phone_number) => ({ phone_number }));
    if (!contacts.length) return;
    await apiPost(`/api/call-center/campaigns/${selectedId}/contacts`, { contacts });
    setPhones('');
    setMessage(`已导入 ${contacts.length} 个联系人`);
    await loadDetail();
  }

  async function launchCampaign() {
    if (!selectedId) return;
    const result = await apiPost<{ tasks_created: number }>(
      `/api/call-center/campaigns/${selectedId}/launch`,
      { limit: 100 }
    );
    setMessage(`已启动拨号，创建 ${result.tasks_created} 个任务`);
    await loadDetail();
  }

  async function pauseCampaign() {
    if (!selectedId) return;
    await apiPut(`/api/call-center/campaigns/${selectedId}/status`, { status: 'paused' });
    await loadCampaigns();
  }

  return (
    <div className="max-w-5xl space-y-6">
      <h2 className="text-lg font-semibold text-gray-900">外呼 Campaign</h2>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {message && <p className="text-sm text-green-600">{message}</p>}

      <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
        <h3 className="font-medium text-gray-800">新建 Campaign</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Campaign 名称"
            className="border border-gray-300 rounded-md px-3 py-2 text-sm"
          />
          <select
            value={dialMode}
            onChange={(e) => setDialMode(e.target.value as Campaign['dial_mode'])}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm"
          >
            <option value="preview">预览拨号 Preview</option>
            <option value="progressive">渐进拨号 Progressive</option>
            <option value="predictive">预测拨号 Predictive</option>
          </select>
          <select value={specA} onChange={(e) => setSpecA(e.target.value)} className="border border-gray-300 rounded-md px-3 py-2 text-sm">
            {specs.map((s) => (
              <option key={s.id} value={s.id}>
                A: {s.id}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={abEnabled} onChange={(e) => setAbEnabled(e.target.checked)} />
            启用 A/B 话术
          </label>
          {abEnabled && (
            <select value={specB} onChange={(e) => setSpecB(e.target.value)} className="border border-gray-300 rounded-md px-3 py-2 text-sm md:col-span-2">
              {specs.map((s) => (
                <option key={s.id} value={s.id}>
                  B: {s.id}
                </option>
              ))}
            </select>
          )}
        </div>
        <button type="button" onClick={() => void createCampaign()} className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm">
          创建
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="font-medium mb-3">Campaign 列表</h3>
          <ul className="space-y-2 text-sm">
            {campaigns.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full text-left px-2 py-1 rounded ${selectedId === c.id ? 'bg-blue-50 text-blue-700' : ''}`}
                >
                  {c.name} <span className="text-gray-400">({c.dial_mode})</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="lg:col-span-2 bg-white border border-gray-200 rounded-lg p-4 space-y-4">
          {stats && (
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div><dt className="text-gray-500">联系人</dt><dd className="text-xl font-bold">{stats.total_contacts}</dd></div>
              <div><dt className="text-gray-500">完成</dt><dd className="text-xl font-bold text-green-600">{stats.completed}</dd></div>
              <div><dt className="text-gray-500">接通率</dt><dd className="text-xl font-bold">{(stats.answer_rate * 100).toFixed(0)}%</dd></div>
              <div><dt className="text-gray-500">转化率</dt><dd className="text-xl font-bold">{(stats.conversion_rate * 100).toFixed(0)}%</dd></div>
              {stats.variant_b.total > 0 && (
                <>
                  <div><dt className="text-gray-500">A 完成</dt><dd>{stats.variant_a.completed}/{stats.variant_a.total}</dd></div>
                  <div><dt className="text-gray-500">B 完成</dt><dd>{stats.variant_b.completed}/{stats.variant_b.total}</dd></div>
                </>
              )}
            </dl>
          )}

          <textarea
            value={phones}
            onChange={(e) => setPhones(e.target.value)}
            rows={4}
            placeholder="导入号码，每行一个"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono"
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void importContacts()} className="border border-gray-300 px-4 py-2 rounded-md text-sm">导入名单</button>
            <button type="button" onClick={() => void launchCampaign()} className="bg-green-600 text-white px-4 py-2 rounded-md text-sm">启动拨号</button>
            <button type="button" onClick={() => void pauseCampaign()} className="border border-amber-300 text-amber-800 px-4 py-2 rounded-md text-sm">暂停</button>
          </div>
        </div>
      </div>
    </div>
  );
}
