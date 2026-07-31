import type { PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import { IntelligencePolicyStore } from '../../collaboration/intelligence-policy-store.js';
import type { IntelligenceProviderGovernanceStore } from '../../collaboration/intelligence-provider-governance-store.js';
import type {
  IntelligenceProviderCircuitTransition,
  IntelligenceProviderOutcome
} from '../../collaboration/intelligence-provider-governance-store.js';
import {
  observeIntelligenceProviderCircuitTransition,
  observeIntelligenceProviderFailover,
  observeIntelligenceProviderRequest,
  observeIntelligenceProviderReservation,
  observeIntelligenceProviderRouteExhausted
} from '../../collaboration/intelligence-provider-metrics.js';
import type {
  IntelligenceProviderProfile,
  IntelligenceProviderRegistry
} from '../../collaboration/intelligence-provider-registry.js';
import {
  IntelligenceProviderRouteError,
  type IntelligenceProviderRouteAttempt,
  type IntelligenceProviderRouteEvent,
  type IntelligenceProviderRouteEventHandler
} from '../../collaboration/intelligence-provider-route.js';
import { createExternalRealtimeSpeechFactory } from './adapters/external-realtime-speech.js';
import { VoiceError } from './errors.js';
import {
  RealtimeSpeechTranslationRegistry,
  RealtimeSpeechTranslationService,
  type EndRealtimeSpeechTranslationInput,
  type RealtimeAudioFrame,
  type RealtimeAudioWriteResult,
  type RealtimeSpeechProviderProfile,
  type RealtimeSpeechTranslationEvent,
  type RealtimeSpeechTranslationEventSink,
  type RealtimeSpeechTranslationFactory,
  type RealtimeSpeechTranslationSession,
  type RealtimeSpeechTranslationSessionPlan,
  type StartRealtimeSpeechTranslationInput
} from './realtime-speech-translation.js';

const CAPABILITY = 'realtime_speech' as const;
const EXTERNAL_ADAPTER = 'ivekit_realtime_speech_v1';

export interface PolicyRealtimeSpeechRouterOptions {
  pg: PgQueryable;
  registry: IntelligenceProviderRegistry;
  governance: IntelligenceProviderGovernanceStore;
  adapters?: Readonly<Record<string, RealtimeSpeechTranslationFactory>>;
  env?: Readonly<Record<string, string | undefined>>;
  onEvent?: IntelligenceProviderRouteEventHandler;
  lease_renew_interval_ms?: number;
}

export interface PolicyRealtimeSpeechRouteResult {
  session: RealtimeSpeechTranslationSession;
  selected_profile_id: string;
  attempt_count: number;
  failed_over: boolean;
  attempts: IntelligenceProviderRouteAttempt[];
}

export interface PolicyRealtimeSpeechRouter {
  startSession(
    input: StartRealtimeSpeechTranslationInput,
    emit: RealtimeSpeechTranslationEventSink
  ): Promise<PolicyRealtimeSpeechRouteResult>;
}

export function createPolicyRealtimeSpeechRouter(
  options: PolicyRealtimeSpeechRouterOptions
): PolicyRealtimeSpeechRouter {
  const adapters = new Map(Object.entries(options.adapters ?? {}));
  if (!adapters.has(EXTERNAL_ADAPTER)) {
    adapters.set(EXTERNAL_ADAPTER, createExternalRealtimeSpeechFactory({ env: options.env }));
  }
  return new DefaultPolicyRealtimeSpeechRouter(options, adapters);
}

class DefaultPolicyRealtimeSpeechRouter implements PolicyRealtimeSpeechRouter {
  constructor(
    private readonly options: PolicyRealtimeSpeechRouterOptions,
    private readonly adapters: ReadonlyMap<string, RealtimeSpeechTranslationFactory>
  ) {}

  async startSession(
    input: StartRealtimeSpeechTranslationInput,
    emit: RealtimeSpeechTranslationEventSink
  ): Promise<PolicyRealtimeSpeechRouteResult> {
    const policy = await withPgTenant(this.options.pg, input.tenant_id, (pg) =>
      new IntelligencePolicyStore(pg, this.options.registry).getEffectivePolicy(input.tenant_id)
    );
    if (!policy.realtime_speech_enabled) {
      throw new VoiceError({ code: 'capability_unavailable', status: 409 });
    }

    const attempts: IntelligenceProviderRouteAttempt[] = [];
    const candidates = policy.realtime_speech_profile_ids.map((profileId) =>
      this.#candidate(profileId, policy.allow_third_party, input.tenant_id)
    );
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!candidate.factory || !candidate.voice_profile) {
        observeIntelligenceProviderReservation({
          capability: CAPABILITY,
          profile_id: candidate.profile.id,
          result: candidate.unavailable_reason
        });
        attempts.push({
          profile_id: candidate.profile.id,
          status: 'skipped',
          code: candidate.unavailable_reason
        });
        continue;
      }

      const reservation = await this.options.governance.reserve({
        tenant_id: input.tenant_id,
        capability: CAPABILITY,
        profile: candidate.profile,
        route_attempt: index + 1
      });
      await this.#emitCircuit(
        input.tenant_id,
        candidate.profile.id,
        reservation.circuit_transition,
        ''
      );
      if (reservation.granted === false) {
        observeIntelligenceProviderReservation({
          capability: CAPABILITY,
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
        capability: CAPABILITY,
        profile_id: candidate.profile.id,
        result: 'granted'
      });
      await this.#emitFailover(input.tenant_id, attempts, candidate.profile.id);

      const startedAt = Date.now();
      let degradationCode = '';
      const service = new RealtimeSpeechTranslationService({
        registry: new RealtimeSpeechTranslationRegistry({
          [candidate.voice_profile.provider]: candidate.factory
        })
      });
      let inner: RealtimeSpeechTranslationSession;
      try {
        inner = await service.startSession(candidate.voice_profile, input, (event) => {
          if (event.type === 'provider.degraded') {
            degradationCode = safeCode(event.safe_metadata.reason || 'provider_degraded');
          }
          emit(event);
        });
      } catch (error) {
        const failure = classifyProviderError(error);
        const runtime = await completeGovernance(this.options.governance, {
          tenant_id: input.tenant_id,
          lease_id: reservation.lease_id,
          outcome: failure.retryable ? 'retryable_failure' : 'terminal_failure',
          error_code: failure.code
        });
        await this.#emitCircuit(
          input.tenant_id,
          candidate.profile.id,
          runtime?.circuit_transition,
          failure.code
        );
        observeIntelligenceProviderRequest({
          capability: CAPABILITY,
          profile_id: candidate.profile.id,
          result: failure.retryable ? 'retryable_failure' : 'terminal_failure',
          error_code: failure.code,
          duration_seconds: (Date.now() - startedAt) / 1_000
        });
        if (!failure.retryable) {
          throw attachRouteContext(error, attempts, candidate.profile.id, failure.code);
        }
        attempts.push({
          profile_id: candidate.profile.id,
          status: 'retryable_failure',
          code: failure.code
        });
        continue;
      }

      attempts.push({ profile_id: candidate.profile.id, status: 'succeeded', code: '' });
      const session = new GovernedRealtimeSpeechSession({
        inner,
        governance: this.options.governance,
        profile: candidate.profile,
        tenant_id: input.tenant_id,
        lease_id: reservation.lease_id,
        started_at_ms: startedAt,
        degradation_code: () => degradationCode,
        mark_degraded: (code) => { degradationCode ||= code; },
        emit,
        onCircuit: (transition, code) => this.#emitCircuit(
          input.tenant_id,
          candidate.profile.id,
          transition,
          code
        ),
        lease_renew_interval_ms: this.options.lease_renew_interval_ms
      });
      await emitEvent(this.options.onEvent, {
        tenant_id: input.tenant_id,
        type: 'collaboration.intelligence.provider.selected',
        data: {
          capability: CAPABILITY,
          profile_id: candidate.profile.id,
          attempt_count: attempts.length,
          failed_over: index > 0
        }
      });
      return {
        session,
        selected_profile_id: candidate.profile.id,
        attempt_count: attempts.length,
        failed_over: index > 0,
        attempts
      };
    }

    observeIntelligenceProviderRouteExhausted(CAPABILITY);
    const exhausted = new IntelligenceProviderRouteError(attempts);
    await emitEvent(this.options.onEvent, {
      tenant_id: input.tenant_id,
      type: 'collaboration.intelligence.provider.route_exhausted',
      data: {
        capability: CAPABILITY,
        attempts,
        retry_at: exhausted.retry_at,
        provider_invoked: exhausted.provider_invoked,
        failover_attempted: exhausted.failover_attempted
      }
    });
    throw exhausted;
  }

  #candidate(profileId: string, allowThirdParty: boolean, tenantId: string): RouteCandidate {
    const profile = this.options.registry.profile(profileId);
    if (!profile || profile.capability !== CAPABILITY) {
      return {
        profile: unavailableProfile(profileId),
        factory: null,
        voice_profile: null,
        unavailable_reason: 'provider_unavailable'
      };
    }
    if (profile.mode === 'third_party' && !allowThirdParty) {
      return { profile, factory: null, voice_profile: null, unavailable_reason: 'third_party_not_allowed' };
    }
    if ((profile.adapter === EXTERNAL_ADAPTER && !profile.token_env)
      || (profile.token_env && !this.options.registry.resolveToken(profile))) {
      return {
        profile,
        factory: null,
        voice_profile: null,
        unavailable_reason: 'provider_credential_unavailable'
      };
    }
    const factory = this.adapters.get(profile.adapter);
    if (!factory) {
      return {
        profile,
        factory: null,
        voice_profile: null,
        unavailable_reason: 'provider_adapter_unavailable'
      };
    }
    return {
      profile,
      factory,
      voice_profile: toRealtimeProfile(profile, tenantId),
      unavailable_reason: ''
    };
  }

  async #emitFailover(
    tenantId: string,
    attempts: IntelligenceProviderRouteAttempt[],
    nextProfileId: string
  ): Promise<void> {
    const previousProfileId = attempts.at(-1)?.profile_id;
    if (!previousProfileId || previousProfileId === nextProfileId) return;
    observeIntelligenceProviderFailover({
      capability: CAPABILITY,
      from_profile: previousProfileId,
      to_profile: nextProfileId
    });
    await emitEvent(this.options.onEvent, {
      tenant_id: tenantId,
      type: 'collaboration.intelligence.provider.failed_over',
      data: {
        capability: CAPABILITY,
        from_profile_id: previousProfileId,
        to_profile_id: nextProfileId,
        attempt_count: attempts.length + 1
      }
    });
  }

  async #emitCircuit(
    tenantId: string,
    profileId: string,
    transition: IntelligenceProviderCircuitTransition | undefined,
    errorCode: string
  ): Promise<void> {
    if (!transition) return;
    observeIntelligenceProviderCircuitTransition({
      capability: CAPABILITY,
      profile_id: profileId,
      from_state: transition.from_state,
      to_state: transition.to_state
    });
    await emitEvent(this.options.onEvent, {
      tenant_id: tenantId,
      type: 'collaboration.intelligence.provider.circuit_changed',
      data: {
        capability: CAPABILITY,
        profile_id: profileId,
        previous_state: transition.from_state,
        state: transition.to_state,
        error_code: errorCode
      }
    });
  }
}

