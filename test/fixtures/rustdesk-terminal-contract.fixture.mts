import type {
  RustDeskDeviceCommand,
  RustDeskDisconnectState,
  RustDeskOperationEvidence,
  RustDeskOperationObservedEvidence
} from '../../sdk/ivekit/src/types.js';
import type {
  IveKitRustDeskGatewayDisconnectState
} from '../../sdk/ivekit/src/rustdesk-http-client.js';

const reference = {
  type: 'operator_report',
  ref: 'evidence://run-1/control-1',
  sha256: 'a'.repeat(64)
};

const notObserved: RustDeskOperationEvidence = {
  operation_id: 'operation-1',
  operation: 'view_screen',
  status: 'not_observed',
  observer: 'none',
  observed_at: null,
  evidence_refs: [],
  metadata: {}
};

const observed: RustDeskOperationEvidence = {
  operation_id: 'operation-2',
  operation: 'transfer_file',
  status: 'observed_succeeded',
  observer: 'qa',
  observed_at: '2026-07-12T12:00:00.000Z',
  evidence_refs: [reference],
  metadata: {
    external_id: 'rdgw_1',
    provider_operation_id: 'transfer-1',
    provider_session_id: 'native-session-1',
    direction: 'upload',
    display_id: 'display-1',
    byte_count: 2048,
    checksum_sha256: 'b'.repeat(64),
    duration_ms: 1200,
    reason: 'operator_verified',
    status_detail: 'checksum_matched'
  }
};

// @ts-expect-error not_observed evidence cannot name a real observer
const invalidNotObservedObserver: RustDeskOperationEvidence = { ...notObserved, observer: 'qa' };

// @ts-expect-error not_observed evidence cannot have an observation timestamp
const invalidNotObservedTimestamp: RustDeskOperationEvidence = { ...notObserved, observed_at: '2026-07-12T12:00:00.000Z' };

// @ts-expect-error not_observed evidence cannot carry evidence references
const invalidNotObservedReference: RustDeskOperationEvidence = { ...notObserved, evidence_refs: [reference] };

// @ts-expect-error observed evidence requires a non-none observer
const invalidObservedObserver: RustDeskOperationEvidence = { ...observed, observer: 'none' };

// @ts-expect-error observed evidence requires a timestamp
const invalidObservedTimestamp: RustDeskOperationEvidence = { ...observed, observed_at: null };

// @ts-expect-error observed evidence requires at least one evidence reference
const invalidObservedReferences: RustDeskOperationEvidence = { ...observed, evidence_refs: [] };

const invalidMetadata: RustDeskOperationEvidence = {
  ...observed,
  metadata: {
    // @ts-expect-error operation evidence metadata rejects content and arbitrary keys
    clipboard_text: 'sensitive clipboard content'
  }
};

const duplicateOperationMetadata: RustDeskOperationEvidence = {
  ...observed,
  metadata: {
    // @ts-expect-error top-level operation_id is the single authoritative operation identifier
    operation_id: 'duplicate-operation-id'
  }
};

const disconnectCommand: RustDeskDeviceCommand & { status: 'succeeded' } = {
  id: 'rdcmd_1',
  tenant_id: 'tenant-led',
  device_id: 'device-1',
  external_id: 'rdgw_1',
  command_type: 'disconnect_session',
  status: 'succeeded',
  requested_by: 'agent-1',
  requested_reason: 'gateway_ended',
  attempt_count: 1,
  max_attempts: 3,
  claimed_by: 'edge-1',
  lease_expires_at: null,
  next_attempt_at: null,
  execution_method: 'session_adapter',
  exit_code: 0,
  duration_ms: 100,
  stdout_bytes: 0,
  stderr_bytes: 0,
  stdout_sha256: '',
  stderr_sha256: '',
  result_metadata: {},
  requested_at: '2026-07-12T12:00:00.000Z',
  started_at: '2026-07-12T12:00:00.000Z',
  completed_at: '2026-07-12T12:00:00.100Z',
  updated_at: '2026-07-12T12:00:00.100Z'
};

const disconnectEvidence: RustDeskOperationObservedEvidence & {
  operation: 'session_disconnect';
  status: 'observed_succeeded';
} = {
  ...observed,
  operation_id: 'disconnect-1',
  operation: 'session_disconnect',
  status: 'observed_succeeded'
};

