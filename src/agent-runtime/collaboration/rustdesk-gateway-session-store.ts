import type { PgQueryable } from '../../db-pg.js';
import { MemoryPg, pgId } from '../../db-pg.js';
import type { RemoteConsentScope } from './types.js';
import type { RemoteGatewayAuditEvent } from './remote-gateway-client.js';
import type { RemoteGatewayTarget } from './remote-gateway-adapter.js';
import {
  rustDeskGatewayEventPermissionError,
  rustDeskGatewayEventValidationError
} from './rustdesk-gateway-event.js';

const RUSTDESK_GATEWAY_SESSION_PERMISSION_SCOPES = new Set<string>([
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard'
]);

export interface RustDeskGatewaySession {
  external_id: string;
  tenant_id: string;
  status: 'active' | 'ended';
  target: RemoteGatewayTarget;
  permissions: RemoteConsentScope[];
  actor_identity: string;
  launch_url: string;
  metadata: Record<string, unknown>;
  created_at: string;
  ended_at: string | null;
  ended_by: string;
}

export interface RustDeskGatewayAuditEventInput {
  external_id: string;
  event_type: string;
  actor_identity: string;
  target?: string;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
  occurred_at?: string;
}

export interface ListRustDeskGatewaySessionsInput {
  tenant_id: string;
  status?: 'active' | 'ended';
  limit?: number;
}

export class RustDeskGatewaySessionStore {
  constructor(private readonly pg: PgQueryable) {}

  async createSession(input: {
    external_id?: string;
    tenant_id: string;
    target: RemoteGatewayTarget;
    permissions: RemoteConsentScope[];
    actor_identity: string;
    launch_url: string;
    metadata?: Record<string, unknown>;
  }): Promise<RustDeskGatewaySession> {
    const externalId = input.external_id === undefined
      ? pgId('rdgw')
      : rustDeskGatewayRequiredString(input.external_id, 'external_id is required');
    const tenantId = rustDeskGatewayRequiredString(input.tenant_id, 'tenant_id is required');
    const target = rustDeskGatewaySessionTarget(input.target);
    const permissions = rustDeskGatewaySessionPermissions(input.permissions);
    const actorIdentity = rustDeskGatewayRequiredString(input.actor_identity, 'actor_identity is required');
    const launchUrl = rustDeskGatewayLaunchUrl(input.launch_url);
    await this.pg.query(
      `INSERT INTO rustdesk_gateway_sessions
        (external_id, tenant_id, status, target_type, target_id, target_display_name,
         permissions, actor_identity, launch_url, metadata)
       VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9)`,
      [
        externalId,
        tenantId,
        target.type,
        target.id,
        target.display_name || '',
        toJson(permissions),
        actorIdentity,
        launchUrl,
        toJson(input.metadata || {})
      ]
    );
    return (await this.getSession(externalId))!;
  }

  async getSession(externalId: string): Promise<RustDeskGatewaySession | null> {
    const normalizedExternalId = rustDeskGatewayRequiredString(externalId, 'external_id is required');
    const result = await this.pg.query(
      'SELECT * FROM rustdesk_gateway_sessions WHERE external_id = $1',
      [normalizedExternalId]
    );
    return result.rows[0] ? decodeSession(result.rows[0]) : null;
  }

  async getSignedLaunchSession(externalId: string): Promise<RustDeskGatewaySession | null> {
    if (this.pg instanceof MemoryPg) return this.getSession(externalId);
    const normalizedExternalId = rustDeskGatewayRequiredString(externalId, 'external_id is required');
    const result = await this.pg.query(
      'SELECT * FROM opc_rustdesk_session_by_external_id($1)',
      [normalizedExternalId]
    );
    return result.rows[0] ? decodeSession(result.rows[0]) : null;
  }

  async listSessions(input: ListRustDeskGatewaySessionsInput): Promise<RustDeskGatewaySession[]> {
    const tenantId = rustDeskGatewayRequiredString(input.tenant_id, 'tenant_id is required');
    const limit = rustDeskGatewaySessionLimit(input.limit);
    const result = input.status
      ? await this.pg.query(
        `SELECT * FROM rustdesk_gateway_sessions
         WHERE tenant_id = $1 AND status = $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [tenantId, input.status, limit]
      )
      : await this.pg.query(
        `SELECT * FROM rustdesk_gateway_sessions
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [tenantId, limit]
      );
    return result.rows.map(decodeSession);
  }

