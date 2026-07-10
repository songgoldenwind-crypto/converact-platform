import type { RemoteGatewayAuditEvent } from '../collaboration/remote-gateway-client.js';
import type { RustDeskClientConfig } from '../collaboration/rustdesk-client-config.js';
import type { RustDeskDevice } from '../collaboration/rustdesk-device-store.js';
import type { RustDeskGatewayLaunchPlan } from '../collaboration/rustdesk-launch-plan.js';
import type { RemoteConsentScope, RemoteToolSession } from '../collaboration/types.js';
import {
  createIveKitRustDeskHttpClient,
  type IveKitRustDeskBusinessRefInput,
  type IveKitRustDeskFetch,
  type IveKitRustDeskHttpClient,
  type IveKitRustDeskGatewayDisconnectState,
  type RecordIveKitRustDeskGatewayEventInput,
  type ListIveKitRustDeskGatewayAuditEventsInput,
  type EndIveKitRustDeskGatewaySessionInput
} from './rustdesk-http-client.js';

export interface IveKitRustDeskLedSdkInput {
  tenantId: string;
  baseUrl?: string;
  apiKey?: string;
  userId?: string;
  fetch?: IveKitRustDeskFetch;
  client?: IveKitRustDeskHttpClient;
  source?: string;
}

export interface EnsureIveKitRustDeskLedDeviceInput {
  deviceId?: string;
  rustdeskId?: string;
  businessRef: IveKitRustDeskBusinessRefInput;
  deviceDisplayName: string;
  actorIdentity: string;
  deviceMetadata?: Record<string, unknown>;
  heartbeatMetadata?: Record<string, unknown>;
  listLimit?: number;
}

export interface StartIveKitRustDeskLedSessionInput extends EnsureIveKitRustDeskLedDeviceInput {
  remoteSessionId: string;
  permissions: RemoteConsentScope[];
  metadata?: Record<string, unknown>;
}

export interface IveKitRustDeskLedSessionResult {
  clientConfig: RustDeskClientConfig;
  device: RustDeskDevice;
  gatewaySession: RemoteToolSession;
  launchPlan: RustDeskGatewayLaunchPlan;
  launch: {
    launchUrl: string;
    openUrl: string;
    protocolUrl: string;
  };
}

