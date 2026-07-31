import type { RustDeskDevice } from './rustdesk-device-store.js';
import type { RustDeskGatewaySession } from './rustdesk-gateway-session-store.js';

export interface RustDeskSessionOwnerBinding {
  interaction_id: string;
  reservation_id: string;
  owner_epoch: string;
}

export type RustDeskNativeControlProtocol =
  | 'ivekit-rustdesk-native-control-v1'
  | 'ivekit-rustdesk-native-control-v2';

export function rustDeskSessionOwnerBinding(
  session: RustDeskGatewaySession
): RustDeskSessionOwnerBinding | null {
  const metadata = session.metadata;
  const values = {
    interaction_id: metadata.remote_session_id,
    reservation_id: metadata.ivekit_reservation_id,
    owner_epoch: metadata.ivekit_owner_epoch
  };
  const present = Object.values(values).filter((value) => value !== undefined && value !== null);
  if (!present.length) return null;
  if (present.length !== 3) {
    throw Object.assign(new Error('rustdesk_session_owner_binding_incomplete'), { status: 409 });
  }
  return ownerBinding(values);
}

export function rustDeskRequestOwnerBinding(
  body: Record<string, unknown>
): RustDeskSessionOwnerBinding | null {
  const values = {
    interaction_id: body.interaction_id,
    reservation_id: body.reservation_id,
    owner_epoch: body.owner_epoch
  };
  const present = Object.values(values).filter((value) => value !== undefined && value !== null);
  if (!present.length) return null;
  if (present.length !== 3) {
    throw Object.assign(new Error('rustdesk_owner_binding_incomplete'), { status: 409 });
  }
  return ownerBinding(values);
}

export function assertRustDeskCurrentOwnerBinding(
  session: RustDeskGatewaySession,
  body: Record<string, unknown>
): RustDeskSessionOwnerBinding | null {
  const current = rustDeskSessionOwnerBinding(session);
  const requested = rustDeskRequestOwnerBinding(body);
  if (!current && !requested) return null;
  if (
    !current ||
    !requested ||
    current.interaction_id !== requested.interaction_id ||
    current.reservation_id !== requested.reservation_id ||
    current.owner_epoch !== requested.owner_epoch
  ) {
    throw Object.assign(new Error('rustdesk_owner_binding_mismatch'), { status: 409 });
  }
  return current;
}

export function rustDeskDeviceNativeControlProtocol(
  device: RustDeskDevice
): RustDeskNativeControlProtocol | null {
  const heartbeat = object(device.metadata.last_heartbeat);
  const protocol = String(heartbeat.native_control_protocol || '').trim();
  if (!protocol) return null;
  if (
    protocol !== 'ivekit-rustdesk-native-control-v1' &&
    protocol !== 'ivekit-rustdesk-native-control-v2'
  ) {
    throw Object.assign(new Error('rustdesk_device_native_control_protocol_invalid'), {
      status: 409
    });
  }
  return protocol;
}

function ownerBinding(values: Record<string, unknown>): RustDeskSessionOwnerBinding {
  return {
    interaction_id: identifier(values.interaction_id, 'interaction_id'),
    reservation_id: identifier(values.reservation_id, 'reservation_id'),
    owner_epoch: ownerEpoch(values.owner_epoch)
  };
}

function identifier(value: unknown, field: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9._:@/-]{1,256}$/.test(normalized)) {
    throw Object.assign(new Error(`rustdesk_owner_${field}_invalid`), { status: 409 });
  }
  return normalized;
}

function ownerEpoch(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!/^[1-9][0-9]{0,19}$/.test(normalized)) {
    throw Object.assign(new Error('rustdesk_owner_epoch_invalid'), { status: 409 });
  }
  return BigInt(normalized).toString();
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
