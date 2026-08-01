export class ConveractFabricOperationsError extends Error {
  readonly retryable = false;

  constructor(
    readonly code:
      | 'validation_failed'
      | 'not_found'
      | 'idempotency_conflict'
      | 'compliance_denied'
      | 'invalid_stored_event'
      | 'audit_append_failed',
    readonly status: number,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(code);
    this.name = 'ConveractFabricOperationsError';
  }
}
