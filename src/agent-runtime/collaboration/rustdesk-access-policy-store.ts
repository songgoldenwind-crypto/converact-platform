import { createHash } from 'node:crypto';

import { MemoryPg, pgId, withPgTransaction, type PgQueryable } from '../../db-pg.js';
import type { BusinessRef, RemoteConsentScope } from './types.js';

export type RustDeskAccessPolicyMode = 'attended_only' | 'unattended_allowed';
export type RustDeskAccessPolicyEventType = 'configured' | 'revoked';
export type RustDeskAccessPolicyState = 'active' | 'expired' | 'revoked' | 'superseded';

export interface RustDeskAccessPolicyEvent {
  id: string;
  tenant_id: string;
  device_id: string;
  event_type: RustDeskAccessPolicyEventType;
  mode: RustDeskAccessPolicyMode;
  allowed_scopes: RemoteConsentScope[];
  business_ref: Pick<BusinessRef, 'type' | 'id'>;
  approved_by: string;
  reason: string;
  expires_at: string | null;
  version: number;
  state: RustDeskAccessPolicyState;
  created_at: string;
}

export interface RustDeskAccessPolicyCurrent {
  device_id: string;
  state: 'not_configured' | Exclude<RustDeskAccessPolicyState, 'superseded'>;
  policy: RustDeskAccessPolicyEvent | null;
}

export interface RustDeskAccessPolicyMutationResult {
  policy: RustDeskAccessPolicyEvent;
  replayed: boolean;
}

export interface ConfigureRustDeskAccessPolicyInput {
  tenant_id: string;
  device_id: string;
  business_ref: Pick<BusinessRef, 'type' | 'id'>;
  mode: RustDeskAccessPolicyMode;
  allowed_scopes: readonly RemoteConsentScope[];
  approved_by: string;
  reason: string;
  expires_at?: string | null;
  idempotency_key: string;
}

export interface RevokeRustDeskAccessPolicyInput {
  tenant_id: string;
  device_id: string;
  approved_by: string;
  reason: string;
  idempotency_key: string;
}

interface StoredPolicy {
  id: string;
  tenant_id: string;
  device_id: string;
  event_type: RustDeskAccessPolicyEventType;
  mode: RustDeskAccessPolicyMode;
  allowed_scopes: RemoteConsentScope[];
  business_ref_type: string;
  business_ref_id: string;
  approved_by: string;
  reason: string;
  expires_at: string | null;
  supersedes_id: string | null;
  version: number;
  idempotency_key: string;
  request_hash: string;
  created_at: string;
}

const REMOTE_SCOPES = new Set<RemoteConsentScope>([
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard'
]);

const memoryPolicyLockTails = new WeakMap<MemoryPg, Map<string, Promise<void>>>();

export class RustDeskAccessPolicyStore {
  constructor(private readonly pg: PgQueryable) {}

  async configurePolicy(input: ConfigureRustDeskAccessPolicyInput): Promise<RustDeskAccessPolicyMutationResult> {
    const normalized = normalizeConfigureInput(input);
    const requestHash = requestHashFor({ action: 'configure', ...normalized });
    return withPolicyWriteLock(this.pg, normalized, async (pg) => {
      const replay = await findIdempotentPolicy(pg, normalized.tenant_id, normalized.idempotency_key);
      if (replay) return replayResult(replay, requestHash);
      const device = await lockPolicyDevice(pg, normalized.tenant_id, normalized.device_id);
      if (!device) throw policyError('rustdesk device not found', 404);
      if (
        String(device.business_ref_type) !== normalized.business_ref.type ||
        String(device.business_ref_id) !== normalized.business_ref.id
      ) {
        throw policyError('rustdesk device not found', 404);
      }
      const latest = await findLatestStoredPolicy(pg, normalized.tenant_id, normalized.device_id);
      const stored = await insertPolicyEvent(pg, {
        id: pgId('rdpol'),
        tenant_id: normalized.tenant_id,
        device_id: normalized.device_id,
        event_type: 'configured',
        mode: normalized.mode,
        allowed_scopes: normalized.allowed_scopes,
        business_ref_type: normalized.business_ref.type,
        business_ref_id: normalized.business_ref.id,
        approved_by: normalized.approved_by,
        reason: normalized.reason,
        expires_at: normalized.expires_at,
        supersedes_id: latest?.id || null,
        version: (latest?.version || 0) + 1,
        idempotency_key: normalized.idempotency_key,
        request_hash: requestHash
      });
      return { policy: toPublicPolicy(stored, stored.version, new Date()), replayed: false };
    });
  }

