import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import {
  RustDeskEdgePendingFileStore,
  type RustDeskEdgePendingFileStoreOptions,
  type RustDeskEdgePendingRecord,
  type RustDeskEdgeSpoolCommand
} from './rustdesk-edge-pending-store.js';
import {
  RustDeskOwnerEpochFence,
  assertRustDeskOwnerBinding,
  type RustDeskOwnerIdentity
} from './rustdesk-owner-epoch-fence.js';

export interface RustDeskEdgeClaimCommand {
  id: string;
  command_type: 'disconnect_session';
  external_id: string;
  target_id: string;
  rustdesk_id: string;
  controller_rustdesk_id: string;
  native_session_id?: string;
  requested_reason: 'consent_revoked' | 'remote_session_ended' | 'tool_ended' | 'gateway_ended';
  attempt: number;
  lease_expires_at: string;
  emergency_fallback_authorized: boolean;
  emergency_fallback_reason: string;
  native_control_protocol?: 'ivekit-rustdesk-native-control-v1' | 'ivekit-rustdesk-native-control-v2';
  interaction_id?: string;
  reservation_id?: string;
  owner_epoch?: string;
}

export interface RustDeskEdgeCommandAdapter {
  executable: string;
  args: string[];
}

export interface RustDeskEdgeCommandExecutionConfig {
  timeoutMs: number;
  edgeInstanceId: string;
  edgeAgentVersion: string;
  os: string;
  disconnectAdapter: RustDeskEdgeCommandAdapter | null;
  restartAdapter: RustDeskEdgeCommandAdapter | null;
}

export interface RustDeskEdgeCommandProgressReport {
  progress: 'session_adapter_failed' | 'fallback_started';
  exit_code?: number;
  duration_ms?: number;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RustDeskEdgeCommandExecutionResult {
  status: 'succeeded' | 'failed';
  execution_method: 'session_adapter' | 'service_restart';
  exit_code?: number;
  duration_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_sha256: string;
  stderr_sha256: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RustDeskEdgeCommandProcessorConfig {
  baseUrl: string;
  commandToken: string;
  edgeInstanceId: string;
  commandLeaseMs: number;
  execution: RustDeskEdgeCommandExecutionConfig;
  spool?: RustDeskEdgePendingFileStoreOptions;
  placementEnabled?: boolean;
}

export type RustDeskEdgeCommandPollResult =
  | 'idle'
  | 'executed'
  | 'result_pending'
  | 'reported'
  | 'quarantined';

interface LocalAdapterResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  timedOut: boolean;
  signal: string;
  errorCode: string;
}

type ProgressReporter = (report: RustDeskEdgeCommandProgressReport) => Promise<void>;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface PendingCommandReport {
  deviceId: string;
  command: RustDeskEdgeSpoolCommand;
  claimToken: string;
  progress: RustDeskEdgeCommandProgressReport[];
  result: RustDeskEdgeCommandExecutionResult;
}

const outputByteCap = 64 * 1024;
const adapterTimeoutKillGraceMs = 250;
const commandLeaseReportingMarginMs = 1_000;

export function rustDeskMinimumCommandLeaseMs(commandTimeoutMs: number): number {
  return commandTimeoutMs * 2 + commandLeaseReportingMarginMs;
}

export class RustDeskEdgeCommandProcessor {
  private pending: PendingCommandReport | null = null;
  private store: RustDeskEdgePendingFileStore | null = null;
  private storePromise: Promise<RustDeskEdgePendingFileStore> | null = null;
  private ownerFence: RustDeskOwnerEpochFence | null = null;
  private ownerFencePromise: Promise<RustDeskOwnerEpochFence> | null = null;

