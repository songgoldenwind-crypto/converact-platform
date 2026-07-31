export type DependencyStatus = 'ready' | 'blocked';
export type TerminalDecision = 'continue' | 'completed' | 'blocked' | 'stopped';
export type FailureType = 'external' | 'reasoning' | 'input_contract' | 'unknown';
export type RecoveryStrategy = 'targeted_fix' | 'bounded_retry' | 'fallback' | 'halt';
export type QualityStatus = 'pass' | 'warn' | 'fail';
export type FeedbackActionType =
  | 'tighten_lead_scoring'
  | 'refresh_script_angles'
  | 'prioritize_verified_channels'
  | 'prepare_next_batch';
export type FeedbackActionStatus = 'pending' | 'applied' | 'verified' | 'dismissed' | 'superseded';

export interface ContextCompressionConfig {
  retain: string[];
  maxChars: number;
}

export interface BuildContextEnvelopeInput {
  tenantId: string;
  runId: string;
  phase: string;
  slices: Record<string, unknown>;
  compression?: ContextCompressionConfig;
  compressionTrace?: ContextCompressionTrace;
  resumeToken?: string;
}

export interface ContextCompressionTrace {
  phase: string;
  max_chars: number;
  total_before_chars: number;
  total_after_chars: number;
  retained_count: number;
  discarded_count: number;
  retained_categories: string[];
  discarded_categories: string[];
  retained_ids: string[];
  discarded_ids: string[];
  critical_open_loops_retained: boolean;
  /** I73: compression discard audit (in-memory trace + particle persist) */
  discard_audit?: {
    discarded_categories: string[];
    discarded_count: number;
    retained_count: number;
    audited_at: string;
  };
}

export interface ContextEnvelope {
  isolation_scope: string;
  phase: string;
  loaded_slices: string[];
  compressed_context: Record<string, unknown>;
  compression_applied: boolean;
  compression_trace: ContextCompressionTrace;
  resume_token: string;
}

export interface ControlDependency {
  id: string;
  status: string;
}

export interface ControlDecisionInput {
  phase: string;
  plannedAction: string;
  dependencies: ControlDependency[];
}

export interface ControlDecision {
  phase: string;
  dependency_status: DependencyStatus;
  terminal_decision: TerminalDecision;
  next_action: string;
  stop_reason?: string;
}

export interface RecoveryError {
  name?: string;
  code?: string;
  message?: string;
}

export interface RecoveryInput {
  phase: string;
  stepId: string;
  attempt: number;
  maxRetries: number;
  error?: RecoveryError;
}

export interface RecoveryDecision {
  phase: string;
  step_id: string;
  failure_type: FailureType;
  strategy: RecoveryStrategy;
  retryable: boolean;
  next_attempt: number | null;
  stop_reason?: string;
}

export interface FeedbackReceipt {
  contacted_leads: number;
  replied_leads: number;
  booked_calls: number;
  bounce_rate: number;
}

export interface FeedbackThresholds {
  min_reply_rate: number;
  min_booking_rate: number;
  max_bounce_rate: number;
}

export interface FeedbackInput {
  goal: string;
  stage: string;
  receipt: FeedbackReceipt;
  thresholds: FeedbackThresholds;
}

export interface FeedbackDecision {
  goal: string;
  stage: string;
  quality_status: QualityStatus;
  drift_detected: boolean;
  adjustment_actions: FeedbackActionType[];
  action_recommendations: FeedbackActionRecommendation[];
  metrics: {
    reply_rate: number;
    booking_rate: number;
    bounce_rate: number;
  };
}

export interface FeedbackActionRecommendation {
  action_type: FeedbackActionType;
  status: FeedbackActionStatus;
  scope: 'lead_acquisition_run';
  reason: string;
  metrics: {
    reply_rate: number;
    booking_rate: number;
    bounce_rate: number;
  };
}
