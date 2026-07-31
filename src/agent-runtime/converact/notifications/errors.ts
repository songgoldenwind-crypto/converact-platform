import type { NotificationErrorCode } from './types.js';

export class NotificationError extends Error {
  readonly code: NotificationErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(input: {
    code: NotificationErrorCode;
    message?: string;
    retryable?: boolean;
    status?: number;
    details?: Readonly<Record<string, unknown>>;
  }) {
    super(input.message || input.code);
    this.name = 'NotificationError';
    this.code = input.code;
    this.retryable = input.retryable === true;
    this.status = input.status ?? 400;
    this.details = input.details || {};
  }
}

