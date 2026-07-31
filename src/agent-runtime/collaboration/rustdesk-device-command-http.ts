import type { PgQueryable } from '../../db-pg.js';
import {
  RustDeskDeviceCommandStore,
  type RustDeskDeviceCommand
} from './rustdesk-device-command-store.js';
import { RustDeskDeviceStore } from './rustdesk-device-store.js';
import { RustDeskGatewaySessionStore } from './rustdesk-gateway-session-store.js';
import {
  assertRustDeskCurrentOwnerBinding,
  rustDeskDeviceNativeControlProtocol,
  rustDeskSessionOwnerBinding
} from './rustdesk-owner-epoch.js';

export interface RouteRustDeskDeviceCommandApiInput {
  pg: PgQueryable;
  method: string;
  routePath: string;
  body: unknown;
  tenantId: string;
  actorIdentity: string;
  expectedRustDeskId?: string;
  allowEmergencyFallback?: boolean;
  onCommandChanged?: (command: RustDeskDeviceCommand) => Promise<void>;
}

export function isRustDeskEdgeDeviceCommandRoute(method: string, routePath: string): boolean {
  return method === 'POST' && (
    /^\/api\/ivekit\/rustdesk\/devices\/[^/]+\/commands\/claim$/.test(routePath) ||
    /^\/api\/ivekit\/rustdesk\/devices\/[^/]+\/commands\/[^/]+\/(progress|result|recover)$/.test(routePath)
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
    /^\/api\/ivekit\/rustdesk\/devices\/([^/]+)\/commands\/([^/]+)\/(progress|result|recover)$/
  );
  const stateMatch = input.routePath.match(
    /^\/api\/ivekit\/rustdesk\/gateway-sessions\/([^/]+)\/disconnect$/
  );
  const emergencyFallbackMatch = input.routePath.match(
    /^\/api\/ivekit\/rustdesk\/gateway-sessions\/([^/]+)\/disconnect\/emergency-fallback$/
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
    const gatewaySession = await sessions.getSession(claimed.command.external_id);
    if (!gatewaySession || gatewaySession.tenant_id !== input.tenantId) {
      return { status: 409, data: { error: 'rustdesk gateway session is unavailable' } };
    }
    const controllerRustDeskId = String(
      gatewaySession.metadata.controller_rustdesk_id || ''
    ).trim();
    const nativeSessionId = rustDeskNativeSessionId(
      gatewaySession.metadata.ivekit_native_session_id
    );
    const ownerBinding = rustDeskSessionOwnerBinding(gatewaySession);
    const deviceProtocol = rustDeskDeviceNativeControlProtocol(device);
    if (ownerBinding && deviceProtocol !== 'ivekit-rustdesk-native-control-v2') {
      return {
        status: 409,
        data: { error: 'rustdesk_owner_epoch_protocol_required' }
      };
    }
    const nativeControlProtocol = ownerBinding
      ? 'ivekit-rustdesk-native-control-v2'
      : 'ivekit-rustdesk-native-control-v1';
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
          controller_rustdesk_id: controllerRustDeskId,
          native_session_id: nativeSessionId,
          requested_reason: claimed.command.requested_reason,
          emergency_fallback_authorized: claimed.command.emergency_fallback_authorized,
          emergency_fallback_reason: claimed.command.emergency_fallback_reason,
          attempt: claimed.command.attempt_count,
          lease_expires_at: claimed.command.lease_expires_at,
          native_control_protocol: nativeControlProtocol,
          ...(ownerBinding || {})
        },
        ...(ownerBinding ? { owner_binding: ownerBinding } : {}),
        claim_token: claimed.claim_token
      }
    };
  }

  if (emergencyFallbackMatch && input.method === 'POST') {
    if (!input.allowEmergencyFallback) {
      return {
        status: 403,
        data: { error: 'RustDesk emergency fallback requires an owner or admin JWT' }
      };
    }
    const externalId = decodeURIComponent(emergencyFallbackMatch[1]);
    const body = bodyRecord(input.body);
    try {
      const command = await commands.authorizeEmergencyFallback({
        tenant_id: input.tenantId,
        external_id: externalId,
        authorized_by: input.actorIdentity,
        reason: String(body.reason || ''),
        collateral_sessions_may_disconnect: body.collateral_sessions_may_disconnect === true
      });
      await input.onCommandChanged?.(command);
      return { status: 201, data: { command } };
    } catch (error) {
      const status = Number((error as { status?: unknown }).status || 500);
      return { status, data: { error: (error as Error).message } };
    }
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
    const persisted = await commands.getById({
      tenant_id: input.tenantId,
      device_id: deviceId,
      command_id: commandId
    });
    if (!persisted) {
      return { status: 404, data: { error: 'rustdesk disconnect command not found' } };
    }
    const gatewaySession = await sessions.getSession(persisted.external_id);
    if (!gatewaySession || gatewaySession.tenant_id !== input.tenantId) {
      return { status: 409, data: { error: 'rustdesk gateway session is unavailable' } };
    }
    assertRustDeskCurrentOwnerBinding(gatewaySession, body);
    const metadata = edgeCommandMetadata(body.metadata, input.actorIdentity);
    if (action === 'recover') {
      const recovered = await commands.recover({
        tenant_id: input.tenantId,
        device_id: deviceId,
        command_id: commandId,
        edge_instance_id: input.actorIdentity,
        attempt: Number(body.attempt),
        state: body.state as 'executing' | 'executed',
        lease_ms: Number(body.lease_ms),
        ...(body.result === undefined
          ? {}
          : { result: recoveryResult(body.result, input.actorIdentity) })
      });
      await input.onCommandChanged?.(recovered.command);
      return { status: 201, data: recovered };
    }
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

function rustDeskNativeSessionId(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!/^[1-9][0-9]{0,18}$/.test(normalized) || BigInt(normalized) > 0x7fffffffffffffffn) {
    throw Object.assign(new Error('rustdesk_native_session_binding_unavailable'), { status: 409 });
  }
  return BigInt(normalized).toString();
}

function recoveryResult(
  value: unknown,
  edgeInstanceId: string
): {
  status: 'succeeded' | 'failed';
  execution_method: 'session_adapter' | 'service_restart';
  exit_code?: number;
  duration_ms?: number;
  stdout_bytes?: number;
  stderr_bytes?: number;
  stdout_sha256?: string;
  stderr_sha256?: string;
  metadata: Record<string, unknown>;
} {
  const result = bodyRecord(value);
  return {
    status: result.status as 'succeeded' | 'failed',
    execution_method: result.execution_method as 'session_adapter' | 'service_restart',
    exit_code: optionalNumber(result.exit_code),
    duration_ms: optionalNumber(result.duration_ms),
    stdout_bytes: optionalNumber(result.stdout_bytes),
    stderr_bytes: optionalNumber(result.stderr_bytes),
    stdout_sha256: optionalString(result.stdout_sha256),
    stderr_sha256: optionalString(result.stderr_sha256),
    metadata: edgeCommandMetadata(result.metadata, edgeInstanceId)
  };
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
