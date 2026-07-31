import { safeVoiceProviderPayload } from '../canonical.js';
import { VoiceError } from '../errors.js';
import type { VoiceCapability } from '../types.js';

export interface RustPbxRouterRequestInput {
  call_id: unknown;
  from: unknown;
  to: unknown;
  source_addr: unknown;
  direction: unknown;
  method: unknown;
  uri: unknown;
  route_snapshot_revision?: unknown;
  headers?: unknown;
  [key: string]: unknown;
}

export interface RustPbxNormalizedRouterRequest {
  call_id: string;
  from: string;
  to: string;
  source_addr: string;
  direction: 'inbound' | 'outbound';
  method: string;
  uri: string;
  route_snapshot_revision: number | null;
  headers: Record<string, string>;
  safe_payload: Record<string, unknown>;
}

export type RustPbxPortableRouteDecision =
  | {
    action: 'forward_sip';
    targets: string[];
    strategy?: 'parallel' | 'sequential';
    record?: boolean;
    timeout?: number;
    max_ring_time?: number;
    headers?: Record<string, string>;
  }
  | { action: 'start_ivr' | 'enqueue' | 'bridge_livekit' | 'voicemail'; target: string; timeout?: number }
  | { action: 'reject'; code?: number; reason?: string }
  | { action: 'abort'; reason?: string }
  | { action: 'spam' | 'not_handled' };

export type RustPbxRouterResponse =
  | {
    action: 'forward';
    targets: string[];
    strategy: 'parallel' | 'sequential';
    record: boolean;
    timeout: number;
    max_ring_time: number;
    headers: Record<string, string>;
  }
  | { action: 'reject'; status?: number; reason?: string }
  | { action: 'abort'; reason?: string }
  | { action: 'spam' | 'not_handled' };

const SAFE_REQUEST_HEADERS = new Set([
  'user-agent',
  'x-correlation-id',
  'x-request-id',
  'x-trace-id'
]);

const PORTABLE_CAPABILITIES: Readonly<Record<
  Extract<RustPbxPortableRouteDecision['action'], 'start_ivr' | 'enqueue' | 'bridge_livekit' | 'voicemail'>,
  VoiceCapability
>> = {
  start_ivr: 'step_ivr',
  enqueue: 'queue',
  bridge_livekit: 'sipflow',
  voicemail: 'recording'
};

export class RustPbxRouterAdapter {
  normalizeRequest(input: RustPbxRouterRequestInput): RustPbxNormalizedRouterRequest {
    if (!isRecord(input)) throw validationError();
    const direction = boundedString(input.direction, 16).toLowerCase();
    if (direction !== 'inbound' && direction !== 'outbound') throw validationError();
    const method = boundedString(input.method, 32).toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]*$/.test(method)) throw validationError();
    const normalized: RustPbxNormalizedRouterRequest = {
      call_id: boundedString(input.call_id, 256),
      from: boundedString(input.from, 512),
      to: boundedString(input.to, 512),
      source_addr: boundedString(input.source_addr, 512),
      direction,
      method,
      uri: boundedString(input.uri, 1024),
      route_snapshot_revision: optionalPositiveSafeInteger(
        input.route_snapshot_revision
      ),
      headers: normalizeRequestHeaders(input.headers),
      safe_payload: {}
    };
    normalized.safe_payload = safeVoiceProviderPayload({
      call_id: normalized.call_id,
      from: normalized.from,
      to: normalized.to,
      source_addr: normalized.source_addr,
      direction: normalized.direction,
      method: normalized.method,
      uri: normalized.uri,
      route_snapshot_revision: normalized.route_snapshot_revision,
      headers: normalized.headers
    });
    return normalized;
  }

  mapDecision(
    input: RustPbxPortableRouteDecision,
    capabilities: Readonly<Record<VoiceCapability, boolean>>
  ): RustPbxRouterResponse {
    if (!isRecord(input) || typeof input.action !== 'string' || !isRecord(capabilities)) throw validationError();
    if (input.action === 'forward_sip') {
      requireCapability(capabilities, 'json_rpc_routing');
      return forwardResponse(input.targets, input);
    }
    if (input.action in PORTABLE_CAPABILITIES) {
      const action = input.action as keyof typeof PORTABLE_CAPABILITIES;
      requireCapability(capabilities, PORTABLE_CAPABILITIES[action]);
      const decision = input as Extract<RustPbxPortableRouteDecision, { action: typeof action }>;
      return forwardResponse([decision.target], { timeout: decision.timeout });
    }
    if (input.action === 'reject') {
      const output: Extract<RustPbxRouterResponse, { action: 'reject' }> = { action: 'reject' };
      if (input.code !== undefined) output.status = boundedSipCode(input.code);
      if (input.reason !== undefined) output.reason = boundedReason(input.reason);
      return output;
    }
    if (input.action === 'abort') {
      const output: Extract<RustPbxRouterResponse, { action: 'abort' }> = { action: 'abort' };
      if (input.reason !== undefined) output.reason = boundedReason(input.reason);
      return output;
    }
    if (input.action === 'spam' || input.action === 'not_handled') return { action: input.action };
    throw new VoiceError({ code: 'capability_unavailable', status: 501 });
  }
}

