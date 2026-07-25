import type { PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import { IntelligencePolicyStore } from './intelligence-policy-store.js';
import type {
  IntelligenceProviderCircuitTransition,
  IntelligenceProviderGovernanceStore,
  IntelligenceProviderOutcome
} from './intelligence-provider-governance-store.js';
import { IntelligenceProviderGovernanceStore as DefaultGovernanceStore } from './intelligence-provider-governance-store.js';
import {
  observeIntelligenceProviderCircuitTransition,
  observeIntelligenceProviderFailover,
  observeIntelligenceProviderRequest,
  observeIntelligenceProviderReservation,
  observeIntelligenceProviderRouteExhausted
} from './intelligence-provider-metrics.js';
import type {
  IntelligenceProviderCapability,
  IntelligenceProviderProfile,
  IntelligenceProviderRegistry
} from './intelligence-provider-registry.js';
import {
  executeIntelligenceProviderRoute,
  IntelligenceProviderRouteError,
  type IntelligenceProviderRouteAttempt,
  type IntelligenceProviderRouteCandidate,
  type IntelligenceProviderRouteEvent,
  type IntelligenceProviderRouteEventHandler,
  type IntelligenceProviderRouteResult
} from './intelligence-provider-route.js';
import {
  createHttpModelGatewayProvider,
  type ModelGatewayProvider
} from './model-gateway-provider.js';
import {
  createHttpTtsProvider,
  type TtsProvider,
  type TtsSynthesisResult
} from './tts-provider.js';

const TTS_ADAPTER = 'ivekit_tts_v1';
const MODEL_ADAPTER = 'openai_compatible';

export interface PolicyTtsProviderResolution {
  enabled: boolean;
  profile_id: string;
  provider: TtsProvider | null;
  error_code: string;
}

export interface PolicyModelGatewayProviderResolution {
  enabled: boolean;
  profile_id: string;
  provider: ModelGatewayProvider | null;
  error_code: string;
}

export type PolicyTtsProviderResolver = (
  input: { tenant_id: string }
) => Promise<PolicyTtsProviderResolution>;

export type PolicyModelGatewayProviderResolver = (
  input: { tenant_id: string }
) => Promise<PolicyModelGatewayProviderResolution>;

interface GenericProviderRoutingOptions {
  pg: PgQueryable;
  registry: IntelligenceProviderRegistry;
  governance?: IntelligenceProviderGovernanceStore;
  fetch?: typeof fetch;
  onEvent?: IntelligenceProviderRouteEventHandler;
}

export function createPolicyTtsProviderResolver(
  input: GenericProviderRoutingOptions & { lease_renew_interval_ms?: number }
): PolicyTtsProviderResolver {
  const governance = input.governance || new DefaultGovernanceStore(input.pg);
  return async ({ tenant_id }) => {
    const policy = await effectivePolicy(input, tenant_id);
    if (!policy.tts_enabled) return unavailableTts(false, policy.tts_profile_ids[0] || '', 'policy_disabled');
    if (!policy.tts_profile_ids.length) return unavailableTts(true, '', 'provider_unavailable');
    const candidates = createCandidates({
      registry: input.registry,
      profile_ids: policy.tts_profile_ids,
      capability: 'tts',
      adapter: TTS_ADAPTER,
      allow_third_party: policy.allow_third_party,
      create: (profile, token) => createHttpTtsProvider({
        ...providerConfig(profile, token, input.fetch),
        providerVersion: profile.provider_version
      })
    });
    const available = candidates.find((candidate) => candidate.provider);
    if (!available) {
      return unavailableTts(
        true,
        policy.tts_profile_ids[0],
        candidates[0]?.unavailable_reason || 'provider_unavailable'
      );
    }
    const provider = routedTtsProvider({
      tenant_id,
      candidates,
      initial: available,
      governance,
      onEvent: input.onEvent,
      lease_renew_interval_ms: input.lease_renew_interval_ms
    });
    return { enabled: true, profile_id: provider.profile_id, provider, error_code: '' };
  };
}

export function createPolicyModelGatewayProviderResolver(
  input: GenericProviderRoutingOptions
): PolicyModelGatewayProviderResolver {
  const governance = input.governance || new DefaultGovernanceStore(input.pg);
  return async ({ tenant_id }) => {
    const policy = await effectivePolicy(input, tenant_id);
    if (!policy.model_gateway_enabled) {
      return unavailableModel(false, policy.model_gateway_profile_ids[0] || '', 'policy_disabled');
    }
    if (!policy.model_gateway_profile_ids.length) return unavailableModel(true, '', 'provider_unavailable');
    const candidates = createCandidates({
      registry: input.registry,
      profile_ids: policy.model_gateway_profile_ids,
      capability: 'model_gateway',
      adapter: MODEL_ADAPTER,
      allow_third_party: policy.allow_third_party,
      create: (profile, token) => createHttpModelGatewayProvider({
        ...providerConfig(profile, token, input.fetch),
        providerVersion: profile.provider_version
      })
    });
    const available = candidates.find((candidate) => candidate.provider);
    if (!available) {
      return unavailableModel(
        true,
        policy.model_gateway_profile_ids[0],
        candidates[0]?.unavailable_reason || 'provider_unavailable'
      );
    }
    const provider = routedModelProvider({
      tenant_id,
      candidates,
      initial: available,
      governance,
      onEvent: input.onEvent
    });
    return { enabled: true, profile_id: provider.profile_id, provider, error_code: '' };
  };
}

async function effectivePolicy(input: GenericProviderRoutingOptions, tenantId: string) {
  return withPgTenant(input.pg, tenantId, (pg) =>
    new IntelligencePolicyStore(pg, input.registry).getEffectivePolicy(tenantId)
  );
}

function createCandidates<TProvider>(input: {
  registry: IntelligenceProviderRegistry;
  profile_ids: string[];
  capability: IntelligenceProviderCapability;
  adapter: string;
  allow_third_party: boolean;
  create(profile: IntelligenceProviderProfile, token: string | undefined): TProvider;
}): Array<IntelligenceProviderRouteCandidate<TProvider>> {
  const candidates: Array<IntelligenceProviderRouteCandidate<TProvider>> = [];
  for (const profileId of input.profile_ids) {
    const profile = input.registry.profile(profileId);
    if (!profile || profile.capability !== input.capability) continue;
    if (profile.mode === 'third_party' && !input.allow_third_party) {
      candidates.push({ profile, provider: null, unavailable_reason: 'third_party_not_allowed' });
      continue;
    }
    if (profile.adapter !== input.adapter) {
      candidates.push({ profile, provider: null, unavailable_reason: 'provider_adapter_unavailable' });
      continue;
    }
    const token = input.registry.resolveToken(profile);
    if (profile.token_env && !token) {
      candidates.push({ profile, provider: null, unavailable_reason: 'provider_credential_unavailable' });
      continue;
    }
    candidates.push({ profile, provider: input.create(profile, token) });
  }
  return candidates;
}

function routedModelProvider(input: {
  tenant_id: string;
  candidates: Array<IntelligenceProviderRouteCandidate<ModelGatewayProvider>>;
  initial: IntelligenceProviderRouteCandidate<ModelGatewayProvider>;
  governance: IntelligenceProviderGovernanceStore;
  onEvent?: IntelligenceProviderRouteEventHandler;
}): ModelGatewayProvider {
  const provider: MutableProvider<ModelGatewayProvider> = {
    name: input.initial.profile.name,
    mode: input.initial.profile.mode,
    profile_id: input.initial.profile.id,
    async generate(request) {
      const result = await executeIntelligenceProviderRoute({
        tenant_id: input.tenant_id,
        capability: 'model_gateway',
        candidates: input.candidates,
        governance: input.governance,
        onEvent: input.onEvent,
        invoke: (candidate) => candidate.generate(request)
      });
      selectProvider(provider, result);
      return { ...result.output, metadata: routeMetadata(result.output.metadata, result) };
    }
  };
  return provider;
}

function routedTtsProvider(input: {
  tenant_id: string;
  candidates: Array<IntelligenceProviderRouteCandidate<TtsProvider>>;
  initial: IntelligenceProviderRouteCandidate<TtsProvider>;
  governance: IntelligenceProviderGovernanceStore;
  onEvent?: IntelligenceProviderRouteEventHandler;
  lease_renew_interval_ms?: number;
}): TtsProvider {
  const provider: MutableProvider<TtsProvider> = {
    name: input.initial.profile.name,
    mode: input.initial.profile.mode,
    profile_id: input.initial.profile.id,
    async synthesize(request) {
      const selected = await startTtsRoute({ ...input, request });
      provider.name = selected.profile.name;
      provider.mode = selected.profile.mode;
      provider.profile_id = selected.profile.id;
      return selected.result;
    }
  };
  return provider;
}

async function startTtsRoute(input: {
  tenant_id: string;
  candidates: Array<IntelligenceProviderRouteCandidate<TtsProvider>>;
  governance: IntelligenceProviderGovernanceStore;
  onEvent?: IntelligenceProviderRouteEventHandler;
  lease_renew_interval_ms?: number;
  request: Parameters<TtsProvider['synthesize']>[0];
}): Promise<{ profile: IntelligenceProviderProfile; result: TtsSynthesisResult }> {
  const attempts: IntelligenceProviderRouteAttempt[] = [];
  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index];
    if (!candidate.provider) {
      const reason = safeCode(candidate.unavailable_reason || 'provider_unavailable');
      observeIntelligenceProviderReservation({ capability: 'tts', profile_id: candidate.profile.id, result: reason });
      attempts.push({ profile_id: candidate.profile.id, status: 'skipped', code: reason });
      continue;
    }
    const reservation = await input.governance.reserve({
      tenant_id: input.tenant_id,
      capability: 'tts',
      profile: candidate.profile,
      route_attempt: index + 1
    });
    await emitCircuit(input, candidate.profile.id, reservation.circuit_transition, '');
    if (reservation.granted === false) {
      observeIntelligenceProviderReservation({
        capability: 'tts', profile_id: candidate.profile.id, result: reservation.reason
      });
      attempts.push({
        profile_id: candidate.profile.id,
        status: 'skipped',
        code: reservation.reason,
        retry_at: reservation.retry_at
      });
      continue;
    }
    observeIntelligenceProviderReservation({ capability: 'tts', profile_id: candidate.profile.id, result: 'granted' });
    await emitFailover(input, attempts, candidate.profile.id);
    const startedAt = Date.now();
    let result: TtsSynthesisResult;
    try {
      result = await candidate.provider.synthesize(input.request);
    } catch (error) {
      const failure = classifyProviderError(error);
      const runtime = await completeGovernance(input.governance, {
        tenant_id: input.tenant_id,
        lease_id: reservation.lease_id,
        outcome: failure.retryable ? 'retryable_failure' : 'terminal_failure',
        error_code: failure.code
      });
      await emitCircuit(input, candidate.profile.id, runtime?.circuit_transition, failure.code);
      observeIntelligenceProviderRequest({
        capability: 'tts', profile_id: candidate.profile.id,
        result: failure.retryable ? 'retryable_failure' : 'terminal_failure',
        error_code: failure.code, duration_seconds: (Date.now() - startedAt) / 1_000
      });
      if (!failure.retryable) throw attachRouteContext(error, attempts, candidate.profile.id, failure.code);
      attempts.push({ profile_id: candidate.profile.id, status: 'retryable_failure', code: failure.code });
      continue;
    }

    attempts.push({ profile_id: candidate.profile.id, status: 'succeeded', code: '' });
    const route = {
      attempt_count: attempts.length,
      failed_over: index > 0,
      attempts,
      governance_completion_pending: false
    };
    result.metadata = routeMetadata(result.metadata, route);
    result = governedTtsResult({
      inner: result,
      tenant_id: input.tenant_id,
      profile: candidate.profile,
      governance: input.governance,
      lease_id: reservation.lease_id,
      started_at_ms: startedAt,
      onEvent: input.onEvent,
      lease_renew_interval_ms: input.lease_renew_interval_ms
    });
    await emitEvent(input.onEvent, {
      tenant_id: input.tenant_id,
      type: 'collaboration.intelligence.provider.selected',
      data: {
        capability: 'tts', profile_id: candidate.profile.id,
        attempt_count: attempts.length, failed_over: index > 0
      }
    });
    return { profile: candidate.profile, result };
  }

  observeIntelligenceProviderRouteExhausted('tts');
  const exhausted = new IntelligenceProviderRouteError(attempts);
  await emitEvent(input.onEvent, {
    tenant_id: input.tenant_id,
    type: 'collaboration.intelligence.provider.route_exhausted',
    data: {
      capability: 'tts', attempts, retry_at: exhausted.retry_at,
      provider_invoked: exhausted.provider_invoked,
      failover_attempted: exhausted.failover_attempted
    }
  });
  throw exhausted;
}

