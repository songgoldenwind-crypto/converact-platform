import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual
} from 'node:crypto';

import { pgId, type PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import {
  rustDeskAuthorizationCodeLock,
  withRustDeskAuthorizationLocks
} from './rustdesk-gateway-authorization-lock.js';
import type { RemoteConsentScope } from './types.js';

export type RustDeskAuthorizationCodeStatus =
  | 'pending'
  | 'verified'
  | 'consumed'
  | 'expired'
  | 'locked';

export interface RustDeskAuthorizationCode {
  id: string;
  tenant_id: string;
  remote_session_id: string;
  device_id: string;
  scopes: RemoteConsentScope[];
  requested_by: string;
  requested_at: string;
  expires_at: string;
  max_attempts: number;
  attempt_count: number;
  status: RustDeskAuthorizationCodeStatus;
  verified_by: string | null;
  verified_at: string | null;
  consumed_external_id: string | null;
  consumed_at: string | null;
  updated_at: string;
}

export interface CreateRustDeskAuthorizationCodeInput {
  tenant_id: string;
  remote_session_id: string;
  device_id: string;
  scopes: readonly RemoteConsentScope[];
  requested_by: string;
  idempotency_key: string;
  ttl_seconds?: number;
  max_attempts?: number;
  now?: string | Date;
}

export interface RustDeskAuthorizationCodeCreateResult {
  authorization: RustDeskAuthorizationCode;
  code: string | null;
  replayed: boolean;
}

interface RustDeskAuthorizationCodeStoreOptions {
  secret?: string;
}

interface StoredAuthorizationCode extends RustDeskAuthorizationCode {
  code_salt: string;
  code_hmac: string;
  idempotency_key: string;
  request_hash: string;
}

const SCOPES = new Set<RemoteConsentScope>([
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard'
]);

export class RustDeskAuthorizationCodeStore {
  private readonly secret: string;

  constructor(
    private readonly pg: PgQueryable,
    options: RustDeskAuthorizationCodeStoreOptions = {}
  ) {
    this.secret = String(
      options.secret ?? process.env.OPC_RUSTDESK_AUTHORIZATION_CODE_SECRET ?? ''
    );
    if (this.secret && Buffer.byteLength(this.secret, 'utf8') < 32) {
      throw authorizationError('RustDesk authorization code secret must be at least 32 bytes', 503);
    }
  }

  async create(
    input: CreateRustDeskAuthorizationCodeInput
  ): Promise<RustDeskAuthorizationCodeCreateResult> {
    const normalized = normalizeCreateInput(input);
    const requestHash = hashJson({
      tenant_id: normalized.tenant_id,
      remote_session_id: normalized.remote_session_id,
      device_id: normalized.device_id,
      scopes: normalized.scopes,
      requested_by: normalized.requested_by,
      ttl_seconds: normalized.ttl_seconds,
      max_attempts: normalized.max_attempts
    });
    return withPgTenant(this.pg, normalized.tenant_id, (tenantPg) =>
      withRustDeskAuthorizationLocks(
      tenantPg,
      [rustDeskAuthorizationCodeLock(normalized.tenant_id, normalized.idempotency_key)],
      async (pg) => {
        const replay = await findByIdempotencyKey(
          pg,
          normalized.tenant_id,
          normalized.idempotency_key
        );
        if (replay) {
          if (replay.request_hash !== requestHash) {
            throw authorizationError(
              'idempotency key was already used for a different authorization code request',
              409
            );
          }
          return { authorization: toPublic(replay), code: null, replayed: true };
        }

        const id = pgId('rdauth');
        const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
        const codeSalt = randomBytes(16).toString('hex');
        const expiresAt = new Date(
          normalized.now.getTime() + normalized.ttl_seconds * 1000
        ).toISOString();
        const stored = await insertAuthorizationCode(pg, {
          id,
          tenant_id: normalized.tenant_id,
          remote_session_id: normalized.remote_session_id,
          device_id: normalized.device_id,
          scopes: normalized.scopes,
          requested_by: normalized.requested_by,
          requested_at: normalized.now.toISOString(),
          expires_at: expiresAt,
          max_attempts: normalized.max_attempts,
          attempt_count: 0,
          status: 'pending',
          verified_by: null,
          verified_at: null,
          consumed_external_id: null,
          consumed_at: null,
          updated_at: normalized.now.toISOString(),
          code_salt: codeSalt,
          code_hmac: this.codeHmac(normalized.tenant_id, id, codeSalt, code),
          idempotency_key: normalized.idempotency_key,
          request_hash: requestHash
        });
        return { authorization: toPublic(stored), code, replayed: false };
      }
    ));
  }

  async get(input: {
    tenant_id: string;
    authorization_id: string;
    now?: string | Date;
  }): Promise<RustDeskAuthorizationCode | null> {
    const tenantId = required(input.tenant_id, 'tenant_id is required');
    const authorizationId = required(input.authorization_id, 'authorization_id is required');
    const now = validNow(input.now);
    const stored = await withPgTenant(this.pg, tenantId, (tenantPg) =>
      expireAndFind(tenantPg, tenantId, authorizationId, now)
    );
    return stored ? toPublic(stored) : null;
  }

  async verify(input: {
    tenant_id: string;
    authorization_id: string;
    code: string;
    verified_by: string;
    now?: string | Date;
  }): Promise<RustDeskAuthorizationCode> {
    const tenantId = required(input.tenant_id, 'tenant_id is required');
    const authorizationId = required(input.authorization_id, 'authorization_id is required');
    const code = String(input.code || '').trim();
    const verifiedBy = required(input.verified_by, 'verified_by is required');
    const now = validNow(input.now);
    if (!/^\d{8}$/.test(code)) throw invalidCode();

    return withPgTenant(this.pg, tenantId, (tenantPg) => withRustDeskAuthorizationLocks(
      tenantPg,
      [rustDeskAuthorizationCodeLock(tenantId, authorizationId)],
      async (pg) => {
        const stored = await expireAndFind(pg, tenantId, authorizationId, now);
        if (!stored || !['pending', 'verified'].includes(stored.status)) throw invalidCode();
        const expected = Buffer.from(stored.code_hmac, 'hex');
        const actual = Buffer.from(
          this.codeHmac(tenantId, stored.id, stored.code_salt, code),
          'hex'
        );
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
          if (stored.status === 'verified') throw invalidCode();
          const attemptCount = stored.attempt_count + 1;
          await updateAttempt(
            pg,
            tenantId,
            authorizationId,
            attemptCount,
            attemptCount >= stored.max_attempts ? 'locked' : 'pending',
            now.toISOString()
          );
          throw invalidCode();
        }
        if (stored.status === 'verified') {
          if (stored.verified_by !== verifiedBy) {
            throw authorizationError('authorization code is already verified for another actor', 409);
          }
          return toPublic(stored);
        }
        return toPublic(await markVerified(
          pg,
          tenantId,
          authorizationId,
          verifiedBy,
          now.toISOString()
        ));
      }
    ));
  }

  async assertVerified(input: {
    tenant_id: string;
    authorization_id: string;
    remote_session_id: string;
    device_id: string;
    permissions: readonly RemoteConsentScope[];
    verified_by: string;
    now?: string | Date;
  }): Promise<RustDeskAuthorizationCode> {
    const authorization = await this.get({
      tenant_id: input.tenant_id,
      authorization_id: input.authorization_id,
      now: input.now
    });
    const grantedScopes = new Set(authorization?.scopes || []);
    if (
      !authorization ||
      authorization.status !== 'verified' ||
      authorization.remote_session_id !== input.remote_session_id ||
      authorization.device_id !== input.device_id ||
      authorization.verified_by !== input.verified_by ||
      input.permissions.some((permission) => !grantedScopes.has(permission))
    ) {
      throw authorizationError('RustDesk authorization code is required or unavailable', 403);
    }
    return authorization;
  }

  async consume(input: {
    tenant_id: string;
    authorization_id: string;
    verified_by: string;
    external_id: string;
    now?: string | Date;
  }): Promise<RustDeskAuthorizationCode> {
    const tenantId = required(input.tenant_id, 'tenant_id is required');
    const authorizationId = required(input.authorization_id, 'authorization_id is required');
    const verifiedBy = required(input.verified_by, 'verified_by is required');
    const externalId = required(input.external_id, 'external_id is required');
    const now = validNow(input.now);
    return withPgTenant(this.pg, tenantId, (tenantPg) => withRustDeskAuthorizationLocks(
      tenantPg,
      [rustDeskAuthorizationCodeLock(tenantId, authorizationId)],
      async (pg) => {
        const stored = await expireAndFind(pg, tenantId, authorizationId, now);
        if (!stored) throw authorizationError('authorization code not found', 404);
        if (
          stored.status === 'consumed' &&
          stored.verified_by === verifiedBy &&
          stored.consumed_external_id === externalId
        ) {
          return toPublic(stored);
        }
        if (stored.status === 'consumed') {
          throw authorizationError('authorization code is already consumed', 409);
        }
        if (stored.status !== 'verified' || stored.verified_by !== verifiedBy) {
          throw authorizationError('authorization code is not verified for this actor', 403);
        }
        return toPublic(await markConsumed(
          pg,
          tenantId,
          authorizationId,
          verifiedBy,
          externalId,
          now.toISOString()
        ));
      }
    ));
  }

  private codeHmac(tenantId: string, id: string, salt: string, code: string): string {
    if (!this.secret) {
      throw authorizationError('RustDesk authorization code secret is not configured', 503);
    }
    return createHmac('sha256', this.secret)
      .update(`${tenantId}\0${id}\0${salt}\0${code}`)
      .digest('hex');
  }
}

