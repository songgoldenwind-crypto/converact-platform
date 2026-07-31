import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  closePostgres,
  initPostgres,
  type PgQueryable
} from '../../../../src/db-pg.js';
import { RealtimeSpeechProjection } from '../../../../src/agent-runtime/converact/voice/realtime-speech-projection.js';
import {
  RealtimeSpeechProjectionDispatcher,
  type RealtimeSpeechProjectionDispatchEvent
} from '../../../../src/agent-runtime/converact/voice/realtime-speech-projection-dispatcher.js';
import { RealtimeSpeechStore } from '../../../../src/agent-runtime/converact/voice/realtime-speech-store.js';
import type {
  RealtimeSpeechTranslationEvent
} from '../../../../src/agent-runtime/converact/voice/realtime-speech-translation.js';

const TENANT_ID = 'tenant-realtime-recovery';
const INTERACTION_ID = 'interaction-realtime-recovery';
const EXPECTED_LED_CONTAINER_COUNT = 7;

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'prepare') {
    await prepare();
    return;
  }
  if (mode === 'postgres-recovery') {
    await postgresRecovery(requiredArgs(args, 4));
    return;
  }
  if (mode === 'finalize') {
    finalize(requiredArgs(args, 4));
    return;
  }
  if (mode === 'environment') {
    environment(requiredArgs(args, 5));
    return;
  }
  throw new Error('realtime_recovery_probe_mode_invalid');
}

async function prepare(): Promise<void> {
  const pg = await productionPostgres();
  try {
    await pg.query(
      `INSERT INTO tenants (id, name, status, plan_code, settings)
       VALUES ($1, $2, 'active', 'enterprise', '{}'::JSONB)
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_ID, 'Realtime recovery acceptance']
    );
    process.stdout.write(`${JSON.stringify({ status: 'prepared' })}\n`);
  } finally {
    await closePostgres();
  }
}

async function postgresRecovery(
  [readyMarker, outageMarker, retryMarker, outputFile]: string[]
): Promise<void> {
  const pg = await productionPostgres();
  const observed: RealtimeSpeechProjectionDispatchEvent[] = [];
  const projection = new RealtimeSpeechProjection({
    store: new RealtimeSpeechStore(pg),
    broadcastEphemeral: () => undefined,
    publishFinal: () => undefined
  });
  const dispatcher = new RealtimeSpeechProjectionDispatcher({
    projection,
    max_queue_items: 8,
    shutdown_timeout_ms: 1_000,
    on_event: (event) => {
      observed.push(event);
      if (event.type === 'projection.retrying') writeMarker(retryMarker);
    }
  });

  try {
    await pg.query('SELECT 1');
    writeMarker(readyMarker);
    await waitFor(() => pathExists(outageMarker), 30_000);
    const offeredAt = new Date();
    const offered = dispatcher.offer(context(offeredAt), finalEvent(offeredAt));
    if (offered !== 'accepted') throw new Error('realtime_recovery_projection_not_accepted');
    await waitFor(
      () => observed.some((event) => event.type === 'projection.succeeded'),
      30_000
    );
    await dispatcher.close();

    const persisted = await pg.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count
       FROM ivekit_realtime_speech_segments
       WHERE tenant_id = $1 AND interaction_id = $2
         AND segment_id = 'segment-postgres-recovery'`,
      [TENANT_ID, INTERACTION_ID]
    );
    const report = {
      status: persisted.rows[0]?.count === '1' ? 'passed' : 'failed',
      actual_postgresql_process_outage: true,
      retry_events: observed.filter(
        (event) => event.type === 'projection.retrying'
      ).length,
      projection_succeeded: observed.some(
        (event) => event.type === 'projection.succeeded'
      ),
      persisted_rows: Number(persisted.rows[0]?.count ?? 0),
      process_pid: process.pid
    };
    if (
      report.status !== 'passed'
      || report.retry_events < 1
      || !report.projection_succeeded
    ) {
      throw new Error('realtime_recovery_postgres_result_invalid');
    }
    writeJson(outputFile, report);
  } finally {
    await dispatcher.close().catch(() => undefined);
    await closePostgres().catch(() => undefined);
  }
}

