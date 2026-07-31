import { createHash, randomBytes } from 'node:crypto';

import { pgId, type PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import type { IveKitMediaCallSnapshot } from './types.js';

export type MediaCallCreateCommandState =
  | 'pending'
  | 'succeeded'
  | 'retryable_failed'
  | 'terminal_failed';

export interface MediaCallCreateCommand {
  tenant_id: string;
  call_id: string;
  idempotency_key_hash: string;
  payload_hash: string;
  requester_identity_hash: string;
  state: MediaCallCreateCommandState;
  attempt_generation: number;
  lease_until: string | null;
  result_snapshot: IveKitMediaCallSnapshot | null;
  error_code: string;
  error_status: number;
  error_retryable: boolean;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  expires_at: string;
}

export interface MediaCallCreateCommandClaim {
  command: MediaCallCreateCommand;
  replayed: boolean;
  attempt: MediaCallCreateAttempt | null;
}

export interface MediaCallCreateAttempt {
  generation: number;
  token: string;
  lease_until: string;
}

export type MediaCallCreateCommandErrorCode =
  | 'idempotency_key_required'
  | 'idempotency_key_invalid'
  | 'idempotency_conflict'
  | 'create_payload_invalid'
  | 'create_command_not_found'
  | 'create_command_reload_failed'
  | 'media_call_create_frozen'
  | 'media_call_create_in_progress'
  | 'attempt_fenced';

export class MediaCallCreateCommandError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number;

  constructor(
    code: string,
    status: number,
    retryable = false,
    retryAfterSeconds = 0
  ) {
    super(code);
    this.name = 'MediaCallCreateCommandError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface MediaCallCreateCommandStoreOptions {
  callId?: () => string;
  attemptToken?: () => string;
  attemptLeaseMs?: number;
  retentionMs?: number;
  cleanupBatchSize?: number;
  cleanupSelector?: (idempotencyKeyHash: string) => boolean;
}

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;
const ATTEMPT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const REQUEST_MAX_BYTES = 256 * 1024;
const SNAPSHOT_MAX_BYTES = 1024 * 1024;
const JSON_MAX_DEPTH = 32;
const JSON_MAX_NODES = 20_000;
const MIN_ATTEMPT_LEASE_MS = 1_000;
const MAX_ATTEMPT_LEASE_MS = 60_000;
const DEFAULT_ATTEMPT_LEASE_MS = 15_000;
const MIN_RETENTION_MS = 60 * 60 * 1_000;
const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MIN_CLEANUP_BATCH_SIZE = 1;
const MAX_CLEANUP_BATCH_SIZE = 128;
const DEFAULT_CLEANUP_BATCH_SIZE = 32;

export class MediaCallCreateCommandStore {
  readonly #callId: () => string;
  readonly #attemptToken: () => string;
  readonly #attemptLeaseMs: number;
  readonly #retentionMs: number;
  readonly #cleanupBatchSize: number;
  readonly #cleanupSelector: (idempotencyKeyHash: string) => boolean;

  constructor(
    private readonly pg: PgQueryable,
    options: MediaCallCreateCommandStoreOptions = {}
  ) {
    this.#callId = options.callId ?? (() => pgId('mcall'));
    this.#attemptToken = options.attemptToken ??
      (() => randomBytes(32).toString('base64url'));
    const leaseMs = options.attemptLeaseMs ?? DEFAULT_ATTEMPT_LEASE_MS;
    if (!Number.isInteger(leaseMs) ||
        leaseMs < MIN_ATTEMPT_LEASE_MS ||
        leaseMs > MAX_ATTEMPT_LEASE_MS) {
      throw new MediaCallCreateCommandError('create_payload_invalid', 400);
    }
    this.#attemptLeaseMs = leaseMs;
    const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    if (!Number.isSafeInteger(retentionMs) ||
        retentionMs < MIN_RETENTION_MS ||
        retentionMs > MAX_RETENTION_MS) {
      throw new MediaCallCreateCommandError('create_payload_invalid', 400);
    }
    this.#retentionMs = retentionMs;
    const cleanupBatchSize =
      options.cleanupBatchSize ?? DEFAULT_CLEANUP_BATCH_SIZE;
    if (!Number.isInteger(cleanupBatchSize) ||
        cleanupBatchSize < MIN_CLEANUP_BATCH_SIZE ||
        cleanupBatchSize > MAX_CLEANUP_BATCH_SIZE) {
      throw new MediaCallCreateCommandError('create_payload_invalid', 400);
    }
    this.#cleanupBatchSize = cleanupBatchSize;
    this.#cleanupSelector = options.cleanupSelector ??
      ((keyHash) => Number.parseInt(keyHash.slice(0, 2), 16) === 0);
  }

  async claim(input: {
    tenant_id: string;
    idempotency_key: string;
    payload: Record<string, unknown>;
  }): Promise<MediaCallCreateCommandClaim> {
    const tenantId = identifier(input.tenant_id, 'create_payload_invalid');
    const idempotencyKey = requiredIdempotencyKey(input.idempotency_key);
    const requestPayload = canonicalJsonObject(input.payload, REQUEST_MAX_BYTES);
    const idempotencyKeyHash = hash(
      'ivekit-media-call-create-key-v1',
      tenantId,
      idempotencyKey
    );
    const payloadHash = hash(
      'ivekit-media-call-create-payload-v1',
      tenantId,
      requestPayload.json
    );
    const requesterIdentity = requiredRequesterIdentity(
      requestPayload.value.initiated_by
    );
    const requesterIdentityHash = hash(
      'ivekit-media-call-create-requester-v1',
      tenantId,
      requesterIdentity
    );
    const callId = identifier(this.#callId(), 'create_payload_invalid');
    const initialToken = attemptToken(this.#attemptToken());
    const initialTokenHash = attemptTokenHash(
      tenantId,
      callId,
      1,
      initialToken
    );

    return withPgTenant(this.pg, tenantId, async (pg) => {
      if (this.#cleanupSelector(idempotencyKeyHash)) {
        await pruneExpired(
          pg,
          tenantId,
          this.#cleanupBatchSize
        );
      }
      const inserted = await pg.query<Record<string, unknown>>(
        `INSERT INTO ivekit_media_call_create_commands
          (call_id, tenant_id, idempotency_key_hash, payload_hash,
           requester_identity_hash, attempt_token_hash, lease_until, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6,
                 clock_timestamp() + ($7::bigint * interval '1 millisecond'),
                 clock_timestamp() + ($8::bigint * interval '1 millisecond'))
         ON CONFLICT (tenant_id, idempotency_key_hash) DO UPDATE
         SET call_id = EXCLUDED.call_id,
             payload_hash = EXCLUDED.payload_hash,
             requester_identity_hash = EXCLUDED.requester_identity_hash,
             state = 'pending', attempt_generation = 1,
             attempt_token_hash = EXCLUDED.attempt_token_hash,
             lease_until = EXCLUDED.lease_until,
             result_snapshot = NULL, error_code = '', error_status = 0,
             error_retryable = FALSE, next_retry_at = NULL,
             created_at = clock_timestamp(),
             updated_at = clock_timestamp(), completed_at = NULL,
             expires_at = EXCLUDED.expires_at
         WHERE ivekit_media_call_create_commands.expires_at <= clock_timestamp()
           AND (
             ivekit_media_call_create_commands.state <> 'pending'
             OR ivekit_media_call_create_commands.lease_until <= clock_timestamp()
           )
         RETURNING *`,
        [
          callId,
          tenantId,
          idempotencyKeyHash,
          payloadHash,
          requesterIdentityHash,
          initialTokenHash,
          this.#attemptLeaseMs,
          this.#retentionMs
        ]
      );
      if (inserted.rows[0]) {
        const command = decodeCommand(inserted.rows[0]);
        return {
          command,
          replayed: false,
          attempt: claimedAttempt(command, initialToken)
        };
      }

      const replay = await selectByKeyHash(pg, tenantId, idempotencyKeyHash);
      if (!replay) {
        throw new MediaCallCreateCommandError(
          'create_command_reload_failed',
          503,
          true
        );
      }
      if (replay.requester_identity_hash !== requesterIdentityHash ||
          replay.payload_hash !== payloadHash) {
        throw new MediaCallCreateCommandError('idempotency_conflict', 409);
      }
      if (replay.state === 'succeeded' ||
          replay.state === 'terminal_failed') {
        return { command: replay, replayed: true, attempt: null };
      }

      const nextGeneration = replay.attempt_generation + 1;
      const takeoverToken = attemptToken(this.#attemptToken());
      const takeoverTokenHash = attemptTokenHash(
        tenantId,
        replay.call_id,
        nextGeneration,
        takeoverToken
      );
      const taken = await pg.query<Record<string, unknown>>(
        `UPDATE ivekit_media_call_create_commands
         SET state = 'pending', attempt_generation = attempt_generation + 1,
             attempt_token_hash = $4,
             lease_until = clock_timestamp() +
               ($5::bigint * interval '1 millisecond'),
             result_snapshot = NULL, error_code = '', error_status = 0,
             error_retryable = FALSE, next_retry_at = NULL,
             completed_at = NULL, updated_at = clock_timestamp(),
             expires_at = clock_timestamp() +
               ($6::bigint * interval '1 millisecond')
         WHERE tenant_id = $1 AND call_id = $2 AND attempt_generation = $3
           AND state IN ('pending', 'retryable_failed')
           AND (
             (state = 'pending' AND lease_until <= clock_timestamp())
             OR
             (state = 'retryable_failed' AND next_retry_at <= clock_timestamp())
           )
         RETURNING *`,
        [
          tenantId,
          replay.call_id,
          replay.attempt_generation,
          takeoverTokenHash,
          this.#attemptLeaseMs,
          this.#retentionMs
        ]
      );
      if (taken.rows[0]) {
        const command = decodeCommand(taken.rows[0]);
        return {
          command,
          replayed: true,
          attempt: claimedAttempt(command, takeoverToken)
        };
      }

      const current = await selectByCallId(pg, tenantId, replay.call_id);
      if (!current) {
        throw new MediaCallCreateCommandError(
          'create_command_reload_failed',
          503,
          true
        );
      }
      return { command: current, replayed: true, attempt: null };
    });
  }

  async findByIdempotencyKey(
    tenantIdInput: string,
    idempotencyKeyInput: string,
    requesterIdentityInput: string
  ): Promise<MediaCallCreateCommand | null> {
    const tenantId = identifier(tenantIdInput, 'create_payload_invalid');
    const key = requiredIdempotencyKey(idempotencyKeyInput);
    const requester = requiredRequesterIdentity(requesterIdentityInput);
    const keyHash = hash('ivekit-media-call-create-key-v1', tenantId, key);
    const requesterHash = hash(
      'ivekit-media-call-create-requester-v1',
      tenantId,
      requester
    );
    return withPgTenant(this.pg, tenantId, (pg) =>
      selectByKeyAndRequesterHash(pg, tenantId, keyHash, requesterHash)
    );
  }

  async findByCallId(
    tenantIdInput: string,
    callIdInput: string
  ): Promise<MediaCallCreateCommand | null> {
    const tenantId = identifier(tenantIdInput, 'create_payload_invalid');
    const callId = identifier(callIdInput, 'create_payload_invalid');
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<Record<string, unknown>>(
        `SELECT command.*
         FROM ivekit_media_call_create_commands command
         WHERE command.tenant_id = $1 AND command.call_id = $2`,
        [tenantId, callId]
      );
      return result.rows[0] ? decodeCommand(result.rows[0]) : null;
    });
  }

  markSucceeded(input: {
    tenant_id: string;
    call_id: string;
    attempt_generation: number;
    attempt_token: string;
    result_snapshot: IveKitMediaCallSnapshot;
  }): Promise<MediaCallCreateCommand> {
    const snapshot = canonicalJsonObject(
      input.result_snapshot as unknown as Record<string, unknown>,
      SNAPSHOT_MAX_BYTES
    );
    return this.#transition({
      tenant_id: input.tenant_id,
      call_id: input.call_id,
      attempt_generation: input.attempt_generation,
      attempt_token: input.attempt_token,
      state: 'succeeded',
      result_snapshot: snapshot.json,
      error_code: '',
      error_status: 0,
      error_retryable: false,
      retry_after_seconds: 0
    });
  }

  markFailed(input: {
    tenant_id: string;
    call_id: string;
    attempt_generation: number;
    attempt_token: string;
    error_code: string;
    error_status: number;
    retryable: boolean;
    retry_after_seconds: number;
  }): Promise<MediaCallCreateCommand> {
    const errorCode = String(input.error_code || '').trim();
    if (!ERROR_CODE_PATTERN.test(errorCode)) {
      throw new MediaCallCreateCommandError('create_payload_invalid', 400);
    }
    const errorStatus = Number(input.error_status);
    if (!Number.isInteger(errorStatus) ||
        errorStatus < 400 ||
        errorStatus > 599) {
      throw new MediaCallCreateCommandError('create_payload_invalid', 400);
    }
    const retryAfterSeconds = Number(input.retry_after_seconds);
    if (!Number.isInteger(retryAfterSeconds) ||
        retryAfterSeconds < (input.retryable ? 1 : 0) ||
        retryAfterSeconds > 60 ||
        (!input.retryable && retryAfterSeconds !== 0)) {
      throw new MediaCallCreateCommandError('create_payload_invalid', 400);
    }
    return this.#transition({
      tenant_id: input.tenant_id,
      call_id: input.call_id,
      attempt_generation: input.attempt_generation,
      attempt_token: input.attempt_token,
      state: input.retryable ? 'retryable_failed' : 'terminal_failed',
      result_snapshot: null,
      error_code: errorCode,
      error_status: errorStatus,
      error_retryable: input.retryable,
      retry_after_seconds: retryAfterSeconds
    });
  }

  async #transition(input: {
    tenant_id: string;
    call_id: string;
    attempt_generation: number;
    attempt_token: string;
    state: Exclude<MediaCallCreateCommandState, 'pending'>;
    result_snapshot: string | null;
    error_code: string;
    error_status: number;
    error_retryable: boolean;
    retry_after_seconds: number;
  }): Promise<MediaCallCreateCommand> {
    const tenantId = identifier(input.tenant_id, 'create_payload_invalid');
    const callId = identifier(input.call_id, 'create_payload_invalid');
    const generation = attemptGeneration(input.attempt_generation);
    const token = attemptToken(input.attempt_token);
    const tokenHash = attemptTokenHash(tenantId, callId, generation, token);
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<Record<string, unknown>>(
        `UPDATE ivekit_media_call_create_commands
         SET state = $5, attempt_token_hash = '', lease_until = NULL,
             result_snapshot = $6::jsonb, error_code = $7,
             error_status = $8, error_retryable = $9,
             next_retry_at = CASE
               WHEN $9 THEN clock_timestamp() +
                 ($10::bigint * interval '1 second')
               ELSE NULL
             END,
             completed_at = CASE
               WHEN $5 IN ('succeeded', 'terminal_failed')
                 THEN clock_timestamp()
               ELSE NULL
             END,
             updated_at = clock_timestamp(),
             expires_at = clock_timestamp() +
               ($11::bigint * interval '1 millisecond')
         WHERE tenant_id = $1 AND call_id = $2 AND state = 'pending'
           AND attempt_generation = $3 AND attempt_token_hash = $4
           AND lease_until > clock_timestamp()
         RETURNING *`,
        [
          tenantId,
          callId,
          generation,
          tokenHash,
          input.state,
          input.result_snapshot,
          input.error_code,
          input.error_status,
          input.error_retryable,
          input.retry_after_seconds,
          this.#retentionMs
        ]
      );
      if (result.rows[0]) return decodeCommand(result.rows[0]);

      const existing = await selectByCallId(pg, tenantId, callId);
      if (!existing) {
        throw new MediaCallCreateCommandError('create_command_not_found', 404);
      }
      throw new MediaCallCreateCommandError('attempt_fenced', 409, true);
    });
  }
}

