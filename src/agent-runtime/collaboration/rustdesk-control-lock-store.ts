import { pgId, type PgQueryable } from '../../db-pg.js';
import { withRustDeskAuthorizationLocks } from './rustdesk-gateway-authorization-lock.js';

export type RustDeskConfirmedOperation =
  | 'control_mouse_keyboard'
  | 'transfer_file'
  | 'clipboard'
  | 'unattended_launch'
  | 'control_transfer';

export interface RustDeskControlOwnership {
  status: 'unowned' | 'owned' | 'released' | 'expired';
  owner_identity: string | null;
  lease_expires_at: string | null;
  version: number;
  updated_at: string;
}

export interface RustDeskSecondaryConfirmation {
  id: string;
  external_id: string;
  actor_identity: string;
  operation: RustDeskConfirmedOperation;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

const OPERATIONS = new Set<RustDeskConfirmedOperation>([
  'control_mouse_keyboard', 'transfer_file', 'clipboard', 'unattended_launch', 'control_transfer'
]);

export class RustDeskControlLockStore {
  constructor(private readonly pg: PgQueryable) {}

  async getOwnership(input: { tenant_id: string; external_id: string; now?: string }): Promise<RustDeskControlOwnership> {
    const row = await this.lockRow(input.tenant_id, input.external_id);
    return ownership(row, input.now || new Date().toISOString());
  }

