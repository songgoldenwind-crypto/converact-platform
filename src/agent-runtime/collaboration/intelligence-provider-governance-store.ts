import { MemoryPg, pgId, type PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import type {
  IntelligenceProviderCapability,
  IntelligenceProviderProfile
} from './intelligence-provider-registry.js';

export type IntelligenceProviderCircuitState = 'closed' | 'open' | 'half_open';
export type IntelligenceProviderReservationReason =
  | 'minute_quota_exhausted'
  | 'day_quota_exhausted'
  | 'concurrency_exhausted'
  | 'circuit_open'
  | 'circuit_half_open_busy';

export type IntelligenceProviderOutcome = 'success' | 'retryable_failure' | 'terminal_failure';

export interface IntelligenceProviderCircuitTransition {
  from_state: IntelligenceProviderCircuitState;
  to_state: IntelligenceProviderCircuitState;
}

export interface IntelligenceProviderRuntimeSnapshot {
  tenant_id: string;
  capability: IntelligenceProviderCapability;
  profile_id: string;
  minute_request_count: number;
  day_request_count: number;
  circuit_state: IntelligenceProviderCircuitState;
  consecutive_retryable_failures: number;
  opened_until: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error_code: string;
  updated_at: string;
  circuit_transition?: IntelligenceProviderCircuitTransition;
}

export type IntelligenceProviderReservation =
  | {
      granted: true;
      lease_id: string;
      profile_id: string;
      expires_at: string;
      circuit_state: IntelligenceProviderCircuitState;
      circuit_transition?: IntelligenceProviderCircuitTransition;
    }
  | {
      granted: false;
      profile_id: string;
      reason: IntelligenceProviderReservationReason;
      retry_at: string;
      circuit_transition?: IntelligenceProviderCircuitTransition;
    };

export interface IntelligenceProviderLeaseRenewal {
  lease_id: string;
  profile_id: string;
  expires_at: string;
}

export interface IntelligenceProviderGovernanceStoreOptions {
  now?: () => Date;
  leaseRetentionMs?: number;
}

interface RuntimeRow extends IntelligenceProviderRuntimeSnapshot {
  minute_window_started_at: string | null;
  day_window_started_at: string | null;
  requests_per_minute: number;
  requests_per_day: number;
  max_concurrency: number;
  failure_threshold: number;
  open_cooldown_ms: number;
}

interface LeaseRow {
  id: string;
  tenant_id: string;
  capability: IntelligenceProviderCapability;
  profile_id: string;
  status: 'active' | 'succeeded' | 'failed' | 'expired';
  route_attempt: number;
  reserved_at: string;
  expires_at: string;
  completed_at: string | null;
  outcome_class: string;
  error_code: string;
  updated_at: string;
}

interface MemoryGovernanceState {
  runtimes: Map<string, RuntimeRow>;
  leases: Map<string, LeaseRow>;
}

const memoryStates = new WeakMap<MemoryPg, MemoryGovernanceState>();

export class IntelligenceProviderGovernanceStore {
  private readonly now: () => Date;
  private readonly leaseRetentionMs: number;

  constructor(
    private readonly pg: PgQueryable,
    options: IntelligenceProviderGovernanceStoreOptions = {}
  ) {
    this.now = options.now || (() => new Date());
    this.leaseRetentionMs = boundedInteger(
      options.leaseRetentionMs ?? 7 * 24 * 60 * 60 * 1_000,
      60_000,
      365 * 24 * 60 * 60 * 1_000,
      'leaseRetentionMs'
    );
  }

  async reserve(input: {
    tenant_id: string;
    capability: IntelligenceProviderCapability;
    profile: IntelligenceProviderProfile;
    route_attempt: number;
  }): Promise<IntelligenceProviderReservation> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    if (input.profile.capability !== input.capability) {
      throw governanceError('provider capability does not match reservation capability', 400);
    }
    const routeAttempt = boundedInteger(input.route_attempt, 1, 10, 'route_attempt');
    if (this.pg instanceof MemoryPg) {
      const now = this.now();
      this.pruneMemoryLeaseHistory(tenantId, now, 100);
      return this.reserveMemory(tenantId, input.capability, input.profile, routeAttempt, now);
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const now = await databaseNow(pg);
      const nowIso = now.toISOString();
      await pruneLeaseHistoryPg(
        pg,
        tenantId,
        new Date(now.getTime() - this.leaseRetentionMs).toISOString(),
        100
      );
      await pg.query(
        `UPDATE collaboration_intelligence_provider_leases
         SET status = 'expired', completed_at = $4, outcome_class = 'expired',
             error_code = 'reservation_expired', updated_at = $4
         WHERE tenant_id = $1 AND capability = $2 AND profile_id = $3
           AND status = 'active' AND expires_at <= $4`,
        [tenantId, input.capability, input.profile.id, nowIso]
      );
      await pg.query(
        `INSERT INTO collaboration_intelligence_provider_runtime
          (tenant_id, capability, profile_id, requests_per_minute, requests_per_day,
           max_concurrency, failure_threshold, open_cooldown_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, capability, profile_id) DO NOTHING`,
        [
          tenantId, input.capability, input.profile.id,
          input.profile.requests_per_minute, input.profile.requests_per_day,
          input.profile.max_concurrency, input.profile.failure_threshold,
          input.profile.open_cooldown_ms
        ]
      );
      const locked = await pg.query(
        `SELECT * FROM collaboration_intelligence_provider_runtime
         WHERE tenant_id = $1 AND capability = $2 AND profile_id = $3
         FOR UPDATE`,
        [tenantId, input.capability, input.profile.id]
      );
      if (!locked.rows[0]) throw governanceError('provider runtime state is unavailable', 503);
      const runtime = normalizeRuntime(locked.rows[0], tenantId, input.capability, input.profile, nowIso);
      const active = await pg.query<{ active_count: string | number; next_expiry: string | null }>(
        `SELECT COUNT(*) AS active_count, MIN(expires_at) AS next_expiry
         FROM collaboration_intelligence_provider_leases
         WHERE tenant_id = $1 AND capability = $2 AND profile_id = $3
           AND status = 'active' AND expires_at > $4`,
        [tenantId, input.capability, input.profile.id, nowIso]
      );
      const activeCount = Number(active.rows[0]?.active_count || 0);
      const previousState = runtime.circuit_state;
      const decision = reservationDecision(
        runtime,
        input.profile,
        activeCount,
        now,
        nullableText(active.rows[0]?.next_expiry)
      );
      const circuitTransition = stateTransition(previousState, runtime.circuit_state);
      if (!decision.granted) {
        await persistRuntime(pg, runtime);
        return withTransition(decision, circuitTransition);
      }

      const leaseId = pgId('cipl');
      const expiresAt = new Date(now.getTime() + input.profile.reservation_ttl_ms).toISOString();
      runtime.minute_request_count += 1;
      runtime.day_request_count += 1;
      runtime.updated_at = nowIso;
      applyBudget(runtime, input.profile);
      await persistRuntime(pg, runtime);
      await pg.query(
        `INSERT INTO collaboration_intelligence_provider_leases
          (id, tenant_id, capability, profile_id, status, route_attempt,
           reserved_at, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $6, $6)`,
        [leaseId, tenantId, input.capability, input.profile.id, routeAttempt, nowIso, expiresAt]
      );
      return {
        granted: true,
        lease_id: leaseId,
        profile_id: input.profile.id,
        expires_at: expiresAt,
        circuit_state: runtime.circuit_state,
        ...(circuitTransition ? { circuit_transition: circuitTransition } : {})
      };
    });
  }

  async complete(input: {
    tenant_id: string;
    lease_id: string;
    outcome: IntelligenceProviderOutcome;
    error_code?: string;
  }): Promise<IntelligenceProviderRuntimeSnapshot> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const leaseId = requiredText(input.lease_id, 'lease_id');
    const outcome = outcomeValue(input.outcome);
    const errorCode = safeCode(input.error_code);
    if (this.pg instanceof MemoryPg) {
      const now = this.now();
      return this.completeMemory(tenantId, leaseId, outcome, errorCode, now);
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const now = await databaseNow(pg);
      const leaseResult = await pg.query(
        `SELECT * FROM collaboration_intelligence_provider_leases
         WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [leaseId, tenantId]
      );
      if (!leaseResult.rows[0]) throw governanceError('provider reservation not found', 404);
      const lease = decodeLease(leaseResult.rows[0]);
      const runtimeResult = await pg.query(
        `SELECT * FROM collaboration_intelligence_provider_runtime
         WHERE tenant_id = $1 AND capability = $2 AND profile_id = $3 FOR UPDATE`,
        [tenantId, lease.capability, lease.profile_id]
      );
      if (!runtimeResult.rows[0]) throw governanceError('provider runtime state is unavailable', 503);
      const runtime = decodeRuntime(runtimeResult.rows[0]);
      if (lease.status !== 'active') return publicRuntime(runtime);

      const nowIso = now.toISOString();
      const previousState = runtime.circuit_state;
      applyOutcome(runtime, outcome, errorCode, now);
      const circuitTransition = stateTransition(previousState, runtime.circuit_state);
      await pg.query(
        `UPDATE collaboration_intelligence_provider_leases
         SET status = $3, completed_at = $4, outcome_class = $5,
             error_code = $6, updated_at = $4
         WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
        [leaseId, tenantId, outcome === 'success' ? 'succeeded' : 'failed', nowIso, outcome, errorCode]
      );
      await persistRuntime(pg, runtime);
      return publicRuntime(runtime, circuitTransition);
    });
  }

  async renew(input: {
    tenant_id: string;
    lease_id: string;
    profile: IntelligenceProviderProfile;
  }): Promise<IntelligenceProviderLeaseRenewal> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const leaseId = requiredText(input.lease_id, 'lease_id');
    if (this.pg instanceof MemoryPg) {
      const state = memoryState(this.pg);
      const lease = state.leases.get(leaseId);
      const now = this.now();
      assertRenewableLease(lease, tenantId, input.profile, now);
      const expiresAt = new Date(now.getTime() + input.profile.reservation_ttl_ms).toISOString();
      lease!.expires_at = expiresAt;
      lease!.updated_at = now.toISOString();
      return { lease_id: leaseId, profile_id: input.profile.id, expires_at: expiresAt };
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const now = await databaseNow(pg);
      const result = await pg.query(
        `SELECT * FROM collaboration_intelligence_provider_leases
         WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [leaseId, tenantId]
      );
      const lease = result.rows[0] ? decodeLease(result.rows[0]) : undefined;
      try {
        assertRenewableLease(lease, tenantId, input.profile, now);
      } catch (error) {
        if (lease?.status === 'active' && lease.expires_at <= now.toISOString()) {
          await pg.query(
            `UPDATE collaboration_intelligence_provider_leases
             SET status = 'expired', completed_at = $3, outcome_class = 'expired',
                 error_code = 'reservation_expired', updated_at = $3
             WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
            [leaseId, tenantId, now.toISOString()]
          );
        }
        throw error;
      }
      const expiresAt = new Date(now.getTime() + input.profile.reservation_ttl_ms).toISOString();
      await pg.query(
        `UPDATE collaboration_intelligence_provider_leases
         SET expires_at = $3, updated_at = $4
         WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
        [leaseId, tenantId, expiresAt, now.toISOString()]
      );
      return { lease_id: leaseId, profile_id: input.profile.id, expires_at: expiresAt };
    });
  }

  async pruneLeaseHistory(input: { tenant_id: string; limit?: number }): Promise<number> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const limit = boundedInteger(input.limit ?? 1_000, 1, 10_000, 'limit');
    if (this.pg instanceof MemoryPg) {
      return this.pruneMemoryLeaseHistory(tenantId, this.now(), limit);
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const now = await databaseNow(pg);
      const cutoff = new Date(now.getTime() - this.leaseRetentionMs).toISOString();
      return pruneLeaseHistoryPg(pg, tenantId, cutoff, limit);
    });
  }

  async listRuntime(tenantIdInput: string): Promise<IntelligenceProviderRuntimeSnapshot[]> {
    const tenantId = requiredText(tenantIdInput, 'tenant_id');
    if (this.pg instanceof MemoryPg) {
      return [...memoryState(this.pg).runtimes.values()]
        .filter((runtime) => runtime.tenant_id === tenantId)
        .sort((left, right) =>
          left.capability.localeCompare(right.capability) || left.profile_id.localeCompare(right.profile_id)
        )
        .map((runtime) => publicRuntime(runtime));
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM collaboration_intelligence_provider_runtime
         WHERE tenant_id = $1 ORDER BY capability, profile_id`,
        [tenantId]
      );
      return result.rows.map((row) => publicRuntime(decodeRuntime(row)));
    });
  }

  private reserveMemory(
    tenantId: string,
    capability: IntelligenceProviderCapability,
    profile: IntelligenceProviderProfile,
    routeAttempt: number,
    now: Date
  ): IntelligenceProviderReservation {
    const state = memoryState(this.pg as MemoryPg);
    const key = runtimeKey(tenantId, capability, profile.id);
    const nowIso = now.toISOString();
    for (const lease of state.leases.values()) {
      if (runtimeKey(lease.tenant_id, lease.capability, lease.profile_id) !== key) continue;
      if (lease.status === 'active' && lease.expires_at <= nowIso) {
        lease.status = 'expired';
        lease.completed_at = nowIso;
        lease.outcome_class = 'expired';
        lease.error_code = 'reservation_expired';
        lease.updated_at = nowIso;
      }
    }
    const runtime = state.runtimes.get(key) || initialRuntime(tenantId, capability, profile, nowIso);
    applyBudget(runtime, profile);
    normalizeWindows(runtime, now);
    state.runtimes.set(key, runtime);
    const activeCount = [...state.leases.values()].filter((lease) =>
      runtimeKey(lease.tenant_id, lease.capability, lease.profile_id) === key &&
      lease.status === 'active' && lease.expires_at > nowIso
    ).length;
    const previousState = runtime.circuit_state;
    const nextExpiry = [...state.leases.values()]
      .filter((lease) => (
        runtimeKey(lease.tenant_id, lease.capability, lease.profile_id) === key &&
        lease.status === 'active' && lease.expires_at > nowIso
      ))
      .map((lease) => lease.expires_at)
      .sort()[0] || null;
    const decision = reservationDecision(runtime, profile, activeCount, now, nextExpiry);
    const circuitTransition = stateTransition(previousState, runtime.circuit_state);
    if (!decision.granted) return withTransition(decision, circuitTransition);
    const leaseId = pgId('cipl');
    const expiresAt = new Date(now.getTime() + profile.reservation_ttl_ms).toISOString();
    runtime.minute_request_count += 1;
    runtime.day_request_count += 1;
    runtime.updated_at = nowIso;
    state.leases.set(leaseId, {
      id: leaseId, tenant_id: tenantId, capability, profile_id: profile.id,
      status: 'active', route_attempt: routeAttempt, reserved_at: nowIso, expires_at: expiresAt,
      completed_at: null, outcome_class: '', error_code: '', updated_at: nowIso
    });
    return {
      granted: true,
      lease_id: leaseId,
      profile_id: profile.id,
      expires_at: expiresAt,
      circuit_state: runtime.circuit_state,
      ...(circuitTransition ? { circuit_transition: circuitTransition } : {})
    };
  }

  private pruneMemoryLeaseHistory(tenantId: string, now: Date, limit: number): number {
    const state = memoryState(this.pg as MemoryPg);
    const cutoff = new Date(now.getTime() - this.leaseRetentionMs).toISOString();
    const expired = [...state.leases.values()]
      .filter((lease) => (
        lease.tenant_id === tenantId && lease.status !== 'active' && lease.updated_at <= cutoff
      ))
      .sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id))
      .slice(0, limit);
    for (const lease of expired) state.leases.delete(lease.id);
    return expired.length;
  }

  private completeMemory(
    tenantId: string,
    leaseId: string,
    outcome: IntelligenceProviderOutcome,
    errorCode: string,
    now: Date
  ): IntelligenceProviderRuntimeSnapshot {
    const state = memoryState(this.pg as MemoryPg);
    const lease = state.leases.get(leaseId);
    if (!lease || lease.tenant_id !== tenantId) throw governanceError('provider reservation not found', 404);
    const runtime = state.runtimes.get(runtimeKey(tenantId, lease.capability, lease.profile_id));
    if (!runtime) throw governanceError('provider runtime state is unavailable', 503);
    if (lease.status !== 'active') return publicRuntime(runtime);
    const nowIso = now.toISOString();
    lease.status = outcome === 'success' ? 'succeeded' : 'failed';
    lease.completed_at = nowIso;
    lease.outcome_class = outcome;
    lease.error_code = errorCode;
    lease.updated_at = nowIso;
    const previousState = runtime.circuit_state;
    applyOutcome(runtime, outcome, errorCode, now);
    return publicRuntime(runtime, stateTransition(previousState, runtime.circuit_state));
  }
}

