export type AcdStrategy = 'longest_idle' | 'least_calls' | 'skill_priority' | 'round_robin' | 'predictive_heuristic';

export type DidRouteType = 'queue' | 'ai' | 'ivr' | 'voicemail';

export type AfterHoursRouteType = 'announcement' | 'voicemail' | 'ai' | 'queue';

export interface CallQueueRow {
  id: string;
  tenant_id: string;
  name: string;
  strategy: AcdStrategy;
  max_wait_sec: number;
  max_size: number;
  overflow_target: string | null;
  music_url: string | null;
  callback_after_sec: number;
  is_active: boolean;
  created_at: string;
}

export interface DidNumberRow {
  id: string;
  tenant_id: string | null;
  number: string;
  label: string | null;
  route_type: DidRouteType;
  route_target: string | null;
  is_active: boolean;
  created_at: string;
}

export interface QueueEntryRow {
  id: string;
  queue_id: string;
  call_session_id: string;
  position: number;
  priority: number;
  assigned_seat_id: string | null;
  entered_at: string;
  answered_at: string | null;
  abandoned_at: string | null;
}

export interface QueueStatusSnapshot {
  queue_id: string;
  queue_name: string;
  waiting_count: number;
  available_agents: number;
  avg_wait_sec: number;
  estimated_wait_sec: number;
  entries: Array<{
    entry_id: string;
    call_session_id: string;
    position: number;
    priority: number;
    wait_sec: number;
  }>;
}

export interface InboundRouteContext {
  tenant_id: string;
  call_session_id?: string;
  queue_id?: string;
  queue_entry_id?: string;
  queue_position?: number;
  estimated_wait_sec?: number;
  assigned_seat_id?: string;
  overflow_applied?: boolean;
  after_hours?: boolean;
}
