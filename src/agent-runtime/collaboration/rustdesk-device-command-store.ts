import { createHash, randomBytes } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import { pgId, withPgTransaction } from '../../db-pg.js';
import { RustDeskDeviceStore } from './rustdesk-device-store.js';
import { RustDeskGatewaySessionStore } from './rustdesk-gateway-session-store.js';

export type RustDeskDisconnectReason =
  | 'consent_revoked'
  | 'remote_session_ended'
  | 'tool_ended'
  | 'gateway_ended';

export type RustDeskDeviceCommandStatus = 'pending' | 'claimed' | 'succeeded' | 'failed';

export type RustDeskDisconnectExecutionMethod = 'session_adapter' | 'service_restart';

export interface RustDeskDeviceCommand {
  id: string;
  tenant_id: string;
  device_id: string;
  external_id: string;
  command_type: 'disconnect_session';
  status: RustDeskDeviceCommandStatus;
  requested_by: string;
  requested_reason: RustDeskDisconnectReason;
  attempt_count: number;
  max_attempts: number;
  claimed_by: string;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  execution_method: RustDeskDisconnectExecutionMethod | null;
  exit_code: number | null;
  duration_ms: number | null;
  stdout_bytes: number | null;
  stderr_bytes: number | null;
  stdout_sha256: string;
  stderr_sha256: string;
  result_metadata: Record<string, unknown>;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface EnqueueRustDeskDisconnectInput {
  tenant_id: string;
  device_id: string;
  external_id: string;
  requested_by: string;
  requested_reason: RustDeskDisconnectReason;
}

export interface ClaimRustDeskDeviceCommandInput {
  tenant_id: string;
  device_id: string;
  edge_instance_id: string;
  lease_ms: number;
  now?: string;
}

export interface ClaimedRustDeskDeviceCommand {
  command: RustDeskDeviceCommand;
  claim_token: string;
}

export type RustDeskDeviceCommandProgress = 'session_adapter_failed' | 'fallback_started';

interface RustDeskDeviceCommandClaimIdentity {
  tenant_id: string;
  device_id: string;
  command_id: string;
  claim_token: string;
  now?: string;
}

export interface RecordRustDeskDeviceCommandProgressInput extends RustDeskDeviceCommandClaimIdentity {
  progress: RustDeskDeviceCommandProgress;
  exit_code?: number;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
}

export interface CompleteRustDeskDeviceCommandInput extends RustDeskDeviceCommandClaimIdentity {
  status: 'succeeded' | 'failed';
  execution_method: RustDeskDisconnectExecutionMethod;
  exit_code?: number;
  duration_ms?: number;
  stdout_bytes?: number;
  stderr_bytes?: number;
  stdout_sha256?: string;
  stderr_sha256?: string;
  metadata?: Record<string, unknown>;
}

const disconnectReasons = new Set<RustDeskDisconnectReason>([
  'consent_revoked',
  'remote_session_ended',
  'tool_ended',
  'gateway_ended'
]);

const resultMetadataFields = new Set([
  'fallback_reason',
  'edge_agent_version',
  'edge_instance_id',
  'os',
  'collateral_sessions_may_disconnect',
  'timed_out',
  'signal',
  'error_code'
]);
const fallbackReasons = new Set([
  'adapter_not_configured',
  'adapter_timeout',
  'adapter_spawn_error',
  'adapter_signal',
  'adapter_exit_nonzero'
]);
const supportedOperatingSystems = new Set([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'windows'
]);

const retryDelaysMs = [2_000, 10_000] as const;

export class RustDeskDeviceCommandStore {
  private readonly devices: RustDeskDeviceStore;
  private readonly sessions: RustDeskGatewaySessionStore;

  constructor(private readonly pg: PgQueryable) {
    this.devices = new RustDeskDeviceStore(pg);
    this.sessions = new RustDeskGatewaySessionStore(pg);
  }

