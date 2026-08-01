import { spawn } from 'node:child_process';
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildSippRtpCheckDockerPlan,
  renderSippRtpCheckScenarios
} from './capacity/sipp-rtp-check.js';
import { resolveFabricEnv } from '../src/config/converact-env.js';

export interface RustPbxRecordingIsolationRuntimePlan {
  compose_file: string;
  runtime_directory: string;
  result_file: string;
  project_name: 'converact-rustpbx-recording-isolation';
  rustpbx_image: string;
  postgres_image: string;
  node_image: string;
  python_image: string;
  fault_image: string;
  sipp_image: string;
  sipp_binary: string;
  network: 'converact-rustpbx-recording-isolation';
  rustpbx_ip: '172.30.45.10';
  uac_ip: '172.30.45.20';
  uas_ip: '172.30.45.21';
}

export interface RustPbxRtpPhaseSnapshot {
  observed_at: string;
  uac_generated_packets: number;
  uac_received_packets: number;
  uas_generated_packets: number;
  uas_received_packets: number;
}

export interface RustPbxRecordingIsolationEvidence {
  run_id: string;
  fault_call_successful: boolean;
  fault_call_duration_ms: number;
  media_before_fault: RustPbxRtpPhaseSnapshot;
  media_during_fault: RustPbxRtpPhaseSnapshot;
  media_after_write_failure: RustPbxRtpPhaseSnapshot;
  spool_fault: {
    kind: 'enospc';
    available_bytes_before: number;
    available_bytes_during: number;
    filler_removed: boolean;
  };
  recorder_write_failure_count: number;
  primary_completion_present: boolean;
  recovery: {
    call_successful: boolean;
    payload_size_bytes: number;
    manifest_present: boolean;
    completion_present: boolean;
    segment_count: number;
  };
  rustpbx_restart_count: number;
  rustpbx_oom_killed: boolean;
}

export interface RustPbxRecordingIsolationResult {
  schema_version: 1;
  status: 'passed_controlled_runtime';
  run_id: string;
  fault_call_duration_ms: number;
  media_before_fault: RustPbxRtpPhaseSnapshot;
  media_during_fault: RustPbxRtpPhaseSnapshot;
  media_after_write_failure: RustPbxRtpPhaseSnapshot;
  spool_fault: RustPbxRecordingIsolationEvidence['spool_fault'];
  recorder_write_failure_count: number;
  primary_recording_terminal_status: 'failed';
  recording_failure_code: 'local_spool_enospc';
  media_transport_progress_verified: true;
  recovery_recording_terminal_status: 'complete';
  recovery_payload_size_bytes: number;
  recovery_segment_count: number;
  rustpbx_restart_count: 0;
  rustpbx_oom_killed: false;
  capacity_claim: 'none';
}

const RTP_COUNTERS = [
  'uac_generated_packets',
  'uac_received_packets',
  'uas_generated_packets',
  'uas_received_packets'
] as const;
const SIPP_BINARY_SHA256 =
  '8e8ecdbe923bf608c844038adfa35c8595400c4629d629f00d51539ac24cdfef';
const SERVICE = '+8613800138000';
const COMMAND_OUTPUT_LIMIT = 2 * 1024 * 1024;

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export function createRustPbxRecordingIsolationRuntimePlan(
  env: NodeJS.ProcessEnv = process.env
): RustPbxRecordingIsolationRuntimePlan {
  const runtimeDirectory = absolutePath(
    resolveFabricEnv(env, 'RUSTPBX_RECORDING_ISOLATION_DIR'),
    'runtime directory'
  );
  return {
    compose_file: absolutePath(
      resolveFabricEnv(env, 'RUSTPBX_RECORDING_ISOLATION_COMPOSE_FILE'),
      'Compose file'
    ),
    runtime_directory: runtimeDirectory,
    result_file: resolve(runtimeDirectory, 'result.json'),
    project_name: 'converact-rustpbx-recording-isolation',
    rustpbx_image: exactRustPbxImage(
      resolveFabricEnv(env, 'RUSTPBX_RECORDING_ISOLATION_IMAGE')
    ),
    postgres_image: digestImage(
      resolveFabricEnv(env, 'RUSTPBX_RECORDING_ISOLATION_POSTGRES_IMAGE'),
      'PostgreSQL image'
    ),
    node_image: digestImage(
      resolveFabricEnv(env, 'RUSTPBX_RECORDING_ISOLATION_NODE_IMAGE'),
      'Node image'
    ),
    python_image: digestImage(
      resolveFabricEnv(env, 'RUSTPBX_RECORDING_ISOLATION_PYTHON_IMAGE'),
      'Python image'
    ),
    fault_image: digestImage(
      resolveFabricEnv(env, 'RUSTPBX_RECORDING_ISOLATION_FAULT_IMAGE'),
      'fault injector image'
    ),
    sipp_image: digestImage(
      resolveFabricEnv(env, 'RUSTPBX_RECORDING_ISOLATION_SIPP_IMAGE'),
      'SIPp runtime image'
    ),
    sipp_binary: absolutePath(resolveFabricEnv(env, 'SIPP_BINARY'), 'SIPp binary'),
    network: 'converact-rustpbx-recording-isolation',
    rustpbx_ip: '172.30.45.10',
    uac_ip: '172.30.45.20',
    uas_ip: '172.30.45.21'
  };
}

