import { resolveConveractEnv, resolveFabricEnv } from '../../../config/converact-env.js';
import type { PgQueryable } from '../../../db-pg.js';
import { converactFabricRuntimeHeartbeatConfig } from './runtime-heartbeat.js';

export interface ConveractFabricPlacementReadinessProbe {
  probe(): Promise<{
    snapshot_version: number;
    generated_at: string;
    expires_at: string;
  }>;
}

export interface ConveractFabricReadinessResult {
  status: 'ready' | 'not_ready';
  checks: {
    database: { status: 'ok' | 'failed' };
    migrations: { status: 'ok' | 'failed'; missing: string[] };
    configuration: { status: 'ok' | 'failed'; missing_or_invalid: string[] };
    notification_providers: {
      status: 'ok' | 'degraded' | 'not_configured' | 'unknown';
      active: number;
      unhealthy: number;
      blocking: boolean;
    };
    runtime_heartbeat: {
      status: 'ok' | 'disabled' | 'missing' | 'stale' | 'draining' | 'unknown';
      instance_id: string;
    };
    placement_snapshot: {
      status: 'ok' | 'disabled' | 'missing' | 'failed';
      snapshot_version: number;
      error_code: string;
    };
  };
}

export interface ConveractFabricReadinessProbe {
  probe(): Promise<ConveractFabricReadinessResult>;
}