const connectedEvidence: RustDeskOperationObservedEvidence & {
  operation: 'session_disconnect';
  status: 'observed_failed';
} = {
  ...disconnectEvidence,
  operation_id: 'disconnect-2',
  status: 'observed_failed'
};

const disconnectNotObserved = {
  ...notObserved,
  operation_id: 'disconnect-3',
  operation: 'session_disconnect' as const
};

const unavailableDisconnect: RustDeskDisconnectState = {
  required: true,
  status: 'unavailable',
  command: null
};

const succeededDisconnect: RustDeskDisconnectState = {
  required: true,
  status: 'succeeded',
  command: disconnectCommand
};

const observedDisconnect: RustDeskDisconnectState = {
  required: true,
  status: 'succeeded',
  command: disconnectCommand,
  observation_status: 'observed_disconnected',
  observed: disconnectEvidence
};

const observedConnected: RustDeskDisconnectState = {
  required: true,
  status: 'succeeded',
  command: disconnectCommand,
  observation_status: 'observed_connected',
  observed: connectedEvidence
};

const notObservedDisconnect: RustDeskDisconnectState = {
  required: true,
  status: 'succeeded',
  command: disconnectCommand,
  observation_status: 'not_observed',
  observed: disconnectNotObserved
};

interface ExtendedDisconnectState extends IveKitRustDeskGatewayDisconnectState {
  consumer_label: string;
}

const extendedDisconnectState: ExtendedDisconnectState = {
  required: true,
  status: 'succeeded',
  command: disconnectCommand,
  consumer_label: 'consumer-compatible'
};

const strictDisconnectAsLegacy: IveKitRustDeskGatewayDisconnectState = observedDisconnect;

// @ts-expect-error unavailable disconnect state cannot carry a command
const invalidUnavailableCommand: RustDeskDisconnectState = {
  required: true,
  status: 'unavailable',
  command: disconnectCommand
};

// @ts-expect-error a concrete disconnect status requires a command
const invalidConcreteWithoutCommand: RustDeskDisconnectState = {
  required: true,
  status: 'succeeded',
  command: null
};

// @ts-expect-error outer and command statuses must agree
const invalidCommandStatus: RustDeskDisconnectState = {
  required: true,
  status: 'failed',
  command: disconnectCommand
};

// @ts-expect-error an observed disconnect state requires observation evidence
const invalidObservedWithoutEvidence: RustDeskDisconnectState = {
  required: true,
  status: 'succeeded',
  command: disconnectCommand,
  observation_status: 'observed_disconnected'
};

// @ts-expect-error disconnect observation evidence must describe session_disconnect
const invalidObservedOperation: RustDeskDisconnectState = { required: true, status: 'succeeded', command: disconnectCommand, observation_status: 'observed_connected', observed };

// @ts-expect-error observed_disconnected requires observed_succeeded evidence
const invalidDisconnectedFailure: RustDeskDisconnectState = { required: true, status: 'succeeded', command: disconnectCommand, observation_status: 'observed_disconnected', observed: connectedEvidence };

// @ts-expect-error observed_connected requires observed_failed evidence
const invalidConnectedSuccess: RustDeskDisconnectState = { required: true, status: 'succeeded', command: disconnectCommand, observation_status: 'observed_connected', observed: disconnectEvidence };

// @ts-expect-error not_observed cannot carry an observed success claim
const invalidNotObservedSuccess: RustDeskDisconnectState = { required: true, status: 'succeeded', command: disconnectCommand, observation_status: 'not_observed', observed: disconnectEvidence };

void [notObserved, observed, invalidNotObservedObserver, invalidNotObservedTimestamp,
  invalidNotObservedReference, invalidObservedObserver, invalidObservedTimestamp,
  invalidObservedReferences, invalidMetadata, duplicateOperationMetadata, unavailableDisconnect, succeededDisconnect,
  observedDisconnect, observedConnected, notObservedDisconnect, invalidUnavailableCommand, invalidConcreteWithoutCommand,
  extendedDisconnectState, strictDisconnectAsLegacy,
  invalidCommandStatus, invalidObservedWithoutEvidence, invalidObservedOperation,
  invalidDisconnectedFailure, invalidConnectedSuccess, invalidNotObservedSuccess];
