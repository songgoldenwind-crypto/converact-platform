import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiGet, apiPost, getUserId } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import {
  buildCollaborationChatClientPlanPath,
  buildCollaborationChatPath,
  buildCollaborationMessageReceiptPath,
  buildCollaborationMessageStatePath,
  buildCollaborationMessagesPath,
  buildCollaborationPresencePath,
  buildCollaborationRealtimeStatePath,
  buildCollaborationTypingPath,
  latestReadableMessageId,
  readCollaborationChatEvent,
  sameCollaborationChatClientPlan,
  type CollaborationChatClientPlan,
  type CollaborationChatMessage,
  type CollaborationPolicyEvent
} from './collaboration-chat';
import { TinodeRealtimeAdapter, type TinodeConnectionState } from './tinode-realtime';

const CHAT_MESSAGE_EVENT = 'collaboration.message.created';

interface ChatBinding {
  provider: string;
  provider_topic_id: string;
  provider_status: string;
}

interface ChatParticipant {
  id: string;
  identity: string;
  role: string;
  display_name: string;
}

interface ChatSnapshot {
  session: {
    id: string;
    title: string;
    business_ref_type: string;
    business_ref_id: string;
  };
  binding: ChatBinding | null;
  participants: ChatParticipant[];
  messages: CollaborationChatMessage[];
  policy_events: CollaborationPolicyEvent[];
}

interface MessageStateSnapshot {
  identity: string;
  unread_count: number;
}

interface RealtimeParticipantState {
  identity: string;
  presence_status: 'online' | 'away' | 'offline';
  typing: boolean;
}

function formatChatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function providerLabel(binding: ChatBinding | null): string {
  if (!binding) return '未绑定 IM 引擎';
  if (binding.provider === 'tinode') return `Tinode · ${binding.provider_status}`;
  return '本地镜像聊天';
}

function riskLabel(event: CollaborationPolicyEvent): string {
  if (event.policy_type === 'phone_number') return '手机号';
  if (event.policy_type === 'email') return '邮箱';
  if (event.policy_type === 'wechat') return '微信';
  if (event.policy_type === 'outside_app') return '站外沟通';
  if (event.policy_type === 'pay_directly') return '线下付款';
  return event.policy_type;
}

