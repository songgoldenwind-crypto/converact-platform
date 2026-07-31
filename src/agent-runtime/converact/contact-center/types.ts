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
export type ContactCenterOverflowActionKind = 'queue' | 'voicemail' | 'hangup' | 'external';
export type ContactCenterOverflowActionState = 'pending' | 'retry_wait' | 'completed' | 'failed';

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

export interface ContactCenterListInput {
  tenant_id: string;
  limit?: number;
  cursor?: string;
  status?: string;
}

export interface ContactCenterPage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ContactCenterQueueEstimateInput {
  position: number;
  average_handle_seconds: number;
  available_agents: number;
}

export interface ContactCenterQueue {
  id: string;
  tenant_id: string;
  name: string;
  routing_strategy: ContactCenterRoutingStrategy;
  max_wait_seconds: number;
  max_size: number;
  callback_after_seconds: number;
  overflow_action: 'none' | 'queue' | 'voicemail' | 'hangup' | 'external';
  overflow_queue_id: string | null;
  overflow_target: string;
  service_level_seconds: number;
  status: ContactCenterQueueStatus;
  metadata: Record<string, unknown>;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface ContactCenterSkill {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  status: ContactCenterAgentStatus;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface ContactCenterAgent {
  id: string;
  tenant_id: string;
  identity: string;
  display_name: string;
  voice_extension_id: string | null;
  status: ContactCenterAgentStatus;
  voice_capacity: number;
  metadata: Record<string, unknown>;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface ContactCenterAgentSkill {
  skill_id: string;
  proficiency: number;
}

export interface ContactCenterQueueMembership {
  queue_id: string;
  agent_id: string;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ContactCenterAgentSnapshot {
  agent: ContactCenterAgent;
  presence: ContactCenterAgentPresence;
  skills: ContactCenterAgentSkill[];
}

export interface ContactCenterQueueConfiguration {
  queue: ContactCenterQueue;
  memberships: ContactCenterQueueMembership[];
  skill_requirements: ContactCenterSkillRequirement[];
}

export interface ContactCenterConfigurationIdempotencyRecord {
  tenant_id: string;
  idempotency_key: string;
  resource_type: 'skill' | 'agent' | 'queue';
  payload_hash: string;
  resource_id: string;
  created_at: string;
}

export interface ContactCenterAgentPresence {
  tenant_id: string;
  agent_id: string;
  state: ContactCenterPresenceState;
  active_voice_count: number;
  voice_capacity: number;
  current_call_id: string | null;
  idle_since: string | null;
  heartbeat_at: string | null;
  session_ref: string;
  revision: number;
  updated_at: string;
}

export interface ContactCenterQueueEntry {
  id: string;
  tenant_id: string;
  queue_id: string;
  call_id: string;
  state: ContactCenterQueueEntryState;
  priority: number;
  idempotency_key: string;
  payload_hash: string;
  entered_at: string;
  offered_at: string | null;
  assigned_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  timeout_at: string | null;
  outcome_reason: string;
  metadata: Record<string, unknown>;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ContactCenterAssignment {
  id: string;
  tenant_id: string;
  queue_entry_id: string;
  agent_id: string;
  capacity_slot: number;
  state: ContactCenterAssignmentState;
  attempt: number;
  idempotency_key: string;
  offer_expires_at: string;
  accepted_at: string | null;
  connected_at: string | null;
  completed_at: string | null;
  outcome_reason: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ContactCenterQueueEntryListInput {
  tenant_id: string;
  queue_id: string;
  state?: ContactCenterQueueEntryState;
  limit?: number;
  cursor?: string;
}

export interface ContactCenterQueueEntrySnapshot {
  entry: ContactCenterQueueEntry;
  assignments: ContactCenterAssignment[];
}

export interface ContactCenterCallbackRecord {
  id: string;
  tenant_id: string;
  queue_id: string;
  queue_entry_id: string;
  source_call_id: string;
  outbound_call_id: string | null;
  business_ref_type: string;
  business_ref_id: string;
  address_kind: 'e164' | 'extension' | 'sip_uri';
  address_ciphertext: string;
  address_hmac: string;
  address_redacted: string;
  state: ContactCenterCallbackState;
  scheduled_for: string | null;
  attempt_count: number;
  max_attempts: number;
  idempotency_key: string;
  requested_by: string;
  cancelled_by: string;
  failure_code: string;
  revision: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ContactCenterCallback {
  id: string;
  tenant_id: string;
  queue_id: string;
  queue_entry_id: string;
  source_call_id: string;
  outbound_call_id: string | null;
  business_ref: { type: string; id: string };
  address: { kind: ContactCenterCallbackRecord['address_kind']; redacted: string };
  state: ContactCenterCallbackState;
  scheduled_for: string | null;
  attempt_count: number;
  max_attempts: number;
  requested_by: string;
  cancelled_by: string;
  failure_code: string;
  revision: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ContactCenterCallbackListInput {
  tenant_id: string;
  queue_id?: string;
  state?: ContactCenterCallbackState;
  limit?: number;
  cursor?: string;
}

export interface ContactCenterSupervisorSession {
  id: string;
  tenant_id: string;
  call_id: string;
  target_agent_id: string;
  supervisor_identity: string;
  mode: ContactCenterSupervisorMode;
  state: ContactCenterSupervisorSessionState;
  authorization_ref: string;
  idempotency_key: string;
  provider_session_id: string;
  reason: string;
  requested_at: string;
  started_at: string | null;
  ended_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ContactCenterOverflowAction {
  id: string;
  tenant_id: string;
  source_entry_id: string;
  source_queue_id: string;
  call_id: string;
  priority: number;
  action: ContactCenterOverflowActionKind;
  target_queue_id: string | null;
  target: string;
  state: ContactCenterOverflowActionState;
  idempotency_key: string;
  attempt_count: number;
  max_attempts: number;
  scheduled_for: string;
  result_ref: string;
  error_code: string;
  revision: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
