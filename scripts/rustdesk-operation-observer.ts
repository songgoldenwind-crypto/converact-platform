import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { rustDeskGatewayEventValidationError } from '../src/agent-runtime/collaboration/rustdesk-gateway-event.js';
import {
  createRustDeskEventForwarderConfigFromEnv,
  forwardRustDeskEvents,
  type RustDeskEventForwarderConfig,
  type RustDeskForwardEventInput
} from './rustdesk-event-forwarder.js';

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
  metadata?: Record<string, unknown>;
}

export function normalizeRustDeskOperationObservation(
  input: RustDeskNativeOperationObservation
): RustDeskForwardEventInput {
  const metadata: Record<string, unknown> = compact({
    ...(input.metadata || {}),
    operation_id: required(input.operation_id, 'operation_id'),
    operation: input.operation,
    status: input.status,
    observer: input.observer,
    observed_at: input.status === 'not_observed' ? null : input.observed_at,
    evidence_refs: input.status === 'not_observed' ? [] : input.evidence_refs,
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
    control_version: input.control_version
  });
  const error = rustDeskGatewayEventValidationError('remote.rustdesk.operation.observed', metadata);
  if (error) throw new Error(error);
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

export async function forwardRustDeskOperationObservations(
  observations: RustDeskNativeOperationObservation[],
  config: RustDeskEventForwarderConfig,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  let forwarded = 0;
  for (const observation of observations) {
    const result = await forwardRustDeskEvents({
      ...config,
      inlineEvent: normalizeRustDeskOperationObservation(observation),
      eventFile: undefined,
      replayDeadLetterFile: undefined,
      replayRemainingFile: undefined
    }, fetchImpl);
    forwarded += result.forwarded;
  }
  return forwarded;
}

function loadObservationFile(path: string): RustDeskNativeOperationObservation[] {
  return readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as RustDeskNativeOperationObservation]; }
    catch { throw new Error(`invalid RustDesk observation JSON at ${path}:${index + 1}`); }
  });
}

function required(value: unknown, name: string): string {
  const result = String(value || '').trim();
  if (!result) throw new Error(`RustDesk observation ${name} is required`);
  return result;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function main() {
  const path = String(process.env.OPC_RUSTDESK_OBSERVER_FILE || '').trim();
  if (!path) throw new Error('OPC_RUSTDESK_OBSERVER_FILE is required');
  const observations = loadObservationFile(path);
  const config = createRustDeskEventForwarderConfigFromEnv({
    ...process.env,
    OPC_RUSTDESK_EVENT_EXTERNAL_ID: process.env.OPC_RUSTDESK_EVENT_EXTERNAL_ID || observations[0]?.external_id || ''
  });
  const forwarded = await forwardRustDeskOperationObservations(observations, config);
  console.log(JSON.stringify({ forwarded }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error((error as Error).message); process.exit(1); });
}