export function createRustPbxRtpPhaseSnapshot(
  uacDebug: string,
  uasDebug: string,
  observedAt = new Date()
): RustPbxRtpPhaseSnapshot {
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
    throw new Error('RTP observation time is invalid');
  }
  const uac = countLiveSippRtpPackets(uacDebug);
  const uas = countLiveSippRtpPackets(uasDebug);
  return {
    observed_at: observedAt.toISOString(),
    uac_generated_packets: uac.sent,
    uac_received_packets: uac.received,
    uas_generated_packets: uas.sent,
    uas_received_packets: uas.received
  };
}

export function assertRustPbxRtpPhaseProgress(
  previous: RustPbxRtpPhaseSnapshot,
  current: RustPbxRtpPhaseSnapshot,
  phase: string
): void {
  validPhaseSnapshot(previous, 'previous');
  validPhaseSnapshot(current, 'current');
  const label = safeIdentifier(phase, 'RTP phase');
  if (Date.parse(current.observed_at) <= Date.parse(previous.observed_at)) {
    throw new Error(`RTP observation time did not progress during ${label}`);
  }
  for (const counter of RTP_COUNTERS) {
    if (current[counter] <= previous[counter]) {
      throw new Error(`${counter} did not progress during ${label}`);
    }
  }
}

export function evaluateRustPbxRecordingIsolationEvidence(
  evidence: RustPbxRecordingIsolationEvidence
): RustPbxRecordingIsolationResult {
  const runId = safeIdentifier(evidence.run_id, 'run ID');
  if (evidence.fault_call_successful !== true) {
    throw new Error('fault injection call did not complete successfully');
  }
  positiveInteger(evidence.fault_call_duration_ms, 'fault call duration');
  assertRustPbxRtpPhaseProgress(
    evidence.media_before_fault,
    evidence.media_during_fault,
    'during_fault'
  );
  assertRustPbxRtpPhaseProgress(
    evidence.media_during_fault,
    evidence.media_after_write_failure,
    'after_write_failure'
  );
  if (evidence.spool_fault?.kind !== 'enospc') {
    throw new Error('recording spool fault must be ENOSPC');
  }
  positiveInteger(evidence.spool_fault.available_bytes_before, 'pre-fault spool availability');
  nonNegativeInteger(evidence.spool_fault.available_bytes_during, 'fault spool availability');
  if (evidence.spool_fault.available_bytes_during >= evidence.spool_fault.available_bytes_before) {
    throw new Error('recording spool availability did not decrease during ENOSPC injection');
  }
  if (evidence.spool_fault.filler_removed !== true) {
    throw new Error('recording spool fault filler was not removed');
  }
  positiveInteger(evidence.recorder_write_failure_count, 'recorder write failure count');
  if (evidence.primary_completion_present) {
    throw new Error('failed primary recording unexpectedly published completion');
  }
  if (evidence.rustpbx_restart_count !== 0) {
    throw new Error('RustPBX restarted during recording isolation acceptance');
  }
  if (evidence.rustpbx_oom_killed) {
    throw new Error('RustPBX was OOM-killed during recording isolation acceptance');
  }
  if (evidence.recovery?.call_successful !== true) {
    throw new Error('recovery call did not complete successfully');
  }
  positiveInteger(evidence.recovery.payload_size_bytes, 'recovery recording payload size');
  if (!evidence.recovery.manifest_present) {
    throw new Error('recovery recording segment manifest is missing');
  }
  if (!evidence.recovery.completion_present) {
    throw new Error('recovery recording completion is missing');
  }
  positiveInteger(evidence.recovery.segment_count, 'recovery recording segment count');

  const result: RustPbxRecordingIsolationResult = {
    schema_version: 1,
    status: 'passed_controlled_runtime',
    run_id: runId,
    fault_call_duration_ms: evidence.fault_call_duration_ms,
    media_before_fault: structuredClone(evidence.media_before_fault),
    media_during_fault: structuredClone(evidence.media_during_fault),
    media_after_write_failure: structuredClone(evidence.media_after_write_failure),
    spool_fault: structuredClone(evidence.spool_fault),
    recorder_write_failure_count: evidence.recorder_write_failure_count,
    primary_recording_terminal_status: 'failed',
    recording_failure_code: 'local_spool_enospc',
    media_transport_progress_verified: true,
    recovery_recording_terminal_status: 'complete',
    recovery_payload_size_bytes: evidence.recovery.payload_size_bytes,
    recovery_segment_count: evidence.recovery.segment_count,
    rustpbx_restart_count: 0,
    rustpbx_oom_killed: false,
    capacity_claim: 'none'
  };
  assertRustPbxRecordingIsolationResultIsSanitized(result);
  return result;
}

