import type { ConveractFabricRateLimitScope } from './types.js';

export class ConveractFabricRateLimitError extends Error {
  readonly code = 'rate_limited';
  readonly status = 429;
  readonly retryable = true;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    readonly retry_after_seconds: number,
    readonly denied_scope: ConveractFabricRateLimitScope
  ) {
    super('rate_limited');
    this.name = 'ConveractFabricRateLimitError';
    this.details = { retry_after_seconds, denied_scope };
  }
}