function governedTtsResult(input: {
  inner: TtsSynthesisResult;
  tenant_id: string;
  profile: IntelligenceProviderProfile;
  governance: IntelligenceProviderGovernanceStore;
  lease_id: string;
  started_at_ms: number;
  onEvent?: IntelligenceProviderRouteEventHandler;
  lease_renew_interval_ms?: number;
}): TtsSynthesisResult {
  let completed = false;
  let renewing = false;
  const interval = leaseRenewInterval(input.profile.reservation_ttl_ms, input.lease_renew_interval_ms);
  const timer = setInterval(() => void renew(), interval);
  timer.unref();

  const complete = async (outcome: IntelligenceProviderOutcome, errorCode = ''): Promise<void> => {
    if (completed) return;
    completed = true;
    clearInterval(timer);
    const runtime = await completeGovernance(input.governance, {
      tenant_id: input.tenant_id,
      lease_id: input.lease_id,
      outcome,
      error_code: errorCode
    });
    if (!runtime) input.inner.metadata.ivekit_governance_completion_pending = true;
    await emitCircuit(input, input.profile.id, runtime?.circuit_transition, errorCode);
    observeIntelligenceProviderRequest({
      capability: 'tts', profile_id: input.profile.id,
      result: outcome === 'success'
        ? 'succeeded'
        : outcome === 'retryable_failure' ? 'retryable_failure' : 'terminal_failure',
      error_code: errorCode,
      duration_seconds: (Date.now() - input.started_at_ms) / 1_000
    });
  };

  async function renew(): Promise<void> {
    if (renewing || completed) return;
    renewing = true;
    try {
      await input.governance.renew({
        tenant_id: input.tenant_id, lease_id: input.lease_id, profile: input.profile
      });
    } catch {
      input.inner.cancel();
      await complete('retryable_failure', 'governance_lease_lost');
    } finally {
      renewing = false;
    }
  }

  const audio = (async function* () {
    let exhausted = false;
    try {
      for await (const chunk of input.inner.audio) yield chunk;
      exhausted = true;
      await complete('success');
    } catch (error) {
      const failure = classifyProviderError(error);
      await complete(failure.retryable ? 'retryable_failure' : 'terminal_failure', failure.code);
      throw error;
    } finally {
      if (!exhausted && !completed) {
        input.inner.cancel();
        await complete('terminal_failure', 'provider_cancelled');
      }
    }
  })();

  return {
    ...input.inner,
    audio,
    cancel() {
      input.inner.cancel();
      void complete('terminal_failure', 'provider_cancelled');
    }
  };
}

