export type CallRouterAction = 'forward' | 'queue' | 'reject' | 'ivr' | 'voicemail' | 'not_handled';

export interface CallRouterRequest {
  call_id: string;
  from_uri?: string;
  from?: string;
  to_uri?: string;
  to?: string;
  from_display?: string;
  direction: 'inbound' | 'outbound';
  transport?: string;
  trunk_name?: string;
  headers?: Record<string, string>;
  timestamp?: string;
}

export interface CallRouterResponse {
  action: CallRouterAction;
  targets?: string[];
  timeout_sec?: number;
  queue_name?: string;
  priority?: number;
  code?: number;
  reason?: string;
  record?: boolean;
  metadata?: Record<string, string>;
  caller_id_override?: string;
}

export interface RustPBXCDR {
  call_id: string;
  from_uri?: string;
  to_uri?: string;
  direction: 'inbound' | 'outbound';
  start_time?: string;
  answer_time?: string | null;
  end_time?: string;
  duration_sec?: number;
  ring_duration_sec?: number;
  hangup_cause?: string;
  hangup_by?: string;
  trunk_name?: string;
  recording_url?: string | null;
  metadata?: Record<string, string>;
}

export type OutboundTaskChannel = 'pstn_voice' | 'video_link_sms' | 'video_link_wechat';
export type OutboundTaskStatus = 'pending' | 'dialing' | 'connected' | 'completed' | 'failed' | 'cancelled';

export interface OutboundTaskStrategy {
  script_id?: string;
  agent_spec_id?: string;
  language?: 'ja' | 'en' | 'zh';
  avatar_id?: string;
  max_duration_sec?: number;
  transfer_threshold?: number;
  source?: string;
  queue_callback_id?: string;
  queue_id?: string;
  original_call_session_id?: string | null;
  dial_mode?: 'preview' | 'progressive' | 'predictive';
  campaign_id?: string;
  campaign_contact_id?: string;
  ab_variant?: 'A' | 'B';
  assigned_seat_id?: string;
  preview_confirmed?: boolean;
  omni_conversation_id?: string;
  context_summary?: string;
}

export interface CreateOutboundTaskInput {
  tenant_id: string;
  lead_id?: string;
  phone_number: string;
  channel: OutboundTaskChannel;
  strategy?: OutboundTaskStrategy;
  scheduled_at?: string | null;
  max_attempts?: number;
  priority?: number;
  campaign_id?: string;
  campaign_contact_id?: string;
}

export type AgentSeatStatus =
  | 'offline'
  | 'idle'
  | 'busy'
  | 'break'
  | 'away'
  | 'training'
  | 'lunch'
  | 'wrap_up';

/** Statuses where the seat can receive transferred calls. */
export const AGENT_SEAT_AVAILABLE_STATUSES: ReadonlySet<AgentSeatStatus> = new Set(['idle']);

export const AGENT_SEAT_STATUSES: readonly AgentSeatStatus[] = [
  'offline',
  'idle',
  'busy',
  'away',
  'training',
  'lunch',
  'wrap_up'
];

export interface UpsertAgentSeatInput {
  tenant_id: string;
  user_id: string;
  display_name: string;
  skills?: string[];
  rustpbx_extension?: string;
  livekit_identity?: string;
}

export type { MediaRoomPurpose as LiveKitRoomPurpose } from '../livekit/types.js';

export type ConversationRole = 'customer' | 'ai' | 'system' | 'agent';

export interface ReportTurnRequest {
  role: ConversationRole;
  content: string;
  stt_confidence?: number;
  latency_ms?: number;
}

export interface ReportIntentRequest {
  intent_score: number;
  signals?: string[];
}

export type AgentDispatchAction = 'transfer_to_human' | 'end_call' | 'schedule_callback';

export interface AgentDispatchRequest {
  tenant_id: string;
  room_name: string;
  action: AgentDispatchAction;
  reason: string;
  customer_summary: string;
  call_session_id?: string;
  intent_score?: number;
  conversation_turns?: number;
  language?: string;
  required_skills?: string[];
  callback_time?: string;
  callback_phone?: string;
}

export type AgentDispatchActionTaken =
  | 'seat_assigned'
  | 'queued'
  | 'no_seats_available'
  | 'callback_scheduled'
  | 'call_ended';

export type VoiceAgentSpecStatus = 'draft' | 'published';
export type VoiceAgentSpecLanguage = 'zh' | 'en' | 'ja' | 'vi';

export interface VoiceAgentSpecRuntime {
  system_prompt: string;
  greeting: string;
  transfer_message?: string;
  end_message?: string;
}

export interface VoiceAgentSpecCompliance {
  ai_disclosure?: string;
  forbidden_topics?: string[];
}

export interface VoiceAgentSpecNode {
  id: string;
  name: string;
  prompt?: string;
  transitions?: Record<string, string>;
}

export interface VoiceAgentSpec {
  id: string;
  tenant_id: string;
  language: VoiceAgentSpecLanguage;
  goal: string;
  status: VoiceAgentSpecStatus;
  version: number;
  tools: string[];
  compliance: VoiceAgentSpecCompliance;
  runtime: VoiceAgentSpecRuntime;
  nodes: VoiceAgentSpecNode[];
}

export interface CreateVoiceAgentSpecInput {
  id?: string;
  tenant_id: string;
  language?: VoiceAgentSpecLanguage;
  goal?: string;
  status?: VoiceAgentSpecStatus;
  version?: number;
  tools?: string[];
  compliance?: VoiceAgentSpecCompliance;
  runtime: VoiceAgentSpecRuntime;
  nodes?: VoiceAgentSpecNode[];
}

export interface GenerateVoiceAgentSpecInput {
  tenant_id: string;
  goal: string;
  industry?: string;
  language?: VoiceAgentSpecLanguage;
  faq?: string;
  brand_name?: string;
  tone?: 'professional' | 'friendly' | 'formal';
  publish?: boolean;
  extra_instructions?: string;
}

export interface IvrMenuOption {
  key: string;
  label: string;
  target: string;
}

export interface IvrMenuNode {
  id: string;
  name: string;
  prompt: string;
  options?: IvrMenuOption[];
  action?: 'transfer_human' | 'schedule_callback' | 'end_call';
  transitions?: Record<string, string>;
}

export interface ImportIvrVoiceAgentInput {
  tenant_id: string;
  goal?: string;
  language?: VoiceAgentSpecLanguage;
  brand_name?: string;
  root_id?: string;
  menus: IvrMenuNode[];
  publish?: boolean;
}

export interface NavigateCallFlowRequest {
  trigger: string;
  agent_spec_id?: string;
  customer_text?: string;
}