function forwardResponse(
  targets: unknown,
  options: {
    strategy?: unknown;
    record?: unknown;
    timeout?: unknown;
    max_ring_time?: unknown;
    headers?: unknown;
  }
): Extract<RustPbxRouterResponse, { action: 'forward' }> {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 32) throw validationError();
  const strategy = options.strategy ?? 'sequential';
  if (strategy !== 'parallel' && strategy !== 'sequential') throw validationError();
  if (options.record !== undefined && typeof options.record !== 'boolean') throw validationError();
  return {
    action: 'forward',
    targets: targets.map(validatedSipTarget),
    strategy,
    record: options.record === true,
    timeout: boundedTimeout(options.timeout),
    max_ring_time: boundedRingTimeout(options.max_ring_time),
    headers: normalizeDecisionHeaders(options.headers)
  };
}

function normalizeRequestHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw validationError();
  const output: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(value).slice(0, 100)) {
    const normalizedName = name.toLowerCase();
    if (!SAFE_REQUEST_HEADERS.has(normalizedName)) continue;
    output[normalizedName] = boundedHeaderValue(rawValue);
  }
  return output;
}

function normalizeDecisionHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value) || Object.keys(value).length > 32) throw validationError();
  const output: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(value)) {
    const normalizedName = name.toLowerCase();
    if (!/^x-[a-z0-9][a-z0-9-]{0,62}$/.test(normalizedName)) throw validationError();
    output[normalizedName] = boundedHeaderValue(rawValue);
  }
  return output;
}

function boundedHeaderValue(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n\u0000]/.test(value)) throw validationError();
  return value;
}

function validatedSipTarget(value: unknown): string {
  const target = boundedString(value, 1024);
  if (!/^sips?:[^\s<>"']+@[^\s<>"']+$/i.test(target) || /[\r\n]/.test(target)) throw validationError();
  return target;
}

function boundedTimeout(value: unknown): number {
  if (value === undefined) return 30;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 300) throw validationError();
  return Number(value);
}

function boundedRingTimeout(value: unknown): number {
  if (value === undefined) return 30;
  if (!Number.isInteger(value) || Number(value) < 30 || Number(value) > 120) throw validationError();
  return Number(value);
}

function optionalPositiveSafeInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw validationError();
  return Number(value);
}

function boundedSipCode(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 300 || Number(value) > 699) throw validationError();
  return Number(value);
}

function boundedReason(value: unknown): string {
  const reason = boundedString(value, 128);
  if (/[\r\n]/.test(reason)) throw validationError();
  return reason;
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw validationError();
  const result = value.trim();
  if (!result || result.length > maxLength || /[\u0000-\u001f\u007f]/.test(result)) throw validationError();
  return result;
}

function requireCapability(
  capabilities: Readonly<Record<VoiceCapability, boolean>>,
  capability: VoiceCapability
): void {
  if (capabilities[capability] !== true) {
    throw new VoiceError({ code: 'capability_unavailable', status: 501, details: { capability } });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}