async function emitFailover(
  input: { tenant_id: string; onEvent?: IntelligenceProviderRouteEventHandler },
  attempts: IntelligenceProviderRouteAttempt[],
  nextProfileId: string
): Promise<void> {
  const previous = attempts.at(-1)?.profile_id;
  if (!previous || previous === nextProfileId) return;
  observeIntelligenceProviderFailover({ capability: 'tts', from_profile: previous, to_profile: nextProfileId });
  await emitEvent(input.onEvent, {
    tenant_id: input.tenant_id,
    type: 'collaboration.intelligence.provider.failed_over',
    data: {
      capability: 'tts', from_profile_id: previous,
      to_profile_id: nextProfileId, attempt_count: attempts.length + 1
    }
  });
}

async function emitCircuit(
  input: { tenant_id: string; onEvent?: IntelligenceProviderRouteEventHandler },
  profileId: string,
  transition: IntelligenceProviderCircuitTransition | undefined,
  errorCode: string
): Promise<void> {
  if (!transition) return;
  observeIntelligenceProviderCircuitTransition({
    capability: 'tts', profile_id: profileId,
    from_state: transition.from_state, to_state: transition.to_state
  });
  await emitEvent(input.onEvent, {
    tenant_id: input.tenant_id,
    type: 'collaboration.intelligence.provider.circuit_changed',
    data: {
      capability: 'tts', profile_id: profileId,
      previous_state: transition.from_state, state: transition.to_state,
      error_code: errorCode
    }
  });
}