export function rustDeskRequireAuthorizationCode(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env.OPC_RUSTDESK_REQUIRE_AUTHORIZATION_CODE || '').trim().toLowerCase()
  );
}

async function findByIdempotencyKey(
  pg: PgQueryable,
  tenantId: string,
  idempotencyKey: string
): Promise<StoredAuthorizationCode | null> {
  const result = await pg.query(
    `SELECT * FROM rustdesk_authorization_codes
     WHERE tenant_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [tenantId, idempotencyKey]
  );
  return result.rows[0] ? decodeStored(result.rows[0]) : null;
}

async function expireAndFind(
  pg: PgQueryable,
  tenantId: string,
  authorizationId: string,
  now: Date
): Promise<StoredAuthorizationCode | null> {
  await pg.query(
    `UPDATE rustdesk_authorization_codes
     SET status = 'expired', updated_at = $3
     WHERE tenant_id = $1 AND id = $2
       AND status IN ('pending', 'verified') AND expires_at <= $3`,
    [tenantId, authorizationId, now.toISOString()]
  );
  const result = await pg.query(
    `SELECT * FROM rustdesk_authorization_codes
     WHERE tenant_id = $1 AND id = $2
     LIMIT 1`,
    [tenantId, authorizationId]
  );
  return result.rows[0] ? decodeStored(result.rows[0]) : null;
}

async function insertAuthorizationCode(
  pg: PgQueryable,
  value: StoredAuthorizationCode
): Promise<StoredAuthorizationCode> {
  const result = await pg.query(
    `INSERT INTO rustdesk_authorization_codes
      (id, tenant_id, remote_session_id, device_id, scopes, requested_by, requested_at,
       code_salt, code_hmac, expires_at, max_attempts, attempt_count, status,
       verified_by, verified_at, consumed_external_id, consumed_at,
       idempotency_key, request_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     RETURNING *`,
    [
      value.id,
      value.tenant_id,
      value.remote_session_id,
      value.device_id,
      JSON.stringify(value.scopes),
      value.requested_by,
      value.requested_at,
      value.code_salt,
      value.code_hmac,
      value.expires_at,
      value.max_attempts,
      value.attempt_count,
      value.status,
      value.verified_by,
      value.verified_at,
      value.consumed_external_id,
      value.consumed_at,
      value.idempotency_key,
      value.request_hash,
      value.updated_at
    ]
  );
  return decodeStored(result.rows[0]);
}

async function updateAttempt(
  pg: PgQueryable,
  tenantId: string,
  authorizationId: string,
  attemptCount: number,
  status: 'pending' | 'locked',
  now: string
): Promise<void> {
  await pg.query(
    `UPDATE rustdesk_authorization_codes
     SET attempt_count = $3, status = $4, updated_at = $5
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, authorizationId, attemptCount, status, now]
  );
}