export function assertRustPbxRecordingIsolationResultIsSanitized(
  value: unknown
): asserts value is RustPbxRecordingIsolationResult {
  const serialized = JSON.stringify(value);
  if (!serialized || /https?:\/\/|wss?:\/\/|bearer\s|authorization|password|token|secret/i.test(serialized)) {
    throw new Error('RustPBX recording isolation result contains endpoint or secret material');
  }
}

export function writeRustPbxRecordingIsolationResult(
  outputFile: string,
  result: RustPbxRecordingIsolationResult
): void {
  assertRustPbxRecordingIsolationResultIsSanitized(result);
  const path = resolve(requiredText(outputFile, 'output file'));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  chmodSync(path, 0o600);
}

export function sanitizeRustPbxRecordingIsolationDiagnostic(value: string): string {
  return String(value || '')
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi,
      '$1[redacted]$2'
    )
    .replace(/\b(Bearer)\s+\S+/gi, '$1 [redacted]')
    .replace(
      /(\b(?:authorization|password|token|secret)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]'
    )
    .slice(-64 * 1024);
}

export async function runRustPbxRecordingIsolationAcceptance(
  env: NodeJS.ProcessEnv = process.env
): Promise<RustPbxRecordingIsolationResult> {
  const plan = createRustPbxRecordingIsolationRuntimePlan(env);
  assertSippBinary(plan.sipp_binary);
  prepareRuntimeDirectory(plan.runtime_directory);
  const secrets = createRuntimeSecrets();
  const composeEnv = {
    ...process.env,
    COMPOSE_PROJECT_NAME: plan.project_name,
    CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_NETWORK: plan.network,
    RUSTPBX_IMAGE: plan.rustpbx_image,
    POSTGRES_IMAGE: plan.postgres_image,
    NODE_IMAGE: plan.node_image,
    PYTHON_IMAGE: plan.python_image,
    FAULT_IMAGE: plan.fault_image,
    RUSTPBX_CONFIG_FILE: join(plan.runtime_directory, 'rustpbx.toml'),
    RUSTPBX_ROUTE_SNAPSHOT_FILE: join(plan.runtime_directory, 'routes.json'),
    ...secrets
  };
  writeRuntimeConfig(plan.runtime_directory, secrets);
  writeRouteSnapshot(plan.runtime_directory, secrets);
  const baseline = await captureBaselineContainerRestarts();
  const compose = (args: string[], timeoutMs = 30_000) =>
    command('docker', ['compose', '-f', plan.compose_file, '-p', plan.project_name, ...args], {
      env: composeEnv,
      timeout_ms: timeoutMs
    });

  await compose(['down', '-v', '--remove-orphans'], 30_000);
  try {
    const startup = await compose(
      ['up', '-d', '--wait', 'postgres', 'rustpbx', 'owner', 'fault'],
      120_000
    );
    if (startup.code !== 0 || startup.timed_out) {
      const diagnostic = await captureStartupDiagnostics(plan, compose);
      throw new Error(
        'recording isolation services did not become healthy: '
        + `${sanitizedCommandError(startup)}\n${diagnostic.slice(-4_000)}`
      );
    }
    requireSuccessful(
      await compose(['run', '--rm', 'bootstrap'], 90_000),
      'RustPBX acceptance trunk bootstrap failed'
    );

    const availableBefore = await spoolAvailableBytes(compose);
    const fault = await runRtpCall({
      plan,
      compose,
      runtime_directory: join(plan.runtime_directory, 'fault-call'),
      run_id: 'recording-fault',
      media_duration_ms: 30_000,
      rtp_port_min: 30000,
      during_call: async ({ before, snapshot, waitForProgress }) => {
        const fill = await compose([
          'exec', '-T', 'fault', 'sh', '-c',
          'available=$(df -Pk /spool | awk \'NR==2 { print $4 }\'); '
          + 'count=$((available / 4 + 32)); '
          + 'dd if=/dev/zero of=/spool/fault-fill bs=4096 count="$count" conv=fsync'
        ], 30_000);
        if (fill.code === 0) {
          throw new Error('recording spool fault injection unexpectedly completed without ENOSPC');
        }
        const during = await waitForProgress(before, 'during_fault');
        await waitForLog(compose, 'recorder capture disabled after write failure', 20_000);
        const after = await waitForProgress(during, 'after_write_failure');
        return {
          before,
          during,
          after,
          available_during: await spoolAvailableBytes(compose),
          write_failures: await countRustPbxLog(compose, 'recorder capture disabled after write failure')
        };
      }
    });
    const faultObservation = requiredFaultObservation(fault.observation);
    const primaryCompletionPresent = await spoolHasCompletion(compose);
    requireSuccessful(
      await compose(['exec', '-T', 'fault', 'rm', '-f', '/spool/fault-fill'], 15_000),
      'recording spool fault filler cleanup failed'
    );

    const recovery = await runRtpCall({
      plan,
      compose,
      runtime_directory: join(plan.runtime_directory, 'recovery-call'),
      run_id: 'recording-recovery',
      media_duration_ms: 12_000,
      rtp_port_min: 31000
    });
    const recoveryArtifact = await readRecoveryArtifact(compose);
    const containerState = await readRustPbxContainerState(compose);
    await assertBaselineContainerRestarts(baseline);

    const result = evaluateRustPbxRecordingIsolationEvidence({
      run_id: `rustpbx-recording-isolation-${Date.now()}`,
      fault_call_successful: fault.successful,
      fault_call_duration_ms: fault.duration_ms,
      media_before_fault: faultObservation.before,
      media_during_fault: faultObservation.during,
      media_after_write_failure: faultObservation.after,
      spool_fault: {
        kind: 'enospc',
        available_bytes_before: availableBefore,
        available_bytes_during: faultObservation.available_during,
        filler_removed: true
      },
      recorder_write_failure_count: faultObservation.write_failures,
      primary_completion_present: primaryCompletionPresent,
      recovery: {
        call_successful: recovery.successful,
        payload_size_bytes: recoveryArtifact.payload_size_bytes,
        manifest_present: recoveryArtifact.manifest_present,
        completion_present: recoveryArtifact.completion_present,
        segment_count: recoveryArtifact.segment_count
      },
      rustpbx_restart_count: containerState.restart_count,
      rustpbx_oom_killed: containerState.oom_killed
    });
    writeRustPbxRecordingIsolationResult(plan.result_file, result);
    return result;
  } finally {
    await compose(['exec', '-T', 'fault', 'rm', '-f', '/spool/fault-fill'], 10_000);
    await compose(['down', '-v', '--remove-orphans'], 60_000);
  }
}