export interface ConveractFabricReadinessScheduler {
  now(): number;
  setTimeout(callback: () => void, delay_ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function createConveractFabricReadinessProbe(input: {
  pg: PgQueryable | null;
  env?: NodeJS.ProcessEnv;
  requiredMigrations?: readonly string[];
  instanceId?: string;
  placementProbe?: ConveractFabricPlacementReadinessProbe;
  probeTimeoutMs?: number;
  scheduler?: ConveractFabricReadinessScheduler;
}): ConveractFabricReadinessProbe {
  const env = input.env || process.env;
  const requiredMigrations = [...(input.requiredMigrations || REQUIRED_MIGRATIONS)];
  const heartbeatConfig = converactFabricRuntimeHeartbeatConfig(env);
  const placementEnabled = booleanEnv(resolveFabricEnv(env, 'PLACEMENT_ENABLED'), false);
  const instanceId = String(input.instanceId || resolveFabricEnv(env, 'INSTANCE_ID') || env.HOSTNAME || '');
  const probeTimeoutMs = boundedProbeTimeout(input.probeTimeoutMs ?? 2_000);
  const scheduler = input.scheduler || defaultReadinessScheduler();
  assertReadinessScheduler(scheduler);
  type ProbeWave = {
    promise: Promise<ConveractFabricReadinessResult>;
    timedOut: boolean;
  };
  let activeWave: ProbeWave | null = null;
  const abandonedWaves = new Set<Promise<ConveractFabricReadinessResult>>();
  const maxAbandonedWaves = 1;
  const createResult = (): ConveractFabricReadinessResult => ({
        status: 'not_ready',
        checks: {
          database: { status: 'failed' },
          migrations: { status: 'failed', missing: requiredMigrations },
          configuration: configurationCheck(env),
          notification_providers: {
            status: 'unknown', active: 0, unhealthy: 0,
            blocking: booleanEnv(resolveFabricEnv(env, 'READINESS_REQUIRE_HEALTHY_NOTIFICATION_PROVIDER'), false)
          },
          runtime_heartbeat: {
            status: heartbeatConfig.enabled ? 'unknown' : 'disabled',
            instance_id: heartbeatConfig.enabled ? instanceId : ''
          },
          placement_snapshot: {
            status: placementEnabled ? 'missing' : 'disabled',
            snapshot_version: 0,
            error_code: placementEnabled ? 'placement_probe_missing' : ''
          }
        }
      });
  const runProbeWave = async (): Promise<ConveractFabricReadinessResult> => {
      const result = createResult();
      if (!input.pg) return result;
      const query = <R>(text: string, params?: unknown[]) => input.pg!.query<R>(text, params);
      try {
        await query('SELECT 1 AS ready');
        result.checks.database.status = 'ok';
      } catch {
        return result;
      }
      const independentProbes: Array<Promise<void>> = [
        (async () => {
          try {
            const migrations = await query<{ version: string }>(
              'SELECT version FROM public.opc_ivekit_applied_migration_versions($1::text[])',
              [requiredMigrations]
            );
            const present = new Set(migrations.rows.map((row) => String(row.version)));
            result.checks.migrations.missing = requiredMigrations.filter((version) => !present.has(version));
            result.checks.migrations.status = result.checks.migrations.missing.length ? 'failed' : 'ok';
          } catch {
            result.checks.migrations.status = 'failed';
          }
        })(),
        (async () => {
          try {
            const providers = await query<{ active: unknown; unhealthy: unknown }>(
              `SELECT COUNT(*) FILTER (WHERE status = 'active') AS active,
                 COUNT(*) FILTER (WHERE status = 'active' AND health_status = 'unhealthy') AS unhealthy
               FROM ivekit_notification_endpoints`
            );
            const active = nonNegativeInteger(providers.rows[0]?.active);
            const unhealthy = nonNegativeInteger(providers.rows[0]?.unhealthy);
            result.checks.notification_providers.active = active;
            result.checks.notification_providers.unhealthy = unhealthy;
            result.checks.notification_providers.status = active === 0
              ? 'not_configured'
              : unhealthy > 0 ? 'degraded' : 'ok';
          } catch {
            result.checks.notification_providers.status = 'unknown';
          }
        })()
      ];
      if (heartbeatConfig.enabled) {
        independentProbes.push((async () => {
          if (!instanceId) {
            result.checks.runtime_heartbeat.status = 'missing';
            return;
          }
          try {
            const heartbeat = await query<{ state: string; heartbeat_at: unknown }>(
              `SELECT state, heartbeat_at FROM ivekit_runtime_heartbeats
               WHERE instance_id = $1`,
              [instanceId]
            );
            const row = heartbeat.rows[0];
            if (!row) {
              result.checks.runtime_heartbeat.status = 'missing';
            } else if (row.state !== 'running') {
              result.checks.runtime_heartbeat.status = row.state === 'draining' || row.state === 'stopped'
                ? 'draining' : 'missing';
            } else {
              const age = Date.now() - new Date(String(row.heartbeat_at)).getTime();
              result.checks.runtime_heartbeat.status = Number.isFinite(age)
                && age <= heartbeatConfig.stale_after_ms ? 'ok' : 'stale';
            }
          } catch {
            result.checks.runtime_heartbeat.status = 'unknown';
          }
        })());
      }
      if (placementEnabled && input.placementProbe) {
        independentProbes.push((async () => {
          try {
            const snapshot = await input.placementProbe!.probe();
            result.checks.placement_snapshot = {
              status: 'ok',
              snapshot_version: positiveSafeInteger(snapshot.snapshot_version),
              error_code: ''
            };
          } catch (error) {
            result.checks.placement_snapshot = {
              status: 'failed',
              snapshot_version: 0,
              error_code: placementProbeErrorCode(error)
            };
          }
        })());
      }
      await Promise.all(independentProbes);
      const providerBlockingFailure = result.checks.notification_providers.blocking
        && result.checks.notification_providers.status !== 'ok';
      result.status = result.checks.database.status === 'ok'
        && result.checks.migrations.status === 'ok'
        && result.checks.configuration.status === 'ok'
        && !providerBlockingFailure
        && ['ok', 'disabled'].includes(result.checks.runtime_heartbeat.status)
        && ['ok', 'disabled'].includes(result.checks.placement_snapshot.status)
        ? 'ready'
        : 'not_ready';
      return result;
  };
  return {
    async probe() {
      const deadline = scheduler.now() + probeTimeoutMs;
      if (activeWave?.timedOut && abandonedWaves.size < maxAbandonedWaves) {
        abandonedWaves.add(activeWave.promise);
        activeWave = null;
      }
      if (!activeWave) {
        const wave: ProbeWave = { promise: runProbeWave(), timedOut: false };
        activeWave = wave;
        void wave.promise.finally(() => {
          abandonedWaves.delete(wave.promise);
          if (activeWave === wave) activeWave = null;
        }).catch(() => undefined);
      }
      const selected = activeWave;
      try {
        return await withReadinessDeadline(scheduler, deadline, () => selected.promise);
      } catch {
        if (activeWave === selected) selected.timedOut = true;
        return createResult();
      }
    }
  };
}

function withReadinessDeadline<T>(
  scheduler: ConveractFabricReadinessScheduler,
  deadline: number,
  operation: () => Promise<T>
): Promise<T> {
  const remaining = Math.ceil(deadline - scheduler.now());
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return Promise.reject(readinessTimeout());
  }
  let operationPromise: Promise<T>;
  try {
    operationPromise = Promise.resolve(operation());
  } catch (error) {
    operationPromise = Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const handle = scheduler.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(readinessTimeout());
    }, remaining);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      scheduler.clearTimeout(handle);
      callback();
    };
    operationPromise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

