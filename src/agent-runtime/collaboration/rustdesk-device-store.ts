import type { PgQueryable } from '../../db-pg.js';
import { pgId } from '../../db-pg.js';
import type { BusinessRef } from './types.js';

export interface RustDeskDevice {
  id: string;
  tenant_id: string;
  business_ref_type: string;
  business_ref_id: string;
  rustdesk_id: string;
  display_name: string;
  status: 'active' | 'inactive';
  runtime_status: 'unknown' | 'online' | 'offline';
  last_seen_at: string | null;
  last_seen_actor: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deactivated_at: string | null;
}

export interface RegisterRustDeskDeviceInput {
  tenant_id: string;
  business_ref: BusinessRef;
  rustdesk_id: string;
  display_name: string;
  metadata?: Record<string, unknown>;
}

export interface HeartbeatRustDeskDeviceInput {
  tenant_id: string;
  device_id: string;
  actor_identity: string;
  runtime_status?: 'online' | 'offline';
  seen_at?: string;
  metadata?: Record<string, unknown>;
}

export class RustDeskDeviceStore {
  constructor(private readonly pg: PgQueryable) {}

  async registerDevice(input: RegisterRustDeskDeviceInput): Promise<RustDeskDevice> {
    const ref = rustDeskDeviceBusinessRef(input.tenant_id, input.business_ref);
    const rustdeskId = String(input.rustdesk_id || '').trim();
    const displayName = String(input.display_name || '').trim();
    if (!rustdeskId) {
      throw Object.assign(new Error('rustdesk_id is required'), { status: 400 });
    }
    if (!displayName) {
      throw Object.assign(new Error('display_name is required'), { status: 400 });
    }
    const existing = await this.pg.query(
      `SELECT * FROM rustdesk_devices
       WHERE tenant_id = $1 AND rustdesk_id = $2 AND deactivated_at IS NULL
       LIMIT 1`,
      [ref.tenant_id, rustdeskId]
    );
    if (existing.rows[0]) {
      throw Object.assign(new Error('rustdesk device already registered'), { status: 409 });
    }

    const deviceId = pgId('rdesk');
    await this.pg.query(
      `INSERT INTO rustdesk_devices
        (id, tenant_id, business_ref_type, business_ref_id, rustdesk_id, display_name, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
      [
        deviceId,
        ref.tenant_id,
        ref.type,
        ref.id,
        rustdeskId,
        displayName,
        toJson(input.metadata || {})
      ]
    );
    return (await this.getDevice({ tenant_id: ref.tenant_id, device_id: deviceId }))!;
  }

  async getDevice(input: { tenant_id: string; device_id: string }): Promise<RustDeskDevice | null> {
    const tenantId = rustDeskDeviceRequiredString(input.tenant_id, 'tenant_id is required');
    const deviceId = rustDeskDeviceRequiredString(input.device_id, 'device_id is required');
    const result = await this.pg.query(
      `SELECT * FROM rustdesk_devices
       WHERE tenant_id = $1 AND id = $2
       LIMIT 1`,
      [tenantId, deviceId]
    );
    return result.rows[0] ? decodeDevice(result.rows[0]) : null;
  }

  async getByBusinessRef(input: {
    tenant_id: string;
    business_ref: BusinessRef;
    limit?: number;
  }): Promise<RustDeskDevice[]> {
    const ref = rustDeskDeviceBusinessRef(input.tenant_id, input.business_ref);
    const limit = rustDeskDeviceLimit(input.limit);
    const result = await this.pg.query(
      `SELECT * FROM rustdesk_devices
       WHERE tenant_id = $1 AND business_ref_type = $2 AND business_ref_id = $3 AND deactivated_at IS NULL
       ORDER BY created_at DESC
       LIMIT $4`,
      [ref.tenant_id, ref.type, ref.id, limit]
    );
    return result.rows.map(decodeDevice);
  }

  async deactivateDevice(input: { tenant_id: string; device_id: string }): Promise<RustDeskDevice | null> {
    const tenantId = rustDeskDeviceRequiredString(input.tenant_id, 'tenant_id is required');
    const deviceId = rustDeskDeviceRequiredString(input.device_id, 'device_id is required');
    await this.pg.query(
      `UPDATE rustdesk_devices
       SET status = 'inactive', updated_at = CURRENT_TIMESTAMP, deactivated_at = COALESCE(deactivated_at, CURRENT_TIMESTAMP)
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, deviceId]
    );
    return this.getDevice({ tenant_id: tenantId, device_id: deviceId });
  }

  async heartbeatDevice(input: HeartbeatRustDeskDeviceInput): Promise<RustDeskDevice | null> {
    const tenantId = rustDeskDeviceRequiredString(input.tenant_id, 'tenant_id is required');
    const deviceId = rustDeskDeviceRequiredString(input.device_id, 'device_id is required');
    const actorIdentity = rustDeskDeviceRequiredString(input.actor_identity, 'actor_identity is required');
    const device = await this.getDevice({
      tenant_id: tenantId,
      device_id: deviceId
    });
    if (!device || device.deactivated_at) return null;
    const runtimeStatus = input.runtime_status === undefined ? 'online' : String(input.runtime_status).trim();
    if (runtimeStatus !== 'online' && runtimeStatus !== 'offline') {
      throw Object.assign(new Error('runtime_status must be online or offline'), { status: 400 });
    }
    const seenAt = input.seen_at || new Date().toISOString();
    if (Number.isNaN(new Date(seenAt).getTime())) {
      throw Object.assign(new Error('seen_at must be an ISO timestamp'), { status: 400 });
    }
    const metadata = {
      ...device.metadata,
      last_heartbeat: {
        ...(input.metadata || {}),
        actor_identity: actorIdentity,
        runtime_status: runtimeStatus,
        seen_at: seenAt
      }
    };
    await this.pg.query(
      `UPDATE rustdesk_devices
       SET runtime_status = $3, last_seen_at = $4, last_seen_actor = $5, metadata = $6, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND id = $2 AND deactivated_at IS NULL`,
      [tenantId, deviceId, runtimeStatus, seenAt, actorIdentity, toJson(metadata)]
    );
    return this.getDevice({
      tenant_id: tenantId,
      device_id: deviceId
    });
  }
}

function rustDeskDeviceRequiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw Object.assign(new Error(message), { status: 400 });
  return normalized;
}

function rustDeskDeviceBusinessRef(
  tenantIdValue: string,
  businessRefValue: BusinessRef
): { tenant_id: string; type: string; id: string } {
  const tenantId = rustDeskDeviceRequiredString(tenantIdValue, 'tenant_id is required');
  const businessRef = businessRefValue || { tenant_id: '', type: '', id: '' };
  const businessRefTenantId = String(businessRef.tenant_id || '').trim();
  if (businessRefTenantId && businessRefTenantId !== tenantId) {
    throw Object.assign(new Error('business_ref tenant mismatch'), { status: 400 });
  }
  return {
    tenant_id: tenantId,
    type: rustDeskDeviceRequiredString(businessRef.type, 'business_ref type is required'),
    id: rustDeskDeviceRequiredString(businessRef.id, 'business_ref id is required')
  };
}

function rustDeskDeviceLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw Object.assign(new Error('limit must be an integer from 1 to 200'), { status: 400 });
  }
  return value;
}

function decodeDevice(row: Record<string, unknown>): RustDeskDevice {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    business_ref_type: String(row.business_ref_type),
    business_ref_id: String(row.business_ref_id),
    rustdesk_id: String(row.rustdesk_id),
    display_name: String(row.display_name || ''),
    status: String(row.status || 'active') as RustDeskDevice['status'],
    runtime_status: String(row.runtime_status || 'unknown') as RustDeskDevice['runtime_status'],
    last_seen_at: row.last_seen_at ? String(row.last_seen_at) : null,
    last_seen_actor: String(row.last_seen_actor || ''),
    metadata: parseJson(String(row.metadata || '{}'), {}),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at || row.created_at),
    deactivated_at: row.deactivated_at ? String(row.deactivated_at) : null
  };
}

function toJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