async function captureStartupDiagnostics(
  plan: RustPbxRecordingIsolationRuntimePlan,
  compose: (args: string[], timeoutMs?: number) => Promise<CommandResult>
): Promise<string> {
  const ps = await compose(['ps', '-a'], 15_000);
  const logs = await compose(['logs', '--no-color', '--tail', '200', 'rustpbx'], 15_000);
  const diagnostic = sanitizeRustPbxRecordingIsolationDiagnostic([
    '=== docker compose ps ===',
    ps.stdout || ps.stderr || `exit ${ps.code}`,
    '=== rustpbx logs ===',
    logs.stdout || logs.stderr || `exit ${logs.code}`
  ].join('\n'));
  writePrivate(join(plan.runtime_directory, 'startup-diagnostics.txt'), diagnostic);
  return diagnostic;
}

async function runRtpCall(input: {
  plan: RustPbxRecordingIsolationRuntimePlan;
  compose: (args: string[], timeoutMs?: number) => Promise<CommandResult>;
  runtime_directory: string;
  run_id: string;
  media_duration_ms: number;
  rtp_port_min: number;
  during_call?: (context: {
    before: RustPbxRtpPhaseSnapshot;
    snapshot: () => RustPbxRtpPhaseSnapshot;
    waitForProgress: (
      previous: RustPbxRtpPhaseSnapshot,
      phase: string
    ) => Promise<RustPbxRtpPhaseSnapshot>;
  }) => Promise<unknown>;
}): Promise<{ successful: boolean; duration_ms: number; observation?: unknown }> {
  mkdirSync(join(input.runtime_directory, 'uac'), { recursive: true, mode: 0o700 });
  mkdirSync(join(input.runtime_directory, 'uas'), { recursive: true, mode: 0o700 });
  const scenarios = renderSippRtpCheckScenarios({
    media_duration_ms: input.media_duration_ms
  });
  writePrivate(join(input.runtime_directory, 'rtp-check-uac.xml'), scenarios.uac);
  writePrivate(join(input.runtime_directory, 'rtp-check-uas.xml'), scenarios.uas);
  const callPlan = buildSippRtpCheckDockerPlan({
    network: input.plan.network,
    target_ip: input.plan.rustpbx_ip,
    uac_ip: input.plan.uac_ip,
    uas_ip: input.plan.uas_ip,
    sipp_binary: input.plan.sipp_binary,
    result_dir: input.runtime_directory,
    container_image: input.plan.sipp_image,
    run_id: input.run_id,
    service: SERVICE,
    calls: 1,
    calls_per_second: 1,
    timeout_seconds: Math.ceil(input.media_duration_ms / 1000) + 30,
    rtp_port_min: input.rtp_port_min,
    rtp_tasks_per_thread: 16,
    evidence_mode: 'strict'
  });
  const startedAt = Date.now();
  try {
    requireSuccessful(
      await command('docker', callPlan.uas_args, { timeout_ms: 15_000 }),
      `${input.run_id} UAS failed to start`
    );
    await sleep(300);
    const uac = command('docker', callPlan.uac_args, {
      timeout_ms: input.media_duration_ms + 45_000
    });
    const snapshot = () => createRustPbxRtpPhaseSnapshot(
      readOptional(join(input.runtime_directory, callPlan.artifacts.uac_rtp_debug)),
      readOptional(join(input.runtime_directory, callPlan.artifacts.uas_rtp_debug))
    );
    const before = await waitForInitialRtp(snapshot, 20_000);
    const waitForProgress = (
      previous: RustPbxRtpPhaseSnapshot,
      phase: string
    ) => waitForRtpProgress(snapshot, previous, phase, 15_000);
    const observation = input.during_call
      ? await input.during_call({ before, snapshot, waitForProgress })
      : undefined;
    const uacResult = await uac;
    const uasWait = await command('docker', ['wait', callPlan.uas_container], {
      timeout_ms: input.media_duration_ms + 30_000
    });
    const successful = uacResult.code === 0
      && !uacResult.timed_out
      && uasWait.code === 0
      && Number(uasWait.stdout.trim()) === 0
      && successfulSippStatistics(
        readFileSync(join(input.runtime_directory, callPlan.artifacts.uac_statistics), 'utf8')
      )
      && successfulSippStatistics(
        readFileSync(join(input.runtime_directory, callPlan.artifacts.uas_statistics), 'utf8')
      );
    return {
      successful,
      duration_ms: Date.now() - startedAt,
      ...(observation === undefined ? {} : { observation })
    };
  } finally {
    await command('docker', ['rm', '-f', callPlan.uac_container], { timeout_ms: 10_000 });
    await command('docker', ['rm', '-f', callPlan.uas_container], { timeout_ms: 10_000 });
  }
}

