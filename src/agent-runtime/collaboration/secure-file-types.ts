export type SecureFileKind = 'image' | 'video' | 'audio' | 'file' | 'screen_recording';
export type SecureFileStatus =
  | 'initiated'
  | 'uploading'
  | 'scanning'
  | 'processing'
  | 'ready'
  | 'quarantined'
  | 'failed'
  | 'expired';
export type SecureFileThreatStatus = 'pending' | 'scanning' | 'clean' | 'infected' | 'error';
export type SecureFileUploadMode = 'single' | 'multipart';

export interface SecureFile {
  id: string;
  tenant_id: string;
  session_id: string;
  created_by: string;
  kind: SecureFileKind;
  filename: string;
  extension: string;
  declared_mime: string;
  detected_mime: string;
  mime_conflict: boolean;
  status: SecureFileStatus;
  threat_status: SecureFileThreatStatus;
  failure_code: string;
  object_key: string;
  size_bytes: number;
  sha256: string;
  upload_mode: SecureFileUploadMode;
  expected_size_bytes: number;
  received_size_bytes: number;
  part_size_bytes: number;
  idempotency_key: string;
  payload_hash: string;
  scan_attempt_count: number;
  scanner_name: string;
  scanner_mode: string;
  scanner_request_id: string;
  scan_metadata: Record<string, unknown>;
  next_attempt_at: string | null;
  lease_until: string | null;
  worker_id: string;
  retention_until: string | null;
  expires_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SecureFilePart {
  tenant_id: string;
  session_id: string;
  secure_file_id: string;
  part_number: number;
  size_bytes: number;
  sha256: string;
  object_key: string;
  etag: string;
  status: 'staged' | 'uploaded' | 'committed' | 'aborted';
  created_at: string;
  updated_at: string;
}

export type SecureFileDerivativeKind =
  | 'image_thumbnail'
  | 'video_thumbnail'
  | 'video_transcode'
  | 'audio_transcode';

export interface SecureFileDerivative {
  tenant_id: string;
  session_id: string;
  secure_file_id: string;
  derivative_kind: SecureFileDerivativeKind;
  status: 'pending' | 'processing' | 'retry_wait' | 'ready' | 'failed' | 'expired';
  object_key: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  provider_profile_id: string;
  provider_request_id: string;
  provider_metadata: Record<string, unknown>;
  attempt_count: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  worker_id: string;
  error_code: string;
  retention_until: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
