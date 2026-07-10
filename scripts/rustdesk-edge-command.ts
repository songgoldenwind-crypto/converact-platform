import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export interface RustDeskEdgeClaimCommand {
  id: string;
  command_type: 'disconnect_session';
  external_id: string;
  target_id: string;
  rustdesk_id: string;
  requested_reason: 'consent_revoked' | 'remote_session_ended' | 'tool_ended' | 'gateway_ended';
  attempt: number;
  lease_expires_at: string;
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
}

export type RustDeskEdgeCommandPollResult = 'idle' | 'executed' | 'result_pending' | 'reported';

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
  command: RustDeskEdgeClaimCommand;
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

  constructor(
    private readonly config: RustDeskEdgeCommandProcessorConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async pollOnce(deviceIdValue: string): Promise<RustDeskEdgeCommandPollResult> {
    const deviceId = requiredString(deviceIdValue, 'deviceId is required');
    if (this.pending) {
      return await this.deliverPending() ? 'reported' : 'result_pending';
    }

    const claim = await this.requestJson<{
      command?: unknown;
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
    const command = decodeClaimCommand(claim.command);
    const claimToken = requiredString(claim.claim_token, 'RustDesk command claim_token is required');
    const failedProgress: RustDeskEdgeCommandProgressReport[] = [];
    const result = await executeRustDeskDisconnectCommand(
      command,
      this.config.execution,
      async (report) => {
        try {
          await this.postProgress(deviceId, command.id, claimToken, report);
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
    return await this.deliverPending() ? 'executed' : 'result_pending';
  }

  private async deliverPending(): Promise<boolean> {
    const pending = this.pending;
    if (!pending) return true;
    try {
      while (pending.progress.length) {
        await this.postProgress(
          pending.deviceId,
          pending.command.id,
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
          ...pending.result
        }
      );
      this.pending = null;
      return true;
    } catch (error) {
      if (error instanceof RustDeskEdgeCommandHttpError && error.status === 409) {
        this.pending = null;
        return true;
      }
      return false;
    }
  }

  private async postProgress(
    deviceId: string,
    commandId: string,
    claimToken: string,
    report: RustDeskEdgeCommandProgressReport
  ): Promise<void> {
    await this.requestJson(
      `/api/ivekit/rustdesk/devices/${encodeURIComponent(deviceId)}` +
        `/commands/${encodeURIComponent(commandId)}/progress`,
      {
        claim_token: claimToken,
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
    metadata: adapterFailureMetadata(primary, fallbackReason)
  });
  await reportProgress({
    progress: 'fallback_started',
    metadata: {
      fallback_reason: fallbackReason,
      collateral_sessions_may_disconnect: true
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
      child = spawn(adapter.executable, adapter.args, {
        shell: false,
        env: {
          ...process.env,
          OPC_RUSTDESK_COMMAND_ID: command.id,
          OPC_RUSTDESK_EXTERNAL_ID: command.external_id,
          OPC_RUSTDESK_TARGET_ID: command.target_id,
          OPC_RUSTDESK_DISCONNECT_REASON: command.requested_reason
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

function decodeClaimCommand(value: unknown): RustDeskEdgeClaimCommand {
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
  return {
    id: requiredString(command.id, 'RustDesk command id is required'),
    command_type: 'disconnect_session',
    external_id: requiredString(command.external_id, 'RustDesk command external_id is required'),
    target_id: requiredString(command.target_id, 'RustDesk command target_id is required'),
    rustdesk_id: requiredString(command.rustdesk_id, 'RustDesk command rustdesk_id is required'),
    requested_reason: requestedReason,
    attempt,
    lease_expires_at: requiredString(command.lease_expires_at, 'RustDesk command lease_expires_at is required')
  };
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function stripTrailingSlash(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}
