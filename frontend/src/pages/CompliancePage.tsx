import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../api/client';
import { useAuth } from '../hooks/useAuth';

interface ComplianceSettings {
  tenant_id: string;
  recording_retention_days: number;
  audit_log_retention_days: number;
  omni_retention_days: number;
  auto_purge_enabled: boolean;
  updated_at: string;
}

interface ActivityItem {
  id: string;
  type: string;
  actor_id: string;
  summary: string;
  occurred_at: string;
}

export default function CompliancePage() {
  const { tenantId } = useAuth();
  const [settings, setSettings] = useState<ComplianceSettings | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [purgePhone, setPurgePhone] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const [s, a] = await Promise.all([
      apiGet<ComplianceSettings>('/api/compliance/settings'),
      apiGet<ActivityItem[]>('/api/compliance/activity?limit=30')
    ]);
    setSettings(s);
    setActivity(a);
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  async function saveSettings() {
    if (!settings) return;
    const updated = await apiPut<ComplianceSettings>('/api/compliance/settings', {
      recording_retention_days: settings.recording_retention_days,
      audit_log_retention_days: settings.audit_log_retention_days,
      omni_retention_days: settings.omni_retention_days,
      auto_purge_enabled: settings.auto_purge_enabled
    });
    setSettings(updated);
    setMessage('保留策略已保存');
    await load();
  }

  async function enforceRetention() {
    const result = await apiPost<Record<string, number>>('/api/compliance/retention/enforce', {});
    setMessage(
      `已执行保留策略：录音 ${result.recordings_deleted}、审计 ${result.audit_logs_deleted}、消息 ${result.omni_messages_deleted}`
    );
    await load();
  }

  async function gdprPurge() {
    if (!purgePhone.trim()) return;
    if (!window.confirm(`确认删除号码 ${purgePhone} 的全部 PII？此操作不可撤销。`)) return;
    const result = await apiPost<{ request_id: string; deleted: Record<string, number> }>(
      '/api/compliance/gdpr/purge',
      { phone: purgePhone.trim(), confirm: true }
    );
    setMessage(`GDPR 删除完成 (${result.request_id})`);
    setPurgePhone('');
    await load();
  }

  if (!settings) {
    return <div className="p-6 text-slate-500">加载合规设置…</div>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-semibold">合规与数据治理</h1>
      {message && <p className="text-sm text-green-600">{message}</p>}

      <section className="bg-white border rounded-lg p-4 space-y-4">
        <h2 className="font-medium">数据保留策略</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label className="text-sm">
            录音保留（天）
            <input
              type="number"
              className="mt-1 w-full border rounded px-3 py-2"
              value={settings.recording_retention_days}
              onChange={(e) =>
                setSettings({ ...settings, recording_retention_days: Number(e.target.value) })
              }
            />
          </label>
          <label className="text-sm">
            审计日志（天）
            <input
              type="number"
              className="mt-1 w-full border rounded px-3 py-2"
              value={settings.audit_log_retention_days}
              onChange={(e) =>
                setSettings({ ...settings, audit_log_retention_days: Number(e.target.value) })
              }
            />
          </label>
          <label className="text-sm">
            全渠道消息（天）
            <input
              type="number"
              className="mt-1 w-full border rounded px-3 py-2"
              value={settings.omni_retention_days}
              onChange={(e) =>
                setSettings({ ...settings, omni_retention_days: Number(e.target.value) })
              }
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.auto_purge_enabled}
            onChange={(e) => setSettings({ ...settings, auto_purge_enabled: e.target.checked })}
          />
          启用自动清理（执行保留策略时删除过期数据）
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void saveSettings()}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
          >
            保存策略
          </button>
          <button
            type="button"
            onClick={() => void enforceRetention()}
            className="px-4 py-2 border rounded text-sm hover:bg-slate-50"
          >
            立即执行保留策略
          </button>
        </div>
      </section>

      <section className="bg-white border rounded-lg p-4 space-y-3">
        <h2 className="font-medium">GDPR 客户数据删除</h2>
        <p className="text-sm text-slate-500">按手机号删除旅程、会话与消息中的个人数据。</p>
        <div className="flex gap-2">
          <input
            className="flex-1 border rounded px-3 py-2 text-sm"
            placeholder="+8613800138000"
            value={purgePhone}
            onChange={(e) => setPurgePhone(e.target.value)}
          />
          <button
            type="button"
            onClick={() => void gdprPurge()}
            className="px-4 py-2 bg-red-600 text-white rounded text-sm hover:bg-red-700"
          >
            删除 PII
          </button>
        </div>
      </section>

      <section className="bg-white border rounded-lg p-4">
        <h2 className="font-medium mb-3">操作活动流</h2>
        <ul className="divide-y text-sm">
          {activity.length === 0 && <li className="py-2 text-slate-400">暂无活动</li>}
          {activity.map((item) => (
            <li key={item.id} className="py-2 flex justify-between gap-4">
              <span>{item.summary}</span>
              <span className="text-slate-400 shrink-0">{item.occurred_at}</span>
            </li>
          ))}
        </ul>
      </section>
      <p className="text-xs text-slate-400">租户 ID: {tenantId}</p>
    </div>
  );
}