function finalize(
  [postgresResultFile, gatewayResultFile, environmentResultFile, evidenceFile]: string[]
): void {
  const postgres = readJson(postgresResultFile);
  const gateway = readJson(gatewayResultFile);
  const environmentResult = readJson(environmentResultFile);
  const checks = [
    check(
      'actual_postgresql_process_outage',
      postgres.status === 'passed'
      && postgres.actual_postgresql_process_outage === true
      && Number(postgres.retry_events) >= 1
      && postgres.projection_succeeded === true
      && Number(postgres.persisted_rows) === 1
    ),
    check(
      'actual_gateway_process_restart',
      gateway.status === 'passed'
      && gateway.actual_gateway_process_restart === true
      && gateway.gateway_process_restarted === true
      && Number(gateway.first_gateway_pid) > 0
      && Number(gateway.second_gateway_pid) > 0
      && gateway.first_gateway_pid !== gateway.second_gateway_pid
      && gateway.transport_module_path === '/workspace/livekit_audio_tap_transport.py'
      && /^[a-f0-9]{64}$/.test(String(gateway.transport_source_sha256 || ''))
    ),
    check(
      'validation_resources_removed',
      environmentResult.status === 'passed'
      && Number(environmentResult.validation_resources_remaining) === 0
    ),
    check(
      'led_containers_unchanged',
      environmentResult.status === 'passed'
      && environmentResult.led_containers_unchanged === true
      && environmentResult.led_all_healthy === true
    ),
    check(
      'transport_network_internal',
      environmentResult.status === 'passed'
      && environmentResult.transport_network_internal === true
    )
  ];
  const report = {
    status: checks.every((entry) => entry.status === 'passed') ? 'passed' : 'failed',
    verification_scope: 'controlled_server_process_recovery',
    actual_postgresql_process_outage: true,
    actual_gateway_process_restart: true,
    real_media_continuity_evidence: false,
    real_vendor_evidence: false,
    capacity_claim: 'none',
    generated_at: new Date().toISOString(),
    checks,
    postgres: sanitizeResult(postgres),
    gateway: sanitizeResult(gateway),
    environment: sanitizeResult(environmentResult)
  };
  writeJson(evidenceFile, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

function environment(
  [beforeFile, afterFile, resourcesFile, networkPolicyFile, outputFile]: string[]
): void {
  const before = readLedSnapshot(beforeFile);
  const after = readLedSnapshot(afterFile);
  const resources = readResourceReport(resourcesFile);
  const transportNetworkInternal = (
    readFileSync(networkPolicyFile, 'utf8') === 'internal\n'
  );
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const expectedLedCount = (
    before.length === EXPECTED_LED_CONTAINER_COUNT
    && after.length === EXPECTED_LED_CONTAINER_COUNT
  );
  const allHealthy = expectedLedCount
    && after.every((entry) => entry.status === 'healthy');
  const report = {
    status: (
      unchanged
      && allHealthy
      && resources.length === 0
      && transportNetworkInternal
    ) ? 'passed' : 'failed',
    validation_resources_remaining: resources.length,
    transport_network_internal: transportNetworkInternal,
    led_containers_unchanged: unchanged,
    led_all_healthy: allHealthy,
    led_expected_container_count: EXPECTED_LED_CONTAINER_COUNT,
    led_container_count_before: before.length,
    led_container_count_after: after.length,
    led_containers: after
  };
  writeJson(outputFile, report);
  if (report.status !== 'passed') throw new Error('realtime_recovery_environment_invalid');
}

async function productionPostgres(): Promise<PgQueryable> {
  const connectionString = String(process.env.DATABASE_URL ?? '').trim();
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pg = await initPostgres();
  if (!pg) throw new Error('realtime_recovery_postgres_unavailable');
  return pg;
}

function context(now: Date) {
  return {
    tenant_id: TENANT_ID,
    interaction_id: INTERACTION_ID,
    media_session_id: 'room-realtime-recovery',
    media_source: 'livekit' as const,
    participant_id: 'customer-realtime-recovery',
    track_id: 'TR_realtime_recovery',
    purpose: 'live_translation' as const,
    consent_ref: 'consent-realtime-recovery',
    provider_profile_id: 'speech-recovery',
    provider: 'speech-recovery',
    provider_version: '1',
    retention_until: new Date(now.getTime() + 86_400_000).toISOString(),
    audience_user_ids: ['agent-realtime-recovery']
  };
}

function finalEvent(now: Date): RealtimeSpeechTranslationEvent {
  return {
    event_id: 'event-postgres-recovery',
    type: 'translation.final',
    provider_session_id: 'provider-session-recovery',
    sequence: 1,
    occurred_at: now.toISOString(),
    segment_id: 'segment-postgres-recovery',
    speaker_id: 'customer-realtime-recovery',
    source_language: 'en',
    target_language: 'zh-CN',
    source_text: 'recovery source',
    translated_text: 'recovery translated',
    provider_request_id: 'request-postgres-recovery',
    latency_ms: { final: 100 },
    safe_metadata: { acceptance: 'process_recovery' },
    final: true
  };
}

function requiredArgs(args: string[], count: number): string[] {
  if (args.length !== count || args.some((value) => !value.trim())) {
    throw new Error('realtime_recovery_probe_arguments_invalid');
  }
  return args.map((value) => resolve(value));
}

function check(name: string, passed: boolean) {
  return { name, status: passed ? 'passed' as const : 'failed' as const };
}

function sanitizeResult(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !/url|password|secret|token|dsn|connection/i.test(key)
  ));
}

