import { randomUUID } from 'node:crypto';

import type { RustPbxNormalizedRouterRequest, RustPbxRouterAdapter, RustPbxRouterResponse } from './adapters/rustpbx-routing.js';
import { canonicalVoicePayloadHash, safeVoiceProviderPayload } from './canonical.js';
import { VoiceError } from './errors.js';
import {
  compileRustPbxRouteRules,
  type VoiceRouteDependency
} from './route-compiler.js';
import type {
  VoiceAddressProtector,
  VoiceCallRepository,
  VoiceConfigurationRepository,
  VoiceProviderEventRepository
} from './ports.js';
import type { VoiceNormalizedProviderEvent, VoiceProviderEvent } from './types.js';

export type { VoiceRouteDependency } from './route-compiler.js';

export interface VoiceProviderEventServiceOptions {
  events: VoiceProviderEventRepository;
  calls: VoiceCallRepository;
  id?: () => string;
  now?: () => Date;
}

export class VoiceProviderEventService {
  readonly #events: VoiceProviderEventRepository;
  readonly #calls: VoiceCallRepository;
  readonly #id: () => string;
  readonly #now: () => Date;

  constructor(options: VoiceProviderEventServiceOptions) {
    this.#events = options.events;
    this.#calls = options.calls;
    this.#id = options.id ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async ingest(input: {
    tenant_id: string;
    profile_id: string;
    event: VoiceNormalizedProviderEvent;
  }): Promise<{ event: VoiceProviderEvent; replayed: boolean }> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const profileId = boundedIdentifier(input.profile_id);
    const normalized = validateNormalizedEvent(input.event);
    const providerCallId = boundedIdentifier(normalized.provider_call_id);
    const call = await this.#calls.findByProviderCallId(tenantId, profileId, providerCallId);
    const now = this.#now().toISOString();
    const safePayload = safeVoiceProviderPayload({
      ...normalized.safe_payload,
      provider_call_id: providerCallId
    });
    const event: VoiceProviderEvent = {
      id: boundedIdentifier(this.#id()),
      tenant_id: tenantId,
      profile_id: profileId,
      call_id: call?.id ?? null,
      external_event_id: boundedOptionalIdentifier(normalized.external_event_id),
      canonical_hash: canonicalVoicePayloadHash({
        profile_id: profileId,
        event_type: normalized.event_type,
        provider_state: normalized.provider_state,
        provider_call_id: providerCallId,
        occurred_at: normalized.occurred_at,
        safe_payload: canonicalSafePayload(safePayload)
      }),
      event_type: boundedEventType(normalized.event_type),
      provider_state: boundedProviderState(normalized.provider_state),
      safe_payload: safePayload,
      processing_state: 'pending',
      attempt_count: 0,
      next_attempt_at: null,
      lease_until: null,
      worker_id: '',
      error_code: '',
      occurred_at: normalized.occurred_at,
      received_at: now,
      processed_at: null
    };
    return this.#events.insert(event);
  }
}

export interface VoiceRouterDecisionServiceOptions {
  configuration: VoiceConfigurationRepository;
  address_protector: VoiceAddressProtector;
  router_adapter: RustPbxRouterAdapter;
  available_dependencies?: readonly VoiceRouteDependency[];
}

export class VoiceRouterDecisionService {
  readonly #configuration: VoiceConfigurationRepository;
  readonly #addressProtector: VoiceAddressProtector;
  readonly #routerAdapter: RustPbxRouterAdapter;
  readonly #availableDependencies: ReadonlySet<VoiceRouteDependency>;

  constructor(options: VoiceRouterDecisionServiceOptions) {
    this.#configuration = options.configuration;
    this.#addressProtector = options.address_protector;
    this.#routerAdapter = options.router_adapter;
    this.#availableDependencies = new Set(options.available_dependencies ?? []);
  }

