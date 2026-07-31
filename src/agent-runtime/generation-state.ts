/**
 * Generation State Machine for AI Script Variant Lifecycle
 *
 * Tracks: pending → generating → ready/failed → deprecated
 * Implements: max 3 retries, error history, idempotency
 *
 * Part of Phase 5C: State Management & Resilience
 */

export type GenerationState = 'pending' | 'generating' | 'ready' | 'failed' | 'deprecated' | 'fallback';

export interface GenerationAttempt {
  attempt_number: number;
  started_at: string;
  completed_at?: string;
  status: 'in_progress' | 'success' | 'error';
  error_message?: string;
  error_code?: string;
  tokens_used?: number;
  duration_ms?: number;
}

export interface GenerationStateData {
  state: GenerationState;
  current_attempt: number;
  max_attempts: number;
  attempts: GenerationAttempt[];
  first_attempt_at: string;
  last_attempt_at?: string;
  generated_at?: string;
  fallback_reason?: string;
  cache_hit?: boolean;
}

/**
 * Initialize generation state in source_strategy
 */
export function initializeGenerationState(): GenerationStateData {
  return {
    state: 'pending',
    current_attempt: 0,
    max_attempts: 3,
    attempts: [],
    first_attempt_at: new Date().toISOString(),
  };
}

/**
 * Transition to generating state
 */
export function transitionToGenerating(state: GenerationStateData): GenerationStateData {
  if (state.current_attempt >= state.max_attempts) {
    throw new Error(`Max retries (${state.max_attempts}) exceeded. Cannot retry.`);
  }

  const attempt_number = state.current_attempt + 1;
  const newAttempt: GenerationAttempt = {
    attempt_number,
    started_at: new Date().toISOString(),
    status: 'in_progress',
  };

  return {
    ...state,
    state: 'generating',
    current_attempt: attempt_number,
    last_attempt_at: new Date().toISOString(),
    attempts: [...state.attempts, newAttempt],
  };
}

/**
 * Transition to ready state (successful generation)
 */
export function transitionToReady(
  state: GenerationStateData,
  options?: { cache_hit?: boolean; tokens_used?: number }
): GenerationStateData {
  if (state.state !== 'generating') {
    throw new Error(`Cannot transition to ready from state: ${state.state}`);
  }

  const attempts = [...state.attempts];
  const lastAttempt = attempts[attempts.length - 1];
  if (lastAttempt) {
    lastAttempt.status = 'success';
    lastAttempt.completed_at = new Date().toISOString();
    lastAttempt.duration_ms = new Date(lastAttempt.completed_at).getTime() - new Date(lastAttempt.started_at).getTime();
    if (options?.tokens_used) {
      lastAttempt.tokens_used = options.tokens_used;
    }
  }

  return {
    ...state,
    state: 'ready',
    attempts,
    generated_at: new Date().toISOString(),
    cache_hit: options?.cache_hit ?? false,
  };
}

/**
 * Transition to failed state (generation failed, not exceeding retry limit)
 */
export function transitionToFailed(
  state: GenerationStateData,
  error: Error | string,
  options?: { error_code?: string }
): GenerationStateData {
  if (state.state !== 'generating') {
    throw new Error(`Cannot transition to failed from state: ${state.state}`);
  }

  const attempts = [...state.attempts];
  const lastAttempt = attempts[attempts.length - 1];
  if (lastAttempt) {
    lastAttempt.status = 'error';
    lastAttempt.completed_at = new Date().toISOString();
    lastAttempt.duration_ms = new Date(lastAttempt.completed_at).getTime() - new Date(lastAttempt.started_at).getTime();
    lastAttempt.error_message = typeof error === 'string' ? error : error.message;
    lastAttempt.error_code = options?.error_code;
  }

  // Decide whether to stay failed (and retry) or transition to fallback (exceeded retries)
  const nextState: GenerationState = state.current_attempt >= state.max_attempts ? 'fallback' : 'failed';

  return {
    ...state,
    state: nextState,
    attempts,
    fallback_reason:
      nextState === 'fallback'
        ? `Max retries (${state.max_attempts}) exceeded. Last error: ${typeof error === 'string' ? error : error.message}`
        : undefined,
  };
}

/**
 * Transition to fallback state (using template after max retries)
 */
export function transitionToFallback(state: GenerationStateData, reason: string): GenerationStateData {
  return {
    ...state,
    state: 'fallback',
    fallback_reason: reason,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Transition to deprecated state (variant underperforming)
 */
export function transitionToDeprecated(state: GenerationStateData, reason: string): GenerationStateData {
  return {
    ...state,
    state: 'deprecated',
    fallback_reason: reason,
  };
}

/**
 * Check if generation can be retried
 */
export function canRetry(state: GenerationStateData): boolean {
  if (state.state === 'ready' || state.state === 'fallback' || state.state === 'deprecated') {
    return false; // Terminal states
  }
  return state.current_attempt < state.max_attempts;
}

/**
 * Check if generation is in terminal state
 */
export function isTerminalState(state: GenerationState): boolean {
  return state === 'ready' || state === 'fallback' || state === 'deprecated';
}

/**
 * Get last error from attempts history
 */
export function getLastError(state: GenerationStateData): string | undefined {
  for (let i = state.attempts.length - 1; i >= 0; i--) {
    if (state.attempts[i].error_message) {
      return state.attempts[i].error_message;
    }
  }
  return undefined;
}

/**
 * Get total tokens used across all attempts
 */
export function getTotalTokensUsed(state: GenerationStateData): number {
  return state.attempts.reduce((sum, attempt) => sum + (attempt.tokens_used || 0), 0);
}

/**
 * Get attempt duration in milliseconds
 */
export function getAttemptDuration(state: GenerationStateData): number {
  if (!state.first_attempt_at || !state.last_attempt_at) return 0;
  return new Date(state.last_attempt_at).getTime() - new Date(state.first_attempt_at).getTime();
}

/**
 * Format state for logging/debugging
 */
export function formatGenerationState(state: GenerationStateData): string {
  return (
    `GenerationState { ` +
    `state: ${state.state}, ` +
    `attempt: ${state.current_attempt}/${state.max_attempts}, ` +
    `attempts: ${state.attempts.length}, ` +
    `last_error: ${getLastError(state) || 'none'} ` +
    `}`
  );
}