async function pruneLeaseHistoryPg(
  pg: PgQueryable,
  tenantId: string,
  cutoff: string,
  limit: number
): Promise<number> {
  const result = await pg.query(
    `WITH doomed AS (
       SELECT id FROM collaboration_intelligence_provider_leases
       WHERE tenant_id = $1 AND status != 'active' AND updated_at <= $2
       ORDER BY updated_at, id LIMIT $3
     )
     DELETE FROM collaboration_intelligence_provider_leases lease
     USING doomed
     WHERE lease.id = doomed.id
     RETURNING lease.id`,
    [tenantId, cutoff, limit]
  );
  return result.rowCount ?? result.rows.length;
}

function reservationDecision(
  runtime: RuntimeRow,
  profile: IntelligenceProviderProfile,
  activeCount: number,
  now: Date,
  nextExpiry: string | null
): IntelligenceProviderReservation {
  normalizeWindows(runtime, now);
  const nowMs = now.getTime();
  if (runtime.circuit_state === 'open') {
    const openedUntilMs = runtime.opened_until ? Date.parse(runtime.opened_until) : Number.POSITIVE_INFINITY;
    if (openedUntilMs > nowMs) {
      return denied(profile.id, 'circuit_open', runtime.opened_until || now.toISOString());
    }
    runtime.circuit_state = 'half_open';
    runtime.opened_until = null;
  }
  if (runtime.circuit_state === 'half_open' && activeCount > 0) {
    return denied(profile.id, 'circuit_half_open_busy', nextExpiry || earliestRetry(now, profile.reservation_ttl_ms));
  }
  if (profile.requests_per_minute > 0 && runtime.minute_request_count >= profile.requests_per_minute) {
    return denied(
      profile.id,
      'minute_quota_exhausted',
      addMs(runtime.minute_window_started_at || now.toISOString(), 60_000)
    );
  }
  if (profile.requests_per_day > 0 && runtime.day_request_count >= profile.requests_per_day) {
    return denied(
      profile.id,
      'day_quota_exhausted',
      addMs(runtime.day_window_started_at || now.toISOString(), 86_400_000)
    );
  }
  if (activeCount >= profile.max_concurrency) {
    return denied(profile.id, 'concurrency_exhausted', nextExpiry || earliestRetry(now, profile.reservation_ttl_ms));
  }
  return {
    granted: true,
    lease_id: '',
    profile_id: profile.id,
    expires_at: '',
    circuit_state: runtime.circuit_state
  };
}