function defaultReadinessScheduler(): ConveractFabricReadinessScheduler {
  return {
    now: () => performance.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
  };
}

function assertReadinessScheduler(value: ConveractFabricReadinessScheduler): void {
  if (!value || typeof value.now !== 'function' || typeof value.setTimeout !== 'function'
    || typeof value.clearTimeout !== 'function' || !Number.isFinite(value.now())) {
    throw new Error('readiness_scheduler_invalid');
  }
}

function boundedProbeTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 30_000) {
    throw new Error('readiness_probe_timeout_invalid');
  }
  return value;
}

function readinessTimeout(): Error & { code: string } {
  return Object.assign(new Error('readiness probe deadline exceeded'), {
    code: 'readiness_probe_timeout'
  });
}

export const REQUIRED_MIGRATIONS = [
  '065_ivekit_notifications',
  '066_ivekit_audit',
  '067_ivekit_rate_limits',
  '068_ivekit_retention',
  '069_ivekit_runtime_heartbeats',
  '070_ivekit_notification_operations',
  '071_ivekit_notification_health',
  '072_ivekit_notification_events',
  '073_ivekit_integration_webhooks',
  '074_tinode_message_mutation_outbox',
  '075_rustdesk_emergency_fallback',
  '076_rustdesk_evidence_intelligence_reconciliation',
  '077_ivekit_capacity_orchestrator',
  '078_ivekit_cell_leases',
  '079_ivekit_voice_route_snapshot_revision',
  '080_ivekit_interaction_placements',
  '081_ivekit_notification_worker_partition',
  '082_ivekit_capacity_worker_checkpoints',
  '083_ivekit_cell_admission_reservations',
  '084_ivekit_cell_lease_topology',
  '085_ivekit_interaction_placement_handoffs',
  '090_ivekit_runtime_security',
  '093_ivekit_cell_admission_rls',
  '094_ivekit_voice_extension_sessions',
  '095_rustdesk_authorization_claims',
  '101_ivekit_migration_readiness',
  '102_ivekit_voice_dialog_takeovers',
  '103_ivekit_voice_cdr_convergence',
  '104_ivekit_cell_admission_ledger_runtime',
  '105_tinode_closed_session_inbound',
  '106_tinode_open_session_mutation_queue',
  '107_ivekit_sip_effect_oracle',
  '108_converact_platform_identity_consent',
  '109_converact_platform_event_receipts',
  '110_converact_platform_usage_ledger',
  '111_converact_platform_key_lifecycle',
  '112_converact_platform_history_receipt_integrity',
  '113_converact_sip_effect_transport_completed',
  '114_converact_sip_effect_transport_completed_validate',
  '115_converact_sip_effect_stale_nonterminal_recovery'
] as const;

function configurationCheck(env: NodeJS.ProcessEnv): ConveractFabricReadinessResult['checks']['configuration'] {
  const invalid: string[] = [];
  for (const key of [
    'CONVERACT_FABRIC_AUDIT_IP_HMAC_KEY',
    'CONVERACT_FABRIC_RATE_LIMIT_HMAC_KEY'
  ]) {
    if (!validBase64Key(resolveConveractEnv(env, key))) invalid.push(key);
  }
  return { status: invalid.length ? 'failed' : 'ok', missing_or_invalid: invalid };
}

function validBase64Key(value: string | undefined): boolean {
  const text = String(value || '');
  const key = Buffer.from(text, 'base64');
  return key.length === 32
    && key.toString('base64').replace(/=+$/, '') === text.replace(/=+$/, '');
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value === 'true';
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function positiveSafeInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('invalid placement snapshot version');
  }
  return number;
}

function placementProbeErrorCode(error: unknown): string {
  const code = String((error as { code?: unknown } | null)?.code || '');
  return /^[a-z][a-z0-9_]{0,127}$/.test(code) ? code : 'placement_probe_failed';
}
