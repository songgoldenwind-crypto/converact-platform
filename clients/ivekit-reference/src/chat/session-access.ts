import type {
  IveKitChatMessage,
  IveKitChatParticipant,
  IveKitChatPin,
  IveKitChatReaction,
  IveKitChatSession,
  IveKitPolicyFinding
} from '@opc/ivekit-sdk';

export interface CollaborationRealtimeEnvelope {
  type?: string;
  data?: {
    session_id?: string;
    participant?: { identity?: string };
    message_id?: string;
    message?: IveKitChatMessage;
    reactions?: IveKitChatReaction[];
    pins?: IveKitChatPin[];
    finding?: IveKitPolicyFinding;
  };
}

export function sessionAllowsWrites(
  session: Pick<IveKitChatSession, 'status'>,
  participants: Pick<IveKitChatParticipant, 'identity' | 'left_at'>[],
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
