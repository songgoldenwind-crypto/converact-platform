export type ContactCenterErrorCode =
  | 'invalid_queue_entry_transition'
  | 'invalid_assignment_transition'
  | 'invalid_presence_transition'
  | 'invalid_supervisor_transition'
  | 'validation_failed'
  | 'not_found'
  | 'conflict'
  | 'capacity_exhausted';

export class ContactCenterError extends Error {
  readonly code: ContactCenterErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(input: {
    code: ContactCenterErrorCode;
    status?: number;
    message?: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message || input.code);
    this.name = 'ContactCenterError';
    this.code = input.code;
    this.status = input.status ?? 409;
    this.details = input.details || {};
  }
}
