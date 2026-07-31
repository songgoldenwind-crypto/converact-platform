import type { IveKitRateLimitScope } from './types.js';

export class IveKitRateLimitError extends Error {
  readonly code = 'rate_limited';
  readonly status = 429;
  readonly retryable = true;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    readonly retry_after_seconds: number,
    readonly denied_scope: IveKitRateLimitScope
  ) {
    super('rate_limited');
    this.name = 'IveKitRateLimitError';
    this.details = { retry_after_seconds, denied_scope };
  }
}