async function selectByKeyHash(
  pg: PgQueryable,
  tenantId: string,
  keyHash: string
): Promise<MediaCallCreateCommand | null> {
  const result = await pg.query<Record<string, unknown>>(
    `SELECT command.*
     FROM ivekit_media_call_create_commands command
     WHERE command.tenant_id = $1 AND command.idempotency_key_hash = $2`,
    [tenantId, keyHash]
  );
  return result.rows[0] ? decodeCommand(result.rows[0]) : null;
}

async function selectByKeyAndRequesterHash(
  pg: PgQueryable,
  tenantId: string,
  keyHash: string,
  requesterHash: string
): Promise<MediaCallCreateCommand | null> {
  const result = await pg.query<Record<string, unknown>>(
    `SELECT command.*
     FROM ivekit_media_call_create_commands command
     WHERE command.tenant_id = $1
       AND command.idempotency_key_hash = $2
       AND command.requester_identity_hash = $3
       AND command.expires_at > clock_timestamp()`,
    [tenantId, keyHash, requesterHash]
  );
  return result.rows[0] ? decodeCommand(result.rows[0]) : null;
}

async function pruneExpired(
  pg: PgQueryable,
  tenantId: string,
  maximumRows: number
): Promise<void> {
  await pg.query(
    `WITH expired AS (
       SELECT call_id
       FROM ivekit_media_call_create_commands
       WHERE tenant_id = $1
         AND expires_at <= clock_timestamp()
         AND (state <> 'pending' OR lease_until <= clock_timestamp())
       ORDER BY expires_at, call_id
       LIMIT $2
     )
     DELETE FROM ivekit_media_call_create_commands command
     USING expired
     WHERE command.tenant_id = $1
       AND command.call_id = expired.call_id`,
    [tenantId, maximumRows]
  );
}