  async issueConfirmation(input: {
    tenant_id: string;
    external_id: string;
    actor_identity: string;
    operation: RustDeskConfirmedOperation;
    ttl_seconds?: number;
    now?: string;
  }): Promise<RustDeskSecondaryConfirmation> {
    const normalized = normalizeIdentity(input);
    const operation = normalizeOperation(input.operation);
    const ttl = input.ttl_seconds ?? 120;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 300) throw controlError('confirmation ttl_seconds must be from 30 to 300', 400);
    const now = input.now || new Date().toISOString();
    await this.requireActiveSession(normalized.tenant_id, normalized.external_id, operationPermission(operation));
    const result = await this.pg.query(
      `INSERT INTO rustdesk_secondary_confirmations
        (id, tenant_id, external_id, actor_identity, operation, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [pgId('rdconfirm'), normalized.tenant_id, normalized.external_id, normalized.actor_identity,
        operation, new Date(new Date(now).getTime() + ttl * 1000).toISOString(), now]
    );
    return decodeConfirmation(result.rows[0]);
  }

  async acquire(input: {
    tenant_id: string; external_id: string; actor_identity: string; confirmation_id: string;
    lease_ms?: number; now?: string;
  }): Promise<RustDeskControlOwnership> {
    return this.withLock(input, async () => {
      const now = input.now || new Date().toISOString();
      await this.requireActiveSession(input.tenant_id, input.external_id, 'control_mouse_keyboard');
      await this.consumeConfirmation({ ...input, operation: 'control_mouse_keyboard', now });
      const current = ownership(await this.lockRow(input.tenant_id, input.external_id), now);
      if (current.status === 'owned' && current.owner_identity !== input.actor_identity) {
        throw controlError('RustDesk control is already owned', 409);
      }
      return this.writeLock(input, input.actor_identity, current.version + 1, now, 'acquired');
    });
  }

  async heartbeat(input: {
    tenant_id: string; external_id: string; actor_identity: string; version: number;
    lease_ms?: number; now?: string;
  }): Promise<RustDeskControlOwnership> {
    return this.withLock(input, async () => {
      const now = input.now || new Date().toISOString();
      await this.requireActiveSession(input.tenant_id, input.external_id);
      const current = ownership(await this.lockRow(input.tenant_id, input.external_id), now);
      assertOwner(current, input.actor_identity, input.version);
      return this.writeLock(input, input.actor_identity, current.version + 1, now, 'heartbeat');
    });
  }

  async release(input: {
    tenant_id: string; external_id: string; actor_identity: string; version: number; now?: string;
  }): Promise<RustDeskControlOwnership> {
    return this.withLock(input, async () => {
      const now = input.now || new Date().toISOString();
      await this.requireActiveSession(input.tenant_id, input.external_id);
      const current = ownership(await this.lockRow(input.tenant_id, input.external_id), now);
      assertOwner(current, input.actor_identity, input.version);
      const version = current.version + 1;
      await this.pg.query(
        `UPDATE rustdesk_control_locks SET status = 'released', version = $3, updated_at = $4
         WHERE tenant_id = $1 AND external_id = $2`,
        [input.tenant_id, input.external_id, version, now]
      );
      await this.insertEvent(input, 'released', version, now, input.actor_identity, null);
      return { status: 'released', owner_identity: null, lease_expires_at: null, version, updated_at: now };
    });
  }

  async transfer(input: {
    tenant_id: string; external_id: string; actor_identity: string; to_identity: string;
    confirmation_id: string; version: number; lease_ms?: number; now?: string;
  }): Promise<RustDeskControlOwnership> {
    return this.withLock(input, async () => {
      const now = input.now || new Date().toISOString();
      await this.requireActiveSession(input.tenant_id, input.external_id, 'control_mouse_keyboard');
      const target = required(input.to_identity, 'to_identity');
      if (target === input.actor_identity) throw controlError('control transfer target must be different', 400);
      const current = ownership(await this.lockRow(input.tenant_id, input.external_id), now);
      assertOwner(current, input.actor_identity, input.version);
      await this.consumeConfirmation({ ...input, operation: 'control_transfer', now });
      return this.writeLock(input, target, current.version + 1, now, 'transferred', input.actor_identity);
    });
  }

  async confirmOperation(input: {
    tenant_id: string; external_id: string; actor_identity: string; operation: RustDeskConfirmedOperation;
    confirmation_id: string; version?: number; now?: string;
  }): Promise<void> {
    await this.withLock(input, async () => {
      const now = input.now || new Date().toISOString();
      await this.requireActiveSession(input.tenant_id, input.external_id, input.operation === 'unattended_launch' ? undefined : input.operation);
      if (input.operation !== 'unattended_launch') {
        const current = ownership(await this.lockRow(input.tenant_id, input.external_id), now);
        assertOwner(current, input.actor_identity, Number(input.version));
      }
      await this.consumeConfirmation({ ...input, now });
    });
  }

  private async withLock<T>(input: { tenant_id: string; external_id: string; actor_identity: string }, fn: () => Promise<T>) {
    normalizeIdentity(input);
    return withRustDeskAuthorizationLocks(this.pg, [`control:${input.tenant_id}:${input.external_id}`], () => fn());
  }

  private async requireActiveSession(tenantId: string, externalId: string, permission?: string) {
    const result = await this.pg.query(
      `SELECT external_id, status, permissions FROM rustdesk_gateway_sessions
       WHERE tenant_id = $1 AND external_id = $2 FOR UPDATE`, [tenantId, externalId]
    );
    const row = result.rows[0];
    if (!row) throw controlError('rustdesk gateway session not found', 404);
    if (String(row.status) !== 'active') throw controlError('RustDesk gateway session is terminal', 409);
    if (permission && !jsonArray(row.permissions).includes(permission)) throw controlError(`RustDesk permission ${permission} is not granted`, 403);
  }

  private async lockRow(tenantId: string, externalId: string) {
    const result = await this.pg.query(
      `SELECT * FROM rustdesk_control_locks WHERE tenant_id = $1 AND external_id = $2 FOR UPDATE`,
      [tenantId, externalId]
    );
    return result.rows[0] || null;
  }

  private async consumeConfirmation(input: {
    tenant_id: string; external_id: string; actor_identity: string; operation: RustDeskConfirmedOperation;
    confirmation_id: string; now: string;
  }) {
    const eventId = pgId('rdctrl');
    const result = await this.pg.query(
      `UPDATE rustdesk_secondary_confirmations SET consumed_at = $6, consumed_by_event_id = $7
       WHERE id = $1 AND tenant_id = $2 AND external_id = $3 AND actor_identity = $4
         AND operation = $5 AND consumed_at IS NULL AND expires_at > $6
       RETURNING *`,
      [required(input.confirmation_id, 'confirmation_id'), input.tenant_id, input.external_id,
        input.actor_identity, normalizeOperation(input.operation), input.now, eventId]
    );
    if (!result.rows[0]) throw controlError('fresh secondary confirmation required', 403);
    return eventId;
  }

  private async writeLock(
    input: { tenant_id: string; external_id: string; actor_identity: string; lease_ms?: number },
    owner: string, version: number, now: string, eventType: string, previousOwner: string | null = null
  ) {
    const leaseMs = input.lease_ms ?? 30_000;
    if (!Number.isInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 120_000) throw controlError('lease_ms must be from 5000 to 120000', 400);
    const expires = new Date(new Date(now).getTime() + leaseMs).toISOString();
    const result = await this.pg.query(
      `INSERT INTO rustdesk_control_locks
        (tenant_id, external_id, owner_identity, status, lease_expires_at, version, updated_at)
       VALUES ($1, $2, $3, 'owned', $4, $5, $6)
       ON CONFLICT (tenant_id, external_id) DO UPDATE SET owner_identity = EXCLUDED.owner_identity,
         status = 'owned', lease_expires_at = EXCLUDED.lease_expires_at, version = EXCLUDED.version,
         updated_at = EXCLUDED.updated_at RETURNING *`,
      [input.tenant_id, input.external_id, owner, expires, version, now]
    );
    await this.insertEvent(input, eventType, version, now, previousOwner, owner);
    return ownership(result.rows[0], now);
  }

  private async insertEvent(input: { tenant_id: string; external_id: string; actor_identity: string }, eventType: string,
    version: number, now: string, previousOwner: string | null, owner: string | null) {
    await this.pg.query(
      `INSERT INTO rustdesk_control_events
        (id, tenant_id, external_id, event_type, actor_identity, previous_owner_identity,
         owner_identity, lock_version, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, $9)`,
      [pgId('rdctrl'), input.tenant_id, input.external_id, eventType, input.actor_identity,
        previousOwner, owner, version, now]
    );
  }
}

function ownership(row: Record<string, unknown> | null, now: string): RustDeskControlOwnership {
  if (!row) return { status: 'unowned', owner_identity: null, lease_expires_at: null, version: 0, updated_at: now };
  const expired = String(row.status) === 'owned' && new Date(String(row.lease_expires_at)).getTime() <= new Date(now).getTime();
  return {
    status: expired ? 'expired' : String(row.status) as RustDeskControlOwnership['status'],
    owner_identity: expired || String(row.status) === 'released' ? null : String(row.owner_identity),
    lease_expires_at: expired || String(row.status) === 'released' ? null : String(row.lease_expires_at),
    version: Number(row.version), updated_at: String(row.updated_at)
  };
}

function assertOwner(current: RustDeskControlOwnership, actor: string, version: number) {
  if (current.status !== 'owned' || current.owner_identity !== actor) throw controlError('active control owner required', 409);
  if (!Number.isInteger(version) || current.version !== version) throw controlError('stale control ownership version', 409);
}

function normalizeIdentity<T extends { tenant_id: string; external_id: string; actor_identity: string }>(input: T) {
  return { ...input, tenant_id: required(input.tenant_id, 'tenant_id'), external_id: required(input.external_id, 'external_id'),
    actor_identity: required(input.actor_identity, 'actor_identity') };
}
function normalizeOperation(value: string): RustDeskConfirmedOperation {
  if (!OPERATIONS.has(value as RustDeskConfirmedOperation)) throw controlError('unsupported secondary confirmation operation', 400);
  return value as RustDeskConfirmedOperation;
}
function operationPermission(operation: RustDeskConfirmedOperation): string | undefined {
  if (operation === 'control_transfer') return 'control_mouse_keyboard';
  if (operation === 'unattended_launch') return undefined;
  return operation;
}
function required(value: unknown, field: string) { const result = String(value || '').trim(); if (!result) throw controlError(`${field} is required`, 400); return result; }
function jsonArray(value: unknown): string[] { try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } }
function decodeConfirmation(row: Record<string, unknown>): RustDeskSecondaryConfirmation { return { id: String(row.id), external_id: String(row.external_id), actor_identity: String(row.actor_identity), operation: String(row.operation) as RustDeskConfirmedOperation, expires_at: String(row.expires_at), consumed_at: row.consumed_at ? String(row.consumed_at) : null, created_at: String(row.created_at) }; }
function controlError(message: string, status: number) { return Object.assign(new Error(message), { status }); }
