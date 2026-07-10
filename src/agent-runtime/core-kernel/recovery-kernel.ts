import type { FailureType, RecoveryDecision, RecoveryError, RecoveryInput } from './types.js';

const EXTERNAL_ERROR_CODES = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'];
const INPUT_CONTRACT_ERROR_NAME = 'InputContractError';
const INPUT_CONTRACT_ERROR_CODE = 'E_INPUT_CONTRACT';

export function classifyFailure(error?: RecoveryError): FailureType {
  const code = String(error?.code ?? '').toUpperCase();
  const name = String(error?.name ?? '');
  const message = String(error?.message ?? '');
  const signature = `${code} ${name} ${message}`;

  if (matchesExplicitInputContract(code, name)) {
    return 'input_contract';
  }

  if (matchesExternal(code, signature)) {
    return 'external';
  }

  if (matchesInputContractText(signature)) {
    return 'input_contract';
  }

  if (matchesReasoning(signature)) {
    return 'reasoning';
  }

  return 'unknown';
}

export function recoverFromFailure(input: RecoveryInput): RecoveryDecision {
  const failureType = classifyFailure(input.error);

  if (failureType === 'external') {
    const exhausted = input.attempt >= input.maxRetries;
    return {
      phase: input.phase,
      step_id: input.stepId,
      failure_type: failureType,
      strategy: exhausted ? 'halt' : 'bounded_retry',
      retryable: !exhausted,
      next_attempt: exhausted ? null : input.attempt + 1,
      stop_reason: exhausted ? 'Retry budget exhausted for external dependency.' : undefined
    };
  }

  if (failureType === 'reasoning') {
    return {
      phase: input.phase,
      step_id: input.stepId,
      failure_type: failureType,
      strategy: 'fallback',
      retryable: false,
      next_attempt: null,
      stop_reason: 'Reasoning path failed; fallback required before continuing.'
    };
  }

  if (failureType === 'input_contract') {
    return {
      phase: input.phase,
      step_id: input.stepId,
      failure_type: failureType,
      strategy: 'targeted_fix',
      retryable: false,
      next_attempt: null,
      stop_reason: 'Input contract violation: required fields or format missing.'
    };
  }

  return {
    phase: input.phase,
    step_id: input.stepId,
    failure_type: failureType,
    strategy: 'halt',
    retryable: false,
    next_attempt: null,
    stop_reason: 'Unknown failure type; manual inspection required.'
  };
}

function matchesExternal(code: string, signature: string): boolean {
  if (EXTERNAL_ERROR_CODES.includes(code)) {
    return true;
  }

  return /\b(timeout|timed out|network|gateway|upstream|socket|provider|http)\b/i.test(signature);
}

function matchesReasoning(signature: string): boolean {
  return /\b(reasoning|unable to derive|halluc|inference|angle)\b/i.test(signature);
}

function matchesExplicitInputContract(code: string, name: string): boolean {
  return name === INPUT_CONTRACT_ERROR_NAME || code === INPUT_CONTRACT_ERROR_CODE;
}

function matchesInputContractText(signature: string): boolean {
  return /\b(input contract|contract|invalid|missing|required|schema|payload|field)\b/i.test(signature);
}