async function selectByCallId(
  pg: PgQueryable,
  tenantId: string,
  callId: string
): Promise<MediaCallCreateCommand | null> {
  const result = await pg.query<Record<string, unknown>>(
    `SELECT command.*
     FROM ivekit_media_call_create_commands command
     WHERE command.tenant_id = $1 AND command.call_id = $2`,
    [tenantId, callId]
  );
  return result.rows[0] ? decodeCommand(result.rows[0]) : null;
}

function decodeCommand(row: Record<string, unknown>): MediaCallCreateCommand {
  return {
    tenant_id: String(row.tenant_id),
    call_id: String(row.call_id),
    idempotency_key_hash: String(row.idempotency_key_hash),
    payload_hash: String(row.payload_hash),
    requester_identity_hash: String(row.requester_identity_hash),
    state: String(row.state) as MediaCallCreateCommandState,
    attempt_generation: attemptGeneration(row.attempt_generation),
    lease_until: nullableTimestamp(row.lease_until),
    result_snapshot: row.result_snapshot == null
      ? null
      : jsonValue<IveKitMediaCallSnapshot>(row.result_snapshot),
    error_code: String(row.error_code || ''),
    error_status: finiteInteger(row.error_status, 0),
    error_retryable: row.error_retryable === true,
    next_retry_at: nullableTimestamp(row.next_retry_at),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
    completed_at: nullableTimestamp(row.completed_at),
    expires_at: timestamp(row.expires_at)
  };
}

function requiredIdempotencyKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) {
    throw new MediaCallCreateCommandError('idempotency_key_required', 400);
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new MediaCallCreateCommandError('idempotency_key_invalid', 400);
  }
  return key;
}

function requiredRequesterIdentity(value: unknown): string {
  const identity = typeof value === 'string' ? value.trim() : '';
  if (!identity ||
      Buffer.byteLength(identity, 'utf8') > 512 ||
      /[\u0000-\u001f\u007f]/u.test(identity)) {
    throw new MediaCallCreateCommandError('create_payload_invalid', 400);
  }
  return identity;
}

function finiteInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function attemptToken(value: unknown): string {
  const token = String(value || '');
  if (!ATTEMPT_TOKEN_PATTERN.test(token)) {
    throw new MediaCallCreateCommandError('create_payload_invalid', 400);
  }
  return token;
}

function attemptGeneration(value: unknown): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new MediaCallCreateCommandError('create_payload_invalid', 400);
  }
  return generation;
}

function attemptTokenHash(
  tenantId: string,
  callId: string,
  generation: number,
  token: string
): string {
  return hash(
    'ivekit-media-call-create-attempt-v1',
    tenantId,
    callId,
    String(generation),
    token
  );
}

function claimedAttempt(
  command: MediaCallCreateCommand,
  token: string
): MediaCallCreateAttempt {
  if (command.state !== 'pending' || !command.lease_until) {
    throw new MediaCallCreateCommandError(
      'create_command_reload_failed',
      503,
      true
    );
  }
  return {
    generation: command.attempt_generation,
    token,
    lease_until: command.lease_until
  };
}

