import { rustDeskGatewayEventValidationError } from './rustdesk-gateway-event.js';

export interface RustDeskNativeOperationObservation {
  external_id: string;
  actor_identity: string;
  target?: string;
  operation_id: string;
  operation: 'view_screen' | 'control_mouse_keyboard' | 'multi_display' | 'transfer_file' | 'clipboard' | 'record_screen' | 'session_disconnect';
  status: 'not_observed' | 'observed_succeeded' | 'observed_failed';
  observer: 'none' | 'native_client' | 'edge_adapter' | 'operator' | 'qa';
  observed_at?: string | null;
  evidence_refs?: Array<{ type: string; ref: string; sha256: string }>;
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
  metadata?: Record<string, unknown>;
}

export interface RustDeskOperationObservationEvent {
  external_id: string;
  event_type: 'remote.rustdesk.operation.observed';
  actor_identity: string;
  target?: string;
  idempotency_key: string;
  metadata: Record<string, unknown>;
  occurred_at?: string;
}

export function normalizeRustDeskOperationObservation(
  input: RustDeskNativeOperationObservation
): RustDeskOperationObservationEvent {
  const metadata: Record<string, unknown> = compact({
    ...(input.metadata || {}),
    operation_id: required(input.operation_id, 'operation_id'),
    operation: input.operation,
    status: input.status,
    observer: input.observer,
    observed_at: input.status === 'not_observed' ? null : input.observed_at,
    evidence_refs: input.status === 'not_observed' ? [] : input.evidence_refs,
    evidence_security: input.evidence_security,
    provider_operation_id: input.provider_operation_id,
    provider_session_id: input.provider_session_id,
    target_id: input.target,
    direction: input.direction,
    display_id: input.display_id,
    byte_count: input.byte_count,
    checksum_sha256: input.checksum_sha256,
    duration_ms: input.duration_ms,
    reason: input.reason,
    status_detail: input.status_detail,
    control_version: input.control_version,
    interaction_id: input.interaction_id,
    reservation_id: input.reservation_id,
    owner_epoch: input.owner_epoch
  });
  const error = rustDeskGatewayEventValidationError('remote.rustdesk.operation.observed', metadata);
  if (error) throw Object.assign(new Error(error), { status: 400 });
  return {
    external_id: required(input.external_id, 'external_id'),
    event_type: 'remote.rustdesk.operation.observed',
    actor_identity: required(input.actor_identity, 'actor_identity'),
    ...(input.target ? { target: input.target } : {}),
    idempotency_key: `rustdesk-observation:${input.operation_id}:${input.status}`,
    metadata,
    ...(input.observed_at ? { occurred_at: input.observed_at } : {})
  };
}

function required(value: unknown, name: string): string {
  const result = String(value || '').trim();
  if (!result) throw Object.assign(new Error(`RustDesk observation ${name} is required`), { status: 400 });
  return result;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
