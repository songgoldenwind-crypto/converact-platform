import type { PgQueryable } from '../../db-pg.js';
import {
  RustDeskDeviceCommandStore,
  type RustDeskDeviceCommand
} from './rustdesk-device-command-store.js';
import { RustDeskDeviceStore } from './rustdesk-device-store.js';
import { RustDeskGatewaySessionStore } from './rustdesk-gateway-session-store.js';

export interface RouteRustDeskDeviceCommandApiInput {
  pg: PgQueryable;
  method: string;
  routePath: string;
  body: unknown;
  tenantId: string;
  actorIdentity: string;
  expectedRustDeskId?: string;
  onCommandChanged?: (command: RustDeskDeviceCommand) => Promise<void>;
}

export function isRustDeskEdgeDeviceCommandRoute(method: string, routePath: string): boolean {
  return method === 'POST' && (
    /^\/api\/ivekit\/rustdesk\/devices\/[^/]+\/commands\/claim$/.test(routePath) ||
    /^\/api\/ivekit\/rustdesk\/devices\/[^/]+\/commands\/[^/]+\/(progress|result)$/.test(routePath)
  );
}

export async function routeRustDeskDeviceCommandApi(
  input: RouteRustDeskDeviceCommandApiInput
): Promise<unknown | undefined> {
  const commands = new RustDeskDeviceCommandStore(input.pg);
  const devices = new RustDeskDeviceStore(input.pg);
  const sessions = new RustDeskGatewaySessionStore(input.pg);
  const claimMatch = input.routePath.match(
    /^\/api\/ivekit\/rustdesk\/devices\/([^/]+)\/commands\/claim$/
  );
  const lifecycleMatch = input.routePath.match(
    /^\/api\/ivekit\/rustdesk\/devices\/([^/]+)\/commands\/([^/]+)\/(progress|result)$/
  );
  const stateMatch = input.routePath.match(
    /^\/api\/ivekit\/rustdesk\/gateway-sessions\/([^/]+)\/disconnect$/
  );

  if (claimMatch && input.method === 'POST') {
    const deviceId = decodeURIComponent(claimMatch[1]);
    const device = await devices.getDevice({ tenant_id: input.tenantId, device_id: deviceId });
    if (
      !device || device.status !== 'active' || device.deactivated_at ||
      (input.expectedRustDeskId && device.rustdesk_id !== input.expectedRustDeskId)
    ) {
      return { status: 404, data: { error: 'rustdesk device not found' } };
    }
    const body = bodyRecord(input.body);
    const claimed = await commands.claimNext({
      tenant_id: input.tenantId,
      device_id: device.id,
      edge_instance_id: input.actorIdentity,
      lease_ms: Number(body.lease_ms)
    });
    if (!claimed) return { status: 204, data: null };
    await input.onCommandChanged?.(claimed.command);
    return {
      status: 201,
      data: {
        command: {
          id: claimed.command.id,
          command_type: claimed.command.command_type,
          external_id: claimed.command.external_id,
          target_id: claimed.command.device_id,
          rustdesk_id: device.rustdesk_id,
          requested_reason: claimed.command.requested_reason,
          attempt: claimed.command.attempt_count,
          lease_expires_at: claimed.command.lease_expires_at
        },
        claim_token: claimed.claim_token
      }
    };
  }

  if (lifecycleMatch && input.method === 'POST') {
    const deviceId = decodeURIComponent(lifecycleMatch[1]);
    const commandId = decodeURIComponent(lifecycleMatch[2]);
    const action = lifecycleMatch[3];
    const device = await devices.getDevice({ tenant_id: input.tenantId, device_id: deviceId });
    if (
      !device || device.status !== 'active' || device.deactivated_at ||
      (input.expectedRustDeskId && device.rustdesk_id !== input.expectedRustDeskId)
    ) {
      return { status: 404, data: { error: 'rustdesk device not found' } };
    }
    const body = bodyRecord(input.body);
    const metadata = edgeCommandMetadata(body.metadata, input.actorIdentity);
    const common = {
      tenant_id: input.tenantId,
      device_id: deviceId,
      command_id: commandId,
      claim_token: String(body.claim_token || '')
    };
    const command = action === 'progress'
      ? await commands.recordProgress({
        ...common,
        progress: body.progress as 'session_adapter_failed' | 'fallback_started',
        exit_code: optionalNumber(body.exit_code),
        duration_ms: optionalNumber(body.duration_ms),
        metadata
      })
      : await commands.complete({
        ...common,
        status: body.status as 'succeeded' | 'failed',
        execution_method: body.execution_method as 'session_adapter' | 'service_restart',
        exit_code: optionalNumber(body.exit_code),
        duration_ms: optionalNumber(body.duration_ms),
        stdout_bytes: optionalNumber(body.stdout_bytes),
        stderr_bytes: optionalNumber(body.stderr_bytes),
        stdout_sha256: optionalString(body.stdout_sha256),
        stderr_sha256: optionalString(body.stderr_sha256),
        metadata
      });
    await input.onCommandChanged?.(command);
    return { status: 201, data: { command } };
  }

  if (stateMatch && input.method === 'GET') {
    const externalId = decodeURIComponent(stateMatch[1]);
    const session = await sessions.getSession(externalId);
    if (!session || session.tenant_id !== input.tenantId) {
      return { status: 404, data: { error: 'rustdesk gateway session not found' } };
    }
    const command = await commands.getByExternalId({
      tenant_id: input.tenantId,
      external_id: externalId
    });
    return {
      data: {
        required: true,
        status: command?.status || 'unavailable',
        command
      }
    };
  }

  return undefined;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function edgeCommandMetadata(value: unknown, edgeInstanceId: string): Record<string, unknown> {
  const metadata = value === undefined ? {} : value;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw Object.assign(new Error('rustdesk command metadata must be a JSON object'), { status: 400 });
  }
  return {
    ...metadata as Record<string, unknown>,
    edge_instance_id: edgeInstanceId
  };
}

function optionalNumber(value: unknown): number | undefined {
  return value === undefined || value === null || value === '' ? undefined : Number(value);
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}