async function completeGovernance(
  governance: IntelligenceProviderGovernanceStore,
  input: Parameters<IntelligenceProviderGovernanceStore['complete']>[0]
) {
  try { return await governance.complete(input); } catch { return null; }
}

async function emitEvent(
  handler: IntelligenceProviderRouteEventHandler | undefined,
  event: IntelligenceProviderRouteEvent
): Promise<void> {
  try { await handler?.(event); } catch { /* Provider result remains authoritative. */ }
}

function classifyProviderError(error: unknown): { code: string; retryable: boolean } {
  const value = error as { code?: unknown; retryable?: unknown };
  return { code: safeCode(value?.code), retryable: value?.retryable === true };
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
      profile_id: profileId, status: 'terminal_failure' as const, code
    }],
    provider_invoked: true
  });
}

function selectProvider(
  provider: { name: string; mode: 'self_hosted' | 'third_party'; profile_id: string },
  result: IntelligenceProviderRouteResult<unknown>
): void {
  provider.name = result.selected_profile.name;
  provider.mode = result.selected_profile.mode;
  provider.profile_id = result.selected_profile.id;
}

function routeMetadata(
  metadata: Record<string, unknown> | undefined,
  route: {
    attempt_count: number;
    failed_over: boolean;
    attempts: IntelligenceProviderRouteAttempt[];
    governance_completion_pending: boolean;
  }
): Record<string, unknown> {
  return {
    ...(metadata || {}),
    ivekit_route_attempt_count: route.attempt_count,
    ivekit_route_failed_over: route.failed_over,
    ivekit_route_attempts: route.attempts,
    ...(route.governance_completion_pending ? { ivekit_governance_completion_pending: true } : {})
  };
}

