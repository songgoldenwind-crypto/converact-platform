export type ContactCenterAgentStatus = 'active' | 'disabled' | 'archived';
export type ContactCenterPresenceState = 'offline' | 'available' | 'busy' | 'after_call' | 'away';
export type ContactCenterRoutingStrategy = 'longest_idle' | 'least_calls' | 'round_robin' | 'skill_priority';
export type ContactCenterQueueStatus = 'active' | 'disabled' | 'archived';
export type ContactCenterQueueEntryState =
  | 'waiting'
  | 'offered'
  | 'assigned'
  | 'answered'
  | 'completed'
  | 'abandoned'
  | 'timed_out'
  | 'cancelled'
  | 'overflowed'
  | 'callback_requested';
export type ContactCenterAssignmentState =
  | 'offered'
  | 'accepted'
  | 'connected'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'completed'
  | 'failed';
export type ContactCenterCallbackState =
  | 'requested'
  | 'scheduled'
  | 'dialing'
  | 'connected'
  | 'completed'
  | 'cancelled'
  | 'failed';
export type ContactCenterSupervisorMode = 'monitor' | 'whisper' | 'barge';
export type ContactCenterSupervisorSessionState = 'requested' | 'active' | 'denied' | 'ended' | 'failed';

export interface ContactCenterRoutingCandidate {
  agent_id: string;
  presence_state: ContactCenterPresenceState;
  active_voice_count: number;
  voice_capacity: number;
  idle_since: string;
  handled_count: number;
  member_priority: number;
  skills: Record<string, number>;
}

export interface ContactCenterSkillRequirement {
  skill_id: string;
  minimum_proficiency: number;
}

export interface ContactCenterQueueEstimateInput {
  position: number;
  average_handle_seconds: number;
  available_agents: number;
}
