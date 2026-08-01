import type { ConveractFabricPolicyFindingReview, ConveractFabricPolicyFindingReviewInput } from './chat-types.js';

export type ConveractFabricProviderCapability =
  | 'ocr'
  | 'asr'
  | 'quality_review'
  | 'translation'
  | 'realtime_speech'
  | 'tts'
  | 'model_gateway';
export type ConveractFabricProviderMode = 'self_hosted' | 'third_party';

interface ConveractFabricIntelligencePolicySettings {
  ocr_enabled: boolean;
  asr_enabled: boolean;
  quality_review_enabled: boolean;
  translation_enabled: boolean;
  allow_third_party: boolean;
  auto_ocr: boolean;
  auto_asr: boolean;
  auto_quality_review: boolean;
  auto_translation: boolean;
  translation_target_languages: string[];
  min_ocr_confidence: number;
  min_asr_confidence: number;
}

interface ConveractFabricRealtimeIntelligencePolicyUpdate {
  realtime_speech_enabled?: boolean;
  tts_enabled?: boolean;
  model_gateway_enabled?: boolean;
  realtime_speech_profile_id?: string;
  tts_profile_id?: string;
  model_gateway_profile_id?: string;
  realtime_speech_profile_ids?: string[];
  tts_profile_ids?: string[];
  model_gateway_profile_ids?: string[];
}

type ConveractFabricRouteNativePolicyProfiles = {
  ocr_profile_id?: string;
  asr_profile_id?: string;
  quality_profile_id?: string;
  translation_profile_id?: string;
  ocr_profile_ids: string[];
  asr_profile_ids: string[];
  quality_profile_ids: string[];
  translation_profile_ids: string[];
};

type ConveractFabricLegacyPolicyProfiles = {
  ocr_profile_id: string;
  asr_profile_id: string;
  quality_profile_id: string;
  translation_profile_id: string;
  ocr_profile_ids?: string[];
  asr_profile_ids?: string[];
  quality_profile_ids?: string[];
  translation_profile_ids?: string[];
};

export type ConveractFabricIntelligencePolicyUpdate = ConveractFabricIntelligencePolicySettings &
  ConveractFabricRealtimeIntelligencePolicyUpdate & (
  | ConveractFabricRouteNativePolicyProfiles
  | ConveractFabricLegacyPolicyProfiles
);

export type ConveractFabricIntelligencePolicy = ConveractFabricIntelligencePolicySettings & {
  realtime_speech_enabled: boolean;
  tts_enabled: boolean;
  model_gateway_enabled: boolean;
  ocr_profile_id: string;
  asr_profile_id: string;
  quality_profile_id: string;
  translation_profile_id: string;
  realtime_speech_profile_id: string;
  tts_profile_id: string;
  model_gateway_profile_id: string;
  ocr_profile_ids: string[];
  asr_profile_ids: string[];
  quality_profile_ids: string[];
  translation_profile_ids: string[];
  realtime_speech_profile_ids: string[];
  tts_profile_ids: string[];
  model_gateway_profile_ids: string[];
  tenant_id: string;
  configured: boolean;
  version: number;
  updated_by: string;
  created_at: string | null;
  updated_at: string | null;
};

export type ConveractFabricIntelligencePolicyWrite = ConveractFabricIntelligencePolicyUpdate & { version: number };

export interface ConveractFabricIntelligenceCapabilities {
  tenant_id: string;
  policy_configured: boolean;
  policy_version: number;
  capabilities: Record<ConveractFabricProviderCapability, {
    enabled: boolean;
    automatic: boolean;
    available: boolean;
    provider_mode: ConveractFabricProviderMode | 'unconfigured';
    provider_profile_ids: string[];
    providers: Array<{
      profile_id: string;
      mode: ConveractFabricProviderMode | 'unconfigured';
      available: boolean;
      reason: string;
    }>;
    reason: string;
  }>;
  translation_target_languages: string[];
  confidence_thresholds: { ocr: number; asr: number };
}