function requiredFaultObservation(value: unknown): {
  before: RustPbxRtpPhaseSnapshot;
  during: RustPbxRtpPhaseSnapshot;
  after: RustPbxRtpPhaseSnapshot;
  available_during: number;
  write_failures: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('recording fault observation is missing');
  }
  return value as ReturnType<typeof requiredFaultObservation>;
}

function createRuntimeSecrets(): Record<string, string> {
  return {
    RUSTPBX_DB_PASSWORD: randomBytes(32).toString('hex'),
    RUSTPBX_MANAGEMENT_TOKEN: randomBytes(36).toString('base64url'),
    RUSTPBX_WEBHOOK_TOKEN: randomBytes(36).toString('base64url'),
    RUSTPBX_COMPONENT_TOKEN: randomBytes(36).toString('base64url'),
    RUSTPBX_TRUNK_CREDENTIAL: randomBytes(36).toString('base64url'),
    RUSTPBX_RWI_TOKEN: randomBytes(36).toString('base64url'),
    RUSTPBX_ROUTE_SNAPSHOT_HMAC_KEY: randomBytes(32).toString('base64'),
    RUSTPBX_ROUTE_LOOKUP_HMAC_ROOT_KEY: randomBytes(32).toString('base64'),
    RUSTPBX_TENANT_ID: 'recording-isolation-tenant',
    RUSTPBX_PROFILE_ID: 'recording-isolation-profile'
  };
}

