import type { ConveractFabricChatMessage, ConveractFabricChatRealtimeState, ConveractFabricChatSession } from '@converact/sdk';

export function projectSessionSummary(
  session: ConveractFabricChatSession,
  messages: ConveractFabricChatMessage[],
  realtime: ConveractFabricChatRealtimeState[],
  unreadCount: number
): ConveractFabricChatSession {
  const latest = messages.at(-1);
  return {
    ...session,
    summary: {
      unread_count: Math.max(0, unreadCount),
      online_participant_count: realtime.filter((item) => item.presence_status === 'online').length,
      last_message: latest ? {
        id: latest.id,
        body: latest.deleted_at ? '' : latest.body,
        sender_identity: latest.sender_identity,
        message_type: latest.message_type,
        created_at: latest.created_at,
        deleted: Boolean(latest.deleted_at)
      } : null
    }
  };
}