  constructor(
    private readonly config: RustDeskEdgeCommandProcessorConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async pollOnce(deviceIdValue: string): Promise<RustDeskEdgeCommandPollResult> {
    const deviceId = requiredString(deviceIdValue, 'deviceId is required');
    const store = await this.pendingStore();
    if (this.pending) {
      return await this.deliverPending() ? 'reported' : 'result_pending';
    }
    const recovered = await store?.load();
    if (recovered) return this.recoverPending(recovered);

    const claim = await this.requestJson<{
      command?: unknown;
      owner_binding?: unknown;
      claim_token?: unknown;
    }>(
      `/api/ivekit/rustdesk/devices/${encodeURIComponent(deviceId)}/commands/claim`,
      {
        edge_instance_id: this.config.edgeInstanceId,
        lease_ms: this.config.commandLeaseMs
      },
      true
    );
    if (!claim) return 'idle';
    const command = decodeClaimCommand(
      claim.command,
      claim.owner_binding,
      this.config.placementEnabled === true
    );
    const claimToken = requiredString(claim.claim_token, 'RustDesk command claim_token is required');
    const ownerIdentity = commandOwnerIdentity(command);
    let fencedResult: RustDeskEdgeCommandExecutionResult | null = null;
    if (ownerIdentity) {
      const fence = await this.epochFence();
      if (!fence) throw new Error('rustdesk_owner_epoch_fence_required');
      try {
        await fence.accept({
          external_id: command.external_id,
          command_id: command.id,
          ...ownerIdentity
        });
      } catch (error) {
        fencedResult = rejectedBeforeNativeExecution(this.config.execution, error);
      }
    }
    await store?.writeExecuting({
      edge_instance_id: this.config.edgeInstanceId,
      device_id: deviceId,
      command,
      progress: []
    });
    const failedProgress: RustDeskEdgeCommandProgressReport[] = [];
    const result = fencedResult || await executeRustDeskDisconnectCommand(
        command,
        this.config.execution,
        async (report) => {
          try {
            await this.postProgress(deviceId, command, claimToken, report);
          } catch {
            failedProgress.push(report);
          }
        }
      );
    this.pending = {
      deviceId,
      command,
      claimToken,
      progress: failedProgress,
      result
    };
    await store?.writeExecuted({
      edge_instance_id: this.config.edgeInstanceId,
      device_id: deviceId,
      command,
      progress: failedProgress,
      result
    });
    return await this.deliverPending() ? 'executed' : 'result_pending';
  }

  async close(): Promise<void> {
    const store = this.store || (this.storePromise ? await this.storePromise : null);
    const ownerFence = this.ownerFence ||
      (this.ownerFencePromise ? await this.ownerFencePromise : null);
    await ownerFence?.close();
    await store?.close();
  }

  private async recoverPending(record: RustDeskEdgePendingRecord): Promise<RustDeskEdgeCommandPollResult> {
    const expired = this.store?.isExpired(record) === true;
    let recovered: {
      action: 'resume_report' | 'terminal' | 'quarantine';
      command: { status: string; lease_expires_at?: string | null };
      claim_token?: string;
      result_matches?: boolean;
      reason?: string;
    };
    try {
      recovered = (await this.requestJson(
        `/api/ivekit/rustdesk/devices/${encodeURIComponent(record.device_id)}` +
          `/commands/${encodeURIComponent(record.command.id)}/recover`,
        {
          state: record.state,
          attempt: record.command.attempt,
          lease_ms: this.config.commandLeaseMs,
          ...ownerReport(record.command),
          ...(record.state === 'executed' ? { result: record.result } : {})
        }
      ))!;
    } catch {
      return 'result_pending';
    }
    if (record.state === 'executing') {
      await this.store?.quarantine(
        `${expired ? 'expired_' : ''}${recovered.reason || 'recovery_execution_state_uncertain'}`
      );
      return 'quarantined';
    }
    if (recovered.action === 'terminal' && recovered.result_matches) {
      await this.store?.remove(record.command.id);
      return 'reported';
    }
    if (recovered.action !== 'resume_report' || !recovered.claim_token) {
      await this.store?.quarantine(
        `${expired ? 'expired_' : ''}${recovered.reason || 'recovery_result_conflict'}`
      );
      return 'quarantined';
    }
    this.pending = {
      deviceId: record.device_id,
      command: record.command,
      claimToken: recovered.claim_token,
      progress: [...record.progress],
      result: record.result
    };
    return await this.deliverPending() ? 'reported' : 'result_pending';
  }

  private async deliverPending(): Promise<boolean> {
    const pending = this.pending;
    if (!pending) return true;
    try {
      while (pending.progress.length) {
        await this.postProgress(
          pending.deviceId,
          pending.command,
          pending.claimToken,
          pending.progress[0]
        );
        pending.progress.shift();
      }
      await this.requestJson(
        `/api/ivekit/rustdesk/devices/${encodeURIComponent(pending.deviceId)}` +
          `/commands/${encodeURIComponent(pending.command.id)}/result`,
        {
          claim_token: pending.claimToken,
          ...ownerReport(pending.command),
          ...pending.result
        }
      );
      await this.store?.remove(pending.command.id);
      this.pending = null;
      return true;
    } catch (error) {
      if (error instanceof RustDeskEdgeCommandHttpError && error.status === 409) {
        if (this.store) {
          this.pending = null;
          return false;
        }
        this.pending = null;
        return true;
      }
      return false;
    }
  }

  private async pendingStore(): Promise<RustDeskEdgePendingFileStore | null> {
    if (!this.config.spool) return null;
    if (this.store) return this.store;
    this.storePromise ||= RustDeskEdgePendingFileStore.open(this.config.spool);
    this.store = await this.storePromise;
    return this.store;
  }

  private async epochFence(): Promise<RustDeskOwnerEpochFence | null> {
    if (!this.config.spool) return null;
    if (this.ownerFence) return this.ownerFence;
    this.ownerFencePromise ||= RustDeskOwnerEpochFence.open({
      directory: this.config.spool.directory
    });
    this.ownerFence = await this.ownerFencePromise;
    return this.ownerFence;
  }

  private async postProgress(
    deviceId: string,
    command: RustDeskEdgeSpoolCommand,
    claimToken: string,
    report: RustDeskEdgeCommandProgressReport
  ): Promise<void> {
    await this.requestJson(
      `/api/ivekit/rustdesk/devices/${encodeURIComponent(deviceId)}` +
        `/commands/${encodeURIComponent(command.id)}/progress`,
      {
        claim_token: claimToken,
        ...ownerReport(command),
        ...report
      }
    );
  }

  private async requestJson<T = unknown>(
    path: string,
    body: Record<string, unknown>,
    allowNoContent = false
  ): Promise<T | null> {
    const response = await this.fetchImpl(`${stripTrailingSlash(this.config.baseUrl)}${path}`, {
      method: 'POST',
      headers: {
        'x-rustdesk-edge-token': this.config.commandToken,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (response.status === 204 && allowNoContent) return null;
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      throw new RustDeskEdgeCommandHttpError(
        `RustDesk edge command request failed: POST ${path} ${response.status}`,
        response.status
      );
    }
    return payload as T;
  }
}

class RustDeskEdgeCommandHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'RustDeskEdgeCommandHttpError';
  }
}

export async function executeRustDeskDisconnectCommand(
  command: RustDeskEdgeClaimCommand,
  config: RustDeskEdgeCommandExecutionConfig,
  reportProgress: ProgressReporter = async () => {}
): Promise<RustDeskEdgeCommandExecutionResult> {
  validateExecutionCommand(command);
  const primary = config.disconnectAdapter
    ? await runAdapter(config.disconnectAdapter, command, config.timeoutMs)
    : missingAdapterResult('adapter_not_configured');
  if (primary.ok) {
    return executionResult('succeeded', 'session_adapter', primary, baseMetadata(config));
  }

  const fallbackReason = adapterFailureReason(primary);
  await reportProgress({
    progress: 'session_adapter_failed',
    ...(primary.exitCode === null ? {} : { exit_code: primary.exitCode }),
    duration_ms: primary.durationMs,
    metadata: {
      ...adapterFailureMetadata(primary, fallbackReason),
      precise_disconnect_unavailable: true,
      emergency_fallback_authorized: command.emergency_fallback_authorized
    }
  });
  if (!command.emergency_fallback_authorized) {
    return executionResult('failed', 'session_adapter', primary, {
      ...baseMetadata(config),
      ...adapterFailureMetadata(primary, fallbackReason),
      precise_disconnect_unavailable: true,
      emergency_fallback_authorized: false
    });
  }
  await reportProgress({
    progress: 'fallback_started',
    metadata: {
      fallback_reason: fallbackReason,
      collateral_sessions_may_disconnect: true,
      emergency_fallback_authorized: true,
      emergency_fallback_reason: command.emergency_fallback_reason
    }
  });

  const fallback = config.restartAdapter
    ? await runAdapter(config.restartAdapter, command, config.timeoutMs)
    : missingAdapterResult('restart_not_configured');
  return executionResult(
    fallback.ok ? 'succeeded' : 'failed',
    'service_restart',
    fallback,
    {
      ...baseMetadata(config),
      fallback_reason: fallbackReason,
      collateral_sessions_may_disconnect: true,
      emergency_fallback_authorized: true,
      emergency_fallback_reason: command.emergency_fallback_reason,
      ...(!fallback.ok ? { fallback_result_reason: adapterFailureReason(fallback) } : {}),
      ...(fallback.timedOut ? { timed_out: true } : {}),
      ...(fallback.signal ? { signal: fallback.signal } : {}),
      ...(fallback.errorCode ? { error_code: fallback.errorCode } : {})
    }
  );
}

async function runAdapter(
  adapter: RustDeskEdgeCommandAdapter,
  command: RustDeskEdgeClaimCommand,
  timeoutMs: number
): Promise<LocalAdapterResult> {
  const adapterArgs = materializeAdapterArgs(adapter.args, command);
  const startedAt = Date.now();
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;

  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null, signal = '', errorCode = '') => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      resolve({
        ok: !timedOut && !errorCode && exitCode === 0,
        exitCode,
        durationMs: Date.now() - startedAt,
        stdoutBytes,
        stderrBytes,
        stdoutSha256: `sha256:${stdoutHash.digest('hex')}`,
        stderrSha256: `sha256:${stderrHash.digest('hex')}`,
        timedOut,
        signal,
        errorCode
      });
    };
    let child;
    try {
      child = spawn(adapter.executable, adapterArgs, {
        shell: false,
        env: {
          ...process.env,
          OPC_RUSTDESK_COMMAND_ID: command.id,
          OPC_RUSTDESK_EXTERNAL_ID: command.external_id,
          OPC_RUSTDESK_TARGET_ID: command.target_id,
          OPC_RUSTDESK_RUSTDESK_ID: command.rustdesk_id,
          OPC_RUSTDESK_CONTROLLER_RUSTDESK_ID: command.controller_rustdesk_id,
          OPC_RUSTDESK_NATIVE_SESSION_ID: command.native_session_id || '',
          OPC_RUSTDESK_DISCONNECT_REASON: command.requested_reason,
          OPC_RUSTDESK_NATIVE_CONTROL_PROTOCOL:
            command.native_control_protocol || 'ivekit-rustdesk-native-control-v1',
          OPC_RUSTDESK_INTERACTION_ID: command.interaction_id || '',
          OPC_RUSTDESK_RESERVATION_ID: command.reservation_id || '',
          OPC_RUSTDESK_OWNER_EPOCH: command.owner_epoch || '',
          OPC_RUSTDESK_EMERGENCY_FALLBACK_AUTHORIZED: command.emergency_fallback_authorized ? '1' : '0',
          OPC_RUSTDESK_EMERGENCY_FALLBACK_REASON: command.emergency_fallback_reason
        },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      finish(null, '', spawnErrorCode(error));
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += hashBounded(stdoutHash, chunk, stdoutBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += hashBounded(stderrHash, chunk, stderrBytes);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(null, '', error.code || 'spawn_error');
    });
    child.once('close', (code, signal) => {
      finish(code, signal || '');
    });
    timeout = setTimeout(() => {
      timedOut = true;
      if (!terminateAdapterProcess(child, 'SIGTERM')) {
        finish(null, '', 'timeout_terminate_failed');
        return;
      }
      forceKillTimeout = setTimeout(() => {
        if (settled) return;
        const killed = terminateAdapterProcess(child, 'SIGKILL');
        finish(null, killed ? 'SIGKILL' : '', killed ? '' : 'timeout_force_kill_failed');
      }, adapterTimeoutKillGraceMs);
    }, timeoutMs);
  });
}