interface RouteCandidate {
  profile: IntelligenceProviderProfile;
  factory: RealtimeSpeechTranslationFactory | null;
  voice_profile: RealtimeSpeechProviderProfile | null;
  unavailable_reason: string;
}

class GovernedRealtimeSpeechSession implements RealtimeSpeechTranslationSession {
  readonly plan: RealtimeSpeechTranslationSessionPlan;
  readonly #renewTimer: NodeJS.Timeout;
  #renewing = false;
  #completed = false;
  #closed = false;

  constructor(private readonly options: {
    inner: RealtimeSpeechTranslationSession;
    governance: IntelligenceProviderGovernanceStore;
    profile: IntelligenceProviderProfile;
    tenant_id: string;
    lease_id: string;
    started_at_ms: number;
    degradation_code: () => string;
    mark_degraded: (code: string) => void;
    emit: RealtimeSpeechTranslationEventSink;
    onCircuit: (
      transition: IntelligenceProviderCircuitTransition | undefined,
      code: string
    ) => Promise<void>;
    lease_renew_interval_ms?: number;
  }) {
    this.plan = options.inner.plan;
    const interval = leaseRenewInterval(
      options.profile.reservation_ttl_ms,
      options.lease_renew_interval_ms
    );
    this.#renewTimer = setInterval(() => void this.#renewLease(), interval);
    this.#renewTimer.unref();
  }

