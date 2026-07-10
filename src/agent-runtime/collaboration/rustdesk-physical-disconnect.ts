import type { PgQueryable } from '../../db-pg.js';
import { pgId } from '../../db-pg.js';
import {
  RustDeskDeviceCommandStore,
  rustDeskDisconnectReason,
  type RustDeskDeviceCommand,
  type RustDeskDeviceCommandStatus,
  type RustDeskDisconnectReason
} from './rustdesk-device-command-store.js';
import {
  RustDeskGatewaySessionStore,
  type RustDeskGatewaySession
} from './rustdesk-gateway-session-store.js';

export interface RustDeskPhysicalDisconnectSummary {
  required: true;
  command_id?: string;
  status: RustDeskDeviceCommandStatus | 'unavailable';
}

export interface EndRustDeskGatewaySessionWithPhysicalDisconnectInput {
  tenant_id?: string;
  external_id: string;
  actor_identity: string;
  requested_reason: RustDeskDisconnectReason;
}

export interface EndRustDeskGatewaySessionWithPhysicalDisconnectResult {
  session: RustDeskGatewaySession;
  command: RustDeskDeviceCommand | null;
  physical_disconnect: RustDeskPhysicalDisconnectSummary;
}

export class RustDeskPhysicalDisconnectService {
  private readonly sessions: RustDeskGatewaySessionStore;
  private readonly commands: RustDeskDeviceCommandStore;

  constructor(private readonly pg: PgQueryable) {
    this.sessions = new RustDeskGatewaySessionStore(pg);
    this.commands = new RustDeskDeviceCommandStore(pg);
  }

  async endGatewaySession(
    input: EndRustDeskGatewaySessionWithPhysicalDisconnectInput
  ): Promise<EndRustDeskGatewaySessionWithPhysicalDisconnectResult> {
    const externalId = requiredString(input.external_id, 'external_id is required');
    const actorIdentity = requiredString(input.actor_identity, 'actor_identity is required');
    const requestedReason = rustDeskDisconnectReason(input.requested_reason);
    const session = await this.sessions.getSession(externalId);
    const tenantId = String(input.tenant_id || session?.tenant_id || '').trim();
    if (!session || !tenantId || session.tenant_id !== tenantId) {
      throw Object.assign(new Error('rustdesk gateway session not found'), { status: 404 });
    }

    const ended = await this.sessions.endSession({
      external_id: externalId,
      actor_identity: actorIdentity
    });
    if (!ended) throw Object.assign(new Error('rustdesk gateway session not found'), { status: 404 });
    const deviceId = String(ended.metadata.rustdesk_device_id || '').trim();
    if (!deviceId) {
      await this.appendUnavailableEvent(ended, requestedReason);
      return unavailableResult(ended);
    }

    try {
      const command = await this.commands.enqueueDisconnect({
        tenant_id: ended.tenant_id,
        device_id: deviceId,
        external_id: ended.external_id,
        requested_by: ended.ended_by || actorIdentity,
        requested_reason: requestedReason
      });
      return {
        session: ended,
        command,
        physical_disconnect: {
          required: true,
          command_id: command.id,
          status: command.status
        }
      };
    } catch (error) {
      if (errorStatus(error) !== 404) throw error;
      await this.appendUnavailableEvent(ended, requestedReason);
      return unavailableResult(ended);
    }
  }

  private async appendUnavailableEvent(
    session: RustDeskGatewaySession,
    requestedReason: RustDeskDisconnectReason
  ): Promise<void> {
    const idempotencyKey = `disconnect:${session.external_id}:unavailable`;
    const existing = await this.pg.query(
      `SELECT * FROM rustdesk_gateway_events
       WHERE external_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [session.external_id, idempotencyKey]
    );
    if (existing.rows[0]) return;
    await this.pg.query(
      `INSERT INTO rustdesk_gateway_events
        (id, external_id, tenant_id, event_type, actor_identity, target, idempotency_key, metadata, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (external_id, idempotency_key)
       WHERE idempotency_key <> ''
       DO NOTHING`,
      [
        pgId('rdgev'),
        session.external_id,
        session.tenant_id,
        'remote.rustdesk.disconnect.unavailable',
        session.ended_by || session.actor_identity,
        session.target.id,
        idempotencyKey,
        JSON.stringify({
          external_id: session.external_id,
          requested_reason: requestedReason,
          rustdesk_target_mode: String(session.metadata.rustdesk_target_mode || 'raw_id')
        }),
        new Date().toISOString()
      ]
    );
  }
}

function unavailableResult(session: RustDeskGatewaySession): EndRustDeskGatewaySessionWithPhysicalDisconnectResult {
  return {
    session,
    command: null,
    physical_disconnect: {
      required: true,
      status: 'unavailable'
    }
  };
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw Object.assign(new Error(message), { status: 400 });
  return normalized;
}

function errorStatus(error: unknown): number {
  return Number((error as { status?: unknown } | null)?.status || 0);
}