function materializeAdapterArgs(
  args: string[],
  command: RustDeskEdgeClaimCommand
): string[] {
  const values: Record<string, string> = {
    '{command_id}': command.id,
    '{external_id}': command.external_id,
    '{target_id}': command.target_id,
    '{rustdesk_id}': command.rustdesk_id,
    '{controller_rustdesk_id}': command.controller_rustdesk_id,
    '{native_session_id}': command.native_session_id || '',
    '{requested_reason}': command.requested_reason,
    '{native_control_protocol}':
      command.native_control_protocol || 'ivekit-rustdesk-native-control-v1',
    '{interaction_id}': command.interaction_id || '',
    '{reservation_id}': command.reservation_id || '',
    '{owner_epoch}': command.owner_epoch || ''
  };
  return args.map((arg) => {
    const placeholders = arg.match(/\{[a-z_]+\}/g) || [];
    if (!placeholders.length) return arg;
    if (placeholders.length !== 1 || arg !== placeholders[0] || !(arg in values)) {
      throw new Error(`unsupported RustDesk adapter placeholder: ${placeholders.join(',') || arg}`);
    }
    return values[arg];
  });
}

function validateExecutionCommand(command: RustDeskEdgeClaimCommand): void {
  for (const [name, value] of [
    ['id', command.id],
    ['external_id', command.external_id],
    ['target_id', command.target_id],
    ['rustdesk_id', command.rustdesk_id],
    ...(command.controller_rustdesk_id
      ? [['controller_rustdesk_id', command.controller_rustdesk_id] as const]
      : [])
  ] as const) {
    if (!/^[A-Za-z0-9._:@/-]{1,256}$/.test(String(value || ''))) {
      throw new Error(`RustDesk command ${name} contains unsupported characters or length`);
    }
  }
  if (!['consent_revoked', 'remote_session_ended', 'tool_ended', 'gateway_ended'].includes(command.requested_reason)) {
    throw new Error('RustDesk command requested_reason is unsupported');
  }
  const protocol = command.native_control_protocol || 'ivekit-rustdesk-native-control-v1';
  if (
    protocol !== 'ivekit-rustdesk-native-control-v1' &&
    protocol !== 'ivekit-rustdesk-native-control-v2'
  ) {
    throw new Error('RustDesk command native_control_protocol is unsupported');
  }
  assertRustDeskOwnerBinding(
    commandOwnerIdentity(command),
    commandOwnerIdentity(command),
    protocol === 'ivekit-rustdesk-native-control-v2'
  );
}