export interface ConveractFabricProviderProfileSummary {
  id: string;
  capability: ConveractFabricProviderCapability;
  mode: ConveractFabricProviderMode;
  name: string;
  configured: boolean;
  token_configured: boolean;
  requests_per_minute: number;
  requests_per_day: number;
  max_concurrency: number;
  failure_threshold: number;
  open_cooldown_ms: number;
  reservation_ttl_ms: number;
  adapter: string;
  provider_version: string;
  data_region: string;
  max_buffered_audio_ms: number;
  max_session_seconds: number;
}

export interface ConveractFabricProviderRuntimeSnapshot {
  tenant_id: string;
  capability: ConveractFabricProviderCapability;
  profile_id: string;
  minute_request_count: number;
  day_request_count: number;
  circuit_state: 'closed' | 'open' | 'half_open';
  consecutive_retryable_failures: number;
  opened_until: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error_code: string;
  updated_at: string;
}

export interface ConveractFabricProviderHealthResult {
  profile_id: string;
  capability: ConveractFabricProviderCapability;
  mode: ConveractFabricProviderMode;
  status: 'healthy' | 'degraded' | 'unavailable';
  http_class: string;
  latency_ms: number;
  checked_at: string;
}

export interface ConveractFabricIntelligenceSourceSnapshot {
  source: Record<string, unknown> & { id: string; session_id: string; status: string };
  message_id: string;
  replayed: boolean;
  attachment: Record<string, unknown>;
  processing_job: Record<string, unknown> | null;
  findings: Array<Record<string, unknown>>;
}

export interface ConveractFabricFindingQueueInput {
  session_id?: string;
  source?: 'text' | 'ocr' | 'asr' | 'ai' | 'aggregate';
  severity?: 'low' | 'medium' | 'high';
  review_status?: 'pending' | 'confirmed' | 'false_positive' | 'resolved' | 'escalated';
  created_from?: string;
  created_to?: string;
  cursor?: string;
  limit?: number;
}

export interface ConveractFabricFindingQueuePage {
  items: ConveractFabricFindingQueueItem[];
  next_cursor: string;
}

export interface ConveractFabricFindingQueueItem {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  source: 'text' | 'ocr' | 'asr' | 'ai' | 'aggregate';
  source_ref_id: string;
  policy_type: string;
  severity: 'low' | 'medium' | 'high';
  matched_text_hash: string;
  fingerprint: string;
  action: string;
  confidence: number | null;
  rationale: string;
  evidence_refs: Array<Record<string, unknown>>;
  detector_version: string;
  policy_version: string;
  evidence_snapshot_hash: string;
  content_version: number;
  review_status: 'pending' | 'confirmed' | 'false_positive' | 'resolved' | 'escalated';
  reviewed_by: string;
  reviewed_at: string | null;
  review_note: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface ConveractFabricFindingQueueDetail {
  session_id: string;
  finding: ConveractFabricFindingQueueItem;
  reviews: ConveractFabricPolicyFindingReview[];
}

export type ConveractFabricFindingQueueReviewInput = ConveractFabricPolicyFindingReviewInput;

export type ConveractFabricTranslationStatus =
  | 'pending' | 'processing' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled';

export interface ConveractFabricTranslationJob {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  source_type: 'message' | 'attachment';
  source_ref_id: string;
  source_language: string;
  target_language: string;
  source_hash: string;
  status: ConveractFabricTranslationStatus;
  attempt_count: number;
  max_attempts: number;
  provider_profile_id: string;
  provider_mode: ConveractFabricProviderMode | 'unconfigured';
  provider_name: string;
  provider_request_id: string;
  error_code: string;
  automatic: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ConveractFabricTranslationResult {
  id: string;
  tenant_id: string;
  message_id: string;
  source_type: 'message' | 'attachment';
  source_ref_id: string;
  source_hash: string;
  source_language: string;
  target_language: string;
  translated_text: string;
  provider_profile_id: string;
  provider_mode: ConveractFabricProviderMode | 'unconfigured';
  provider_name: string;
  provider_request_id: string;
  confidence: number | null;
  output_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ConveractFabricTranslationRequestInput {
  source_language?: string;
  target_language: string;
}

export interface ConveractFabricTranslationRequestResult {
  job: ConveractFabricTranslationJob;
  replayed: boolean;
}

export interface ConveractFabricTranslationListResult {
  items: ConveractFabricTranslationResult[];
  jobs: ConveractFabricTranslationJob[];
}
