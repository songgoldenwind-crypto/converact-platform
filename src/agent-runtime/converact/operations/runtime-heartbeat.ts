import { resolveConveractEnv, resolveFabricEnv } from '../../../config/converact-env.js';
import type { PgQueryable } from '../../../db-pg.js';

export interface ConveractFabricRuntimeHeartbeatConfig {
  enabled: boolean;
  interval_ms: number;
  stale_after_ms: number;
}

export function startConveractFabricRuntimeHeartbeat(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  instance_id: string;
  components: readonly string[];
  now?: () => Date;
}): { stop(): Promise<void>; ready: Promise<void> } {
  const env = input.env || process.env;
  const config = converactFabricRuntimeHeartbeatConfig(env);
  if (!config.enabled) return { stop: async () => undefined, ready: Promise.resolve() };
  const instanceId = safeText(input.instance_id, 255);
  const components = [...new Set(input.components.map((value) => safeComponent(value)))].sort();
  const sourceCommit = sourceCommitValue(resolveFabricEnv(env, 'SOURCE_COMMIT') || env.GIT_COMMIT);
  const now = input.now || (() => new Date());
  const startedAt = now().toISOString();
  let stopped = false;
  let active: Promise<void> | null = null;
  const write = (state: 'starting' | 'running' | 'draining' | 'stopped'): Promise<void> => {
    if (active) return active;
    const timestamp = now().toISOString();
    active = input.pg.query(
      `INSERT INTO ivekit_runtime_heartbeats
        (instance_id, source_commit, state, components, started_at, heartbeat_at,
         stopped_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz,
         CASE WHEN $3 = 'stopped' THEN $6::timestamptz ELSE NULL END, $6::timestamptz)
       ON CONFLICT (instance_id) DO UPDATE SET
         source_commit = EXCLUDED.source_commit,
         state = EXCLUDED.state,
         components = EXCLUDED.components,
         started_at = CASE
           WHEN ivekit_runtime_heartbeats.state = 'stopped' THEN EXCLUDED.started_at
           ELSE ivekit_runtime_heartbeats.started_at
         END,
         heartbeat_at = EXCLUDED.heartbeat_at,
         stopped_at = EXCLUDED.stopped_at,
         updated_at = EXCLUDED.updated_at`,
      [instanceId, sourceCommit, state, JSON.stringify(components), startedAt, timestamp]
    ).then(() => undefined).finally(() => { active = null; });
    return active;
  };
  const ready = write('starting').then(() => write('running'));
  const timer = setInterval(() => {
    if (!stopped) void write('running').catch((error) => {
      console.error('[converact-runtime-heartbeat] update failed', safeErrorCode(error));
    });
  }, config.interval_ms);
  timer.unref?.();
  return {
    ready,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
      await write('draining');
      await write('stopped');
    }
  };
}

export function converactFabricRuntimeHeartbeatConfig(
  env: NodeJS.ProcessEnv = process.env
): ConveractFabricRuntimeHeartbeatConfig {
  return {
    enabled: booleanEnv(resolveFabricEnv(env, 'RUNTIME_HEARTBEAT_ENABLED'), false),
    interval_ms: integerEnv(resolveFabricEnv(env, 'RUNTIME_HEARTBEAT_INTERVAL_MS'), 10_000, 1_000, 300_000),
    stale_after_ms: integerEnv(resolveFabricEnv(env, 'RUNTIME_HEARTBEAT_STALE_AFTER_MS'), 45_000, 5_000, 900_000)
  };
}

export function converactFabricRuntimeComponents(env: NodeJS.ProcessEnv = process.env): string[] {
  const components = ['api'];
  const flags: Array<[string, string]> = [
    ['notification_worker', 'CONVERACT_FABRIC_NOTIFICATION_WORKER_ENABLED'],
    ['event_webhook_worker', 'CONVERACT_FABRIC_EVENT_WEBHOOK_WORKER_ENABLED'],
    ['notification_health_worker', 'CONVERACT_FABRIC_NOTIFICATION_HEALTH_WORKER_ENABLED'],
    ['retention_worker', 'CONVERACT_FABRIC_RETENTION_WORKER_ENABLED'],
    ['contact_center_worker', 'CONVERACT_FABRIC_CONTACT_CENTER_WORKER_ENABLED'],
    ['ivr_workers', 'CONVERACT_FABRIC_IVR_WORKERS_ENABLED'],
    ['voice_workers', 'CONVERACT_FABRIC_VOICE_WORKERS_ENABLED'],
    ['translation_worker', 'CONVERACT_TRANSLATION_WORKER_ENABLED'],
    ['quality_worker', 'CONVERACT_QUALITY_REVIEW_WORKER_ENABLED'],
    ['file_scan_worker', 'CONVERACT_FILE_SECURITY_SCAN_WORKER_ENABLED'],
    ['file_cleanup_worker', 'CONVERACT_FILE_CLEANUP_WORKER_ENABLED']
  ];
  for (const [component, key] of flags) {
    if (resolveConveractEnv(env, key) === '1' || resolveConveractEnv(env, key) === 'true') components.push(component);
  }
  return components;
}

function safeComponent(value: string): string {
  if (!/^[a-z0-9_.-]{1,100}$/.test(value)) throw new Error('invalid runtime component');
  return value;
}

function safeText(value: string, max: number): string {
  if (!value || value.length > max || /[\r\n\0]/.test(value)) throw new Error('invalid instance id');
  return value;
}

function sourceCommitValue(value: string | undefined): string {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : '';
}

function safeErrorCode(error: unknown): string {
  return String((error as { code?: unknown }).code || 'heartbeat_failed')
    .toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 100);
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error('invalid runtime heartbeat configuration');
}

function integerEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error('invalid runtime heartbeat configuration');
  }
  return number;
}