function terminateAdapterProcess(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals
): boolean {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // Fall back to the direct child when process-group signaling is unavailable.
    }
  }
  return child.kill(signal);
}

function spawnErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code?: unknown }).code || 'spawn_error');
  }
  return 'spawn_error';
}

function hashBounded(hash: ReturnType<typeof createHash>, chunk: Buffer, capturedBytes: number): number {
  const remaining = Math.max(0, outputByteCap - capturedBytes);
  if (!remaining) return 0;
  const captured = chunk.subarray(0, remaining);
  hash.update(captured);
  return captured.byteLength;
}

function missingAdapterResult(errorCode: string): LocalAdapterResult {
  const emptyDigest = `sha256:${createHash('sha256').digest('hex')}`;
  return {
    ok: false,
    exitCode: null,
    durationMs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutSha256: emptyDigest,
    stderrSha256: emptyDigest,
    timedOut: false,
    signal: '',
    errorCode
  };
}

function adapterFailureReason(result: LocalAdapterResult): string {
  if (result.errorCode === 'adapter_not_configured') return 'adapter_not_configured';
  if (result.timedOut) return 'adapter_timeout';
  if (result.errorCode) return 'adapter_spawn_error';
  if (result.signal) return 'adapter_signal';
  if (result.exitCode === 20) return 'targeted_disconnect_unavailable';
  if (result.exitCode === 21) return 'service_unavailable';
  return 'adapter_exit_nonzero';
}

