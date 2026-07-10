import type { RemoteConsentScope } from './types.js';

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

export function rustDeskGatewayEventValidationError(
  eventType: string,
  metadata: Record<string, unknown> = {}
): string {
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