function identifier(
  value: unknown,
  code: MediaCallCreateCommandErrorCode
): string {
  const text = String(value || '').trim();
  if (!IDENTIFIER_PATTERN.test(text)) {
    throw new MediaCallCreateCommandError(code, 400);
  }
  return text;
}

function hash(domain: string, ...values: string[]): string {
  const digest = createHash('sha256');
  digest.update(domain);
  for (const value of values) {
    digest.update('\u0000');
    digest.update(value);
  }
  return digest.digest('hex');
}

function canonicalJsonObject(
  value: Record<string, unknown>,
  maximumBytes: number
): { value: Record<string, unknown>; json: string } {
  const state = {
    nodes: 0,
    active: new WeakSet<object>()
  };
  const normalized = normalizeJson(value, 0, state);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new MediaCallCreateCommandError('create_payload_invalid', 400);
  }
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, 'utf8') > maximumBytes) {
    throw new MediaCallCreateCommandError('create_payload_invalid', 413);
  }
  return { value: normalized as Record<string, unknown>, json };
}

function normalizeJson(
  value: unknown,
  depth: number,
  state: { nodes: number; active: WeakSet<object> }
): unknown {
  state.nodes += 1;
  if (state.nodes > JSON_MAX_NODES || depth > JSON_MAX_DEPTH) {
    throw new MediaCallCreateCommandError('create_payload_invalid', 400);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MediaCallCreateCommandError('create_payload_invalid', 400);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== 'object') {
    throw new MediaCallCreateCommandError('create_payload_invalid', 400);
  }
  if (state.active.has(value)) {
    throw new MediaCallCreateCommandError('create_payload_invalid', 400);
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeJson(entry, depth + 1, state));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new MediaCallCreateCommandError('create_payload_invalid', 400);
    }
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          normalizeJson(
            (value as Record<string, unknown>)[key],
            depth + 1,
            state
          )
        ])
    );
  } finally {
    state.active.delete(value);
  }
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function timestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('media call create command database timestamp is invalid');
  }
  return parsed.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value == null || value === '' ? null : timestamp(value);
}
