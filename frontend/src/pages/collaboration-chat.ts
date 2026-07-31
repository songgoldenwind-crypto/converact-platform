export interface CollaborationChatMessage {
  id: string;
  tenant_id?: string;
  session_id?: string;
  sender_identity: string;
  message_type: string;
  body: string;
  metadata?: Record<string, unknown>;
  edit_version?: number;
  edited_at?: string | null;
  deleted_at?: string | null;
  deleted_by?: string;
  created_at: string;
}

export interface CollaborationPolicyEvent {
  id: string;
  policy_type: string;
  severity: string;
  message_id: string;
  created_at: string;
}

export interface CollaborationChatClientPlan {
  provider: 'tinode' | 'local' | string;
  provider_topic_id: string;
  provider_user_id: string;
  auth_token: string;
  ws_url: string;
  api_key: string;
}

export interface CollaborationChatEvent {
  session_id: string;
  message: CollaborationChatMessage;
  policy: {
    matched: boolean;
    events: CollaborationPolicyEvent[];
  };
}

export function buildCollaborationChatPath(sessionId: string): string {
  return `/api/collaboration/sessions/${encodeURIComponent(sessionId)}/chat`;
}

export function buildCollaborationChatClientPlanPath(sessionId: string): string {
  return `/api/collaboration/sessions/${encodeURIComponent(sessionId)}/chat/client-plan`;
}

export function buildCollaborationMessagesPath(sessionId: string): string {
  return `/api/collaboration/sessions/${encodeURIComponent(sessionId)}/messages`;
}

export function buildCollaborationMessageReceiptPath(sessionId: string, messageId: string): string {
  return `/api/collaboration/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/receipts`;
}

export function buildCollaborationMessageStatePath(sessionId: string): string {
  return `/api/collaboration/sessions/${encodeURIComponent(sessionId)}/message-state`;
}

export function buildCollaborationTypingPath(sessionId: string): string {
  return `/api/collaboration/sessions/${encodeURIComponent(sessionId)}/typing`;
}

export function buildCollaborationPresencePath(sessionId: string): string {
  return `/api/collaboration/sessions/${encodeURIComponent(sessionId)}/presence`;
}

export function buildCollaborationRealtimeStatePath(sessionId: string): string {
  return `/api/collaboration/sessions/${encodeURIComponent(sessionId)}/realtime-state`;
}

export function sameCollaborationChatClientPlan(
  left: CollaborationChatClientPlan | null,
  right: CollaborationChatClientPlan | null
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.provider === right.provider &&
    left.provider_topic_id === right.provider_topic_id &&
    left.provider_user_id === right.provider_user_id &&
    left.auth_token === right.auth_token &&
    left.ws_url === right.ws_url &&
    left.api_key === right.api_key;
}

export function latestReadableMessageId(
  messages: CollaborationChatMessage[],
  identity: string
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.sender_identity !== identity && !message.deleted_at) return message.id;
  }
  return '';
}

export function readCollaborationChatEvent(
  type: string,
  data: unknown,
  sessionId: string
): CollaborationChatEvent | null {
  if (type !== 'collaboration.message.created') return null;
  if (!data || typeof data !== 'object') return null;
  const event = data as Partial<CollaborationChatEvent>;
  if (event.session_id !== sessionId) return null;
  if (!event.message || typeof event.message !== 'object') return null;
  return {
    session_id: event.session_id,
    message: event.message as CollaborationChatMessage,
    policy: event.policy || { matched: false, events: [] }
  };
}