async function markVerified(
  pg: PgQueryable,
  tenantId: string,
  authorizationId: string,
  verifiedBy: string,
  now: string
): Promise<StoredAuthorizationCode> {
  const result = await pg.query(
    `UPDATE rustdesk_authorization_codes
     SET status = 'verified', verified_by = $3, verified_at = $4, updated_at = $4
     WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
     RETURNING *`,
    [tenantId, authorizationId, verifiedBy, now]
  );
  if (!result.rows[0]) throw invalidCode();
  return decodeStored(result.rows[0]);
}

async function markConsumed(
  pg: PgQueryable,
  tenantId: string,
  authorizationId: string,
  verifiedBy: string,
  externalId: string,
  now: string
): Promise<StoredAuthorizationCode> {
  const result = await pg.query(
    `UPDATE rustdesk_authorization_codes
     SET status = 'consumed', consumed_external_id = $4, consumed_at = $5, updated_at = $5
     WHERE tenant_id = $1 AND id = $2 AND status = 'verified' AND verified_by = $3
     RETURNING *`,
    [tenantId, authorizationId, verifiedBy, externalId, now]
  );
  if (!result.rows[0]) {
    throw authorizationError('authorization code could not be consumed', 409);
  }
  return decodeStored(result.rows[0]);
}

