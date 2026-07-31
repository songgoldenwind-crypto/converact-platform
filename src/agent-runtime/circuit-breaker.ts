/**
 * Circuit Breaker Pattern for AI Script Generation
 *
 * Prevents cascading failures when provider is down:
 * - Closed: Normal operation, calls go through
 * - Open: Provider failing, bypass AI → use template only
 * - Half-Open: Attempting recovery, test call allowed
 *
 * Transition rules:
 * - Closed → Open: 5+ consecutive failures in last 1 hour
 * - Open → Half-Open: 5 min recovery window has passed
 * - Half-Open → Closed: Recovery test succeeds
 * - Half-Open → Open: Recovery test fails
 *
 * Part of Phase 5C: State Management & Resilience
 */

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerMetrics {
  tenant_id: string;
  state: CircuitBreakerState;
  failure_count: number;
  failure_threshold: number;
  last_failure_at?: string;
  opened_at?: string;
  recovery_window_ms: number; // Time before attempting half-open
  last_recovery_attempt_at?: string;
  total_requests: number;
  total_failures: number;
  success_rate: number; // percent
}

export interface FailureRecord {
  timestamp: string;
  error_message: string;
  model?: string;
  run_id?: string;
}

/**
 * Initialize circuit breaker for a tenant
 */
export function initializeCircuitBreaker(tenantId: string): CircuitBreakerMetrics {
  return {
    tenant_id: tenantId,
    state: 'closed',
    failure_count: 0,
    failure_threshold: 5,
    recovery_window_ms: 5 * 60 * 1000, // 5 minutes
    total_requests: 0,
    total_failures: 0,
    success_rate: 100,
  };
}

/**
 * Get circuit breaker state
 * Called before each AI generation attempt
 */
export function getCircuitBreakerState(
  breaker: CircuitBreakerMetrics,
  currentTimeMs: number = Date.now()
): CircuitBreakerState {
  if (breaker.state === 'closed') {
    return 'closed';
  }

  if (breaker.state === 'open') {
    // Check if recovery window has passed
    const openedAtMs = breaker.opened_at ? new Date(breaker.opened_at).getTime() : 0;
    const timeSinceOpened = currentTimeMs - openedAtMs;

    if (timeSinceOpened >= breaker.recovery_window_ms) {
      // Recovery window has passed, try half-open
      return 'half-open';
    }
    // Still in recovery window, stay open
    return 'open';
  }

  // Already half-open
  return 'half-open';
}

/**
 * Record a successful generation
 */
export function recordSuccess(breaker: CircuitBreakerMetrics): CircuitBreakerMetrics {
  const updated = { ...breaker };

  updated.total_requests += 1;
  updated.failure_count = 0; // Reset consecutive failure count
  updated.success_rate = (100 * (updated.total_requests - updated.total_failures)) / Math.max(1, updated.total_requests);

  // If was half-open, close the circuit
  if (updated.state === 'half-open') {
    updated.state = 'closed';
  }

  return updated;
}

/**
 * Record a failed generation
 */
export function recordFailure(
  breaker: CircuitBreakerMetrics,
  error: Error | string,
  context?: { model?: string; run_id?: string }
): CircuitBreakerMetrics {
  const updated = { ...breaker };

  updated.total_requests += 1;
  updated.total_failures += 1;
  updated.failure_count += 1;
  updated.last_failure_at = new Date().toISOString();
  updated.success_rate = (100 * (updated.total_requests - updated.total_failures)) / Math.max(1, updated.total_requests);

  // Decide state transition
  if (updated.failure_count >= updated.failure_threshold) {
    // Threshold reached, open circuit
    updated.state = 'open';
    updated.opened_at = new Date().toISOString();
  } else if (updated.state === 'half-open') {
    // Recovery attempt failed, reopen
    updated.state = 'open';
    updated.opened_at = new Date().toISOString();
  }

  return updated;
}

/**
 * Attempt recovery (half-open state)
 * Called for one test generation to see if provider recovered
 */
export function attemptRecovery(breaker: CircuitBreakerMetrics): CircuitBreakerMetrics {
  if (breaker.state !== 'open') {
    return breaker;
  }

  const updated = { ...breaker };
  updated.state = 'half-open';
  updated.last_recovery_attempt_at = new Date().toISOString();
  return updated;
}

/**
 * Check if AI call should be skipped (circuit is open/half-open)
 * Returns true if we should bypass AI and use template instead
 */
export function shouldBypassAI(
  breaker: CircuitBreakerMetrics,
  allowRecoveryTest: boolean = false,
  currentTimeMs: number = Date.now()
): boolean {
  const state = getCircuitBreakerState(breaker, currentTimeMs);

  if (state === 'closed') {
    return false; // Normal operation, don't bypass
  }

  if (state === 'open') {
    return true; // Circuit open, bypass AI
  }

  // Half-open: allow one recovery test, then bypass subsequent calls
  if (state === 'half-open' && allowRecoveryTest) {
    return false; // Allow recovery test to proceed
  }

  return true; // Half-open but no recovery test, bypass
}

/**
 * Format state for logging
 */
export function formatCircuitBreakerState(breaker: CircuitBreakerMetrics): string {
  return (
    `CircuitBreaker { ` +
    `state: ${breaker.state}, ` +
    `failures: ${breaker.failure_count}/${breaker.failure_threshold}, ` +
    `success_rate: ${breaker.success_rate.toFixed(1)}%, ` +
    `total: ${breaker.total_requests} requests, ` +
    `opened_at: ${breaker.opened_at || 'N/A'} ` +
    `}`
  );
}

/**
 * Compute recovery deadline (when half-open becomes available)
 */
export function getRecoveryDeadline(breaker: CircuitBreakerMetrics): Date | null {
  if (breaker.state !== 'open' || !breaker.opened_at) {
    return null;
  }
  const openedMs = new Date(breaker.opened_at).getTime();
  return new Date(openedMs + breaker.recovery_window_ms);
}
