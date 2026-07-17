import type { PgQueryable } from '../../../db-pg.js';
import { iveKitRuntimeHeartbeatConfig } from './runtime-heartbeat.js';

export interface IveKitPlacementReadinessProbe {
  probe(): Promise<{
    snapshot_version: number;
    generated_at: string;
    expires_at: string;
  }>;
}

export interface IveKitReadinessResult {
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

export interface IveKitReadinessProbe {
  probe(): Promise<IveKitReadinessResult>;
}

export function createIveKitReadinessProbe(input: {
  pg: PgQueryable | null;
  env?: NodeJS.ProcessEnv;
  requiredMigrations?: readonly string[];
  instanceId?: string;
  placementProbe?: IveKitPlacementReadinessProbe;
}): IveKitReadinessProbe {
  const env = input.env || process.env;
  const requiredMigrations = [...(input.requiredMigrations || REQUIRED_MIGRATIONS)];
  const heartbeatConfig = iveKitRuntimeHeartbeatConfig(env);
  const placementEnabled = booleanEnv(env.OPC_IVEKIT_PLACEMENT_ENABLED, false);
  const instanceId = String(input.instanceId || env.OPC_IVEKIT_INSTANCE_ID || env.HOSTNAME || '');
  return {
    async probe() {
      const result: IveKitReadinessResult = {
        status: 'not_ready',
        checks: {
          database: { status: 'failed' },
          migrations: { status: 'failed', missing: requiredMigrations },
          configuration: configurationCheck(env),
          notification_providers: {
            status: 'unknown', active: 0, unhealthy: 0,
            blocking: booleanEnv(env.OPC_IVEKIT_READINESS_REQUIRE_HEALTHY_NOTIFICATION_PROVIDER, false)
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
      };
      if (!input.pg) return result;
      try {
        await input.pg.query('SELECT 1 AS ready');
        result.checks.database.status = 'ok';
      } catch {
        return result;
      }
      try {
        const migrations = await input.pg.query<{ version: string }>(
          'SELECT version FROM schema_migrations WHERE version = ANY($1::text[])',
          [requiredMigrations]
        );
        const present = new Set(migrations.rows.map((row) => String(row.version)));
        result.checks.migrations.missing = requiredMigrations.filter((version) => !present.has(version));
        result.checks.migrations.status = result.checks.migrations.missing.length ? 'failed' : 'ok';
      } catch {
        result.checks.migrations.status = 'failed';
      }
      try {
        const providers = await input.pg.query<{ active: unknown; unhealthy: unknown }>(
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
      if (heartbeatConfig.enabled) {
        if (!instanceId) {
          result.checks.runtime_heartbeat.status = 'missing';
        } else {
          try {
            const heartbeat = await input.pg.query<{ state: string; heartbeat_at: unknown }>(
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
        }
      }
      if (placementEnabled && input.placementProbe) {
        try {
          const snapshot = await input.placementProbe.probe();
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
      }
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
    }
  };
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
  '090_ivekit_runtime_security'
] as const;

function configurationCheck(env: NodeJS.ProcessEnv): IveKitReadinessResult['checks']['configuration'] {
  const invalid: string[] = [];
  for (const key of [
    'OPC_IVEKIT_AUDIT_IP_HMAC_KEY',
    'OPC_IVEKIT_RATE_LIMIT_HMAC_KEY'
  ]) {
    if (!validBase64Key(env[key])) invalid.push(key);
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