function adapterFailureMetadata(
  result: LocalAdapterResult,
  fallbackReason: string
): Record<string, string | number | boolean | null> {
  return {
    fallback_reason: fallbackReason,
    ...(result.timedOut ? { timed_out: true } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.errorCode ? { error_code: result.errorCode } : {})
  };
}

function baseMetadata(
  config: RustDeskEdgeCommandExecutionConfig
): Record<string, string | number | boolean | null> {
  const edgeAgentVersion = String(config.edgeAgentVersion || '').trim();
  return {
    edge_instance_id: config.edgeInstanceId,
    ...(edgeAgentVersion ? { edge_agent_version: edgeAgentVersion } : {}),
    os: config.os
  };
}

function executionResult(
  status: 'succeeded' | 'failed',
  executionMethod: 'session_adapter' | 'service_restart',
  result: LocalAdapterResult,
  metadata: Record<string, string | number | boolean | null>
): RustDeskEdgeCommandExecutionResult {
  return {
    status,
    execution_method: executionMethod,
    ...(result.exitCode === null ? {} : { exit_code: result.exitCode }),
    duration_ms: result.durationMs,
    stdout_bytes: result.stdoutBytes,
    stderr_bytes: result.stderrBytes,
    stdout_sha256: result.stdoutSha256,
    stderr_sha256: result.stderrSha256,
    metadata
  };
}