  async revokePolicy(input: RevokeRustDeskAccessPolicyInput): Promise<RustDeskAccessPolicyMutationResult> {
    const normalized = normalizeMutationIdentity(input);
    const requestHash = requestHashFor({ action: 'revoke', ...normalized });
    return withPolicyWriteLock(this.pg, normalized, async (pg) => {
      const replay = await findIdempotentPolicy(pg, normalized.tenant_id, normalized.idempotency_key);
      if (replay) return replayResult(replay, requestHash);
      if (!(await lockPolicyDevice(pg, normalized.tenant_id, normalized.device_id))) {
        throw policyError('rustdesk device not found', 404);
      }
      const latest = await findLatestStoredPolicy(pg, normalized.tenant_id, normalized.device_id);
      if (!latest) throw policyError('rustdesk access policy not found', 404);
      if (latest.event_type === 'revoked') throw policyError('rustdesk access policy is already revoked', 409);
      const stored = await insertPolicyEvent(pg, {
        id: pgId('rdpol'),
        tenant_id: normalized.tenant_id,
        device_id: normalized.device_id,
        event_type: 'revoked',
        mode: latest.mode,
        allowed_scopes: latest.allowed_scopes,
        business_ref_type: latest.business_ref_type,
        business_ref_id: latest.business_ref_id,
        approved_by: normalized.approved_by,
        reason: normalized.reason,
        expires_at: latest.expires_at,
        supersedes_id: latest.id,
        version: latest.version + 1,
        idempotency_key: normalized.idempotency_key,
        request_hash: requestHash
      });
      return { policy: toPublicPolicy(stored, stored.version, new Date()), replayed: false };
    });
  }

  async getCurrentPolicy(input: {
    tenant_id: string;
    device_id: string;
    now?: Date;
  }): Promise<RustDeskAccessPolicyCurrent> {
    const tenantId = requiredString(input.tenant_id, 'tenant_id is required');
    const deviceId = requiredString(input.device_id, 'device_id is required');
    const now = validNow(input.now);
    const latest = await findLatestStoredPolicy(this.pg, tenantId, deviceId);
    if (!latest) return { device_id: deviceId, state: 'not_configured', policy: null };
    const policy = toPublicPolicy(latest, latest.version, now);
    if (policy.state === 'superseded') throw new Error('latest access policy cannot be superseded');
    return { device_id: deviceId, state: policy.state, policy };
  }

  async listPolicyHistory(input: {
    tenant_id: string;
    device_id: string;
    now?: Date;
  }): Promise<{ device_id: string; events: RustDeskAccessPolicyEvent[] }> {
    const tenantId = requiredString(input.tenant_id, 'tenant_id is required');
    const deviceId = requiredString(input.device_id, 'device_id is required');
    const now = validNow(input.now);
    const result = await this.pg.query(
      `SELECT * FROM rustdesk_access_policy_events
       WHERE tenant_id = $1 AND device_id = $2
       ORDER BY version ASC`,
      [tenantId, deviceId]
    );
    const stored = result.rows.map(decodeStoredPolicy);
    const latestVersion = stored.at(-1)?.version || 0;
    return {
      device_id: deviceId,
      events: stored.map((event) => toPublicPolicy(event, latestVersion, now))
    };
  }

  async assertUnattendedAccess(input: {
    tenant_id: string;
    device_id: string;
    business_ref: Pick<BusinessRef, 'type' | 'id'>;
    permissions: readonly RemoteConsentScope[];
    now?: Date;
  }): Promise<RustDeskAccessPolicyEvent> {
    const businessRef = normalizeBusinessRef(input.business_ref);
    const permissions = normalizeScopes(input.permissions, false);
    const current = await this.getCurrentPolicy({
      tenant_id: input.tenant_id,
      device_id: input.device_id,
      now: input.now
    });
    const policy = current.policy;
    if (
      current.state !== 'active' ||
      !policy ||
      policy.event_type !== 'configured' ||
      policy.mode !== 'unattended_allowed' ||
      policy.business_ref.type !== businessRef.type ||
      policy.business_ref.id !== businessRef.id
    ) {
      throw policyError('active unattended access policy required', 403);
    }
    const allowed = new Set(policy.allowed_scopes);
    const missing = permissions.find((permission) => !allowed.has(permission));
    if (missing) {
      throw Object.assign(policyError('access policy does not cover requested remote permissions', 403), {
        permission: missing
      });
    }
    return policy;
  }
}