interface IveKitRustDeskLedAuditBaseInput {
  actorIdentity: string;
  target?: string;
  idempotencyKey?: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordIveKitRustDeskControlActionInput extends IveKitRustDeskLedAuditBaseInput {
  operationId: string;
  action: string;
  permission: RemoteConsentScope;
}

export interface RecordIveKitRustDeskFileTransferInput extends IveKitRustDeskLedAuditBaseInput {
  transferId: string;
  status: 'started' | 'completed' | 'failed';
  direction: 'upload' | 'download';
  fileName?: string;
  fileSizeBytes?: number;
  failureReason?: string;
}

export interface RecordIveKitRustDeskScreenRecordingInput extends IveKitRustDeskLedAuditBaseInput {
  recordingId: string;
  status: 'started' | 'stopped' | 'failed';
  storageUrl?: string;
  durationMs?: number;
  failureReason?: string;
}

export interface RecordIveKitRustDeskClipboardSyncInput extends IveKitRustDeskLedAuditBaseInput {
  clipboardId: string;
  direction: 'agent_to_device' | 'device_to_agent';
  contentKind?: string;
}

export interface IveKitRustDeskLedSdk {
  ensureDevice(input: EnsureIveKitRustDeskLedDeviceInput): Promise<RustDeskDevice>;
  startSession(input: StartIveKitRustDeskLedSessionInput): Promise<IveKitRustDeskLedSessionResult>;
  recordGatewayEvent(externalId: string, input: RecordIveKitRustDeskGatewayEventInput): Promise<RemoteGatewayAuditEvent>;
  recordControlAction(externalId: string, input: RecordIveKitRustDeskControlActionInput): Promise<RemoteGatewayAuditEvent>;
  recordFileTransfer(externalId: string, input: RecordIveKitRustDeskFileTransferInput): Promise<RemoteGatewayAuditEvent>;
  recordScreenRecording(externalId: string, input: RecordIveKitRustDeskScreenRecordingInput): Promise<RemoteGatewayAuditEvent>;
  recordClipboardSync(externalId: string, input: RecordIveKitRustDeskClipboardSyncInput): Promise<RemoteGatewayAuditEvent>;
  listGatewayAuditEvents(
    externalId: string,
    input?: ListIveKitRustDeskGatewayAuditEventsInput
  ): Promise<RemoteGatewayAuditEvent[]>;
  endGatewaySession(externalId: string, input: EndIveKitRustDeskGatewaySessionInput): Promise<void>;
  getGatewayDisconnectState(externalId: string): Promise<IveKitRustDeskGatewayDisconnectState>;
}

export function createIveKitRustDeskLedSdk(input: IveKitRustDeskLedSdkInput): IveKitRustDeskLedSdk {
  const tenantId = requiredString(input.tenantId, 'tenantId is required');
  const source = String(input.source || 'ivekit-rustdesk-led-sdk').trim() || 'ivekit-rustdesk-led-sdk';
  const client = input.client || createIveKitRustDeskHttpClient({
    baseUrl: requiredString(input.baseUrl, 'baseUrl is required when client is not provided'),
    apiKey: requiredString(input.apiKey, 'apiKey is required when client is not provided'),
    tenantId,
    userId: input.userId,
    fetch: input.fetch
  });

  const ensureDevice = async (deviceInput: EnsureIveKitRustDeskLedDeviceInput): Promise<RustDeskDevice> => {
    const actorIdentity = requiredString(deviceInput.actorIdentity, 'actorIdentity is required');
    let device = await resolveDevice(client, tenantId, source, deviceInput);
    if (deviceInput.rustdeskId && device.rustdesk_id !== deviceInput.rustdeskId) {
      throw new Error(`RustDesk device runtime id mismatch: expected ${deviceInput.rustdeskId}, got ${device.rustdesk_id}`);
    }
    device = await client.heartbeatDevice(requiredString(device.id, 'RustDesk device id is required'), {
      actor_identity: actorIdentity,
      runtime_status: 'online',
      metadata: {
        source,
        ...deviceInput.heartbeatMetadata
      }
    });
    return device;
  };

  return {
    ensureDevice,
    async startSession(sessionInput) {
      const clientConfig = await client.getClientConfig();
      assertClientConfigReady(clientConfig);
      const device = await ensureDevice(sessionInput);
      const rustdeskId = requiredString(device.rustdesk_id || sessionInput.rustdeskId, 'RustDesk runtime id is required');
      const gatewaySession = await client.startGatewaySession({
        remote_session_id: requiredString(sessionInput.remoteSessionId, 'remoteSessionId is required'),
        device_id: requiredString(device.id, 'RustDesk device id is required'),
        actor_identity: requiredString(sessionInput.actorIdentity, 'actorIdentity is required'),
        permissions: sessionInput.permissions,
        metadata: {
          source,
          rustdesk_id: rustdeskId,
          ...sessionInput.metadata
        }
      });
      const externalId = requiredString(gatewaySession.external_id, 'RustDesk gateway external id is required');
      const launchPlan = await client.getGatewayLaunchPlan(externalId);
      const launch = launchSummary(gatewaySession, launchPlan);
      return {
        clientConfig,
        device,
        gatewaySession,
        launchPlan,
        launch
      };
    },
    recordGatewayEvent(externalId, eventInput) {
      return client.recordGatewayEvent(externalId, eventInput);
    },
    recordControlAction(externalId, eventInput) {
      const operationId = requiredString(eventInput.operationId, 'operationId is required');
      return client.recordGatewayEvent(externalId, {
        event_type: 'remote.rustdesk.control_action.performed',
        actor_identity: requiredString(eventInput.actorIdentity, 'actorIdentity is required'),
        target: optionalString(eventInput.target),
        idempotency_key: eventInput.idempotencyKey || `rustdesk-control:${operationId}`,
        occurred_at: optionalString(eventInput.occurredAt),
        metadata: compactRecord({
          ...(eventInput.metadata || {}),
          operation_id: operationId,
          action: requiredString(eventInput.action, 'action is required'),
          permission: requiredString(eventInput.permission, 'permission is required')
        })
      });
    },
    recordFileTransfer(externalId, eventInput) {
      const transferId = requiredString(eventInput.transferId, 'transferId is required');
      const status = requiredFileTransferStatus(eventInput.status);
      return client.recordGatewayEvent(externalId, {
        event_type: `remote.rustdesk.file_transfer.${status}`,
        actor_identity: requiredString(eventInput.actorIdentity, 'actorIdentity is required'),
        target: optionalString(eventInput.target),
        idempotency_key: eventInput.idempotencyKey || `rustdesk-file-transfer:${transferId}:${status}`,
        occurred_at: optionalString(eventInput.occurredAt),
        metadata: compactRecord({
          ...(eventInput.metadata || {}),
          transfer_id: transferId,
          direction: requiredFileTransferDirection(eventInput.direction),
          file_name: optionalString(eventInput.fileName),
          file_size_bytes: eventInput.fileSizeBytes,
          failure_reason: optionalString(eventInput.failureReason)
        })
      });
    },
    recordScreenRecording(externalId, eventInput) {
      const recordingId = requiredString(eventInput.recordingId, 'recordingId is required');
      const status = requiredScreenRecordingStatus(eventInput.status);
      return client.recordGatewayEvent(externalId, {
        event_type: `remote.rustdesk.recording.${status}`,
        actor_identity: requiredString(eventInput.actorIdentity, 'actorIdentity is required'),
        target: optionalString(eventInput.target),
        idempotency_key: eventInput.idempotencyKey || `rustdesk-recording:${recordingId}:${status}`,
        occurred_at: optionalString(eventInput.occurredAt),
        metadata: compactRecord({
          ...(eventInput.metadata || {}),
          recording_id: recordingId,
          evidence_type: 'screen_recording',
          storage_url: optionalString(eventInput.storageUrl),
          duration_ms: eventInput.durationMs,
          failure_reason: optionalString(eventInput.failureReason)
        })
      });
    },
    recordClipboardSync(externalId, eventInput) {
      const clipboardId = requiredString(eventInput.clipboardId, 'clipboardId is required');
      const direction = requiredClipboardDirection(eventInput.direction);
      return client.recordGatewayEvent(externalId, {
        event_type: 'remote.rustdesk.clipboard.synced',
        actor_identity: requiredString(eventInput.actorIdentity, 'actorIdentity is required'),
        target: optionalString(eventInput.target),
        idempotency_key: eventInput.idempotencyKey || `rustdesk-clipboard:${clipboardId}:${direction}`,
        occurred_at: optionalString(eventInput.occurredAt),
        metadata: compactRecord({
          ...(eventInput.metadata || {}),
          clipboard_id: clipboardId,
          direction,
          content_kind: optionalString(eventInput.contentKind)
        })
      });
    },
    listGatewayAuditEvents(externalId, auditInput) {
      return client.listGatewayAuditEvents(externalId, auditInput);
    },
    endGatewaySession(externalId, endInput) {
      return client.endGatewaySession(externalId, endInput);
    },
    getGatewayDisconnectState(externalId) {
      return client.getGatewayDisconnectState(externalId);
    }
  };
}

async function resolveDevice(
  client: IveKitRustDeskHttpClient,
  tenantId: string,
  source: string,
  input: EnsureIveKitRustDeskLedDeviceInput
): Promise<RustDeskDevice> {
  const deviceId = String(input.deviceId || '').trim();
  if (deviceId) return client.getDevice(deviceId);

  const rustdeskId = requiredString(input.rustdeskId, 'rustdeskId is required when deviceId is not provided');
  const businessRef = input.businessRef;
  const existingDevices = await client.listDevicesByBusinessRef({
    business_ref: businessRef,
    limit: input.listLimit || 50
  });
  const existing = existingDevices.find((device) => device.status === 'active' && device.rustdesk_id === rustdeskId);
  if (existing) return existing;

  return client.registerDevice({
    business_ref: {
      tenant_id: businessRef.tenant_id || tenantId,
      ...businessRef,
      metadata: {
        source,
        ...businessRef.metadata
      }
    },
    rustdesk_id: rustdeskId,
    display_name: requiredString(input.deviceDisplayName, 'deviceDisplayName is required'),
    metadata: {
      source,
      ...input.deviceMetadata
    }
  });
}

function assertClientConfigReady(config: RustDeskClientConfig): void {
  requiredString(config.id_server, 'RustDesk client config id_server is required');
  if (!config.public_key_configured) throw new Error('RustDesk client config public key is not configured');
  requiredString(config.manual_fields?.key, 'RustDesk client config manual key is required');
}

function launchSummary(gatewaySession: RemoteToolSession, launchPlan: RustDeskGatewayLaunchPlan): IveKitRustDeskLedSessionResult['launch'] {
  if (launchPlan.actions?.can_launch === false) {
    throw new Error('RustDesk launch plan is not launchable');
  }
  const launchUrl = requiredString(gatewaySession.launch_url || launchPlan.launch_url, 'RustDesk launch URL is required');
  const openUrl = requiredString(launchPlan.actions?.open_url || launchUrl, 'RustDesk open URL is required');
  return {
    launchUrl,
    openUrl,
    protocolUrl: String(launchPlan.actions?.protocol_url || '')
  };
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function requiredFileTransferStatus(value: unknown): RecordIveKitRustDeskFileTransferInput['status'] {
  if (value === 'started' || value === 'completed' || value === 'failed') return value;
  throw new Error('file transfer status must be one of started, completed, failed');
}

function requiredFileTransferDirection(value: unknown): RecordIveKitRustDeskFileTransferInput['direction'] {
  if (value === 'upload' || value === 'download') return value;
  throw new Error('file transfer direction must be one of upload, download');
}

function requiredScreenRecordingStatus(value: unknown): RecordIveKitRustDeskScreenRecordingInput['status'] {
  if (value === 'started' || value === 'stopped' || value === 'failed') return value;
  throw new Error('screen recording status must be one of started, stopped, failed');
}

function requiredClipboardDirection(value: unknown): RecordIveKitRustDeskClipboardSyncInput['direction'] {
  if (value === 'agent_to_device' || value === 'device_to_agent') return value;
  throw new Error('clipboard direction must be one of agent_to_device, device_to_agent');
}
