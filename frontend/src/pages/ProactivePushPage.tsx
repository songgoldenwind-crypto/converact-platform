import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api/client';

interface PushRule {
  id: string;
  name: string;
  trigger_event: string;
  channel: string;
  message_template: string;
  min_intent_score: number;
  enabled: boolean;
}

export default function ProactivePushPage() {
  const [rules, setRules] = useState<PushRule[]>([]);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('pricing_page');
  const [template, setTemplate] = useState('您好 {{name}}，看到您在浏览价格页，需要帮助吗？');
  const [minScore, setMinScore] = useState(0.6);
  const [testKey, setTestKey] = useState('web:visitor_1');
  const [testScore, setTestScore] = useState(0.8);
  const [evalResult, setEvalResult] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const data = await apiGet<PushRule[]>('/api/call-center/proactive-push/rules');
    setRules(data);
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  async function createRule() {
    await apiPost('/api/call-center/proactive-push/rules', {
      name: name || '新规则',
      trigger_event: trigger,
      channel: 'web_chat',
      message_template: template,
      min_intent_score: minScore,
      enabled: true
    });
    setMessage('规则已创建');
    setName('');
    await load();
  }

  async function testEvaluate() {
    const result = await apiPost<{ sent: number; skipped: number }>(
      '/api/call-center/proactive-push/evaluate',
      {
        trigger_event: trigger,
        customer_key: testKey,
        intent_score: testScore,
        variables: { name: '访客' }
      }
    );
    setEvalResult(`发送 ${result.sent} · 跳过 ${result.skipped}`);
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-semibold">主动推送规则 (G12)</h1>
      {message && <p className="text-sm text-green-600">{message}</p>}

      <section className="bg-white border rounded-lg p-4 space-y-3">
        <h2 className="font-medium">新建规则</h2>
        <input className="w-full border rounded px-3 py-2 text-sm" placeholder="规则名称" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="w-full border rounded px-3 py-2 text-sm" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
          <option value="page_view">page_view</option>
          <option value="pricing_page">pricing_page</option>
          <option value="cart_abandon">cart_abandon</option>
          <option value="demo_request">demo_request</option>
        </select>
        <textarea className="w-full border rounded px-3 py-2 text-sm h-20" value={template} onChange={(e) => setTemplate(e.target.value)} />
        <label className="text-sm block">
          最低意向分 {minScore}
          <input type="range" min={0} max={1} step={0.05} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="w-full" />
        </label>
        <button type="button" onClick={() => void createRule()} className="px-4 py-2 bg-blue-600 text-white rounded text-sm">创建</button>
      </section>

      <section className="bg-white border rounded-lg p-4">
        <h2 className="font-medium mb-3">现有规则</h2>
        <ul className="divide-y text-sm">
          {rules.length === 0 && <li className="py-2 text-slate-400">暂无规则</li>}
          {rules.map((r) => (
            <li key={r.id} className="py-2 flex justify-between gap-4">
              <span>{r.name} · {r.trigger_event} · ≥{r.min_intent_score}</span>
              <span className={r.enabled ? 'text-green-600' : 'text-slate-400'}>{r.enabled ? '启用' : '停用'}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="bg-white border rounded-lg p-4 space-y-3">
        <h2 className="font-medium">模拟触发</h2>
        <input className="w-full border rounded px-3 py-2 text-sm" value={testKey} onChange={(e) => setTestKey(e.target.value)} placeholder="customer_key" />
        <label className="text-sm block">意向分 {testScore}
          <input type="range" min={0} max={1} step={0.05} value={testScore} onChange={(e) => setTestScore(Number(e.target.value))} className="w-full" />
        </label>
        <button type="button" onClick={() => void testEvaluate()} className="px-4 py-2 border rounded text-sm">执行 evaluate</button>
        {evalResult && <p className="text-sm text-slate-600">{evalResult}</p>}
      </section>
    </div>
  );
}
