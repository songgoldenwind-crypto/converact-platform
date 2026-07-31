import type {
  IntelligenceProviderCapability,
  IntelligenceProviderProfile
} from './intelligence-provider-registry.js';
import type { IntelligenceProviderGovernanceStore } from './intelligence-provider-governance-store.js';
import type { IntelligenceProviderCircuitTransition } from './intelligence-provider-governance-store.js';
import {
  observeIntelligenceProviderCircuitTransition,
  observeIntelligenceProviderFailover,
  observeIntelligenceProviderRequest,
  observeIntelligenceProviderReservation,
  observeIntelligenceProviderRouteExhausted
} from './intelligence-provider-metrics.js';

export interface IntelligenceProviderRouteCandidate<TProvider> {
  profile: IntelligenceProviderProfile;
  provider: TProvider | null;
  unavailable_reason?: string;
}

export interface IntelligenceProviderRouteAttempt {
  profile_id: string;
  status: 'succeeded' | 'retryable_failure' | 'terminal_failure' | 'skipped';
  code: string;
  retry_at?: string;
}

export interface IntelligenceProviderRouteResult<TOutput> {
  output: TOutput;
  selected_profile: IntelligenceProviderProfile;
  attempt_count: number;
  failed_over: boolean;
  attempts: IntelligenceProviderRouteAttempt[];
  governance_completion_pending: boolean;
}

export type IntelligenceProviderRouteEventType =
  | 'collaboration.intelligence.provider.selected'
  | 'collaboration.intelligence.provider.failed_over'
  | 'collaboration.intelligence.provider.circuit_changed'
  | 'collaboration.intelligence.provider.route_exhausted';

export interface IntelligenceProviderRouteEvent {
  tenant_id: string;
  type: IntelligenceProviderRouteEventType;
  data: Record<string, unknown>;
}

export type IntelligenceProviderRouteEventHandler = (
  event: IntelligenceProviderRouteEvent
) => void | Promise<void>;

export class IntelligenceProviderRouteError extends Error {
  readonly code = 'provider_route_unavailable';
  readonly retryable = true;

  readonly retry_at: string;
  readonly provider_invoked: boolean;
  readonly failover_attempted: boolean;

  constructor(attempts: IntelligenceProviderRouteAttempt[]) {
    super('provider route is unavailable');
    this.name = 'IntelligenceProviderRouteError';
    this.attempts = attempts;
    this.retry_at = earliestRetryAt(attempts);
    this.provider_invoked = attempts.some((attempt) => attempt.status !== 'skipped');
    this.failover_attempted = attempts.length > 1;
  }

  readonly attempts: IntelligenceProviderRouteAttempt[];
}

export interface IntelligenceProviderRouteFailureContext {
  retry_at: string;
  provider_invoked: boolean;
  failover_attempted: boolean;
  attempts: IntelligenceProviderRouteAttempt[];
}

export function intelligenceProviderRouteFailure(
  error: unknown
): IntelligenceProviderRouteFailureContext | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as {
    code?: unknown;
    retry_at?: unknown;
    provider_invoked?: unknown;
    failover_attempted?: unknown;
    attempts?: unknown;
    route_attempts?: unknown;
  };
  if (value.code !== 'provider_route_unavailable' && !value.route_attempts) return null;
  const attempts = safeAttempts(value.attempts || value.route_attempts);
  return {
    retry_at: safeRetryAt(value.retry_at) || earliestRetryAt(attempts),
    provider_invoked: value.provider_invoked === false
      ? false
      : value.provider_invoked === true || attempts.length === 0 || attempts.some(
        (attempt) => attempt.status !== 'skipped'
      ),
    failover_attempted: value.failover_attempted === true || attempts.length > 1,
    attempts
  };
}

