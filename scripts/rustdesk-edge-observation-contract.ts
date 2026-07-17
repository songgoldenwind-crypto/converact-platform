export type RustDeskEdgeObservedOperation =
  | 'view_screen'
  | 'control_mouse_keyboard'
  | 'multi_display'
  | 'transfer_file'
  | 'clipboard'
  | 'record_screen'
  | 'session_disconnect';

export type RustDeskEdgeObservationStatus =
  | 'not_observed'
  | 'observed_succeeded'
  | 'observed_failed';

export interface RustDeskEdgeEvidenceReference {
  type: string;
  ref: string;
  sha256: string;
}

export interface RustDeskEdgeObservationInput {
  external_id: string;
  operation_id: string;
  operation: RustDeskEdgeObservedOperation;
  status: RustDeskEdgeObservationStatus;
  observer: 'none' | 'native_client' | 'edge_adapter';
  source_adapter: 'native_client' | 'rustdesk_log' | 'companion_hook';
  observed_at?: string | null;
  evidence_refs?: RustDeskEdgeEvidenceReference[];
  evidence_security?: 'ivekit_secure_file' | 'native_unscanned' | 'local_only';
  provider_operation_id?: string;
  provider_session_id?: string;
  direction?: 'upload' | 'download' | 'agent_to_device' | 'device_to_agent';
  display_id?: string;
  byte_count?: number;
  checksum_sha256?: string;
  duration_ms?: number;
  reason?: string;
  status_detail?: string;
  control_version?: number;
  interaction_id?: string;
  reservation_id?: string;
  owner_epoch?: string;
}

const FIELDS = new Set([
  'external_id',
  'operation_id',
  'operation',
  'status',
  'observer',
  'source_adapter',
  'observed_at',
  'evidence_refs',
  'evidence_security',
  'provider_operation_id',
  'provider_session_id',
  'direction',
  'display_id',
  'byte_count',
  'checksum_sha256',
  'duration_ms',
  'reason',
  'status_detail',
  'control_version',
  'interaction_id',
  'reservation_id',
  'owner_epoch'
]);
const OPERATIONS = new Set<RustDeskEdgeObservedOperation>([
  'view_screen',
  'control_mouse_keyboard',
  'multi_display',
  'transfer_file',
  'clipboard',
  'record_screen',
  'session_disconnect'
]);
const STATUSES = new Set<RustDeskEdgeObservationStatus>([
  'not_observed',
  'observed_succeeded',
  'observed_failed'
]);
const SOURCE_ADAPTERS = new Set<RustDeskEdgeObservationInput['source_adapter']>([
  'native_client',
  'rustdesk_log',
  'companion_hook'
]);
const EVIDENCE_FIELDS = new Set(['type', 'ref', 'sha256']);
const SHA256 = /^sha256:[a-f0-9]{64}$/;

export function decodeRustDeskEdgeObservation(value: unknown): RustDeskEdgeObservationInput {
  const input = strictObject(value, 'RustDesk observation input');
  const unknown = Object.keys(input).find((field) => !FIELDS.has(field));
  if (unknown) throw new Error(`unsupported RustDesk observation input field: ${unknown}`);

  const operation = requiredString(input.operation, 'operation') as RustDeskEdgeObservedOperation;
  if (!OPERATIONS.has(operation)) throw new Error('RustDesk observation operation is unsupported');
  const status = requiredString(input.status, 'status') as RustDeskEdgeObservationStatus;
  if (!STATUSES.has(status)) throw new Error('RustDesk observation status is unsupported');
  const sourceAdapter = requiredString(
    input.source_adapter,
    'source_adapter'
  ) as RustDeskEdgeObservationInput['source_adapter'];
  if (!SOURCE_ADAPTERS.has(sourceAdapter)) {
    throw new Error('RustDesk observation source_adapter is unsupported');
  }
  const observer = requiredString(input.observer, 'observer') as RustDeskEdgeObservationInput['observer'];
  if (status === 'not_observed') {
    if (observer !== 'none' || input.observed_at != null || evidenceReferences(input.evidence_refs, true).length) {
      throw new Error('RustDesk not_observed input must use observer none without evidence');
    }
  } else {
    const expectedObserver = sourceAdapter === 'companion_hook' ? 'edge_adapter' : 'native_client';
    if (observer !== expectedObserver) {
      throw new Error('RustDesk observation observer does not match source_adapter');
    }
    isoTimestamp(input.observed_at, 'observed_at');
  }

  const evidenceRefs = evidenceReferences(input.evidence_refs, status === 'not_observed');
  if (status !== 'not_observed' && evidenceRefs.length === 0) {
    throw new Error('RustDesk observed input evidence_refs is required');
  }
  const direction = optionalString(input.direction, 'direction') as RustDeskEdgeObservationInput['direction'];
  if (operation === 'transfer_file' && !['upload', 'download'].includes(String(direction || ''))) {
    throw new Error('RustDesk transfer_file observation direction is invalid');
  }
  if (operation === 'clipboard' && !['agent_to_device', 'device_to_agent'].includes(String(direction || ''))) {
    throw new Error('RustDesk clipboard observation direction is invalid');
  }
  if (direction && operation !== 'transfer_file' && operation !== 'clipboard') {
    throw new Error('RustDesk observation direction is unsupported for operation');
  }

  const evidenceSecurity = optionalString(
    input.evidence_security,
    'evidence_security'
  ) as RustDeskEdgeObservationInput['evidence_security'];
  if (operation === 'transfer_file' && !['ivekit_secure_file', 'native_unscanned'].includes(String(evidenceSecurity || ''))) {
    throw new Error('RustDesk transfer_file observation evidence_security is required');
  }
  if (operation === 'record_screen' && !['ivekit_secure_file', 'local_only'].includes(String(evidenceSecurity || ''))) {
    throw new Error('RustDesk record_screen observation evidence_security is required');
  }
  if (operation !== 'transfer_file' && operation !== 'record_screen' && evidenceSecurity) {
    throw new Error('RustDesk observation evidence_security is unsupported for operation');
  }
  if (evidenceSecurity === 'ivekit_secure_file') {
    if (!Number.isSafeInteger(input.byte_count) || Number(input.byte_count) < 1) {
      throw new Error('RustDesk secure evidence observation byte_count is required');
    }
    if (!SHA256.test(String(input.checksum_sha256 || ''))) {
      throw new Error('RustDesk secure evidence observation checksum_sha256 is required');
    }
    if (!evidenceRefs.some((ref) => ref.type === 'ivekit_secure_file' && ref.ref.startsWith('ivekit-secure-file://'))) {
      throw new Error('RustDesk secure evidence observation ref is required');
    }
  }

  const checksum = optionalString(input.checksum_sha256, 'checksum_sha256');
  if (checksum && !SHA256.test(checksum)) throw new Error('RustDesk observation checksum_sha256 is invalid');
  return compact({
    external_id: requiredString(input.external_id, 'external_id'),
    operation_id: requiredString(input.operation_id, 'operation_id'),
    operation,
    status,
    observer,
    source_adapter: sourceAdapter,
    ...(status === 'not_observed'
      ? { observed_at: null, evidence_refs: [] }
      : { observed_at: isoTimestamp(input.observed_at, 'observed_at'), evidence_refs: evidenceRefs }),
    evidence_security: evidenceSecurity,
    provider_operation_id: optionalString(input.provider_operation_id, 'provider_operation_id'),
    provider_session_id: optionalString(input.provider_session_id, 'provider_session_id'),
    direction,
    display_id: optionalString(input.display_id, 'display_id'),
    byte_count: optionalNonNegativeInteger(input.byte_count, 'byte_count'),
    checksum_sha256: checksum,
    duration_ms: optionalNonNegativeInteger(input.duration_ms, 'duration_ms'),
    reason: optionalString(input.reason, 'reason', 512),
    status_detail: optionalString(input.status_detail, 'status_detail', 512),
    control_version: optionalNonNegativeInteger(input.control_version, 'control_version'),
    ...optionalOwnerIdentity(input)
  }) as RustDeskEdgeObservationInput;
}