  async endSession(input: {
    external_id: string;
    actor_identity: string;
  }): Promise<RustDeskGatewaySession | null> {
    const externalId = rustDeskGatewayRequiredString(input.external_id, 'external_id is required');
    const actorIdentity = rustDeskGatewayRequiredString(input.actor_identity, 'actor_identity is required');
    await this.pg.query(
      `UPDATE rustdesk_gateway_sessions
       SET status = 'ended',
           ended_by = CASE WHEN ended_at IS NULL THEN $2 ELSE ended_by END,
           ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP)
       WHERE external_id = $1`,
      [externalId, actorIdentity]
    );
    return this.getSession(externalId);
  }

  async listAuditEvents(input: { external_id: string; since?: string }): Promise<RemoteGatewayAuditEvent[] | null> {
    const externalId = rustDeskGatewayRequiredString(input.external_id, 'external_id is required');
    const session = await this.getSession(externalId);
    if (!session) return null;
    const storedEvents = await this.pg.query(
      `SELECT * FROM rustdesk_gateway_events
       WHERE external_id = $1
       ORDER BY occurred_at ASC, created_at ASC`,
      [externalId]
    );
    const events: RemoteGatewayAuditEvent[] = [
      {
        external_id: session.external_id,
        event_type: 'remote.gateway_session.created',
        actor_identity: session.actor_identity,
        target: session.target.id,
        metadata: session.metadata,
        occurred_at: session.created_at
      }
    ];
    events.push(...storedEvents.rows.map(decodeAuditEvent));
    if (session.ended_at) {
      events.push({
        external_id: session.external_id,
        event_type: 'remote.gateway_session.ended',
        actor_identity: session.ended_by || session.actor_identity,
        target: session.target.id,
        metadata: {
          ...session.metadata,
          reason: 'session_ended'
        },
        occurred_at: session.ended_at
      });
    }
    const sinceMs = rustDeskGatewayAuditSince(input.since);
    if (sinceMs === null) return events;
    return events.filter((event) => new Date(event.occurred_at).getTime() > sinceMs);
  }

  async appendAuditEvent(input: RustDeskGatewayAuditEventInput): Promise<RemoteGatewayAuditEvent | null> {
    const externalId = rustDeskGatewayRequiredString(input.external_id, 'external_id is required');
    const eventType = rustDeskGatewayRequiredString(input.event_type, 'event_type is required');
    const actorIdentity = rustDeskGatewayRequiredString(input.actor_identity, 'actor_identity is required');
    const session = await this.getSession(externalId);
    if (!session) return null;
    if (session.status !== 'active') {
      throw Object.assign(new Error('RustDesk gateway session is not active'), { status: 409 });
    }
    const inputMetadata = rustDeskGatewayEventMetadata(input.metadata);
    const validationError = rustDeskGatewayEventValidationError(eventType, inputMetadata);
    if (validationError) {
      throw Object.assign(new Error(validationError), { status: 400 });
    }
    const permissionError = rustDeskGatewayEventPermissionError(
      eventType,
      inputMetadata,
      session.permissions
    );
    if (permissionError) {
      throw Object.assign(new Error(permissionError), { status: 403 });
    }
    const eventTarget = rustDeskGatewayEventTarget(input.target, session);
    const idempotencyKey = String(input.idempotency_key || '').trim();
    if (idempotencyKey) {
      const existing = await this.pg.query(
        `SELECT * FROM rustdesk_gateway_events
         WHERE external_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [session.external_id, idempotencyKey]
      );
      if (existing.rows[0]) return decodeAuditEvent(existing.rows[0]);
    }
    const metadata = {
      ...inputMetadata,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
    };
    const occurredAt = rustDeskGatewayEventOccurredAt(input.occurred_at);
    const event: RemoteGatewayAuditEvent = {
      external_id: session.external_id,
      event_type: eventType,
      actor_identity: actorIdentity,
      target: eventTarget,
      metadata,
      occurred_at: occurredAt || new Date().toISOString()
    };
    await this.pg.query(
      `INSERT INTO rustdesk_gateway_events
        (id, external_id, tenant_id, event_type, actor_identity, target, idempotency_key, metadata, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        pgId('rdgev'),
        event.external_id,
        session.tenant_id,
        event.event_type,
        event.actor_identity,
        event.target,
        idempotencyKey,
        toJson(event.metadata),
        event.occurred_at
      ]
    );
    return event;
  }
}

function decodeAuditEvent(row: Record<string, unknown>): RemoteGatewayAuditEvent {
  const idempotencyKey = String(row.idempotency_key || '');
  const metadata = parseJson(String(row.metadata || '{}'), {});
  return {
    external_id: String(row.external_id),
    event_type: String(row.event_type || 'remote.rustdesk.event'),
    actor_identity: String(row.actor_identity || ''),
    target: String(row.target || ''),
    metadata: {
      ...metadata,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
    },
    occurred_at: String(row.occurred_at)
  };
}

function decodeSession(row: Record<string, unknown>): RustDeskGatewaySession {
  return {
    external_id: String(row.external_id),
    tenant_id: String(row.tenant_id || 'system'),
    status: String(row.status || 'active') as RustDeskGatewaySession['status'],
    target: {
      type: String(row.target_type || 'device'),
      id: String(row.target_id || ''),
      display_name: row.target_display_name ? String(row.target_display_name) : undefined
    },
    permissions: parseJson(String(row.permissions || '[]'), []) as RemoteConsentScope[],
    actor_identity: String(row.actor_identity || ''),
    launch_url: String(row.launch_url || ''),
    metadata: parseJson(String(row.metadata || '{}'), {}),
    created_at: String(row.created_at),
    ended_at: row.ended_at ? String(row.ended_at) : null,
    ended_by: String(row.ended_by || '')
  };
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function rustDeskGatewayRequiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw Object.assign(new Error(message), { status: 400 });
  }
  return normalized;
}