  async decide(input: {
    tenant_id: string;
    profile_id: string;
    request: RustPbxNormalizedRouterRequest;
  }): Promise<RustPbxRouterResponse> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const profileId = boundedIdentifier(input.profile_id);
    const destination = destinationE164(input.request.to);
    if (!destination) return routeNotFound();
    const protectedAddress = await this.#addressProtector.protect(tenantId, destination, 'e164');
    const did = this.#configuration.findDidByAddressHmac
      ? await this.#configuration.findDidByAddressHmac(tenantId, protectedAddress.hmac)
      : null;
    if (!did || did.status !== 'active' || !did.route_id) return routeNotFound();
    const trunk = await this.#configuration.getTrunk(tenantId, did.trunk_id);
    if (!trunk || trunk.profile_id !== profileId || trunk.status !== 'active') return routeNotFound();
    const route = await this.#configuration.getRoute(tenantId, did.route_id);
    if (!route || route.profile_id !== profileId || route.status !== 'active'
      || (route.direction !== 'inbound' && route.direction !== 'both')
      || route.current_published_version === null) return routeNotFound();
    const versions = await this.#configuration.listRouteVersions(tenantId, route.id);
    const version = versions.find((candidate) => candidate.version === route.current_published_version
      && candidate.deployment_state === 'applied');
    if (!version) return routeNotFound();
    const snapshot = await this.#configuration.getLatestCapabilitySnapshot(tenantId, profileId);
    const capabilities = snapshot?.capabilities ?? emptyCapabilities();
    return compileRustPbxRouteRules({
      rules: version.rules,
      capabilities,
      router_adapter: this.#routerAdapter,
      available_dependencies: this.#availableDependencies
    });
  }
}

function validateNormalizedEvent(input: VoiceNormalizedProviderEvent): VoiceNormalizedProviderEvent {
  if (!isRecord(input) || !isRecord(input.safe_payload)) {
    throw new VoiceError({ code: 'protocol_mismatch', status: 422 });
  }
  boundedEventType(input.event_type);
  boundedProviderState(input.provider_state);
  if (input.occurred_at !== null && !validTimestamp(input.occurred_at)) {
    throw new VoiceError({ code: 'protocol_mismatch', status: 422 });
  }
  return input;
}

function canonicalSafePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const output = { ...payload };
  delete output.event_id;
  delete output.cdr_id;
  delete output.external_event_id;
  return output;
}

function destinationE164(input: string): string | null {
  const trimmed = input.trim();
  const sipMatch = trimmed.match(/^sips?:([^@;>]+)@/i);
  const candidate = (sipMatch?.[1] ?? trimmed).replace(/^tel:/i, '');
  return /^\+[1-9]\d{6,14}$/.test(candidate) ? candidate : null;
}

function routeNotFound(): RustPbxRouterResponse {
  return { action: 'reject', status: 404, reason: 'route_not_found' };
}

function emptyCapabilities(): Parameters<RustPbxRouterAdapter['mapDecision']>[1] {
  return {
    management_http: false, json_rpc_routing: false, step_ivr: false, rwi: false,
    webrtc_extension: false, recording: false, sipflow: false, queue: false, postgres_backend: false
  };
}

function boundedEventType(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!/^call\.[a-z_]{2,32}$/.test(result)) throw new VoiceError({ code: 'protocol_mismatch', status: 422 });
  return result;
}

function boundedProviderState(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-z][a-z0-9_-]{1,63}$/i.test(result)) throw new VoiceError({ code: 'protocol_mismatch', status: 422 });
  return result;
}

function boundedIdentifier(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new VoiceError({ code: 'validation_failed', status: 422 });
  }
  return result;
}

function boundedOptionalIdentifier(value: unknown): string {
  if (value === '' || value === null || value === undefined) return '';
  return boundedIdentifier(value);
}

function validTimestamp(value: string): boolean {
  return value.length <= 64 && !Number.isNaN(new Date(value).getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
