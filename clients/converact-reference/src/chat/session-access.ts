import type {
  ConveractFabricChatMessage,
  ConveractFabricChatParticipant,
  ConveractFabricChatPin,
  ConveractFabricChatReaction,
  ConveractFabricChatSession,
  ConveractFabricPolicyFinding
} from '@converact/sdk';

export interface CollaborationRealtimeEnvelope {
  type?: string;
  data?: {
    session_id?: string;
    participant?: { identity?: string };
    message_id?: string;
    message?: ConveractFabricChatMessage;
    reactions?: ConveractFabricChatReaction[];
    pins?: ConveractFabricChatPin[];
    finding?: ConveractFabricPolicyFinding;
  };
}

export function sessionAllowsWrites(
  session: Pick<ConveractFabricChatSession, 'status'>,
  participants: Pick<ConveractFabricChatParticipant, 'identity' | 'left_at'>[],
  identity: string
): boolean {
  return session.status === 'open' && participants.some(
    (participant) => participant.identity === identity && !participant.left_at
  );
}

export function eventRevokesSession(envelope: CollaborationRealtimeEnvelope, identity: string): boolean {
  if (envelope.type === 'collaboration.session.closed') return true;
  return envelope.type === 'collaboration.participant.left' &&
    envelope.data?.participant?.identity === identity;
}
