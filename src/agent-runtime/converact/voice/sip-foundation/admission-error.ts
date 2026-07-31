import { VoiceError } from '../errors.js';
import {
  createStoreFailureSip503,
  SipEffectError
} from './effect-oracle.js';
import {
  readPostgresStoreFailureEvidence
} from './postgres-effect-store.js';

const RETRY_AFTER_BY_ERROR = new WeakMap<VoiceError, number>();

export function mapStoreFailureToVoice503(error: unknown): VoiceError | null {
  if (!(error instanceof SipEffectError)) {
    return null;
  }
  const evidence = readPostgresStoreFailureEvidence(error);
  if (
    !evidence ||
    evidence.failure_code !== error.code ||
    error.status !== 503 ||
    error.retryable !== true
  ) {
    return null;
  }
  const contract = evidence.retry_after_facts === null
    ? null
    : createStoreFailureSip503({
        failure_code: evidence.failure_code,
        ...evidence.retry_after_facts
      });
  const mapped = new VoiceError({
    code: 'provider_unavailable',
    status: 503,
    retryable: true,
    details: Object.freeze({ failure_code: evidence.failure_code })
  });
  if (contract) {
    RETRY_AFTER_BY_ERROR.set(mapped, contract.retry_after_seconds);
  }
  return mapped;
}

export function trustedStoreFailureRetryAfterSeconds(
  error: unknown
): number | null {
  if (!(error instanceof VoiceError)) return null;
  const value = RETRY_AFTER_BY_ERROR.get(error);
  return error.status === 503 &&
    error.retryable === true &&
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 30
    ? value as number
    : null;
}
