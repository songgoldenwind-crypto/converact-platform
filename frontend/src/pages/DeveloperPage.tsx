import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api/client';
import { useAuth } from '../hooks/useAuth';

interface WebhookSub {
  id: string;
  url: string;
  events: string[];
  active: boolean;
}

interface WebhookDelivery {
  id: string;
  event: string;
  status: string;
  attempt_count: number;
  http_status: number | null;
  error: string | null;
  created_at: string;
}

export default function DeveloperPage() {
  const { tenantId } = useAuth();
  const [subs, setSubs] = useState<WebhookSub[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState('call.completed,sentiment.alert,omni.message');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const s = await apiGet<WebhookSub[]>(`/api/webhooks/subscriptions?tenant_id=${tenantId}`);
    setSubs(s);
    const d = await apiGet<WebhookDelivery[]>(`/api/webhooks/deliveries?tenant_id=${tenantId}`);
    setDeliveries(d);
  }, [tenantId]);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  async function createSub() {
    await apiPost('/api/webhooks/subscriptions', {
      tenant_id: tenantId,
      url: url.trim(),
      events: events.split(',').map((e) => e.trim()).filter(Boolean)
    });
    setMessage('Webhook 已创建');
    setUrl('');
    await load();
  }

  async function processRetries() {
    const result = await apiPost<{ processed: number }>('/api/webhooks/process-retries', {});
    setMessage(`已处理 ${result.processed} 条重试`);
    await load();
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">开发者 / 开放平台</h1>
        <a href="/docs/api" target="_blank" rel="noreferrer" className="text-sm text-blue-600 hover:underline">
          OpenAPI 文档 →
        </a>
      </div>
      {message && <p className="text-sm text-green-600">{message}</p>}

      <section className="bg-white border rounded-lg p-4 space-y-3">
        <h2 className="font-medium">Webhook 订阅</h2>
        <input
          className="w-full border rounded px-3 py-2 text-sm"
          placeholder="https://your-server.com/hooks/opc"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <input
          className="w-full border rounded px-3 py-2 text-sm"
          value={events}
          onChange={(e) => setEvents(e.target.value)}
        />
        <button type="button" onClick={() => void createSub()} className="bg-blue-600 text-white px-4 py-2 rounded text-sm">
          创建订阅
        </button>
        <ul className="text-sm divide-y">
          {subs.map((s) => (
            <li key={s.id} className="py-2">
              <div className="font-mono text-xs text-gray-500">{s.id}</div>
              <div>{s.url}</div>
              <div className="text-gray-500">{s.events.join(', ')}</div>
            </li>
          ))}
        </ul>
      </section>

      <section className="bg-white border rounded-lg p-4 space-y-3">
        <div className="flex justify-between items-center">
          <h2 className="font-medium">投递日志</h2>
          <button type="button" onClick={() => void processRetries()} className="text-sm border px-3 py-1 rounded">
            处理重试
          </button>
        </div>
        <ul className="text-xs space-y-2 max-h-64 overflow-y-auto">
          {deliveries.map((d) => (
            <li key={d.id} className="border-l-2 border-gray-200 pl-2">
              <span className="font-medium">{d.event}</span> · {d.status} · attempts={d.attempt_count}
              {d.error && <span className="text-red-500"> · {d.error}</span>}
            </li>
          ))}
          {!deliveries.length && <li className="text-gray-400">暂无投递记录</li>}
        </ul>
      </section>

      <section className="bg-white border rounded-lg p-4 text-sm text-gray-600">
        <p>Python SDK: <code>sdk/python/opc_client/client.py</code></p>
        <p>n8n 清单: <code>integrations/n8n/opc-manifest.json</code></p>
      </section>
    </div>
  );
}