function applyOutcome(
  runtime: RuntimeRow,
  outcome: IntelligenceProviderOutcome,
  errorCode: string,
  now: Date
): void {
  const nowIso = now.toISOString();
  if (outcome === 'success') {
    runtime.circuit_state = 'closed';
    runtime.consecutive_retryable_failures = 0;
    runtime.opened_until = null;
    runtime.last_success_at = nowIso;
    runtime.last_error_code = '';
  } else if (outcome === 'retryable_failure') {
    runtime.last_failure_at = nowIso;
    runtime.last_error_code = errorCode || 'provider_error';
    runtime.consecutive_retryable_failures += 1;
    if (
      runtime.circuit_state === 'half_open' ||
      runtime.consecutive_retryable_failures >= runtime.failure_threshold
    ) {
      runtime.circuit_state = 'open';
      runtime.opened_until = new Date(now.getTime() + runtime.open_cooldown_ms).toISOString();
    }
  }
  runtime.updated_at = nowIso;
}

function normalizeRuntime(
  row: Record<string, unknown>,
  tenantId: string,
  capability: IntelligenceProviderCapability,
  profile: IntelligenceProviderProfile,
  nowIso: string
): RuntimeRow {
  const runtime = decodeRuntime({ ...row, tenant_id: tenantId, capability, profile_id: profile.id });
  if (!runtime.minute_window_started_at) runtime.minute_window_started_at = nowIso;
  if (!runtime.day_window_started_at) runtime.day_window_started_at = nowIso;
  applyBudget(runtime, profile);
  normalizeWindows(runtime, new Date(nowIso));
  return runtime;
}