  async enqueueDisconnect(input: EnqueueRustDeskDisconnectInput): Promise<RustDeskDeviceCommand> {
    const tenantId = requiredString(input.tenant_id, 'tenant_id is required');
    const deviceId = requiredString(input.device_id, 'device_id is required');
    const externalId = requiredString(input.external_id, 'external_id is required');
    const requestedBy = requiredString(input.requested_by, 'requested_by is required');
    const requestedReason = rustDeskDisconnectReason(input.requested_reason);
    const existing = await this.getByExternalId({ tenant_id: tenantId, external_id: externalId });
    if (existing) return existing;

    const [device, session] = await Promise.all([
      this.devices.getDevice({ tenant_id: tenantId, device_id: deviceId }),
      this.sessions.getSession(externalId)
    ]);
    if (!device) throw Object.assign(new Error('rustdesk device not found'), { status: 404 });
    if (!session || session.tenant_id !== tenantId) {
      throw Object.assign(new Error('rustdesk gateway session not found'), { status: 404 });
    }
    if (String(session.metadata.rustdesk_device_id || '').trim() !== deviceId) {
      throw Object.assign(new Error('rustdesk gateway session device mismatch'), { status: 409 });
    }

    await this.pg.query(
      `INSERT INTO rustdesk_device_commands
        (id, tenant_id, device_id, external_id, command_type, status, requested_by, requested_reason)
       VALUES ($1, $2, $3, $4, 'disconnect_session', 'pending', $5, $6)
       ON CONFLICT (tenant_id, external_id, command_type) DO NOTHING`,
      [pgId('rdcmd'), tenantId, deviceId, externalId, requestedBy, requestedReason]
    );
    const command = await this.getByExternalId({ tenant_id: tenantId, external_id: externalId });
    if (!command) throw new Error('rustdesk disconnect command was not persisted');
    await this.appendAuditEvent(
      command,
      'remote.rustdesk.disconnect.requested',
      command.requested_by,
      'requested',
      {}
    );
    return command;
  }

  async getByExternalId(input: {
    tenant_id: string;
    external_id: string;
    now?: string;
  }): Promise<RustDeskDeviceCommand | null> {
    const tenantId = requiredString(input.tenant_id, 'tenant_id is required');
    const externalId = requiredString(input.external_id, 'external_id is required');
    const now = isoTimestamp(input.now, 'now must be an ISO timestamp');
    let result = await this.pg.query(
      `SELECT * FROM rustdesk_device_commands
       WHERE tenant_id = $1 AND external_id = $2 AND command_type = 'disconnect_session'
       LIMIT 1`,
      [tenantId, externalId]
    );
    const row = result.rows[0];
    if (row && exhaustedClaimExpired(row, now)) {
      await this.failExpiredExhaustedClaims(tenantId, String(row.device_id), now);
      result = await this.pg.query(
        `SELECT * FROM rustdesk_device_commands
         WHERE tenant_id = $1 AND external_id = $2 AND command_type = 'disconnect_session'
         LIMIT 1`,
        [tenantId, externalId]
      );
    }
    return result.rows[0] ? decodeCommand(result.rows[0]) : null;
  }