function rejectedBeforeNativeExecution(
  config: RustDeskEdgeCommandExecutionConfig,
  error: unknown
): RustDeskEdgeCommandExecutionResult {
  const result = missingAdapterResult('owner_epoch_rejected');
  return executionResult('failed', 'session_adapter', result, {
    ...baseMetadata(config),
    error_code: boundedErrorCode(error)
  });
}

function boundedErrorCode(error: unknown): string {
  const value = String((error as Error)?.message || 'owner_epoch_rejected');
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'owner_epoch_rejected';
}

function decodeClaimCommand(
  value: unknown,
  boundValue: unknown,
  placementEnabled: boolean
): RustDeskEdgeClaimCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RustDesk command claim is missing command');
  }
  const command = value as Record<string, unknown>;
  if (command.command_type !== 'disconnect_session') {
    throw new Error('RustDesk edge agent received an unsupported command type');
  }
  const requestedReason = String(command.requested_reason || '') as RustDeskEdgeClaimCommand['requested_reason'];
  if (!['consent_revoked', 'remote_session_ended', 'tool_ended', 'gateway_ended'].includes(requestedReason)) {
    throw new Error('RustDesk edge agent received an unsupported disconnect reason');
  }
  const attempt = Number(command.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('RustDesk command attempt must be a positive integer');
  }
  if (
    command.emergency_fallback_authorized !== undefined &&
    typeof command.emergency_fallback_authorized !== 'boolean'
  ) {
    throw new Error('RustDesk command emergency_fallback_authorized must be a boolean');
  }
  const emergencyFallbackAuthorized = command.emergency_fallback_authorized === true;
  const emergencyFallbackReason = String(command.emergency_fallback_reason || '').trim();
  if (emergencyFallbackAuthorized && (emergencyFallbackReason.length < 8 || emergencyFallbackReason.length > 500)) {
    throw new Error('RustDesk command emergency_fallback_reason must be 8 to 500 characters');
  }
  if (!emergencyFallbackAuthorized && emergencyFallbackReason) {
    throw new Error('RustDesk command emergency fallback reason requires authorization');
  }
  const owner = optionalOwnerIdentity(command);
  const bound = optionalOwnerIdentity(boundValue);
  const protocol = String(
    command.native_control_protocol ||
    (owner ? 'ivekit-rustdesk-native-control-v2' : 'ivekit-rustdesk-native-control-v1')
  );
  if (
    protocol !== 'ivekit-rustdesk-native-control-v1' &&
    protocol !== 'ivekit-rustdesk-native-control-v2'
  ) {
    throw new Error('RustDesk command native_control_protocol is unsupported');
  }
  if (protocol === 'ivekit-rustdesk-native-control-v1' && owner) {
    throw new Error('RustDesk v1 command must not carry an owner binding');
  }
  assertRustDeskOwnerBinding(
    owner,
    bound,
    placementEnabled || protocol === 'ivekit-rustdesk-native-control-v2'
  );
  return {
    id: requiredString(command.id, 'RustDesk command id is required'),
    command_type: 'disconnect_session',
    external_id: requiredString(command.external_id, 'RustDesk command external_id is required'),
    target_id: requiredString(command.target_id, 'RustDesk command target_id is required'),
    rustdesk_id: requiredString(command.rustdesk_id, 'RustDesk command rustdesk_id is required'),
    controller_rustdesk_id: String(command.controller_rustdesk_id || '').trim(),
    ...(protocol === 'ivekit-rustdesk-native-control-v2'
      ? { native_session_id: nativeSessionId(command.native_session_id) }
      : {}),
    requested_reason: requestedReason,
    attempt,
    lease_expires_at: requiredString(command.lease_expires_at, 'RustDesk command lease_expires_at is required'),
    emergency_fallback_authorized: emergencyFallbackAuthorized,
    emergency_fallback_reason: emergencyFallbackReason,
    native_control_protocol: protocol,
    ...(owner || {})
  };
}

