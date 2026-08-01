import type {
  ConveractFabricChatMessage,
  ConveractFabricChatPin,
  ConveractFabricChatReaction,
  ConveractFabricChatRealtimeState,
  ConveractFabricChatReceipt
} from '@converact/sdk';
import type { ChatConnectionState } from './types.js';

export type ChatClientMessage = ConveractFabricChatMessage & {
  client_state?: 'sending' | 'retry_wait' | 'failed';
  client_error?: string;
  client_idempotency_key?: string;
};

export interface ChatState {
  messages: ChatClientMessage[];
  realtime: ConveractFabricChatRealtimeState[];
  pins: ConveractFabricChatPin[];
  receipts: ConveractFabricChatReceipt[];
  unreadCount: number;
  requestId: number;
  historyPrependCount: number;
  connection: ChatConnectionState;
  closed: boolean;
}

export type ChatAction =
  | { type: 'reset' }
  | { type: 'request_started'; requestId: number }
  | { type: 'loaded'; requestId: number; messages: ConveractFabricChatMessage[]; realtime?: ConveractFabricChatRealtimeState[]; unreadCount?: number; pins?: ConveractFabricChatPin[]; receipts?: ConveractFabricChatReceipt[] }
  | { type: 'history_prepended'; requestId: number; messages: ConveractFabricChatMessage[] }
  | { type: 'converged'; messages: ConveractFabricChatMessage[] }
  | { type: 'optimistic_sent'; message: ConveractFabricChatMessage; idempotencyKey: string }
  | { type: 'send_succeeded'; requestId: number; localId: string; message: ConveractFabricChatMessage }
  | { type: 'send_retrying'; localId: string }
  | { type: 'send_failed'; requestId: number; localId: string; retryable: boolean; error: string }
  | { type: 'message_state_updated'; requestId: number; unreadCount: number; receipts?: ConveractFabricChatReceipt[] }
  | { type: 'realtime_updated'; realtime: ConveractFabricChatRealtimeState[] }
  | { type: 'realtime_expired'; now: number }
  | { type: 'message_edited'; requestId: number; message: ConveractFabricChatMessage }
  | { type: 'message_deleted'; requestId: number; message: ConveractFabricChatMessage }
  | { type: 'reactions_updated'; requestId: number; messageId: string; reactions: ConveractFabricChatReaction[] }
  | { type: 'pins_updated'; requestId: number; pins: ConveractFabricChatPin[] }
  | { type: 'connection_changed'; connection: ChatConnectionState }
  | { type: 'session_closed' };

export function initialChatState(): ChatState {
  return {
    messages: [],
    realtime: [],
    pins: [],
    receipts: [],
    unreadCount: 0,
    requestId: 0,
    historyPrependCount: 0,
    connection: 'idle',
    closed: false
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (
    action.type !== 'request_started' &&
    action.type !== 'loaded' &&
    'requestId' in action &&
    action.requestId !== state.requestId
  ) return state;
  switch (action.type) {
    case 'reset':
      return initialChatState();
    case 'request_started':
      return action.requestId < state.requestId ? state : { ...state, requestId: action.requestId };
    case 'loaded':
      if (action.requestId < state.requestId) return state;
      return markPins({
        ...state,
        requestId: action.requestId,
        messages: mergeMessages([], action.messages),
        realtime: action.realtime || [],
        pins: action.pins || [],
        receipts: action.receipts || [],
        unreadCount: action.unreadCount ?? 0,
        historyPrependCount: 0
      });
    case 'history_prepended': {
      const existing = new Set(state.messages.map((message) => message.id));
      const added = new Set(action.messages.filter((message) => !existing.has(message.id)).map((message) => message.id)).size;
      return { ...state, messages: mergeMessages(action.messages, state.messages), historyPrependCount: added };
    }
    case 'converged':
      return markPins({ ...state, messages: mergeMessages(state.messages, action.messages) });
    case 'optimistic_sent':
      if (state.closed) return state;
      return {
        ...state,
        messages: mergeMessages(state.messages, [{
          ...action.message,
          client_state: 'sending',
          client_idempotency_key: action.idempotencyKey
        }])
      };
    case 'send_succeeded':
      return markPins({
        ...state,
        messages: mergeMessages(
          state.messages.filter((message) => message.id !== action.localId),
          [action.message]
        )
      });
    case 'send_retrying':
      return {
        ...state,
        messages: state.messages.map((message) => message.id === action.localId
          ? { ...message, client_state: 'sending', client_error: undefined }
          : message)
      };
    case 'send_failed':
      return {
        ...state,
        messages: state.messages.map((message) => message.id === action.localId ? {
          ...message,
          client_state: action.retryable ? 'retry_wait' : 'failed',
          client_error: action.error
        } : message)
      };
    case 'message_state_updated':
      return {
        ...state,
        unreadCount: Math.max(0, Math.floor(action.unreadCount)),
        receipts: action.receipts ? mergeReceipts(state.receipts, action.receipts) : state.receipts
      };
    case 'realtime_updated':
      return { ...state, realtime: dedupeRealtime(action.realtime) };
    case 'realtime_expired':
      return { ...state, realtime: state.realtime.map((item) => expireRealtime(item, action.now)) };
    case 'message_edited':
    case 'message_deleted':
      return markPins({ ...state, messages: mergeMessages(state.messages, [action.message]) });
    case 'reactions_updated':
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === action.messageId ? { ...message, reactions: action.reactions } : message
        )
      };
    case 'pins_updated':
      return markPins({ ...state, pins: action.pins });
    case 'connection_changed':
      return { ...state, connection: action.connection };
    case 'session_closed':
      return { ...state, closed: true, connection: 'closed' };
  }
}

function mergeMessages(
  current: readonly ChatClientMessage[],
  incoming: readonly ChatClientMessage[]
): ChatClientMessage[] {
  const merged = new Map<string, ChatClientMessage>();
  for (const message of current) merged.set(message.id, message);
  for (const message of incoming) merged.set(message.id, message);
  return [...merged.values()].sort((left, right) =>
    left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
  );
}

function markPins(state: ChatState): ChatState {
  const pinned = new Set(state.pins.map((pin) => pin.message_id));
  return { ...state, messages: state.messages.map((message) => ({ ...message, pinned: pinned.has(message.id) })) };
}

function dedupeRealtime(items: readonly ConveractFabricChatRealtimeState[]): ConveractFabricChatRealtimeState[] {
  return [...new Map(items.map((item) => [item.identity, item])).values()];
}

function mergeReceipts(
  current: readonly ConveractFabricChatReceipt[],
  incoming: readonly ConveractFabricChatReceipt[]
): ConveractFabricChatReceipt[] {
  const merged = new Map(current.map((receipt) => [`${receipt.message_id}:${receipt.identity}`, receipt]));
  for (const receipt of incoming) merged.set(`${receipt.message_id}:${receipt.identity}`, receipt);
  return [...merged.values()];
}

function expireRealtime(item: ConveractFabricChatRealtimeState, now: number): ConveractFabricChatRealtimeState {
  const presenceExpired = item.presence_expires_at
    ? new Date(item.presence_expires_at).getTime() <= now
    : item.presence_status !== 'offline';
  const typingExpired = item.typing_expires_at
    ? new Date(item.typing_expires_at).getTime() <= now
    : item.typing;
  return {
    ...item,
    presence_status: presenceExpired ? 'offline' : item.presence_status,
    typing: typingExpired ? false : item.typing
  };
}