function initialRuntime(
  tenantId: string,
  capability: IntelligenceProviderCapability,
  profile: IntelligenceProviderProfile,
  nowIso: string
): RuntimeRow {
  return {
    tenant_id: tenantId, capability, profile_id: profile.id,
    minute_window_started_at: nowIso, minute_request_count: 0,
    day_window_started_at: nowIso, day_request_count: 0,
    requests_per_minute: profile.requests_per_minute,
    requests_per_day: profile.requests_per_day,
    max_concurrency: profile.max_concurrency,
    failure_threshold: profile.failure_threshold,
    open_cooldown_ms: profile.open_cooldown_ms,
    circuit_state: 'closed', consecutive_retryable_failures: 0, opened_until: null,
    last_success_at: null, last_failure_at: null, last_error_code: '', updated_at: nowIso
  };
}

function applyBudget(runtime: RuntimeRow, profile: IntelligenceProviderProfile): void {
  runtime.requests_per_minute = profile.requests_per_minute;
  runtime.requests_per_day = profile.requests_per_day;
  runtime.max_concurrency = profile.max_concurrency;
  runtime.failure_threshold = profile.failure_threshold;
  runtime.open_cooldown_ms = profile.open_cooldown_ms;
}

function normalizeWindows(runtime: RuntimeRow, now: Date): void {
  if (!runtime.minute_window_started_at || Date.parse(runtime.minute_window_started_at) + 60_000 <= now.getTime()) {
    runtime.minute_window_started_at = now.toISOString();
    runtime.minute_request_count = 0;
  }
  if (!runtime.day_window_started_at || Date.parse(runtime.day_window_started_at) + 86_400_000 <= now.getTime()) {
    runtime.day_window_started_at = now.toISOString();
    runtime.day_request_count = 0;
  }
}

