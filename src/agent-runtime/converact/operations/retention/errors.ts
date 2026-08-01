export type ConveractFabricRetentionErrorCode =
  | 'validation_failed' | 'revision_conflict' | 'idempotency_conflict'
  | 'conflict' | 'not_found' | 'compliance_denied' | 'retention_lease_lost'
  | 'retention_handler_unavailable' | 'invalid_retention_result';

export class ConveractFabricRetentionError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: ConveractFabricRetentionErrorCode,
    readonly status: number,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(code);
    this.name = 'ConveractFabricRetentionError';
  }
}
