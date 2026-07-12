import type { RemoteConsentScope } from './types.js';
import type { RustDeskConfirmedOperation } from './rustdesk-control-lock-store.js';

const RUSTDESK_EVENT_METADATA_REQUIREMENTS = {
  'remote.rustdesk.control_action.performed': {
    label: 'control action',
    required: ['operation_id', 'action', 'permission']
  },
  'remote.rustdesk.file_transfer.started': {
    label: 'file transfer',
    required: ['transfer_id']
  },
  'remote.rustdesk.file_transfer.completed': {
    label: 'file transfer',
    required: ['transfer_id']
  },
  'remote.rustdesk.file_transfer.failed': {
    label: 'file transfer',
    required: ['transfer_id']
  },
  'remote.rustdesk.recording.started': {
    label: 'recording',
    required: ['recording_id', 'evidence_type']
  },
  'remote.rustdesk.recording.stopped': {
    label: 'recording',
    required: ['recording_id', 'evidence_type']
  },
  'remote.rustdesk.recording.failed': {
    label: 'recording',
    required: ['recording_id', 'evidence_type']
  },
  'remote.rustdesk.clipboard.synced': {
    label: 'clipboard',
    required: ['clipboard_id', 'direction']
  }
} as const;

const RUSTDESK_EVENT_METADATA_VALUE_REQUIREMENTS = {
  'remote.rustdesk.file_transfer.started': {
    label: 'file transfer',
    values: {
      direction: ['upload', 'download']
    }
  },
  'remote.rustdesk.file_transfer.completed': {
    label: 'file transfer',
    values: {
      direction: ['upload', 'download']
    }
  },
  'remote.rustdesk.file_transfer.failed': {
    label: 'file transfer',
    values: {
      direction: ['upload', 'download']
    }
  },
  'remote.rustdesk.recording.started': {
    label: 'recording',
    values: {
      evidence_type: ['screen_recording']
    }
  },
  'remote.rustdesk.recording.stopped': {
    label: 'recording',
    values: {
      evidence_type: ['screen_recording']
    }
  },
  'remote.rustdesk.recording.failed': {
    label: 'recording',
    values: {
      evidence_type: ['screen_recording']
    }
  },
  'remote.rustdesk.clipboard.synced': {
    label: 'clipboard',
    values: {
      direction: ['agent_to_device', 'device_to_agent']
    }
  }
} as const;

const RUSTDESK_EVENT_PERMISSION_REQUIREMENTS = {
  'remote.rustdesk.file_transfer.started': {
    label: 'file transfer',
    scope: 'transfer_file'
  },
  'remote.rustdesk.file_transfer.completed': {
    label: 'file transfer',
    scope: 'transfer_file'
  },
  'remote.rustdesk.file_transfer.failed': {
    label: 'file transfer',
    scope: 'transfer_file'
  },
  'remote.rustdesk.recording.started': {
    label: 'recording',
    scope: 'record_screen'
  },
  'remote.rustdesk.recording.stopped': {
    label: 'recording',
    scope: 'record_screen'
  },
  'remote.rustdesk.recording.failed': {
    label: 'recording',
    scope: 'record_screen'
  },
  'remote.rustdesk.clipboard.synced': {
    label: 'clipboard',
    scope: 'clipboard'
  }
} as const satisfies Record<string, { label: string; scope: RemoteConsentScope }>;

const RUSTDESK_STANDARD_SCOPES = new Set<RemoteConsentScope>([
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard'
]);

const OBSERVED_OPERATIONS = new Set(['view_screen', 'control_mouse_keyboard', 'multi_display', 'transfer_file', 'clipboard', 'record_screen', 'session_disconnect']);
const OBSERVATION_STATUSES = new Set(['not_observed', 'observed_succeeded', 'observed_failed']);
const OBSERVERS = new Set(['none', 'native_client', 'edge_adapter', 'operator', 'qa']);
const SENSITIVE_KEYS = new Set(['clipboard_content', 'clipboard_text', 'file_content', 'file_bytes', 'keystrokes', 'screen_pixels', 'recording_bytes', 'password', 'access_token', 'api_key', 'private_key', 'token', 'authorization', 'cookie', 'content', 'payload', 'bytes_base64']);

export function rustDeskGatewayEventValidationError(
  eventType: string,
  metadata: Record<string, unknown> = {}
): string {
  if (eventType === 'remote.rustdesk.operation.observed') return operationObservationError(metadata);
  const requirement = RUSTDESK_EVENT_METADATA_REQUIREMENTS[
    eventType as keyof typeof RUSTDESK_EVENT_METADATA_REQUIREMENTS
  ];
  if (!requirement) return '';
  const missingField = requirement.required.find((field) => !String(metadata[field] || '').trim());
  if (missingField) return `RustDesk ${requirement.label} event metadata.${missingField} is required`;
  const valueRequirement = RUSTDESK_EVENT_METADATA_VALUE_REQUIREMENTS[
    eventType as keyof typeof RUSTDESK_EVENT_METADATA_VALUE_REQUIREMENTS
  ];
  if (!valueRequirement) return '';
  for (const [field, allowedValues] of Object.entries(valueRequirement.values)) {
    const value = String(metadata[field] || '').trim();
    if (value && !(allowedValues as readonly string[]).includes(value)) {
      return `RustDesk ${valueRequirement.label} event metadata.${field} must be one of ${allowedValues.join(', ')}`;
    }
  }
  return '';
}