async function persistRuntime(pg: PgQueryable, runtime: RuntimeRow): Promise<void> {
  await pg.query(
    `UPDATE collaboration_intelligence_provider_runtime
     SET minute_window_started_at = $4, minute_request_count = $5,
         day_window_started_at = $6, day_request_count = $7,
         requests_per_minute = $8, requests_per_day = $9, max_concurrency = $10,
         failure_threshold = $11, open_cooldown_ms = $12,
         circuit_state = $13, consecutive_retryable_failures = $14,
         opened_until = $15, last_success_at = $16, last_failure_at = $17,
         last_error_code = $18, updated_at = $19
     WHERE tenant_id = $1 AND capability = $2 AND profile_id = $3`,
    [
      runtime.tenant_id, runtime.capability, runtime.profile_id,
      runtime.minute_window_started_at, runtime.minute_request_count,
      runtime.day_window_started_at, runtime.day_request_count,
      runtime.requests_per_minute, runtime.requests_per_day, runtime.max_concurrency,
      runtime.failure_threshold, runtime.open_cooldown_ms,
      runtime.circuit_state, runtime.consecutive_retryable_failures,
      runtime.opened_until, runtime.last_success_at, runtime.last_failure_at,
      runtime.last_error_code, runtime.updated_at
    ]
  );
}