function readJson(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('realtime_recovery_result_invalid');
  }
  return value as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to remove.
    }
    throw error;
  }
}

function writeMarker(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, 'ready\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
  } catch (error) {
    if (
      String((error as { code?: unknown }).code || '') === 'EEXIST'
      && lstatSync(path).isFile()
      && !lstatSync(path).isSymbolicLink()
    ) return;
    throw error;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function readLedSnapshot(path: string): Array<{
  name: string;
  container_id: string;
  started_at: string;
  status: string;
}> {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.map((line) => {
    const [rawName, rawContainerId, rawStartedAt, rawStatus, ...rest] = line.split('\t');
    const name = rawName || '';
    const containerId = rawContainerId || '';
    const startedAt = rawStartedAt || '';
    const status = rawStatus || '';
    if (
      rest.length
      || !/^led-platform-[a-z0-9-]{1,100}$/.test(name)
      || !/^[a-f0-9]{64}$/.test(containerId)
      || !/^\d{4}-\d{2}-\d{2}T/.test(startedAt)
      || !/^(healthy|running|unhealthy|exited)$/.test(status)
    ) {
      throw new Error('realtime_recovery_led_snapshot_invalid');
    }
    return {
      name,
      container_id: containerId,
      started_at: startedAt,
      status
    };
  });
}

function readResourceReport(path: string): Array<{
  kind: 'container' | 'network' | 'volume';
  name: string;
}> {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.map((line) => {
    const [rawKind, rawName, ...rest] = line.split('\t');
    if (
      rest.length
      || !/^(container|network|volume)$/.test(rawKind || '')
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/.test(rawName || '')
    ) {
      throw new Error('realtime_recovery_resource_report_invalid');
    }
    return {
      kind: rawKind as 'container' | 'network' | 'volume',
      name: rawName as string
    };
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('realtime_recovery_wait_timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

main().catch((error) => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exit(1);
});

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_ -]{1,160}$/i.test(message)
    ? message
    : 'realtime_recovery_probe_failed';
}