  async claimNext(input: ClaimRustDeskDeviceCommandInput): Promise<ClaimedRustDeskDeviceCommand | null> {
    const tenantId = requiredString(input.tenant_id, 'tenant_id is required');
    const deviceId = requiredString(input.device_id, 'device_id is required');
    const edgeInstanceId = requiredString(input.edge_instance_id, 'edge_instance_id is required');
    const leaseMs = commandLeaseMs(input.lease_ms);
    const now = isoTimestamp(input.now, 'now must be an ISO timestamp');
    const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString();
    await this.failExpiredExhaustedClaims(tenantId, deviceId, now);
    const claimToken = randomBytes(32).toString('base64url');
    const claimTokenHash = sha256(claimToken);
    const result = await this.pg.query(
      `UPDATE rustdesk_device_commands
       SET status = 'claimed',
           attempt_count = attempt_count + 1,
           claimed_by = $3,
           claim_token_hash = $4,
           lease_expires_at = $5,
           next_attempt_at = NULL,
           started_at = COALESCE(started_at, $6),
           updated_at = $6
       WHERE id = (
         SELECT id FROM rustdesk_device_commands
         WHERE tenant_id = $1
           AND device_id = $2
           AND attempt_count < max_attempts
           AND (
             (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $6))
             OR (status = 'claimed' AND lease_expires_at <= $6)
           )
         ORDER BY requested_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [tenantId, deviceId, edgeInstanceId, claimTokenHash, leaseExpiresAt, now]
    );
    if (!result.rows[0]) return null;
    const command = decodeCommand(result.rows[0]);
    await this.appendAuditEvent(
      command,
      'remote.rustdesk.disconnect.claimed',
      edgeInstanceId,
      `claimed:${command.attempt_count}`,
      { edge_instance_id: edgeInstanceId }
    );
    return {
      command,
      claim_token: claimToken
    };
  }

  private async failExpiredExhaustedClaims(
    tenantId: string,
    deviceId: string,
    now: string
  ): Promise<void> {
    await withPgTransaction(this.pg, async (pg) => {
      const result = await pg.query(
        `UPDATE rustdesk_device_commands
         SET status = 'failed',
             claim_token_hash = NULL,
             lease_expires_at = NULL,
             next_attempt_at = NULL,
             execution_method = NULL,
             exit_code = NULL,
             duration_ms = NULL,
             stdout_bytes = NULL,
             stderr_bytes = NULL,
             stdout_sha256 = NULL,
             stderr_sha256 = NULL,
             result_metadata = $4,
             completed_at = $3,
             updated_at = $3
         WHERE tenant_id = $1
           AND device_id = $2
           AND status = 'claimed'
           AND attempt_count >= max_attempts
           AND lease_expires_at <= $3
         RETURNING *`,
        [tenantId, deviceId, now, JSON.stringify({ error_code: 'claim_lease_expired' })]
      );
      for (const row of result.rows) {
        await this.appendCompletionAudit(decodeCommand(row), pg);
      }
    });
  }

  async recordProgress(input: RecordRustDeskDeviceCommandProgressInput): Promise<RustDeskDeviceCommand> {
    const identity = commandClaimIdentity(input);
    const progress = commandProgress(input.progress);
    const exitCode = optionalInteger(input.exit_code, 'exit_code must be an integer');
    const durationMs = optionalNonNegativeInteger(input.duration_ms, 'duration_ms must be a non-negative integer');
    const metadata = commandResultMetadata(input.metadata);
    const row = await this.requireValidClaim(identity);
    const command = decodeCommand(row);
    const eventType = progress === 'session_adapter_failed'
      ? 'remote.rustdesk.disconnect.session_adapter_failed'
      : 'remote.rustdesk.disconnect.fallback_started';
    await this.appendAuditEvent(
      command,
      eventType,
      command.claimed_by,
      `${progress}:${command.attempt_count}`,
      {
        ...(exitCode === null ? {} : { exit_code: exitCode }),
        ...(durationMs === null ? {} : { duration_ms: durationMs }),
        ...metadata
      }
    );
    return command;
  }

  async complete(input: CompleteRustDeskDeviceCommandInput): Promise<RustDeskDeviceCommand> {
    return withPgTransaction(this.pg, async (pg) => {
      const store = pg === this.pg ? this : new RustDeskDeviceCommandStore(pg);
      return store.completeInTransaction(input);
    });
  }

  private async completeInTransaction(
    input: CompleteRustDeskDeviceCommandInput
  ): Promise<RustDeskDeviceCommand> {
    const identity = commandClaimIdentity(input);
    const status = commandResultStatus(input.status);
    const executionMethod = commandExecutionMethod(input.execution_method);
    const exitCode = optionalInteger(input.exit_code, 'exit_code must be an integer');
    const durationMs = optionalNonNegativeInteger(input.duration_ms, 'duration_ms must be a non-negative integer');
    const stdoutBytes = optionalNonNegativeInteger(input.stdout_bytes, 'stdout_bytes must be a non-negative integer');
    const stderrBytes = optionalNonNegativeInteger(input.stderr_bytes, 'stderr_bytes must be a non-negative integer');
    const stdoutSha256 = optionalSha256(input.stdout_sha256, 'stdout_sha256');
    const stderrSha256 = optionalSha256(input.stderr_sha256, 'stderr_sha256');
    const metadata = commandResultMetadata(input.metadata);
    const row = await this.getScopedRow(identity);
    if (!row) throw Object.assign(new Error('rustdesk command not found'), { status: 404 });
    if (!claimTokenMatches(row, identity.claim_token)) {
      throw invalidClaimError();
    }
    if (row.status === 'succeeded' || row.status === 'failed') {
      if (!completedResultMatches(row, {
        status,
        executionMethod,
        exitCode,
        durationMs,
        stdoutBytes,
        stderrBytes,
        stdoutSha256,
        stderrSha256,
        metadata
      })) {
        throw Object.assign(new Error('rustdesk command is already completed with a different result'), { status: 409 });
      }
      const completed = decodeCommand(row);
      await this.appendCompletionAudit(completed);
      return completed;
    }
    assertClaimActive(row, identity.now);

    const attemptCount = Number(row.attempt_count || 0);
    const maxAttempts = Number(row.max_attempts || 3);
    const shouldRetry = status === 'failed' && attemptCount < maxAttempts;
    const nextAttemptAt = shouldRetry
      ? new Date(new Date(identity.now).getTime() + retryDelaysMs[Math.min(attemptCount - 1, retryDelaysMs.length - 1)]).toISOString()
      : null;
    const params = [
      identity.tenant_id,
      identity.device_id,
      identity.command_id,
      sha256(identity.claim_token),
      nextAttemptAt,
      executionMethod,
      exitCode,
      durationMs,
      stdoutBytes,
      stderrBytes,
      stdoutSha256,
      stderrSha256,
      JSON.stringify(metadata),
      identity.now
    ];
    const result = shouldRetry
      ? await this.pg.query(
        `UPDATE rustdesk_device_commands
         SET status = 'pending',
             claimed_by = NULL,
             claim_token_hash = NULL,
             lease_expires_at = NULL,
             next_attempt_at = $5,
             execution_method = $6,
             exit_code = $7,
             duration_ms = $8,
             stdout_bytes = $9,
             stderr_bytes = $10,
             stdout_sha256 = $11,
             stderr_sha256 = $12,
             result_metadata = $13,
             updated_at = $14
         WHERE tenant_id = $1 AND device_id = $2 AND id = $3
           AND status = 'claimed' AND claim_token_hash = $4 AND lease_expires_at > $14
         RETURNING *`,
        params
      )
      : await this.pg.query(
        `UPDATE rustdesk_device_commands
         SET status = $5,
             lease_expires_at = NULL,
             next_attempt_at = NULL,
             execution_method = $6,
             exit_code = $7,
             duration_ms = $8,
             stdout_bytes = $9,
             stderr_bytes = $10,
             stdout_sha256 = $11,
             stderr_sha256 = $12,
             result_metadata = $13,
             completed_at = $14,
             updated_at = $14
         WHERE tenant_id = $1 AND device_id = $2 AND id = $3
           AND status = 'claimed' AND claim_token_hash = $4 AND lease_expires_at > $14
         RETURNING *`,
        [params[0], params[1], params[2], params[3], status, ...params.slice(5)]
      );
    if (!result.rows[0]) {
      const concurrent = await this.getScopedRow(identity);
      if (
        concurrent &&
        claimTokenMatches(concurrent, identity.claim_token) &&
        (concurrent.status === 'succeeded' || concurrent.status === 'failed') &&
        completedResultMatches(concurrent, {
          status,
          executionMethod,
          exitCode,
          durationMs,
          stdoutBytes,
          stderrBytes,
          stdoutSha256,
          stderrSha256,
          metadata
        })
      ) {
        const completed = decodeCommand(concurrent);
        await this.appendCompletionAudit(completed);
        return completed;
      }
      throw invalidClaimError();
    }
    const command = decodeCommand(result.rows[0]);
    if (!shouldRetry) await this.appendCompletionAudit(command);
    return command;
  }

  private async getScopedRow(input: {
    tenant_id: string;
    device_id: string;
    command_id: string;
  }): Promise<Record<string, unknown> | null> {
    const result = await this.pg.query(
      `SELECT * FROM rustdesk_device_commands
       WHERE tenant_id = $1 AND device_id = $2 AND id = $3
       LIMIT 1`,
      [input.tenant_id, input.device_id, input.command_id]
    );
    return result.rows[0] || null;
  }

  private async requireValidClaim(input: Required<RustDeskDeviceCommandClaimIdentity>): Promise<Record<string, unknown>> {
    const row = await this.getScopedRow(input);
    if (!row) throw Object.assign(new Error('rustdesk command not found'), { status: 404 });
    if (!claimTokenMatches(row, input.claim_token)) throw invalidClaimError();
    assertClaimActive(row, input.now);
    return row;
  }

  private async appendCompletionAudit(
    command: RustDeskDeviceCommand,
    pg: PgQueryable = this.pg
  ): Promise<void> {
    const succeeded = command.status === 'succeeded';
    await this.appendAuditEvent(
      command,
      succeeded ? 'remote.rustdesk.disconnect.succeeded' : 'remote.rustdesk.disconnect.failed',
      command.claimed_by,
      `${command.status}:${command.attempt_count}`,
      {
        execution_method: command.execution_method,
        exit_code: command.exit_code,
        duration_ms: command.duration_ms,
        stdout_bytes: command.stdout_bytes,
        stderr_bytes: command.stderr_bytes,
        stdout_sha256: command.stdout_sha256,
        stderr_sha256: command.stderr_sha256,
        ...command.result_metadata
      },
      pg
    );
  }

  private async appendAuditEvent(
    command: RustDeskDeviceCommand,
    eventType: string,
    actorIdentity: string,
    idempotencySuffix: string,
    metadata: Record<string, unknown>,
    pg: PgQueryable = this.pg
  ): Promise<void> {
    const idempotencyKey = `disconnect:${command.id}:${idempotencySuffix}`;
    await pg.query(
      `INSERT INTO rustdesk_gateway_events
        (id, external_id, tenant_id, event_type, actor_identity, target, idempotency_key, metadata, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (external_id, idempotency_key)
       WHERE idempotency_key <> ''
       DO NOTHING`,
      [
        pgId('rdgev'),
        command.external_id,
        command.tenant_id,
        eventType,
        actorIdentity,
        command.device_id,
        idempotencyKey,
        JSON.stringify({
          command_id: command.id,
          device_id: command.device_id,
          external_id: command.external_id,
          attempt: command.attempt_count,
          requested_reason: command.requested_reason,
          ...metadata
        }),
        new Date().toISOString()
      ]
    );
  }
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw Object.assign(new Error(message), { status: 400 });
  return normalized;
}

export function rustDeskDisconnectReason(value: unknown): RustDeskDisconnectReason {
  const normalized = String(value || '').trim() as RustDeskDisconnectReason;
  if (!disconnectReasons.has(normalized)) {
    throw Object.assign(new Error('unsupported rustdesk disconnect reason'), { status: 400 });
  }
  return normalized;
}

function commandLeaseMs(value: unknown): number {
  const leaseMs = Number(value);
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
    throw Object.assign(new Error('lease_ms must be an integer from 1000 to 300000'), { status: 400 });
  }
  return leaseMs;
}

function commandClaimIdentity(input: RustDeskDeviceCommandClaimIdentity): Required<RustDeskDeviceCommandClaimIdentity> {
  return {
    tenant_id: requiredString(input.tenant_id, 'tenant_id is required'),
    device_id: requiredString(input.device_id, 'device_id is required'),
    command_id: requiredString(input.command_id, 'command_id is required'),
    claim_token: requiredString(input.claim_token, 'claim_token is required'),
    now: isoTimestamp(input.now, 'now must be an ISO timestamp')
  };
}

function commandProgress(value: unknown): RustDeskDeviceCommandProgress {
  if (value === 'session_adapter_failed' || value === 'fallback_started') return value;
  throw Object.assign(new Error('unsupported rustdesk command progress'), { status: 400 });
}

function commandResultStatus(value: unknown): CompleteRustDeskDeviceCommandInput['status'] {
  if (value === 'succeeded' || value === 'failed') return value;
  throw Object.assign(new Error('rustdesk command status must be succeeded or failed'), { status: 400 });
}

function commandExecutionMethod(value: unknown): RustDeskDisconnectExecutionMethod {
  if (value === 'session_adapter' || value === 'service_restart') return value;
  throw Object.assign(new Error('unsupported rustdesk command execution_method'), { status: 400 });
}

function optionalInteger(value: unknown, message: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number)) throw Object.assign(new Error(message), { status: 400 });
  return number;
}

function optionalNonNegativeInteger(value: unknown, message: string): number | null {
  const number = optionalInteger(value, message);
  if (number !== null && number < 0) throw Object.assign(new Error(message), { status: 400 });
  return number;
}

function optionalSha256(value: unknown, field: string): string {
  const digest = String(value || '').trim().toLowerCase();
  if (!digest) return '';
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw Object.assign(new Error(`${field} must be a sha256 digest`), { status: 400 });
  }
  return digest;
}

function commandResultMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('rustdesk command metadata must be a JSON object'), { status: 400 });
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!resultMetadataFields.has(key)) {
      throw Object.assign(new Error(`unsupported rustdesk command metadata field: ${key}`), { status: 400 });
    }
    validateCommandMetadataField(key, fieldValue);
  }
  return value;
}

function validateCommandMetadataField(key: string, value: unknown): void {
  if (key === 'collateral_sessions_may_disconnect' || key === 'timed_out') {
    if (typeof value !== 'boolean') metadataError(key, 'must be a boolean');
    return;
  }
  const text = typeof value === 'string' ? value.trim() : '';
  if (key === 'fallback_reason') {
    if (!fallbackReasons.has(text)) metadataError(key, 'must be a supported fallback reason');
    return;
  }
  if (key === 'os') {
    if (!supportedOperatingSystems.has(text)) metadataError(key, 'must be a supported operating system');
    return;
  }
  if (key === 'edge_agent_version') {
    if (!/^[a-zA-Z0-9._+-]{1,64}$/.test(text)) {
      metadataError(key, 'must contain 1 to 64 version characters');
    }
    return;
  }
  if (key === 'edge_instance_id') {
    if (!text || text.length > 200 || /[\r\n]/.test(text)) {
      metadataError(key, 'must contain 1 to 200 single-line characters');
    }
    return;
  }
  if (key === 'signal') {
    if (!/^[A-Z0-9_]{1,32}$/.test(text)) metadataError(key, 'must be a valid process signal');
    return;
  }
  if (key === 'error_code') {
    if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(text)) metadataError(key, 'must be a bounded error code');
  }
}

function metadataError(key: string, message: string): never {
  throw Object.assign(new Error(`rustdesk command metadata.${key} ${message}`), { status: 400 });
}

function claimTokenMatches(row: Record<string, unknown>, claimToken: string): boolean {
  const storedHash = String(row.claim_token_hash || '');
  return Boolean(storedHash) && storedHash === sha256(claimToken);
}

function assertClaimActive(row: Record<string, unknown>, now: string): void {
  const leaseExpiresAt = timestampMilliseconds(row.lease_expires_at);
  if (
    row.status !== 'claimed' ||
    leaseExpiresAt === null ||
    leaseExpiresAt <= new Date(now).getTime()
  ) {
    throw invalidClaimError();
  }
}

function exhaustedClaimExpired(row: Record<string, unknown>, now: string): boolean {
  const leaseExpiresAt = timestampMilliseconds(row.lease_expires_at);
  return row.status === 'claimed' &&
    Number(row.attempt_count || 0) >= Number(row.max_attempts || 3) &&
    leaseExpiresAt !== null &&
    leaseExpiresAt <= new Date(now).getTime();
}

function invalidClaimError(): Error {
  return Object.assign(new Error('command claim token is invalid or expired'), { status: 409 });
}

function completedResultMatches(
  row: Record<string, unknown>,
  result: {
    status: 'succeeded' | 'failed';
    executionMethod: RustDeskDisconnectExecutionMethod;
    exitCode: number | null;
    durationMs: number | null;
    stdoutBytes: number | null;
    stderrBytes: number | null;
    stdoutSha256: string;
    stderrSha256: string;
    metadata: Record<string, unknown>;
  }
): boolean {
  return row.status === result.status &&
    String(row.execution_method || '') === result.executionMethod &&
    nullableNumber(row.exit_code) === result.exitCode &&
    nullableNumber(row.duration_ms) === result.durationMs &&
    nullableNumber(row.stdout_bytes) === result.stdoutBytes &&
    nullableNumber(row.stderr_bytes) === result.stderrBytes &&
    String(row.stdout_sha256 || '') === result.stdoutSha256 &&
    String(row.stderr_sha256 || '') === result.stderrSha256 &&
    JSON.stringify(jsonObject(row.result_metadata)) === JSON.stringify(result.metadata);
}

function isoTimestamp(value: string | undefined, message: string): string {
  if (value === undefined) return new Date().toISOString();
  const normalized = String(value).trim();
  if (!normalized || Number.isNaN(new Date(normalized).getTime())) {
    throw Object.assign(new Error(message), { status: 400 });
  }
  return new Date(normalized).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeCommand(row: Record<string, unknown>): RustDeskDeviceCommand {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    device_id: String(row.device_id),
    external_id: String(row.external_id),
    command_type: 'disconnect_session',
    status: String(row.status || 'pending') as RustDeskDeviceCommandStatus,
    requested_by: String(row.requested_by || ''),
    requested_reason: String(row.requested_reason || '') as RustDeskDisconnectReason,
    attempt_count: Number(row.attempt_count || 0),
    max_attempts: Number(row.max_attempts || 3),
    claimed_by: String(row.claimed_by || ''),
    lease_expires_at: nullableTimestamp(row.lease_expires_at),
    next_attempt_at: nullableTimestamp(row.next_attempt_at),
    execution_method: row.execution_method
      ? String(row.execution_method) as RustDeskDisconnectExecutionMethod
      : null,
    exit_code: nullableNumber(row.exit_code),
    duration_ms: nullableNumber(row.duration_ms),
    stdout_bytes: nullableNumber(row.stdout_bytes),
    stderr_bytes: nullableNumber(row.stderr_bytes),
    stdout_sha256: String(row.stdout_sha256 || ''),
    stderr_sha256: String(row.stderr_sha256 || ''),
    result_metadata: jsonObject(row.result_metadata),
    requested_at: timestampString(row.requested_at),
    started_at: nullableTimestamp(row.started_at),
    completed_at: nullableTimestamp(row.completed_at),
    updated_at: timestampString(row.updated_at)
  };
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : timestampString(value);
}

function timestampString(value: unknown): string {
  const milliseconds = timestampMilliseconds(value);
  if (milliseconds === null) throw new Error('rustdesk command timestamp is invalid');
  return new Date(milliseconds).toISOString();
}

function timestampMilliseconds(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const milliseconds = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isNaN(milliseconds) ? null : milliseconds;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined || value === '' ? null : Number(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(value || '{}')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