export default function CollaborationChatPage() {
  const [params] = useSearchParams();
  const sessionId = params.get('session_id') || '';
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [clientPlan, setClientPlan] = useState<CollaborationChatClientPlan | null>(null);
  const [tinodeConnection, setTinodeConnection] = useState<TinodeConnectionState>('disconnected');
  const [unreadCount, setUnreadCount] = useState(0);
  const [realtimeStates, setRealtimeStates] = useState<RealtimeParticipantState[]>([]);
  const tinodeAdapter = useRef<TinodeRealtimeAdapter | null>(null);
  const identity = getUserId() || 'agent';

  const refreshMessageState = useCallback(async () => {
    if (!sessionId) return;
    const [messageState, realtime] = await Promise.all([
      apiGet<MessageStateSnapshot>(buildCollaborationMessageStatePath(sessionId)),
      apiGet<{ states: RealtimeParticipantState[] }>(buildCollaborationRealtimeStatePath(sessionId))
    ]);
    setUnreadCount(messageState.unread_count);
    setRealtimeStates(realtime.states);
  }, [sessionId]);

  const reportReceipt = useCallback(async (
    messageId: string,
    status: 'delivered' | 'read',
    source: 'ivekit' | 'tinode',
    providerSequence?: number
  ) => {
    if (!sessionId || !messageId) return;
    const result = await apiPost<{ unread_count: number }>(
      buildCollaborationMessageReceiptPath(sessionId, messageId),
      {
        identity,
        status,
        source,
        provider_sequence: providerSequence
      }
    );
    setUnreadCount(result.unread_count);
  }, [identity, sessionId]);

  const loadSnapshot = useCallback(async () => {
    if (!sessionId) return;
    const data = await apiGet<ChatSnapshot>(buildCollaborationChatPath(sessionId));
    setSnapshot(data);
    return data;
  }, [sessionId]);

  const loadChat = useCallback(async () => {
    const data = await loadSnapshot();
    if (!data) return;
    if (data.binding?.provider === 'tinode') {
      const plan = await apiPost<CollaborationChatClientPlan>(
        buildCollaborationChatClientPlanPath(sessionId),
        {
          identity,
          role: 'agent',
          display_name: identity
        }
      );
      setClientPlan((current) => sameCollaborationChatClientPlan(current, plan) ? current : plan);
    } else {
      setClientPlan(null);
    }
    const latestMessageId = latestReadableMessageId(data.messages, identity);
    if (latestMessageId) {
      await reportReceipt(latestMessageId, 'read', 'ivekit').catch(() => undefined);
    }
  }, [identity, loadSnapshot, reportReceipt, sessionId]);

  useEffect(() => {
    void loadChat().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    void refreshMessageState().catch(() => undefined);
  }, [loadChat, refreshMessageState]);

  useEffect(() => {
    if (!sessionId) return;
    const reportPresence = (status: 'online' | 'offline') => apiPost(
      buildCollaborationPresencePath(sessionId),
      { identity, status, ttl_ms: status === 'online' ? 90_000 : undefined }
    );
    void reportPresence('online').catch(() => undefined);
    const heartbeat = setInterval(() => {
      void reportPresence('online').catch(() => undefined);
    }, 60_000);
    return () => {
      clearInterval(heartbeat);
      void reportPresence('offline').catch(() => undefined);
    };
  }, [identity, sessionId]);

  useEffect(() => {
    if (!clientPlan || clientPlan.provider !== 'tinode' || !sessionId) return;
    let stopped = false;
    const adapter = new TinodeRealtimeAdapter({
      plan: clientPlan,
      onConnectionChange: setTinodeConnection,
      onMessage: (message) => {
        if (message.sequence > 0) {
          try {
            adapter.noteReceived(message.sequence);
            adapter.noteRead(message.sequence);
          } catch {
            // The HTTP mirror still refreshes if the SDK topic is reconnecting.
          }
        }
        if (message.opc_message_id) {
          void reportReceipt(
            message.opc_message_id,
            'read',
            'tinode',
            message.sequence || undefined
          ).catch(() => undefined);
        }
        void loadSnapshot().catch(() => undefined);
      },
      onInfo: () => void refreshMessageState().catch(() => undefined),
      onPresence: () => void refreshMessageState().catch(() => undefined),
      onError: (err) => {
        if (!stopped) setError(err.message);
      }
    });
    tinodeAdapter.current = adapter;
    void adapter.connect()
      .then(async () => {
        if (stopped) return;
        await refreshMessageState();
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      if (tinodeAdapter.current === adapter) tinodeAdapter.current = null;
      void adapter.disconnect();
    };
  }, [clientPlan, loadSnapshot, refreshMessageState, reportReceipt, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    if (!draft.trim()) {
      void apiPost(buildCollaborationTypingPath(sessionId), {
        identity,
        typing: false
      }).catch(() => undefined);
      return;
    }
    const timer = setTimeout(() => {
      try {
        tinodeAdapter.current?.noteTyping();
      } catch {
        // Converact Fabric typing remains available while Tinode reconnects.
      }
      void apiPost(buildCollaborationTypingPath(sessionId), {
        identity,
        typing: true,
        ttl_ms: 8_000
      }).catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, identity, sessionId]);

  const { connected } = useWebSocket((type, data) => {
    if (
      type === 'collaboration.message.receipt_updated' ||
      type === 'collaboration.typing.updated' ||
      type === 'collaboration.presence.updated'
    ) {
      void refreshMessageState().catch(() => undefined);
      return;
    }
    if (type === 'collaboration.message.edited' || type === 'collaboration.message.deleted') {
      const mutation = data && typeof data === 'object'
        ? data as { session_id?: string; message?: CollaborationChatMessage }
        : {};
      if (mutation.session_id === sessionId && mutation.message) {
        setSnapshot((current) => current ? {
          ...current,
          messages: current.messages.map((message) =>
            message.id === mutation.message?.id ? mutation.message : message
          )
        } : current);
      }
      return;
    }
    if (type !== CHAT_MESSAGE_EVENT) return;
    const event = readCollaborationChatEvent(type, data, sessionId);
    if (!event) return;
    setSnapshot((current) => {
      if (!current) return current;
      if (current.messages.some((message) => message.id === event.message.id)) return current;
      return {
        ...current,
        messages: [...current.messages, event.message],
        policy_events: [...event.policy.events, ...current.policy_events]
      };
    });
    if (event.message.sender_identity !== identity) {
      void reportReceipt(event.message.id, 'read', 'ivekit').catch(() => undefined);
    }
    if (event.policy.matched) setNotice('这条消息命中了防绕单规则');
  });

  const policyByMessage = useMemo(() => {
    const map = new Map<string, CollaborationPolicyEvent[]>();
    for (const event of snapshot?.policy_events || []) {
      const list = map.get(event.message_id) || [];
      list.push(event);
      map.set(event.message_id, list);
    }
    return map;
  }, [snapshot?.policy_events]);

  const realtimeByIdentity = useMemo(
    () => new Map(realtimeStates.map((state) => [state.identity, state])),
    [realtimeStates]
  );

  const typingNames = useMemo(
    () => realtimeStates
      .filter((state) => state.typing && state.identity !== identity)
      .map((state) => state.identity),
    [identity, realtimeStates]
  );

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionId || !draft.trim()) return;
    setError('');
    setNotice('');
    try {
      const result = await apiPost<{
        message: CollaborationChatMessage;
        policy: { matched: boolean; events: CollaborationPolicyEvent[] };
      }>(buildCollaborationMessagesPath(sessionId), {
        sender_identity: getUserId() || 'agent',
        body: draft.trim()
      });
      setDraft('');
      setSnapshot((current) => {
        if (!current) return current;
        if (current.messages.some((message) => message.id === result.message.id)) return current;
        return {
          ...current,
          messages: [...current.messages, result.message],
          policy_events: [...result.policy.events, ...current.policy_events]
        };
      });
      if (result.policy.matched) setNotice('这条消息命中了防绕单规则');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!sessionId) {
    return <div className="p-6 text-sm text-red-600">缺少 session_id</div>;
  }

  return (
    <div className="h-[calc(100vh-120px)] min-h-[620px] grid grid-cols-[260px_1fr] bg-white border border-gray-200 rounded-lg overflow-hidden">
      <aside className="border-r bg-gray-50 flex flex-col">
        <div className="px-4 py-3 border-b">
          <div className="text-sm font-semibold text-gray-900">协作聊天</div>
          <div className="text-xs text-gray-500 mt-1">{snapshot?.session.business_ref_id || sessionId}</div>
        </div>
        <div className="px-4 py-3 border-b text-xs text-gray-600">
          <div>{providerLabel(snapshot?.binding || null)}</div>
          <div className={connected ? 'text-green-600 mt-1' : 'text-gray-400 mt-1'}>
            {connected ? '实时通道已连接' : '实时通道未连接'}
          </div>
          {snapshot?.binding?.provider === 'tinode' && (
            <>
              <div className={clientPlan ? 'text-green-600 mt-1' : 'text-gray-400 mt-1'}>
                {clientPlan ? 'Tinode 客户端凭证已准备' : 'Tinode 客户端凭证待准备'}
              </div>
              <div className={tinodeConnection === 'connected' ? 'text-green-600 mt-1' : 'text-gray-400 mt-1'}>
                Tinode 实时连接：{tinodeConnection === 'connected' ? '已连接' : tinodeConnection === 'connecting' ? '连接中' : '未连接'}
              </div>
            </>
          )}
          <div className="mt-1">未读：{unreadCount}</div>
        </div>
        <div className="px-4 py-3 overflow-y-auto">
          <div className="text-xs font-medium text-gray-500 mb-2">参与人</div>
          <div className="space-y-2">
            {(snapshot?.participants || []).map((participant) => (
              <div key={participant.id} className="text-sm">
                <div className="font-medium text-gray-800">{participant.display_name || participant.identity}</div>
                <div className="text-xs text-gray-400">
                  {participant.role} · {realtimeByIdentity.get(participant.identity)?.presence_status || 'offline'}
                  {realtimeByIdentity.get(participant.identity)?.typing ? ' · 正在输入' : ''}
                </div>
              </div>
            ))}
            {!snapshot?.participants?.length && <div className="text-xs text-gray-400">暂无参与人</div>}
          </div>
        </div>
      </aside>

      <main className="flex flex-col min-w-0">
        <div className="px-5 py-3 border-b flex items-center justify-between gap-3">
          <div>
            <div className="text-base font-semibold text-gray-900">{snapshot?.session.title || '聊天会话'}</div>
            <div className="text-xs text-gray-500">
              {snapshot?.session.business_ref_type || 'session'} · {snapshot?.session.business_ref_id || sessionId}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadChat()}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
          >
            刷新
          </button>
        </div>

        {notice && <div className="px-5 py-2 bg-amber-50 text-amber-700 text-sm">{notice}</div>}
        {error && <div className="px-5 py-2 bg-red-50 text-red-700 text-sm">{error}</div>}
        {typingNames.length > 0 && (
          <div className="px-5 py-2 text-xs text-gray-500">{typingNames.join('、')} 正在输入</div>
        )}

        <div className="flex-1 overflow-y-auto bg-slate-50 px-5 py-4 space-y-3">
          {(snapshot?.messages || []).map((message) => {
            const mine = message.sender_identity === (getUserId() || 'agent');
            const risks = policyByMessage.get(message.id) || [];
            return (
              <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[72%] px-3 py-2 text-sm rounded ${
                  mine ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-900'
                }`}>
                  <div className={`text-[11px] mb-1 ${mine ? 'text-blue-100' : 'text-gray-400'}`}>
                    {message.sender_identity} · {formatChatTime(message.created_at)}
                  </div>
                  <div className={`whitespace-pre-wrap break-words ${message.deleted_at ? 'italic opacity-70' : ''}`}>
                    {message.deleted_at ? '消息已删除' : message.body}
                  </div>
                  {!message.deleted_at && message.edited_at && (
                    <div className={`mt-1 text-[11px] ${mine ? 'text-blue-100' : 'text-gray-400'}`}>已编辑</div>
                  )}
                  {risks.length > 0 && (
                    <div className={`mt-2 text-xs ${mine ? 'text-amber-100' : 'text-amber-700'}`}>
                      命中：{risks.map(riskLabel).join('、')}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {!snapshot?.messages?.length && <div className="text-sm text-gray-400 text-center mt-20">暂无消息</div>}
        </div>

        <form onSubmit={sendMessage} className="p-4 border-t flex gap-2">
          <input
            className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="输入消息..."
          />
          <button
            type="submit"
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm disabled:bg-gray-300"
            disabled={!draft.trim()}
          >
            发送
          </button>
        </form>
      </main>
    </div>
  );
}
