import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api/client';
import { useAuth } from '../hooks/useAuth';

interface OmniConversation {
  id: string;
  channel: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  status: string;
  assigned_seat_id: string | null;
  intent_score: number | null;
  last_message_preview: string;
  last_message_at: string;
}

interface OmniMessage {
  id: string;
  direction: string;
  sender_type: string;
  content: string;
  created_at: string;
}

interface JourneyEvent {
  id: string;
  event_type: string;
  channel: string;
  summary: string;
  occurred_at: string;
}

interface AgentSeat {
  id: string;
  display_name: string;
}

const CHANNEL_LABELS: Record<string, string> = {
  web_chat: 'Web Chat',
  sms: 'SMS',
  email: 'Email',
  wechat: '微信',
  whatsapp: 'WhatsApp'
};

export default function UnifiedInboxPage() {
  const { tenantId } = useAuth();
  const [conversations, setConversations] = useState<OmniConversation[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState<OmniMessage[]>([]);
  const [journey, setJourney] = useState<JourneyEvent[]>([]);
  const [seats, setSeats] = useState<AgentSeat[]>([]);
  const [reply, setReply] = useState('');
  const [filterChannel, setFilterChannel] = useState('');
  const [assignSeatId, setAssignSeatId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadInbox = useCallback(async () => {
    const qs = filterChannel ? `?channel=${filterChannel}` : '';
    const rows = await apiGet<OmniConversation[]>(`/api/call-center/omni/inbox${qs}`);
    setConversations(rows);
    if (!selectedId && rows[0]) setSelectedId(rows[0].id);
  }, [filterChannel, selectedId]);

  const loadDetail = useCallback(async () => {
    if (!selectedId) return;
    const detail = await apiGet<{
      conversation: OmniConversation;
      messages: OmniMessage[];
      journey: JourneyEvent[];
    }>(`/api/call-center/omni/conversations/${selectedId}`);
    setMessages(detail.messages);
    setJourney(detail.journey || []);
  }, [selectedId]);

  useEffect(() => {
    void loadInbox();
    void apiGet<AgentSeat[]>(`/api/call-center/agent-seats?tenant_id=${tenantId}`).then(setSeats);
  }, [loadInbox, tenantId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  async function handleReply() {
    if (!selectedId || !reply.trim()) return;
    setError('');
    try {
      await apiPost(`/api/call-center/omni/conversations/${selectedId}/reply`, {
        content: reply.trim()
      });
      setReply('');
      setMessage('已发送');
      await loadDetail();
      await loadInbox();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAssign() {
    if (!selectedId || !assignSeatId) return;
    await apiPost(`/api/call-center/omni/conversations/${selectedId}/assign`, {
      seat_id: assignSeatId
    });
    setMessage('已分配坐席');
    await loadDetail();
    await loadInbox();
  }

  async function handleEscalateVoice() {
    if (!selectedId) return;
    const conv = conversations.find((c) => c.id === selectedId);
    if (!conv?.customer_phone) {
      setError('该会话无手机号，无法升级语音');
      return;
    }
    await apiPost(`/api/call-center/omni/conversations/${selectedId}/escalate-voice`, {
      phone_number: conv.customer_phone,
      seat_id: assignSeatId || undefined
    });
    setMessage('已创建外呼任务（聊天→语音）');
  }

  async function handleEscalateVideo() {
    if (!selectedId) return;
    const conv = conversations.find((c) => c.id === selectedId);
    if (!conv?.customer_phone) {
      setError('该会话无手机号，无法发起视频');
      return;
    }
    const result = await apiPost<{ join_url: string }>(
      `/api/call-center/omni/conversations/${selectedId}/escalate-video`,
      { phone_number: conv.customer_phone }
    );
    setMessage(`视频邀请已发送：${result.join_url}`);
  }

  const selected = conversations.find((c) => c.id === selectedId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">统一收件箱</h1>
        <select
          className="border rounded px-3 py-1.5 text-sm"
          value={filterChannel}
          onChange={(e) => setFilterChannel(e.target.value)}
        >
          <option value="">全部渠道</option>
          {Object.entries(CHANNEL_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>

      {message && <p className="text-sm text-green-600">{message}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid grid-cols-12 gap-4 min-h-[600px]">
        <div className="col-span-4 bg-white border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b font-medium text-sm text-gray-600">会话列表</div>
          <ul className="divide-y max-h-[560px] overflow-y-auto">
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full text-left px-4 py-3 hover:bg-gray-50 ${
                    selectedId === c.id ? 'bg-blue-50' : ''
                  }`}
                >
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">
                      {c.customer_name || c.customer_phone || c.customer_email || '访客'}
                    </span>
                    <span className="text-xs text-gray-400">{CHANNEL_LABELS[c.channel] || c.channel}</span>
                  </div>
                  <p className="text-xs text-gray-500 truncate mt-1">{c.last_message_preview}</p>
                  <div className="flex gap-2 mt-1 text-xs">
                    <span className="text-gray-400">{c.status}</span>
                    {c.intent_score != null && c.intent_score >= 0.7 && (
                      <span className="text-orange-600">高意向</span>
                    )}
                  </div>
                </button>
              </li>
            ))}
            {!conversations.length && (
              <li className="px-4 py-8 text-sm text-gray-400 text-center">暂无会话</li>
            )}
          </ul>
        </div>

        <div className="col-span-5 bg-white border rounded-lg flex flex-col">
          <div className="px-4 py-3 border-b font-medium text-sm">
            {selected
              ? `${CHANNEL_LABELS[selected.channel] || selected.channel} · ${selected.customer_name || '访客'}`
              : '选择会话'}
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  m.sender_type === 'customer'
                    ? 'bg-gray-200 mr-auto'
                    : m.sender_type === 'bot'
                      ? 'bg-blue-100 ml-auto'
                      : 'bg-white border ml-auto'
                }`}
              >
                <div className="text-[10px] text-gray-400 mb-1">{m.sender_type}</div>
                {m.content}
              </div>
            ))}
          </div>
          <div className="p-3 border-t flex gap-2">
            <input
              className="flex-1 border rounded px-3 py-2 text-sm"
              placeholder="回复客户..."
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleReply()}
            />
            <button
              type="button"
              onClick={handleReply}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm"
            >
              发送
            </button>
          </div>
        </div>

        <div className="col-span-3 space-y-4">
          <div className="bg-white border rounded-lg p-4 space-y-3">
            <h3 className="font-medium text-sm">操作</h3>
            <select
              className="w-full border rounded px-2 py-1.5 text-sm"
              value={assignSeatId}
              onChange={(e) => setAssignSeatId(e.target.value)}
            >
              <option value="">选择坐席</option>
              {seats.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAssign}
              className="w-full py-2 border rounded text-sm hover:bg-gray-50"
            >
              分配坐席
            </button>
            <button
              type="button"
              onClick={handleEscalateVoice}
              className="w-full py-2 bg-green-600 text-white rounded text-sm"
            >
              升级语音外呼
            </button>
            <button
              type="button"
              onClick={handleEscalateVideo}
              className="w-full py-2 bg-purple-600 text-white rounded text-sm"
            >
              发起视频通话
            </button>
          </div>

          <div className="bg-white border rounded-lg p-4">
            <h3 className="font-medium text-sm mb-3">客户旅程</h3>
            <ul className="space-y-2 max-h-64 overflow-y-auto">
              {journey.map((e) => (
                <li key={e.id} className="text-xs border-l-2 border-blue-300 pl-2">
                  <div className="text-gray-500">{new Date(e.occurred_at).toLocaleString()}</div>
                  <div className="font-medium">{e.event_type}</div>
                  <div className="text-gray-600 truncate">{e.summary}</div>
                </li>
              ))}
              {!journey.length && <li className="text-xs text-gray-400">暂无旅程记录</li>}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