function providerConfig(
  profile: IntelligenceProviderProfile,
  token: string | undefined,
  fetchImpl: typeof fetch | undefined
) {
  return {
    mode: profile.mode,
    baseUrl: profile.base_url,
    endpoint: profile.endpoint,
    token,
    timeoutMs: profile.timeout_ms,
    name: profile.name,
    profileId: profile.id,
    fetch: fetchImpl
  };
}

function leaseRenewInterval(ttlMs: number, override: number | undefined): number {
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 5 || override >= ttlMs) {
      throw new Error('lease_renew_interval_ms must be at least 5 and below reservation TTL');
    }
    return override;
  }
  return Math.min(30_000, Math.max(1_000, Math.floor(ttlMs / 3)));
}

function unavailableTts(enabled: boolean, profileId: string, errorCode: string): PolicyTtsProviderResolution {
  return { enabled, profile_id: profileId, provider: null, error_code: errorCode };
}

function unavailableModel(
  enabled: boolean,
  profileId: string,
  errorCode: string
): PolicyModelGatewayProviderResolution {
  return { enabled, profile_id: profileId, provider: null, error_code: errorCode };
}

function safeCode(value: unknown): string {
  return String(value || 'provider_error')
    .trim().replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 100) || 'provider_error';
}

type MutableProvider<T> = { -readonly [K in keyof T]: T[K] };