export async function executeIntelligenceProviderRoute<TProvider, TOutput>(input: {
  tenant_id: string;
  capability: IntelligenceProviderCapability;
  candidates: Array<IntelligenceProviderRouteCandidate<TProvider>>;
  governance: IntelligenceProviderGovernanceStore;
  onEvent?: IntelligenceProviderRouteEventHandler;
  invoke(provider: TProvider, profile: IntelligenceProviderProfile): Promise<TOutput>;
}): Promise<IntelligenceProviderRouteResult<TOutput>> {
  const attempts: IntelligenceProviderRouteAttempt[] = [];
  let governanceCompletionPending = false;
  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index];
    if (!candidate.provider) {
      observeIntelligenceProviderReservation({
        capability: input.capability,
        profile_id: candidate.profile.id,
        result: candidate.unavailable_reason || 'provider_unavailable'
      });
      attempts.push({
        profile_id: candidate.profile.id,
        status: 'skipped',
        code: safeCode(candidate.unavailable_reason || 'provider_unavailable')
      });
      continue;
    }
    const reservation = await input.governance.reserve({
      tenant_id: input.tenant_id,
      capability: input.capability,
      profile: candidate.profile,
      route_attempt: index + 1
    });
    await emitCircuitTransition(
      input,
      candidate.profile.id,
      reservation.circuit_transition,
      ''
    );
    if (reservation.granted === false) {
      observeIntelligenceProviderReservation({
        capability: input.capability,
        profile_id: candidate.profile.id,
        result: reservation.reason
      });
      attempts.push({
        profile_id: candidate.profile.id,
        status: 'skipped',
        code: reservation.reason,
        retry_at: reservation.retry_at
      });
      continue;
    }
    observeIntelligenceProviderReservation({
      capability: input.capability,
      profile_id: candidate.profile.id,
      result: 'granted'
    });

    const previousProfile = attempts.at(-1)?.profile_id;
    if (previousProfile && previousProfile !== candidate.profile.id) {
      observeIntelligenceProviderFailover({
        capability: input.capability,
        from_profile: previousProfile,
        to_profile: candidate.profile.id
      });
      await emitEvent(input.onEvent, {
        tenant_id: input.tenant_id,
        type: 'collaboration.intelligence.provider.failed_over',
        data: {
          capability: input.capability,
          from_profile_id: previousProfile,
          to_profile_id: candidate.profile.id,
          attempt_count: attempts.length + 1
        }
      });
    }

    const startedAt = Date.now();
    let output: TOutput;
    try {
      output = await input.invoke(candidate.provider, candidate.profile);
    } catch (error) {
      const classified = classifyProviderError(error);
      const completion = await completeGovernance(input.governance, {
        tenant_id: input.tenant_id,
        lease_id: reservation.lease_id,
        outcome: classified.retryable ? 'retryable_failure' : 'terminal_failure',
        error_code: classified.code
      });
      governanceCompletionPending ||= completion.pending;
      if (completion.runtime) {
        await emitCircuitTransition(
          input,
          candidate.profile.id,
          completion.runtime.circuit_transition,
          classified.code
        );
      }
      observeIntelligenceProviderRequest({
        capability: input.capability,
        profile_id: candidate.profile.id,
        result: classified.retryable ? 'retryable_failure' : 'terminal_failure',
        error_code: classified.code,
        duration_seconds: (Date.now() - startedAt) / 1_000
      });
      if (!classified.retryable) {
        throw attachRouteContext(error, attempts, candidate.profile.id, classified.code);
      }
      attempts.push({
        profile_id: candidate.profile.id,
        status: 'retryable_failure',
        code: classified.code
      });
      continue;
    }

    const completion = await completeGovernance(input.governance, {
      tenant_id: input.tenant_id,
      lease_id: reservation.lease_id,
      outcome: 'success'
    });
    governanceCompletionPending ||= completion.pending;
    if (completion.runtime) {
      await emitCircuitTransition(
        input,
        candidate.profile.id,
        completion.runtime.circuit_transition,
        ''
      );
    }
    observeIntelligenceProviderRequest({
      capability: input.capability,
      profile_id: candidate.profile.id,
      result: 'succeeded',
      duration_seconds: (Date.now() - startedAt) / 1_000
    });
    attempts.push({ profile_id: candidate.profile.id, status: 'succeeded', code: '' });
    await emitEvent(input.onEvent, {
      tenant_id: input.tenant_id,
      type: 'collaboration.intelligence.provider.selected',
      data: {
        capability: input.capability,
        profile_id: candidate.profile.id,
        attempt_count: attempts.length,
        failed_over: index > 0,
        ...(governanceCompletionPending ? { governance_completion_pending: true } : {})
      }
    });
    return {
      output,
      selected_profile: { ...candidate.profile },
      attempt_count: attempts.length,
      failed_over: index > 0,
      attempts,
      governance_completion_pending: governanceCompletionPending
    };
  }
  observeIntelligenceProviderRouteExhausted(input.capability);
  const exhausted = new IntelligenceProviderRouteError(attempts);
  await emitEvent(input.onEvent, {
    tenant_id: input.tenant_id,
    type: 'collaboration.intelligence.provider.route_exhausted',
    data: {
      capability: input.capability,
      attempts,
      retry_at: exhausted.retry_at,
      provider_invoked: exhausted.provider_invoked,
      failover_attempted: exhausted.failover_attempted,
      governance_completion_pending: governanceCompletionPending
    }
  });
  throw exhausted;
}

