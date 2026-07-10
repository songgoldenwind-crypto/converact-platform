import type { RustDeskDevice } from './rustdesk-device-store.js';

export function assertRustDeskDeviceOnlineIfRequired(
  device: RustDeskDevice,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now()
): void {
  if (!rustDeskRequireDeviceOnline(env)) return;
  assertRustDeskDeviceOnline(device, env, nowMs);
}

export function assertRustDeskPhysicalDisconnectCapableIfRequired(
  device: RustDeskDevice,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now()
): void {
  if (!rustDeskRequirePhysicalDisconnect(env)) return;
  assertRustDeskDeviceOnline(device, env, nowMs);
  const lastHeartbeat = device.metadata.last_heartbeat;
  const disconnectCommandCapable = Boolean(
    lastHeartbeat &&
    typeof lastHeartbeat === 'object' &&
    !Array.isArray(lastHeartbeat) &&
    (lastHeartbeat as Record<string, unknown>).disconnect_command_capable === true
  );
  if (!disconnectCommandCapable) {
    throw Object.assign(new Error('rustdesk device is not disconnect capable'), { status: 409 });
  }
}

function assertRustDeskDeviceOnline(
  device: RustDeskDevice,
  env: NodeJS.ProcessEnv,
  nowMs: number
): void {
  const lastSeenMs = device.last_seen_at ? new Date(device.last_seen_at).getTime() : NaN;
  if (device.runtime_status !== 'online' || Number.isNaN(lastSeenMs)) {
    throw Object.assign(new Error('rustdesk device is not online'), { status: 409 });
  }
  if (nowMs - lastSeenMs > rustDeskDeviceOnlineTtlMs(env)) {
    throw Object.assign(new Error('rustdesk device online heartbeat is stale'), { status: 409 });
  }
}

export function rustDeskRequireDeviceOnline(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env.OPC_RUSTDESK_REQUIRE_DEVICE_ONLINE || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function rustDeskRequirePhysicalDisconnect(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function rustDeskDeviceOnlineTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const rawValue = env.OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS;
  if (rawValue === undefined || rawValue.trim() === '') return 300_000;
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 100) {
    throw new Error('OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS must be a number >= 100');
  }
  return value;
}
