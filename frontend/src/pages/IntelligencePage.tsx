import { useState } from 'react';
import { apiPost } from '../api/client';

interface RoutingResult {
  seat_id: string | null;
  seat_display_name: string | null;
  confidence: number;
  factors: Record<string, number>;
  explanation: string;
}

interface IntentResult {
  customer_key: string;
  intent_score: number;
  predicted_topic: string;
  recommended_action: string;
  explanation: string;
  proactive_push?: { sent: number; skipped: number };
}

export default function IntelligencePage() {
  const [queueId, setQueueId] = useState('');
  const [skills, setSkills] = useState('sales,support');
  const [routing, setRouting] = useState<RoutingResult | null>(null);

  const [customerKey, setCustomerKey] = useState('web:visitor_42');
  const [signals, setSignals] = useState('pricing_page,cart_abandon');
  const [autoPush, setAutoPush] = useState(true);
  const [intent, setIntent] = useState<IntentResult | null>(null);
  const [error, setError] = useState('');

  async function runRouting() {
    setError('');
    try {
      const result = await apiPost<RoutingResult>('/api/call-center/routing/predict', {
        queue_id: queueId || undefined,
        required_skills: skills.split(',').map((s) => s.trim()).filter(Boolean),
        vip_priority: 0
      });
      setRouting(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : '路由预测失败');
    }
  }

  async function runIntent() {
    setError('');
    try {
      const result = await apiPost<IntentResult>('/api/call-center/intent/predict', {
        customer_key: customerKey,
        signals: signals.split(',').map((event) => ({ event: event.trim() })).filter((s) => s.event),
        auto_push: autoPush,
        variables: { name: '访客' }
      });
      setIntent(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : '意图预测失败');
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-semibold">智能路由与意图 (F7 / F9)</h1>
      <p className="text-sm text-slate-500">启发式桩实现：基于技能匹配、空闲时长、负载与 QM 历史评分推荐坐席；基于浏览信号预测客户意向。</p>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="bg-white border rounded-lg p-4 space-y-3">
        <h2 className="font-medium">F7 预测路由</h2>
        <input className="w-full border rounded px-3 py-2 text-sm" placeholder="队列 ID（可选）" value={queueId} onChange={(e) => setQueueId(e.target.value)} />
        <input className="w-full border rounded px-3 py-2 text-sm" placeholder="技能，逗号分隔" value={skills} onChange={(e) => setSkills(e.target.value)} />
        <button type="button" onClick={() => void runRouting()} className="px-4 py-2 bg-blue-600 text-white rounded text-sm">预测最佳坐席</button>
        {routing && (
          <div className="text-sm bg-slate-50 rounded p-3 space-y-1">
            <div>推荐：<strong>{routing.seat_display_name || '无'}</strong> ({routing.seat_id || '—'})</div>
            <div>置信度：{routing.confidence}</div>
            <div className="text-slate-500">{routing.explanation}</div>
            <pre className="text-xs mt-2">{JSON.stringify(routing.factors, null, 2)}</pre>
          </div>
        )}
      </section>

      <section className="bg-white border rounded-lg p-4 space-y-3">
        <h2 className="font-medium">F9 客户意图预测</h2>
        <input className="w-full border rounded px-3 py-2 text-sm" value={customerKey} onChange={(e) => setCustomerKey(e.target.value)} />
        <input className="w-full border rounded px-3 py-2 text-sm" value={signals} onChange={(e) => setSignals(e.target.value)} placeholder="信号事件，逗号分隔" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autoPush} onChange={(e) => setAutoPush(e.target.checked)} />
          高分时自动触发主动推送
        </label>
        <button type="button" onClick={() => void runIntent()} className="px-4 py-2 bg-indigo-600 text-white rounded text-sm">预测意向</button>
        {intent && (
          <div className="text-sm bg-slate-50 rounded p-3 space-y-1">
            <div>意向分：<strong>{intent.intent_score}</strong> · 话题：{intent.predicted_topic}</div>
            <div>建议动作：{intent.recommended_action}</div>
            <div className="text-slate-500">{intent.explanation}</div>
            {intent.proactive_push && (
              <div>推送：发送 {intent.proactive_push.sent} / 跳过 {intent.proactive_push.skipped}</div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
