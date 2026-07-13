export type ContactCenterErrorCode =
  | 'invalid_queue_entry_transition'
  | 'invalid_assignment_transition'
  | 'invalid_presence_transition'
  | 'invalid_supervisor_transition'
  | 'validation_failed'
  | 'not_found'
  | 'revision_conflict'
  | 'idempotency_conflict'
  | 'conflict'
  | 'capacity_exhausted';

export class ContactCenterError extends Error {
  readonly code: ContactCenterErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(input: {
    code: ContactCenterErrorCode;
    status?: number;
    retryable?: boolean;
    message?: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message || input.code);
    this.name = 'ContactCenterError';
    this.code = input.code;
    this.status = input.status ?? 409;
    this.retryable = input.retryable ?? false;
    this.details = input.details || {};
  }
}