function normalizeCreateInput(input: CreateRustDeskAuthorizationCodeInput) {
  const scopes = normalizeScopes(input.scopes);
  const ttlSeconds = input.ttl_seconds ?? 300;
  const maxAttempts = input.max_attempts ?? 5;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 900) {
    throw authorizationError('ttl_seconds must be an integer between 60 and 900');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw authorizationError('max_attempts must be an integer between 1 and 10');
  }
  const idempotencyKey = required(input.idempotency_key, 'Idempotency-Key is required');
  if (idempotencyKey.length > 200) {
    throw authorizationError('Idempotency-Key must be at most 200 characters');
  }
  return {
    tenant_id: required(input.tenant_id, 'tenant_id is required'),
    remote_session_id: required(input.remote_session_id, 'remote_session_id is required'),
    device_id: required(input.device_id, 'device_id is required'),
    scopes,
    requested_by: required(input.requested_by, 'requested_by is required'),
    idempotency_key: idempotencyKey,
    ttl_seconds: ttlSeconds,
    max_attempts: maxAttempts,
    now: validNow(input.now)
  };
}

function normalizeScopes(value: readonly RemoteConsentScope[]): RemoteConsentScope[] {
  if (!Array.isArray(value)) throw authorizationError('scopes must be an array');
  const scopes = [...new Set(value.map((scope) => String(scope).trim()))].sort();
  if (!scopes.length) throw authorizationError('scopes are required');
  const unsupported = scopes.find((scope) => !SCOPES.has(scope as RemoteConsentScope));
  if (unsupported) throw authorizationError(`unsupported remote consent scope: ${unsupported}`);
  return scopes as RemoteConsentScope[];
}

function decodeStored(row: Record<string, unknown>): StoredAuthorizationCode {
  const scopes = Array.isArray(row.scopes)
    ? row.scopes
    : JSON.parse(String(row.scopes || '[]')) as unknown[];
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    remote_session_id: String(row.remote_session_id),
    device_id: String(row.device_id),
    scopes: scopes.map(String) as RemoteConsentScope[],
    requested_by: String(row.requested_by),
    requested_at: timestamp(row.requested_at),
    expires_at: timestamp(row.expires_at),
    max_attempts: Number(row.max_attempts),
    attempt_count: Number(row.attempt_count),
    status: String(row.status) as RustDeskAuthorizationCodeStatus,
    verified_by: row.verified_by ? String(row.verified_by) : null,
    verified_at: row.verified_at ? timestamp(row.verified_at) : null,
    consumed_external_id: row.consumed_external_id ? String(row.consumed_external_id) : null,
    consumed_at: row.consumed_at ? timestamp(row.consumed_at) : null,
    updated_at: timestamp(row.updated_at),
    code_salt: String(row.code_salt),
    code_hmac: String(row.code_hmac),
    idempotency_key: String(row.idempotency_key),
    request_hash: String(row.request_hash)
  };
}

function toPublic(value: StoredAuthorizationCode): RustDeskAuthorizationCode {
  return {
    id: value.id,
    tenant_id: value.tenant_id,
    remote_session_id: value.remote_session_id,
    device_id: value.device_id,
    scopes: [...value.scopes],
    requested_by: value.requested_by,
    requested_at: value.requested_at,
    expires_at: value.expires_at,
    max_attempts: value.max_attempts,
    attempt_count: value.attempt_count,
    status: value.status,
    verified_by: value.verified_by,
    verified_at: value.verified_at,
    consumed_external_id: value.consumed_external_id,
    consumed_at: value.consumed_at,
    updated_at: value.updated_at
  };
}

function validNow(value: string | Date | undefined): Date {
  const now = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(now.getTime())) throw authorizationError('now must be a valid timestamp');
  return now;
}

function required(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw authorizationError(message);
  return normalized;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function invalidCode(): Error & { status: number } {
  return authorizationError('authorization code is invalid or unavailable', 403);
}

function authorizationError(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