function decodeRuntime(row: Record<string, unknown>): RuntimeRow {
  return {
    tenant_id: String(row.tenant_id),
    capability: String(row.capability) as IntelligenceProviderCapability,
    profile_id: String(row.profile_id),
    minute_window_started_at: nullableText(row.minute_window_started_at),
    minute_request_count: Number(row.minute_request_count || 0),
    day_window_started_at: nullableText(row.day_window_started_at),
    day_request_count: Number(row.day_request_count || 0),
    requests_per_minute: Number(row.requests_per_minute || 0),
    requests_per_day: Number(row.requests_per_day || 0),
    max_concurrency: Number(row.max_concurrency || 10),
    failure_threshold: Number(row.failure_threshold || 3),
    open_cooldown_ms: Number(row.open_cooldown_ms || 30_000),
    circuit_state: String(row.circuit_state || 'closed') as IntelligenceProviderCircuitState,
    consecutive_retryable_failures: Number(row.consecutive_retryable_failures || 0),
    opened_until: nullableText(row.opened_until),
    last_success_at: nullableText(row.last_success_at),
    last_failure_at: nullableText(row.last_failure_at),
    last_error_code: String(row.last_error_code || ''),
    updated_at: timestampText(row.updated_at)
  };
}

function decodeLease(row: Record<string, unknown>): LeaseRow {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id),
    capability: String(row.capability) as IntelligenceProviderCapability,
    profile_id: String(row.profile_id), status: String(row.status) as LeaseRow['status'],
    route_attempt: Number(row.route_attempt || 1), reserved_at: timestampText(row.reserved_at),
    expires_at: timestampText(row.expires_at), completed_at: nullableText(row.completed_at),
    outcome_class: String(row.outcome_class || ''), error_code: String(row.error_code || ''),
    updated_at: timestampText(row.updated_at)
  };
}