function writeRuntimeConfig(directory: string, secrets: Record<string, string>): void {
  writePrivate(join(directory, 'rustpbx.toml'), `http_addr = "0.0.0.0:8080"
log_level = "info"
database_url = "postgresql://rustpbx_app:${secrets.RUSTPBX_DB_PASSWORD}@postgres:5432/rustpbx"
rtp_start_port = 20000
rtp_end_port = 22000
storage_dir = "/app/storage"

[console]
base_path = "/console"
api_prefix = "/api"
allow_registration = false
secure_cookie = false

[[console.api_tokens]]
token = "${secrets.RUSTPBX_MANAGEMENT_TOKEN}"
scopes = ["extensions.write", "trunks.write", "routing.write"]
description = "Converact Fabric recording isolation"

[ami]
allows = ["172.30.45.0/24"]

[proxy]
addr = "0.0.0.0"
generated_dir = "/app/generated"
udp_port = 5060
tcp_port = 5060
modules = ["acl", "auth", "presence", "registrar", "call"]
media_proxy = "all"
ensure_user = true
acl_rules = ["allow all", "deny all"]
sip_max_active_transactions = 4096
sip_max_finished_transactions = 4096
sip_incoming_transaction_queue_capacity = 1024
sip_max_transport_connections = 1024
media_session_cleanup_concurrency = 16
media_session_cleanup_timeout_ms = 2000
media_recording_channel_capacity = 64
media_recording_worker_threads = 2
media_recording_worker_queue_capacity = 512

[[proxy.user_backends]]
type = "extension"
ttl = 30

[proxy.http_router]
url = "http://127.0.0.1:3210/router"
timeout_ms = 500
fallback_to_static = false
fallback_action = "reject"

[proxy.http_router.headers]
X-PBX-Key = "${secrets.RUSTPBX_WEBHOOK_TOKEN}"

[rwi]
enabled = true
max_connections = 16
max_calls_per_connection = 16
orphan_hold_secs = 30
originate_rate_limit = 10

[[rwi.tokens]]
token = "${secrets.RUSTPBX_RWI_TOKEN}"
scopes = ["call.control", "queue.control", "record.control", "supervisor.control", "media.stream"]

[callrecord]
type = "http"
max_concurrent = 16
channel_capacity = 256
worker_threads = 1
persist_to_database = false
url = "http://127.0.0.1:3210/cdr"
headers = { "X-PBX-Key" = "${secrets.RUSTPBX_WEBHOOK_TOKEN}" }
`);
}

function writeRouteSnapshot(directory: string, secrets: Record<string, string>): void {
  const root = Buffer.from(secrets.RUSTPBX_ROUTE_LOOKUP_HMAC_ROOT_KEY, 'base64');
  const tenantKey = Buffer.from(hkdfSync(
    'sha256',
    root,
    Buffer.from('ivekit-voice-address-v1', 'utf8'),
    Buffer.from(`hmac:${secrets.RUSTPBX_TENANT_ID}`, 'utf8'),
    32
  ));
  const addressHmac = createHmac('sha256', tenantKey)
    .update('e164')
    .update('\0')
    .update(SERVICE)
    .digest('hex');
  const now = Date.now();
  const body = canonicalJson({
    expires_at: new Date(now + 300_000).toISOString(),
    generated_at: new Date(now).toISOString(),
    profile_id: secrets.RUSTPBX_PROFILE_ID,
    routes: {
      [addressHmac]: {
        action: 'forward',
        headers: {},
        max_ring_time: 30,
        record: true,
        strategy: 'sequential',
        targets: ['sip:rtp-uas@172.30.45.21:5060'],
        timeout: 30
      }
    },
    schema_version: '1.0.0',
    sequence: now,
    source_revision: 1,
    tenant_id: secrets.RUSTPBX_TENANT_ID
  });
  const signature = createHmac(
    'sha256',
    Buffer.from(secrets.RUSTPBX_ROUTE_SNAPSHOT_HMAC_KEY, 'base64')
  ).update(body).digest('base64url');
  writePrivate(join(directory, 'routes.json'), `ivekit-route-snapshot-v1.${signature}\n${body}`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function prepareRuntimeDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function assertSippBinary(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error('SIPp binary is missing');
  }
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest !== SIPP_BINARY_SHA256) throw new Error('SIPp binary checksum mismatch');
}

async function waitForInitialRtp(
  snapshot: () => RustPbxRtpPhaseSnapshot,
  timeoutMs: number
): Promise<RustPbxRtpPhaseSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = snapshot();
    if (RTP_COUNTERS.every((counter) => current[counter] >= 5)) return current;
    await sleep(100);
  }
  throw new Error('initial bidirectional RTP was not observed');
}