async function withPolicyWriteLock<T>(
  pg: PgQueryable,
  input: { tenant_id: string; device_id: string; idempotency_key: string },
  fn: (lockedPg: PgQueryable) => Promise<T>
): Promise<T> {
  if (pg instanceof MemoryPg) {
    let locks = memoryPolicyLockTails.get(pg);
    if (!locks) {
      locks = new Map();
      memoryPolicyLockTails.set(pg, locks);
    }
    const lockKey = `${input.tenant_id}\u0000${input.device_id}`;
    const previous = locks.get(lockKey) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    locks.set(lockKey, current);
    await previous;
    try {
      return await fn(pg);
    } finally {
      release();
      if (locks.get(lockKey) === current) locks.delete(lockKey);
    }
  }
  return withPgTransaction(pg, async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [input.tenant_id, input.idempotency_key]
    );
    return fn(client);
  });
}

async function lockPolicyDevice(pg: PgQueryable, tenantId: string, deviceId: string) {
  const result = await pg.query(
    `SELECT id, business_ref_type, business_ref_id FROM rustdesk_devices
     WHERE tenant_id = $1 AND id = $2
     FOR UPDATE`,
    [tenantId, deviceId]
  );
  return result.rows[0] || null;
}

async function findIdempotentPolicy(
  pg: PgQueryable,
  tenantId: string,
  idempotencyKey: string
): Promise<StoredPolicy | null> {
  const result = await pg.query(
    `SELECT * FROM rustdesk_access_policy_events
     WHERE tenant_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [tenantId, idempotencyKey]
  );
  return result.rows[0] ? decodeStoredPolicy(result.rows[0]) : null;
}

async function findLatestStoredPolicy(
  pg: PgQueryable,
  tenantId: string,
  deviceId: string
): Promise<StoredPolicy | null> {
  const result = await pg.query(
    `SELECT * FROM rustdesk_access_policy_events
     WHERE tenant_id = $1 AND device_id = $2
     ORDER BY version DESC
     LIMIT 1`,
    [tenantId, deviceId]
  );
  return result.rows[0] ? decodeStoredPolicy(result.rows[0]) : null;
}

async function insertPolicyEvent(
  pg: PgQueryable,
  event: Omit<StoredPolicy, 'created_at'>
): Promise<StoredPolicy> {
  const result = await pg.query(
    `INSERT INTO rustdesk_access_policy_events
      (id, tenant_id, device_id, event_type, mode, allowed_scopes,
       business_ref_type, business_ref_id, approved_by, reason, expires_at,
       supersedes_id, version, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      event.id,
      event.tenant_id,
      event.device_id,
      event.event_type,
      event.mode,
      JSON.stringify(event.allowed_scopes),
      event.business_ref_type,
      event.business_ref_id,
      event.approved_by,
      event.reason,
      event.expires_at,
      event.supersedes_id,
      event.version,
      event.idempotency_key,
      event.request_hash
    ]
  );
  return decodeStoredPolicy(result.rows[0]);
}

function replayResult(stored: StoredPolicy, requestHash: string): RustDeskAccessPolicyMutationResult {
  if (stored.request_hash !== requestHash) {
    throw policyError('idempotency key was already used for a different request', 409);
  }
  return { policy: toPublicPolicy(stored, stored.version, new Date()), replayed: true };
}

function normalizeConfigureInput(input: ConfigureRustDeskAccessPolicyInput) {
  const identity = normalizeMutationIdentity(input);
  const mode = String(input.mode || '').trim();
  if (mode !== 'attended_only' && mode !== 'unattended_allowed') {
    throw policyError('mode must be attended_only or unattended_allowed');
  }
  const scopes = normalizeScopes(input.allowed_scopes, mode === 'unattended_allowed');
  if (mode === 'attended_only' && scopes.length) {
    throw policyError('attended_only policy must not grant unattended scopes');
  }
  return {
    ...identity,
    business_ref: normalizeBusinessRef(input.business_ref),
    mode: mode as RustDeskAccessPolicyMode,
    allowed_scopes: scopes,
    expires_at: input.expires_at == null ? null : validTimestamp(input.expires_at, 'expires_at')
  };
}