export function rustDeskGatewayEventPermissionError(
  eventType: string,
  metadata: Record<string, unknown> = {},
  permissions: readonly RemoteConsentScope[] = []
): string {
  const granted = new Set(permissions);
  if (eventType === 'remote.rustdesk.operation.observed') {
    const operation = String(metadata.operation || '');
    const scope = operation === 'multi_display' || operation === 'session_disconnect' ? 'view_screen' : operation;
    return granted.has(scope as RemoteConsentScope) ? '' : `RustDesk operation observation requires ${scope} permission`;
  }
  if (eventType === 'remote.rustdesk.control_action.performed') {
    const permission = String(metadata.permission || '').trim() as RemoteConsentScope;
    if (!permission) return '';
    if (!RUSTDESK_STANDARD_SCOPES.has(permission)) {
      return `unsupported RustDesk event permission scope: ${permission}`;
    }
    return granted.has(permission) ? '' : `RustDesk control action event requires ${permission} permission`;
  }
  const requirement = RUSTDESK_EVENT_PERMISSION_REQUIREMENTS[
    eventType as keyof typeof RUSTDESK_EVENT_PERMISSION_REQUIREMENTS
  ];
  if (!requirement) return '';
  return granted.has(requirement.scope)
    ? ''
    : `RustDesk ${requirement.label} event requires ${requirement.scope} permission`;
}

export function rustDeskGatewayObservedOperationControllerRequirement(
  eventType: string,
  metadata: Record<string, unknown> = {}
): RustDeskConfirmedOperation | null {
  if (eventType !== 'remote.rustdesk.operation.observed' || metadata.status === 'not_observed') return null;
  const operation = String(metadata.operation || '');
  return operation === 'control_mouse_keyboard' || operation === 'transfer_file' || operation === 'clipboard'
    ? operation
    : null;
}

function operationObservationError(metadata: Record<string, unknown>): string {
  for (const field of ['operation_id', 'operation', 'status', 'observer']) {
    if (!String(metadata[field] || '').trim()) return `RustDesk operation observation metadata.${field} is required`;
  }
  const operation = String(metadata.operation);
  const status = String(metadata.status);
  const observer = String(metadata.observer);
  if (!OBSERVED_OPERATIONS.has(operation)) return 'RustDesk operation observation metadata.operation is unsupported';
  if (!OBSERVATION_STATUSES.has(status)) return 'RustDesk operation observation metadata.status is unsupported';
  if (!OBSERVERS.has(observer)) return 'RustDesk operation observation metadata.observer is unsupported';
  const sensitive = sensitiveKey(metadata);
  if (sensitive) return `RustDesk operation observation metadata.${sensitive} is forbidden`;
  const refs = metadata.evidence_refs;
  if (status === 'not_observed') {
    return observer === 'none' && metadata.observed_at == null && (!Array.isArray(refs) || refs.length === 0)
      ? ''
      : 'RustDesk not_observed operation must use observer none without observed_at or evidence_refs';
  }
  if (observer === 'none') return 'RustDesk observed operation requires a concrete observer';
  if (!String(metadata.observed_at || '') || Number.isNaN(Date.parse(String(metadata.observed_at)))) {
    return 'RustDesk observed operation metadata.observed_at must be an ISO timestamp';
  }
  if (!Array.isArray(refs) || refs.length === 0) return 'RustDesk observed operation metadata.evidence_refs is required';
  for (const refValue of refs) {
    if (!refValue || typeof refValue !== 'object' || Array.isArray(refValue)) return 'RustDesk operation evidence ref must be an object';
    const ref = refValue as Record<string, unknown>;
    if (!String(ref.type || '').trim() || !String(ref.ref || '').trim() || !/^sha256:[a-f0-9]{64}$/.test(String(ref.sha256 || ''))) {
      return 'RustDesk operation evidence ref requires type, ref, and sha256';
    }
    const reference = String(ref.ref);
    if (/[?#]/.test(reference)) return 'RustDesk operation evidence ref must not contain query or fragment';
    try {
      const parsed = new URL(reference);
      if (parsed.username || parsed.password) return 'RustDesk operation evidence ref must not contain credentials';
    } catch {
      // Opaque evidence references are valid.
    }
  }
  const direction = String(metadata.direction || '');
  if ((operation === 'transfer_file' || operation === 'clipboard') && !direction) {
    return `RustDesk operation observation metadata.direction is required for ${operation}`;
  }
  if (direction) {
    const allowed = operation === 'transfer_file'
      ? ['upload', 'download']
      : operation === 'clipboard'
        ? ['agent_to_device', 'device_to_agent']
        : [];
    if (!allowed.includes(direction)) return `RustDesk operation observation metadata.direction is invalid for ${operation}`;
  }
  for (const field of ['byte_count', 'duration_ms', 'control_version']) {
    if (metadata[field] !== undefined && (typeof metadata[field] !== 'number' || !Number.isInteger(metadata[field]) || metadata[field] < 0)) {
      return `RustDesk operation observation metadata.${field} must be a non-negative integer`;
    }
  }
  if (metadata.checksum_sha256 !== undefined && !/^sha256:[a-f0-9]{64}$/.test(String(metadata.checksum_sha256))) {
    return 'RustDesk operation observation metadata.checksum_sha256 must be sha256';
  }
  return '';
}

function sensitiveKey(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) return key;
    const nested = sensitiveKey(child);
    if (nested) return nested;
  }
  return '';
}

export function rustDeskGatewaySecondaryConfirmationOperation(
  eventType: string,
  metadata: Record<string, unknown> = {}
): RustDeskConfirmedOperation | null {
  if (eventType === 'remote.rustdesk.file_transfer.started') return 'transfer_file';
  if (eventType === 'remote.rustdesk.clipboard.synced') return 'clipboard';
  if (eventType !== 'remote.rustdesk.control_action.performed') return null;
  const permission = String(metadata.permission || '').trim();
  return permission === 'control_mouse_keyboard' || permission === 'transfer_file' || permission === 'clipboard'
    ? permission
    : null;
}