async function waitForRtpProgress(
  snapshot: () => RustPbxRtpPhaseSnapshot,
  previous: RustPbxRtpPhaseSnapshot,
  phase: string,
  timeoutMs: number
): Promise<RustPbxRtpPhaseSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    await sleep(100);
    const current = snapshot();
    try {
      assertRustPbxRtpPhaseProgress(previous, current, phase);
      return current;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`RTP did not progress during ${phase}`);
}

async function waitForLog(
  compose: (args: string[], timeoutMs?: number) => Promise<CommandResult>,
  pattern: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await countRustPbxLog(compose, pattern) > 0) return;
    await sleep(200);
  }
  throw new Error(`RustPBX log marker was not observed: ${pattern}`);
}

async function countRustPbxLog(
  compose: (args: string[], timeoutMs?: number) => Promise<CommandResult>,
  pattern: string
): Promise<number> {
  const logs = await compose(['logs', '--no-color', 'rustpbx'], 10_000);
  return String(logs.stdout || '').split(pattern).length - 1;
}

async function spoolAvailableBytes(
  compose: (args: string[], timeoutMs?: number) => Promise<CommandResult>
): Promise<number> {
  const result = await compose(
    ['exec', '-T', 'fault', 'sh', '-c', "df -Pk /spool | awk 'NR==2 { print $4 * 1024 }'"],
    10_000
  );
  requireSuccessful(result, 'recording spool availability probe failed');
  const value = Number(result.stdout.trim());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('recording spool availability probe returned invalid data');
  }
  return value;
}

async function spoolHasCompletion(
  compose: (args: string[], timeoutMs?: number) => Promise<CommandResult>
): Promise<boolean> {
  const result = await compose([
    'exec', '-T', 'fault', 'sh', '-c',
    "find /spool -type f -name recording-completed.json -print -quit"
  ], 10_000);
  requireSuccessful(result, 'recording completion probe failed');
  return Boolean(result.stdout.trim());
}

async function readRecoveryArtifact(
  compose: (args: string[], timeoutMs?: number) => Promise<CommandResult>
): Promise<{
  payload_size_bytes: number;
  manifest_present: boolean;
  completion_present: boolean;
  segment_count: number;
}> {
  const result = await compose([
    'exec', '-T', 'fault', 'sh', '-c',
    'completion=$(find /spool -type f -name recording-completed.json | sort | tail -n 1); '
    + 'test -n "$completion" || exit 4; '
    + 'directory=${completion%/*}; '
    + 'payload=$(find "$directory" -type f -name "segment-*.wav" -exec wc -c {} \\; '
    + '| awk \'{ total += $1 } END { print total + 0 }\'); '
    + 'manifests=$(find "$directory" -type f -name "segment-*.json" | wc -l); '
    + 'printf "%s\\n%s\\n" "$payload" "$manifests"; '
    + 'cat "$completion"'
  ], 15_000);
  requireSuccessful(result, 'recovery recording artifacts are incomplete');
  const lines = result.stdout.trim().split(/\r?\n/);
  const payload = Number(lines.shift());
  const manifests = Number(lines.shift());
  const completion = JSON.parse(lines.join('\n')) as { segment_count?: unknown };
  const segmentCount = Number(completion.segment_count);
  return {
    payload_size_bytes: payload,
    manifest_present: Number.isSafeInteger(manifests) && manifests > 0,
    completion_present: true,
    segment_count: segmentCount
  };
}

async function readRustPbxContainerState(
  compose: (args: string[], timeoutMs?: number) => Promise<CommandResult>
): Promise<{ restart_count: number; oom_killed: boolean }> {
  const id = await compose(['ps', '-q', 'rustpbx'], 10_000);
  requireSuccessful(id, 'RustPBX container identity lookup failed');
  const inspect = await command('docker', [
    'inspect', '--format',
    '{{json .State}}|{{.RestartCount}}',
    id.stdout.trim()
  ], { timeout_ms: 10_000 });
  requireSuccessful(inspect, 'RustPBX container state lookup failed');
  const separator = inspect.stdout.lastIndexOf('|');
  const state = JSON.parse(inspect.stdout.slice(0, separator)) as { OOMKilled?: unknown };
  const restartCount = Number(inspect.stdout.slice(separator + 1).trim());
  return {
    restart_count: restartCount,
    oom_killed: state.OOMKilled === true
  };
}

