import type { IveKitPolicyFindingReview, IveKitPolicyFindingReviewInput } from './chat-types.js';

export type IveKitProviderCapability = 'ocr' | 'asr' | 'quality_review' | 'translation';
export type IveKitProviderMode = 'self_hosted' | 'third_party';

interface IveKitIntelligencePolicySettings {
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

type IveKitRouteNativePolicyProfiles = {
  ocr_profile_id?: string;
  asr_profile_id?: string;
  quality_profile_id?: string;
  translation_profile_id?: string;
  ocr_profile_ids: string[];
  asr_profile_ids: string[];
  quality_profile_ids: string[];
  translation_profile_ids: string[];
};

type IveKitLegacyPolicyProfiles = {
  ocr_profile_id: string;
  asr_profile_id: string;
  quality_profile_id: string;
  translation_profile_id: string;
  ocr_profile_ids?: string[];
  asr_profile_ids?: string[];
  quality_profile_ids?: string[];
  translation_profile_ids?: string[];
};

export type IveKitIntelligencePolicyUpdate = IveKitIntelligencePolicySettings & (
  | IveKitRouteNativePolicyProfiles
  | IveKitLegacyPolicyProfiles
);

export type IveKitIntelligencePolicy = IveKitIntelligencePolicySettings & {
  ocr_profile_id: string;
  asr_profile_id: string;
  quality_profile_id: string;
  translation_profile_id: string;
  ocr_profile_ids: string[];
  asr_profile_ids: string[];
  quality_profile_ids: string[];
  translation_profile_ids: string[];
  tenant_id: string;
  configured: boolean;
  version: number;
  updated_by: string;
  created_at: string | null;
  updated_at: string | null;
};

export type IveKitIntelligencePolicyWrite = IveKitIntelligencePolicyUpdate & { version: number };

export interface IveKitIntelligenceCapabilities {
  tenant_id: string;
  policy_configured: boolean;
  policy_version: number;
  capabilities: Record<IveKitProviderCapability, {
    enabled: boolean;
    automatic: boolean;
    available: boolean;
    provider_mode: IveKitProviderMode | 'unconfigured';
    provider_profile_ids: string[];
    providers: Array<{
      profile_id: string;
      mode: IveKitProviderMode | 'unconfigured';
      available: boolean;
      reason: string;
    }>;
    reason: string;
  }>;
  translation_target_languages: string[];
  confidence_thresholds: { ocr: number; asr: number };
}

export interface IveKitProviderProfileSummary {
  id: string;
  capability: IveKitProviderCapability;
  mode: IveKitProviderMode;
  name: string;
  configured: boolean;
  token_configured: boolean;
  requests_per_minute: number;
  requests_per_day: number;
  max_concurrency: number;
  failure_threshold: number;
  open_cooldown_ms: number;
  reservation_ttl_ms: number;
}

export interface IveKitProviderRuntimeSnapshot {
  tenant_id: string;
  capability: IveKitProviderCapability;
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

export interface IveKitProviderHealthResult {
  profile_id: string;
  capability: IveKitProviderCapability;
  mode: IveKitProviderMode;
  status: 'healthy' | 'degraded' | 'unavailable';
  http_class: string;
  latency_ms: number;
  checked_at: string;
}

export interface IveKitIntelligenceSourceSnapshot {
  source: Record<string, unknown> & { id: string; session_id: string; status: string };
  message_id: string;
  replayed: boolean;
  attachment: Record<string, unknown>;
  processing_job: Record<string, unknown> | null;
  findings: Array<Record<string, unknown>>;
}

export interface IveKitFindingQueueInput {
  session_id?: string;
  source?: 'text' | 'ocr' | 'asr' | 'ai' | 'aggregate';
  severity?: 'low' | 'medium' | 'high';
  review_status?: 'pending' | 'confirmed' | 'false_positive' | 'resolved' | 'escalated';
  created_from?: string;
  created_to?: string;
  cursor?: string;
  limit?: number;
}

export interface IveKitFindingQueuePage {
  items: IveKitFindingQueueItem[];
  next_cursor: string;
}

export interface IveKitFindingQueueItem {
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

export interface IveKitFindingQueueDetail {
  session_id: string;
  finding: IveKitFindingQueueItem;
  reviews: IveKitPolicyFindingReview[];
}

export type IveKitFindingQueueReviewInput = IveKitPolicyFindingReviewInput;

export type IveKitTranslationStatus =
  | 'pending' | 'processing' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled';

export interface IveKitTranslationJob {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  source_type: 'message' | 'attachment';
  source_ref_id: string;
  source_language: string;
  target_language: string;
  source_hash: string;
  status: IveKitTranslationStatus;
  attempt_count: number;
  max_attempts: number;
  provider_profile_id: string;
  provider_mode: IveKitProviderMode | 'unconfigured';
  provider_name: string;
  provider_request_id: string;
  error_code: string;
  automatic: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface IveKitTranslationResult {
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
  provider_mode: IveKitProviderMode | 'unconfigured';
  provider_name: string;
  provider_request_id: string;
  confidence: number | null;
  output_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface IveKitTranslationRequestInput {
  source_language?: string;
  target_language: string;
}

export interface IveKitTranslationRequestResult {
  job: IveKitTranslationJob;
  replayed: boolean;
}

export interface IveKitTranslationListResult {
  items: IveKitTranslationResult[];
  jobs: IveKitTranslationJob[];
}