async function completeGovernance(
  governance: IntelligenceProviderGovernanceStore,
  input: Parameters<IntelligenceProviderGovernanceStore['complete']>[0]
): Promise<{
  runtime: Awaited<ReturnType<IntelligenceProviderGovernanceStore['complete']>> | null;
  pending: boolean;
}> {
  try {
    return { runtime: await governance.complete(input), pending: false };
  } catch {
    return { runtime: null, pending: true };
  }
}

async function emitCircuitTransition(
  input: {
    tenant_id: string;
    capability: IntelligenceProviderCapability;
    onEvent?: IntelligenceProviderRouteEventHandler;
  },
  profileId: string,
  transition: IntelligenceProviderCircuitTransition | undefined,
  errorCode: string
): Promise<void> {
  if (!transition) return;
  observeIntelligenceProviderCircuitTransition({
    capability: input.capability,
    profile_id: profileId,
    from_state: transition.from_state,
    to_state: transition.to_state
  });
  await emitEvent(input.onEvent, {
    tenant_id: input.tenant_id,
    type: 'collaboration.intelligence.provider.circuit_changed',
    data: {
      capability: input.capability,
      profile_id: profileId,
      previous_state: transition.from_state,
      state: transition.to_state,
      error_code: errorCode
    }
  });
}

async function emitEvent(
  handler: IntelligenceProviderRouteEventHandler | undefined,
  event: IntelligenceProviderRouteEvent
): Promise<void> {
  try {
    await handler?.(event);
  } catch {
    // Provider completion is authoritative; replay/event delivery is best-effort here.
  }
}

function classifyProviderError(error: unknown): { code: string; retryable: boolean } {
  const details = error as { code?: unknown; retryable?: unknown };
  return {
    code: safeCode(details?.code),
    retryable: details?.retryable === true
  };
}

function safeCode(value: unknown): string {
  return String(value || 'provider_error')
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, '_')
    .slice(0, 100) || 'provider_error';
}

function earliestRetryAt(attempts: IntelligenceProviderRouteAttempt[]): string {
  return attempts
    .map((attempt) => attempt.retry_at || '')
    .filter((value) => !Number.isNaN(Date.parse(value)))
    .sort()[0] || '';
}

function safeRetryAt(value: unknown): string {
  const text = String(value || '');
  return Number.isNaN(Date.parse(text)) ? '' : new Date(text).toISOString();
}

function safeAttempts(value: unknown): IntelligenceProviderRouteAttempt[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const attempt = raw as Record<string, unknown>;
    const status = attempt.status;
    if (
      status !== 'succeeded' && status !== 'retryable_failure' &&
      status !== 'terminal_failure' && status !== 'skipped'
    ) return [];
    const retryAt = safeRetryAt(attempt.retry_at);
    return [{
      profile_id: safeCode(attempt.profile_id),
      status,
      code: safeCode(attempt.code),
      ...(retryAt ? { retry_at: retryAt } : {})
    }];
  });
}

function attachRouteContext(
  error: unknown,
  attempts: IntelligenceProviderRouteAttempt[],
  profileId: string,
  code: string
): unknown {
  if (!error || typeof error !== 'object') return error;
  return Object.assign(error, {
    route_attempts: [...attempts, { profile_id: profileId, status: 'terminal_failure', code }],
    provider_invoked: true
  });
}