async function captureBaselineContainerRestarts(): Promise<Map<string, number>> {
  const result = await command('docker', [
    'ps', '--format', '{{.Names}}'
  ], { timeout_ms: 10_000 });
  if (result.code !== 0) return new Map();
  const names = result.stdout.split(/\r?\n/).filter((name) =>
    /^(converact-homer-acceptance|converact-livekit-(browser|turn)-baseline|converact-rustpbx-baseline-)/.test(name)
      || /^(ivekit-homer-acceptance|ivekit-livekit-(browser|turn)-baseline|ivekit-rustpbx-baseline-)/.test(name)
  );
  const entries = await Promise.all(names.map(async (name) => {
    const inspect = await command('docker', [
      'inspect', '--format', '{{.RestartCount}}', name
    ], { timeout_ms: 10_000 });
    requireSuccessful(inspect, `baseline container state lookup failed for ${name}`);
    return [name, Number(inspect.stdout.trim())] as const;
  }));
  return new Map(entries);
}

async function assertBaselineContainerRestarts(before: Map<string, number>): Promise<void> {
  for (const [name, restartCount] of before) {
    const inspect = await command('docker', [
      'inspect', '--format', '{{.RestartCount}}', name
    ], { timeout_ms: 10_000 });
    requireSuccessful(inspect, `baseline container disappeared during acceptance: ${name}`);
    if (Number(inspect.stdout.trim()) !== restartCount) {
      throw new Error(`baseline container restarted during acceptance: ${name}`);
    }
  }
}

function successfulSippStatistics(csv: string): boolean {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return false;
  const headers = lines[0]!.split(';');
  const values = lines.at(-1)!.split(';');
  const value = (name: string) => Number(values[headers.indexOf(name)]);
  return value('SuccessfulCall(C)') === 1 && value('FailedCall(C)') === 0;
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function requireSuccessful(result: CommandResult, message: string): void {
  if (result.code !== 0 || result.timed_out) {
    throw new Error(`${message}: ${sanitizedCommandError(result)}`);
  }
}

function sanitizedCommandError(result: CommandResult): string {
  return String(result.stderr || result.stdout || `exit ${result.code}`)
    .replace(/https?:\/\/\S+/gi, '[endpoint]')
    .replace(/(authorization|password|token|secret)[^\s]*/gi, '$1=[redacted]')
    .slice(-2_000);
}

function command(
  executable: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout_ms: number }
): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn(executable, args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current: string, chunk: Buffer) =>
      (current + chunk.toString('utf8')).slice(-COMMAND_OUTPUT_LIMIT);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeout_ms);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolveCommand({ code: -1, stdout, stderr: String(error), timed_out: timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveCommand({ code: code ?? -1, stdout, stderr, timed_out: timedOut });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function countLiveSippRtpPackets(debug: string): { sent: number; received: number } {
  let sent = 0;
  let received = 0;
  for (const line of String(debug || '').split(/\r?\n/)) {
    const match = line.match(
      /SIPP SUCCESS (SEND|RECV) LOG:.*\[([A-Fa-f0-9]{2})[A-Fa-f0-9]*\]/
    );
    if (!match) continue;
    const firstByte = Number.parseInt(match[2]!, 16);
    if ((firstByte & 0xc0) !== 0x80) continue;
    if (match[1] === 'SEND') sent += 1;
    else received += 1;
  }
  return { sent, received };
}

function validPhaseSnapshot(value: RustPbxRtpPhaseSnapshot, label: string): void {
  if (!value || typeof value !== 'object' || !Number.isFinite(Date.parse(value.observed_at))) {
    throw new Error(`${label} RTP phase snapshot is invalid`);
  }
  for (const counter of RTP_COUNTERS) {
    nonNegativeInteger(value[counter], `${label} ${counter}`);
  }
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/.test(value || '')) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredText(value: string, label: string): string {
  if (!value || value.length > 4_096 || value.includes('\0')) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function absolutePath(value: string | undefined, label: string): string {
  const path = resolve(requiredText(String(value || ''), label));
  if (!String(value || '').startsWith('/')) {
    throw new Error(`${label} must be absolute`);
  }
  return path;
}

function digestImage(value: string | undefined, label: string): string {
  const image = requiredText(String(value || ''), label);
  if (!/@sha256:[a-f0-9]{64}$/.test(image) || /\s/.test(image)) {
    throw new Error(`${label} must be pinned by digest`);
  }
  return image;
}

function exactRustPbxImage(value: string | undefined): string {
  const image = requiredText(String(value || ''), 'RustPBX image');
  if (/\s/.test(image)
    || (!/@sha256:[a-f0-9]{64}$/.test(image)
      && !/:0\.4\.11-ivekit\.\d+-[a-f0-9]{8}$/.test(image))) {
    throw new Error('RustPBX image must use an exact Converact Fabric release tag or digest');
  }
  return image;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  runRustPbxRecordingIsolationAcceptance()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'RustPBX recording isolation failed'}\n`
      );
      process.exitCode = 1;
    });
}
