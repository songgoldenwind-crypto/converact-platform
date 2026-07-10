import { useState } from 'react';
import { apiGet } from '../api/client';
import { useAuth } from '../hooks/useAuth';

interface JourneyEvent {
  id: string;
  event_type: string;
  channel: string;
  summary: string;
  occurred_at: string;
  source: string;
}

export default function CustomerJourneyPage() {
  const { tenantId } = useAuth();
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [events, setEvents] = useState<JourneyEvent[]>([]);
  const [error, setError] = useState('');

  async function search() {
    setError('');
    const qs = new URLSearchParams();
    if (phone.trim()) qs.set('phone', phone.trim());
    if (email.trim()) qs.set('email', email.trim());
    if (!qs.toString()) {
      setError('请输入手机号或邮箱');
      return;
    }
    try {
      const rows = await apiGet<JourneyEvent[]>(`/api/call-center/journey/unified?${qs}`);
      setEvents(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">客户旅程时间线</h1>
      <div className="flex gap-2">
        <input className="border rounded px-3 py-2 text-sm flex-1" placeholder="手机号" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <input className="border rounded px-3 py-2 text-sm flex-1" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button type="button" onClick={() => void search()} className="bg-blue-600 text-white px-4 py-2 rounded text-sm">查询</button>
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <ul className="space-y-3">
        {events.map((e) => (
          <li key={e.id} className="bg-white border rounded-lg p-4">
            <div className="text-xs text-gray-400">{new Date(e.occurred_at).toLocaleString()} · {e.channel} · {e.source}</div>
            <div className="font-medium text-sm mt-1">{e.event_type}</div>
            <div className="text-sm text-gray-600">{e.summary}</div>
          </li>
        ))}
        {!events.length && <li className="text-gray-400 text-sm">输入客户标识后查询</li>}
      </ul>
      <p className="text-xs text-gray-400">Tenant: {tenantId}</p>
    </div>
  );
}