function assertRenewableLease(
  lease: LeaseRow | undefined,
  tenantId: string,
  profile: IntelligenceProviderProfile,
  now: Date
): asserts lease is LeaseRow {
  if (!lease || lease.tenant_id !== tenantId) {
    throw governanceError('provider reservation not found', 404);
  }
  if (lease.profile_id !== profile.id || lease.capability !== profile.capability) {
    throw governanceError('provider reservation profile mismatch', 409);
  }
  if (lease.status !== 'active' || lease.expires_at <= now.toISOString()) {
    if (lease.status === 'active') {
      lease.status = 'expired';
      lease.completed_at = now.toISOString();
      lease.outcome_class = 'expired';
      lease.error_code = 'reservation_expired';
      lease.updated_at = now.toISOString();
    }
    throw governanceError('provider reservation expired', 409);
  }
}

function publicRuntime(
  runtime: RuntimeRow,
  circuitTransition?: IntelligenceProviderCircuitTransition | null
): IntelligenceProviderRuntimeSnapshot {
  return {
    tenant_id: runtime.tenant_id, capability: runtime.capability, profile_id: runtime.profile_id,
    minute_request_count: runtime.minute_request_count, day_request_count: runtime.day_request_count,
    circuit_state: runtime.circuit_state,
    consecutive_retryable_failures: runtime.consecutive_retryable_failures,
    opened_until: runtime.opened_until, last_success_at: runtime.last_success_at,
    last_failure_at: runtime.last_failure_at, last_error_code: runtime.last_error_code,
    updated_at: runtime.updated_at,
    ...(circuitTransition ? { circuit_transition: circuitTransition } : {})
  };
}

function stateTransition(
  fromState: IntelligenceProviderCircuitState,
  toState: IntelligenceProviderCircuitState
): IntelligenceProviderCircuitTransition | null {
  return fromState === toState ? null : { from_state: fromState, to_state: toState };
}

function withTransition<T extends IntelligenceProviderReservation>(
  reservation: T,
  transition: IntelligenceProviderCircuitTransition | null
): T {
  return transition ? { ...reservation, circuit_transition: transition } : reservation;
}

async function databaseNow(pg: PgQueryable): Promise<Date> {
  const result = await pg.query<{ now: string | Date }>('SELECT clock_timestamp() AS now');
  const value = result.rows[0]?.now;
  const parsed = value instanceof Date ? value : new Date(String(value || ''));
  if (Number.isNaN(parsed.getTime())) throw governanceError('database clock is unavailable', 503);
  return parsed;
}

function memoryState(pg: MemoryPg): MemoryGovernanceState {
  let state = memoryStates.get(pg);
  if (!state) {
    state = { runtimes: new Map(), leases: new Map() };
    memoryStates.set(pg, state);
  }
  return state;
}

function runtimeKey(tenantId: string, capability: string, profileId: string): string {
  return `${tenantId}\u0000${capability}\u0000${profileId}`;
}

function denied(
  profileId: string,
  reason: IntelligenceProviderReservationReason,
  retryAt: string
): IntelligenceProviderReservation {
  return { granted: false, profile_id: profileId, reason, retry_at: retryAt };
}

function earliestRetry(now: Date, ttlMs: number): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

function addMs(value: string, duration: number): string {
  return new Date(Date.parse(value) + duration).toISOString();
}

function outcomeValue(value: unknown): IntelligenceProviderOutcome {
  if (value === 'success' || value === 'retryable_failure' || value === 'terminal_failure') return value;
  throw governanceError('provider outcome is invalid', 400);
}

function safeCode(value: unknown): string {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 100);
}

function nullableText(value: unknown): string | null {
  if (value == null || value === '') return null;
  return timestampText(value);
}

function timestampText(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value || '');
}

function requiredText(value: unknown, field: string): string {
  const text = String(value || '').trim();
  if (!text) throw governanceError(`${field} is required`, 400);
  return text;
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw governanceError(`${field} must be an integer between ${min} and ${max}`, 400);
  }
  return parsed;
}

function governanceError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}