function nativeSessionId(value: unknown): string {
  const normalized = requiredString(value, 'RustDesk command native_session_id is required');
  if (!/^[1-9][0-9]{0,18}$/.test(normalized) || BigInt(normalized) > 0x7fffffffffffffffn) {
    throw new Error('RustDesk command native_session_id is invalid');
  }
  return BigInt(normalized).toString();
}

function optionalOwnerIdentity(value: unknown): RustDeskOwnerIdentity | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RustDesk owner binding must be an object');
  }
  const record = value as Record<string, unknown>;
  const present = ['interaction_id', 'reservation_id', 'owner_epoch']
    .filter((field) => record[field] !== undefined);
  if (!present.length) return undefined;
  if (present.length !== 3) throw new Error('RustDesk owner binding is incomplete');
  return {
    interaction_id: requiredString(record.interaction_id, 'RustDesk interaction_id is required'),
    reservation_id: requiredString(record.reservation_id, 'RustDesk reservation_id is required'),
    owner_epoch: ownerEpoch(record.owner_epoch)
  };
}

function commandOwnerIdentity(
  command: RustDeskEdgeClaimCommand | RustDeskEdgeSpoolCommand
): RustDeskOwnerIdentity | undefined {
  return optionalOwnerIdentity(command);
}

function ownerReport(command: RustDeskEdgeSpoolCommand): Record<string, string> {
  const owner = commandOwnerIdentity(command);
  return owner ? { ...owner } : {};
}

function ownerEpoch(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!/^[1-9][0-9]{0,19}$/.test(normalized)) {
    throw new Error('RustDesk command owner_epoch must be a positive decimal integer');
  }
  return BigInt(normalized).toString();
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function stripTrailingSlash(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}