function optionalOwnerIdentity(
  input: Record<string, unknown>
): Pick<RustDeskEdgeObservationInput, 'interaction_id' | 'reservation_id' | 'owner_epoch'> {
  const values = [input.interaction_id, input.reservation_id, input.owner_epoch];
  const present = values.filter((value) => value !== undefined && value !== null);
  if (!present.length) return {};
  if (present.length !== 3) throw new Error('RustDesk observation owner binding is incomplete');
  const ownerEpoch = requiredString(input.owner_epoch, 'owner_epoch', 20);
  if (!/^[1-9][0-9]{0,19}$/.test(ownerEpoch)) {
    throw new Error('RustDesk observation owner_epoch is invalid');
  }
  return {
    interaction_id: requiredString(input.interaction_id, 'interaction_id'),
    reservation_id: requiredString(input.reservation_id, 'reservation_id'),
    owner_epoch: BigInt(ownerEpoch).toString()
  };
}

function evidenceReferences(value: unknown, optional: boolean): RustDeskEdgeEvidenceReference[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error('RustDesk observation evidence_refs must be an array with at most 20 items');
  }
  return value.map((item) => {
    const ref = strictObject(item, 'RustDesk observation evidence ref');
    const unknown = Object.keys(ref).find((field) => !EVIDENCE_FIELDS.has(field));
    if (unknown) throw new Error(`unsupported RustDesk observation evidence field: ${unknown}`);
    const reference = requiredString(ref.ref, 'evidence ref', 2_048);
    if (/[?#]/.test(reference)) throw new Error('RustDesk observation evidence ref must not contain query or fragment');
    try {
      const parsed = new URL(reference);
      if (parsed.username || parsed.password) {
        throw new Error('RustDesk observation evidence ref must not contain credentials');
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('credentials')) throw error;
    }
    const digest = requiredString(ref.sha256, 'evidence sha256');
    if (!SHA256.test(digest)) throw new Error('RustDesk observation evidence sha256 is invalid');
    return {
      type: requiredString(ref.type, 'evidence type', 128),
      ref: reference,
      sha256: digest
    };
  });
}

function strictObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maxLength = 256): string {
  if (typeof value !== 'string') throw new Error(`RustDesk observation ${name} is required`);
  const result = value.trim();
  if (!result) throw new Error(`RustDesk observation ${name} is required`);
  if (result.length > maxLength || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`RustDesk observation ${name} is invalid`);
  }
  return result;
}

function optionalString(value: unknown, name: string, maxLength = 256): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name, maxLength);
}

function isoTimestamp(value: unknown, name: string): string {
  const result = requiredString(value, name, 64);
  if (Number.isNaN(Date.parse(result))) throw new Error(`RustDesk observation ${name} must be an ISO timestamp`);
  return new Date(result).toISOString();
}

function optionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`RustDesk observation ${name} must be a non-negative integer`);
  }
  return Number(value);
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