function normalizeMutationIdentity(input: RevokeRustDeskAccessPolicyInput) {
  const reason = requiredString(input.reason, 'reason is required');
  if (reason.length > 1000) throw policyError('reason must be at most 1000 characters');
  const idempotencyKey = requiredString(input.idempotency_key, 'Idempotency-Key is required');
  if (idempotencyKey.length > 200) throw policyError('Idempotency-Key must be at most 200 characters');
  return {
    tenant_id: requiredString(input.tenant_id, 'tenant_id is required'),
    device_id: requiredString(input.device_id, 'device_id is required'),
    approved_by: requiredString(input.approved_by, 'approved_by is required'),
    reason,
    idempotency_key: idempotencyKey
  };
}

function normalizeBusinessRef(value: Pick<BusinessRef, 'type' | 'id'>) {
  return {
    type: requiredString(value?.type, 'business_ref.type is required'),
    id: requiredString(value?.id, 'business_ref.id is required')
  };
}

function normalizeScopes(value: readonly RemoteConsentScope[], requireAtLeastOne: boolean) {
  if (!Array.isArray(value)) throw policyError('allowed_scopes must be an array');
  const scopes = [...new Set(value.map((scope) => String(scope).trim()))].sort();
  const unsupported = scopes.find((scope) => !REMOTE_SCOPES.has(scope as RemoteConsentScope));
  if (unsupported) throw policyError(`unsupported remote consent scope: ${unsupported}`);
  if (requireAtLeastOne && !scopes.length) throw policyError('allowed_scopes required for unattended access');
  return scopes as RemoteConsentScope[];
}

function requestHashFor(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function toPublicPolicy(
  stored: StoredPolicy,
  latestVersion: number,
  now: Date
): RustDeskAccessPolicyEvent {
  let state: RustDeskAccessPolicyState;
  if (stored.version < latestVersion) state = 'superseded';
  else if (stored.event_type === 'revoked') state = 'revoked';
  else if (stored.expires_at && Date.parse(stored.expires_at) <= now.getTime()) state = 'expired';
  else state = 'active';
  return {
    id: stored.id,
    tenant_id: stored.tenant_id,
    device_id: stored.device_id,
    event_type: stored.event_type,
    mode: stored.mode,
    allowed_scopes: [...stored.allowed_scopes],
    business_ref: { type: stored.business_ref_type, id: stored.business_ref_id },
    approved_by: stored.approved_by,
    reason: stored.reason,
    expires_at: stored.expires_at,
    version: stored.version,
    state,
    created_at: stored.created_at
  };
}

function decodeStoredPolicy(row: Record<string, unknown>): StoredPolicy {
  const rawScopes = Array.isArray(row.allowed_scopes)
    ? row.allowed_scopes
    : parseJson(String(row.allowed_scopes || '[]'), [] as unknown[]);
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    device_id: String(row.device_id),
    event_type: String(row.event_type) as RustDeskAccessPolicyEventType,
    mode: String(row.mode) as RustDeskAccessPolicyMode,
    allowed_scopes: rawScopes.map(String) as RemoteConsentScope[],
    business_ref_type: String(row.business_ref_type),
    business_ref_id: String(row.business_ref_id),
    approved_by: String(row.approved_by),
    reason: String(row.reason),
    expires_at: row.expires_at ? storedTimestamp(row.expires_at) : null,
    supersedes_id: row.supersedes_id ? String(row.supersedes_id) : null,
    version: Number(row.version),
    idempotency_key: String(row.idempotency_key),
    request_hash: String(row.request_hash),
    created_at: storedTimestamp(row.created_at)
  };
}

function storedTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function validTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, `${field} is required`);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) throw policyError(`${field} must be an ISO timestamp`);
  return parsed.toISOString();
}

function validNow(value: Date | undefined): Date {
  const now = value || new Date();
  if (Number.isNaN(now.getTime())) throw policyError('now must be a valid date');
  return now;
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw policyError(message);
  return normalized;
}

function policyError(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