function rustDeskGatewaySessionTarget(value: RemoteGatewayTarget): RemoteGatewayTarget {
  const target = value || { type: 'device', id: '' };
  return {
    type: String(target.type || 'device').trim() || 'device',
    id: rustDeskGatewayRequiredString(target.id, 'target id is required'),
    display_name: target.display_name ? String(target.display_name).trim() : undefined
  };
}

function rustDeskGatewaySessionPermissions(value: readonly unknown[] | undefined): RemoteConsentScope[] {
  const permissions = Array.isArray(value)
    ? value.map((permission) => String(permission).trim()).filter(Boolean)
    : [];
  if (!permissions.length) {
    throw Object.assign(new Error('permissions required'), { status: 400 });
  }
  const unsupportedPermission = permissions.find(
    (permission) => !RUSTDESK_GATEWAY_SESSION_PERMISSION_SCOPES.has(permission)
  );
  if (unsupportedPermission) {
    throw Object.assign(new Error(`unsupported RustDesk permission scope: ${unsupportedPermission}`), { status: 400 });
  }
  return permissions as RemoteConsentScope[];
}

function rustDeskGatewaySessionLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw Object.assign(new Error('limit must be an integer from 1 to 200'), { status: 400 });
  }
  return value;
}

function rustDeskGatewayLaunchUrl(value: unknown): string {
  const launchUrl = rustDeskGatewayRequiredString(value, 'launch_url is required');
  let protocol = '';
  try {
    protocol = new URL(launchUrl).protocol;
  } catch {
    throw Object.assign(new Error('launch_url must be http(s)'), { status: 400 });
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw Object.assign(new Error('launch_url must be http(s)'), { status: 400 });
  }
  return launchUrl;
}

function rustDeskGatewayEventOccurredAt(value: string | undefined): string {
  if (value === undefined) return '';
  const occurredAt = String(value).trim();
  if (!occurredAt || Number.isNaN(new Date(occurredAt).getTime())) {
    throw Object.assign(new Error('occurred_at must be an ISO timestamp'), { status: 400 });
  }
  return occurredAt;
}

function rustDeskGatewayEventMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  throw Object.assign(new Error('RustDesk event metadata must be a JSON object'), { status: 400 });
}

function rustDeskGatewayEventTarget(value: string | undefined, session: RustDeskGatewaySession): string {
  const target = String(value || '').trim();
  if (!target) return session.target.id;
  const allowedTargets = [
    String(session.target.id || '').trim(),
    rustDeskGatewayMetadataString(session.metadata.rustdesk_id),
    rustDeskGatewayMetadataString(session.metadata.target_id),
    rustDeskGatewayMetadataString(session.metadata.rustdesk_device_id)
  ].filter((candidate) => Boolean(candidate));
  if (!allowedTargets.includes(target)) {
    throw Object.assign(new Error('RustDesk event target must match gateway session target'), { status: 400 });
  }
  return target;
}

function rustDeskGatewayMetadataString(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  return '';
}

function rustDeskGatewayAuditSince(value: string | undefined): number | null {
  if (value === undefined) return null;
  const since = String(value).trim();
  if (!since) return null;
  const sinceMs = new Date(since).getTime();
  if (Number.isNaN(sinceMs)) {
    throw Object.assign(new Error('since must be an ISO timestamp'), { status: 400 });
  }
  return sinceMs;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
