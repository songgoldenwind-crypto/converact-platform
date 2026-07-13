export type IvrErrorCode =
  | 'validation_failed'
  | 'publish_validation_failed'
  | 'not_found'
  | 'revision_conflict'
  | 'idempotency_conflict'
  | 'capability_unavailable'
  | 'event_sequence_conflict'
  | 'invalid_session_state'
  | 'step_limit_exceeded'
  | 'branch_missing'
  | 'lease_lost'
  | 'provider_timeout'
  | 'provider_result_unknown'
  | 'internal_error';

export class IvrError extends Error {
  readonly code: IvrErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(input: {
    code: IvrErrorCode;
    message?: string;
    retryable?: boolean;
    status?: number;
    details?: Readonly<Record<string, unknown>>;
  }) {
    super(input.message ?? input.code);
    this.name = 'IvrError';
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.status = input.status ?? 409;
    this.details = input.details ?? {};
  }
}
