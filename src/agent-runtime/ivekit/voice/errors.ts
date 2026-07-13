export type VoiceErrorCode =
  | 'invalid_call_transition'
  | 'terminal_call_state'
  | 'unsupported_provider_call_state'
  | 'invalid_address'
  | 'address_decryption_failed'
  | 'provider_payload_invalid'
  | 'validation_failed'
  | 'not_found'
  | 'revision_conflict'
  | 'lease_lost'
  | 'idempotency_conflict'
  | 'capability_unavailable'
  | 'provider_auth_failed'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_response_too_large'
  | 'protocol_mismatch'
  | 'event_sequence_conflict'
  | 'compliance_denied'
  | 'provider_result_unknown'
  | 'webhook_auth_failed'
  | 'secret_ref_invalid'
  | 'secret_unavailable';

export class VoiceError extends Error {
  readonly code: VoiceErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(input: {
    code: VoiceErrorCode;
    message?: string;
    retryable?: boolean;
    status?: number;
    details?: Readonly<Record<string, unknown>>;
  }) {
    super(input.message ?? input.code);
    this.name = 'VoiceError';
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.status = input.status ?? 409;
    this.details = input.details ?? {};
  }
}