  tryWriteAudio(frame: RealtimeAudioFrame): RealtimeAudioWriteResult {
    if (this.#closed || this.#completed) return 'closed';
    return this.options.inner.tryWriteAudio(frame);
  }

  async end(input: EndRealtimeSpeechTranslationInput): Promise<void> {
    if (this.#closed || this.#completed) return;
    try {
      await this.options.inner.end(input);
      await this.#complete(this.options.degradation_code() ? 'retryable_failure' : 'success');
    } catch (error) {
      const failure = classifyProviderError(error);
      await this.#complete(
        failure.retryable ? 'retryable_failure' : 'terminal_failure',
        failure.code
      );
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#renewTimer);
    try {
      await this.options.inner.close();
    } finally {
      const code = this.options.degradation_code();
      await this.#complete(code ? 'retryable_failure' : 'success', code);
    }
  }

  async #renewLease(): Promise<void> {
    if (this.#renewing || this.#completed || this.#closed) return;
    this.#renewing = true;
    try {
      await this.options.governance.renew({
        tenant_id: this.options.tenant_id,
        lease_id: this.options.lease_id,
        profile: this.options.profile
      });
    } catch {
      const code = 'governance_lease_lost';
      this.options.mark_degraded(code);
      this.options.emit(degradedEvent(this.plan.provider_session_id, code));
      await this.options.inner.close().catch(() => undefined);
      await this.#complete('retryable_failure', code);
      this.#closed = true;
    } finally {
      this.#renewing = false;
    }
  }

  async #complete(outcome: IntelligenceProviderOutcome, errorCode = ''): Promise<void> {
    if (this.#completed) return;
    this.#completed = true;
    clearInterval(this.#renewTimer);
    const runtime = await completeGovernance(this.options.governance, {
      tenant_id: this.options.tenant_id,
      lease_id: this.options.lease_id,
      outcome,
      error_code: errorCode
    });
    await this.options.onCircuit(runtime?.circuit_transition, errorCode);
    observeIntelligenceProviderRequest({
      capability: CAPABILITY,
      profile_id: this.options.profile.id,
      result: outcome === 'success'
        ? 'succeeded'
        : outcome === 'retryable_failure' ? 'retryable_failure' : 'terminal_failure',
      error_code: errorCode,
      duration_seconds: (Date.now() - this.options.started_at_ms) / 1_000
    });
  }
}

function toRealtimeProfile(
  profile: IntelligenceProviderProfile,
  tenantId: string
): RealtimeSpeechProviderProfile {
  const endpoint = new URL(profile.endpoint, `${profile.base_url}/`);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    id: profile.id,
    tenant_id: tenantId,
    name: profile.name,
    provider: profile.id,
    mode: profile.mode,
    transport: 'websocket',
    status: 'enabled',
    endpoint: endpoint.toString(),
    provider_version: profile.provider_version,
    data_region: profile.data_region || 'unspecified',
    secret_refs: profile.token_env
      ? { authorization: `env://${profile.token_env}` }
      : {},
    limits: {
      connect_timeout_ms: profile.timeout_ms,
      idle_timeout_ms: Math.max(1_000, Math.min(300_000, profile.timeout_ms * 3)),
      max_buffered_audio_ms: profile.max_buffered_audio_ms,
      max_session_seconds: profile.max_session_seconds
    },
    config: {},
    revision: 1
  };
}

function degradedEvent(providerSessionId: string, reason: string): RealtimeSpeechTranslationEvent {
  return {
    event_id: `degraded-${Date.now()}`,
    type: 'provider.degraded',
    provider_session_id: providerSessionId,
    sequence: 0,
    occurred_at: new Date().toISOString(),
    segment_id: '',
    speaker_id: '',
    source_language: '',
    target_language: '',
    source_text: '',
    translated_text: '',
    provider_request_id: '',
    latency_ms: {},
    safe_metadata: { reason },
    final: false
  };
}

async function completeGovernance(
  governance: IntelligenceProviderGovernanceStore,
  input: Parameters<IntelligenceProviderGovernanceStore['complete']>[0]
): Promise<Awaited<ReturnType<IntelligenceProviderGovernanceStore['complete']>> | null> {
  try {
    return await governance.complete(input);
  } catch {
    return null;
  }
}

async function emitEvent(
  handler: IntelligenceProviderRouteEventHandler | undefined,
  event: IntelligenceProviderRouteEvent
): Promise<void> {
  try {
    await handler?.(event);
  } catch {
    // The provider session remains authoritative; event delivery is replayable.
  }
}

function classifyProviderError(error: unknown): { code: string; retryable: boolean } {
  const value = error as { code?: unknown; retryable?: unknown };
  return { code: safeCode(value?.code), retryable: value?.retryable === true };
}

function safeCode(value: unknown): string {
  return String(value || 'provider_error')
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, '_')
    .slice(0, 100) || 'provider_error';
}

function attachRouteContext(
  error: unknown,
  attempts: IntelligenceProviderRouteAttempt[],
  profileId: string,
  code: string
): unknown {
  if (!error || typeof error !== 'object') return error;
  return Object.assign(error, {
    route_attempts: [...attempts, {
      profile_id: profileId,
      status: 'terminal_failure',
      code
    }],
    provider_invoked: true
  });
}

function leaseRenewInterval(reservationTtlMs: number, override: number | undefined): number {
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 5 || override >= reservationTtlMs) {
      throw new Error('lease_renew_interval_ms must be at least 5 and below reservation TTL');
    }
    return override;
  }
  return Math.min(30_000, Math.max(1_000, Math.floor(reservationTtlMs / 3)));
}

function unavailableProfile(profileId: string): IntelligenceProviderProfile {
  return {
    id: /^[a-z][a-z0-9_-]{0,63}$/.test(profileId) ? profileId : 'unknown-profile',
    capability: CAPABILITY,
    mode: 'self_hosted',
    base_url: 'http://unavailable.invalid',
    endpoint: '/v1/realtime-speech',
    health_endpoint: '/health',
    token_env: '',
    timeout_ms: 1_000,
    requests_per_minute: 0,
    requests_per_day: 0,
    max_concurrency: 1,
    failure_threshold: 1,
    open_cooldown_ms: 1_000,
    reservation_ttl_ms: 5_000,
    adapter: EXTERNAL_ADAPTER,
    provider_version: 'unavailable',
    data_region: '',
    max_buffered_audio_ms: 100,
    max_session_seconds: 30,
    name: 'Unavailable provider',
    legacy: false
  };
}
