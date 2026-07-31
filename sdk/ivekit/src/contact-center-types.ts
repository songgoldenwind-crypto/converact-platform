export type IveKitContactCenterAgentStatus = 'active' | 'disabled' | 'archived';
export type IveKitContactCenterPresenceState = 'offline' | 'available' | 'busy' | 'after_call' | 'away';
export type IveKitContactCenterQueueStatus = 'active' | 'disabled' | 'archived';
export type IveKitContactCenterRoutingStrategy =
  'longest_idle' | 'least_calls' | 'round_robin' | 'skill_priority';
export type IveKitContactCenterQueueEntryState =
  'waiting' | 'offered' | 'assigned' | 'answered' | 'completed' | 'abandoned' |
  'timed_out' | 'cancelled' | 'overflowed' | 'callback_requested';
export type IveKitContactCenterAssignmentState =
  'offered' | 'accepted' | 'connected' | 'rejected' | 'expired' | 'revoked' |
  'completed' | 'failed';
export type IveKitContactCenterCallbackState =
  'requested' | 'scheduled' | 'dialing' | 'connected' | 'completed' | 'cancelled' | 'failed';
export type IveKitContactCenterSupervisorMode = 'monitor' | 'whisper' | 'barge';

export interface IveKitContactCenterPage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface IveKitContactCenterCapabilities {
  api_version: 'v1';
  tenant_id: string;
  capabilities: {
    agents: boolean;
    skills: boolean;
    presence: boolean;
    queues: boolean;
    memberships: boolean;
    skill_requirements: boolean;
    acd_routing: boolean;
    queue_entries: boolean;
    callbacks: boolean;
    overflow: boolean;
    queue_monitor: boolean;
    supervisor: boolean;
  };
}

export interface IveKitContactCenterSkill {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  status: IveKitContactCenterAgentStatus;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface IveKitContactCenterAgent {
  id: string;
  tenant_id: string;
  identity: string;
  display_name: string;
  voice_extension_id: string | null;
  status: IveKitContactCenterAgentStatus;
  voice_capacity: number;
  metadata: Record<string, unknown>;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface IveKitContactCenterPresence {
  tenant_id: string;
  agent_id: string;
  state: IveKitContactCenterPresenceState;
  active_voice_count: number;
  voice_capacity: number;
  current_call_id: string | null;
  idle_since: string | null;
  heartbeat_at: string | null;
  session_ref: string;
  revision: number;
  updated_at: string;
}

export interface IveKitContactCenterAgentSkill {
  skill_id: string;
  proficiency: number;
}

export interface IveKitContactCenterAgentSnapshot {
  agent: IveKitContactCenterAgent;
  presence: IveKitContactCenterPresence;
  skills: IveKitContactCenterAgentSkill[];
}

export interface IveKitContactCenterQueue {
  id: string;
  tenant_id: string;
  name: string;
  routing_strategy: IveKitContactCenterRoutingStrategy;
  max_wait_seconds: number;
  max_size: number;
  callback_after_seconds: number;
  overflow_action: 'none' | 'queue' | 'voicemail' | 'hangup' | 'external';
  overflow_queue_id: string | null;
  overflow_target: string;
  service_level_seconds: number;
  status: IveKitContactCenterQueueStatus;
  metadata: Record<string, unknown>;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface IveKitContactCenterMembership {
  queue_id: string;
  agent_id: string;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface IveKitContactCenterSkillRequirement {
  skill_id: string;
  minimum_proficiency: number;
}

export interface IveKitContactCenterQueueConfiguration {
  queue: IveKitContactCenterQueue;
  memberships: IveKitContactCenterMembership[];
  skill_requirements: IveKitContactCenterSkillRequirement[];
}

export interface IveKitContactCenterQueueEntry {
  id: string;
  tenant_id: string;
  queue_id: string;
  call_id: string;
  state: IveKitContactCenterQueueEntryState;
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

export interface IveKitContactCenterAssignment {
  id: string;
  tenant_id: string;
  queue_entry_id: string;
  agent_id: string;
  capacity_slot: number;
  state: IveKitContactCenterAssignmentState;
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

export interface IveKitContactCenterQueueEntrySnapshot {
  entry: IveKitContactCenterQueueEntry;
  assignments: IveKitContactCenterAssignment[];
}

export interface IveKitContactCenterCallback {
  id: string;
  tenant_id: string;
  queue_id: string;
  queue_entry_id: string;
  source_call_id: string;
  outbound_call_id: string | null;
  business_ref: { type: string; id: string };
  address: { kind: 'e164' | 'extension' | 'sip_uri'; redacted: string };
  state: IveKitContactCenterCallbackState;
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

export interface IveKitContactCenterSupervisorSession {
  id: string;
  tenant_id: string;
  call_id: string;
  target_agent_id: string;
  supervisor_identity: string;
  mode: IveKitContactCenterSupervisorMode;
  state: 'requested' | 'active' | 'denied' | 'ended' | 'failed';
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

export interface IveKitContactCenterMonitorSnapshot {
  generated_at: string;
  agents: {
    configured: number; active: number; offline: number; available: number;
    busy: number; after_call: number; away: number;
    active_voice_count: number; voice_capacity: number;
  };
  calls: { active_inbound: number; active_outbound: number };
  operations: {
    callbacks_pending: number; callbacks_failed_today: number;
    overflows_pending: number; overflows_failed_today: number;
    supervisor_requested: number; supervisor_active: number;
  };
  queues: Array<{
    queue_id: string; queue_name: string; status: IveKitContactCenterQueueStatus;
    routing_strategy: IveKitContactCenterRoutingStrategy;
    max_wait_seconds: number; service_level_seconds: number;
    waiting_count: number; offered_count: number; assigned_count: number;
    answered_count: number; available_agents: number; available_capacity: number;
    oldest_wait_seconds: number; average_handle_seconds: number;
    estimated_wait_seconds: number | null; answered_today: number;
    answered_in_service_level_today: number; abandoned_today: number;
    timed_out_today: number; overflowed_today: number;
    average_wait_seconds_today: number; service_level_percent_today: number;
    callbacks_pending: number; callbacks_failed_today: number;
    overflows_pending: number; overflows_failed_today: number;
  }>;
  alerts: Array<{
    code: 'queue_without_capacity' | 'service_level_wait' |
      'callback_failures' | 'overflow_failures';
    severity: 'warning' | 'critical';
    queue_id: string;
    value: number;
  }>;
}

export interface IveKitContactCenterListInput {
  status?: string;
  cursor?: string;
  limit?: number;
}

export interface IveKitContactCenterCreateQueueInput {
  name: string;
  routing_strategy?: IveKitContactCenterRoutingStrategy;
  max_wait_seconds?: number;
  max_size?: number;
  callback_after_seconds?: number;
  overflow_action?: IveKitContactCenterQueue['overflow_action'];
  overflow_queue_id?: string | null;
  overflow_target?: string;
  service_level_seconds?: number;
  metadata?: Record<string, unknown>;
  status?: IveKitContactCenterQueueStatus;
}
