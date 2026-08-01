import { createHash, randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import type {
  ComponentPlacementOwner,
  ComponentPlacementReservation
} from '../placement/component-placement.js';
import { canonicalVoicePayloadHash, safeVoiceProviderPayload } from './canonical.js';
import { supportsVoiceCommand, VOICE_CAPABILITY_SCHEMA_VERSION } from './capabilities.js';
import {
  assertVoiceConfigContainsNoSecrets,
  validateVoiceDeploymentProfile,
  voiceProfileConfigHash
} from './deployment-profile-service.js';
import { VoiceError } from './errors.js';
import {
  parseRustPbxMediaControlProfile,
  resolveRustPbxMediaControlProfile,
  type RustPbxMediaControlProfile
} from './media-control-profile.js';
import { observeVoiceCall, observeVoiceCommand } from './metrics.js';
import type {
  VoiceAddressProtector,
  VoiceCallUnitOfWork,
  VoiceCallUnitOfWorkContext,
  VoiceCallRepository,
  VoiceCompliancePort,
  VoiceConfigurationRepository,
  VoiceEventPort,
  VoiceParkingRepository,
  VoiceProviderOwnerContracts,
  VoiceProviderParkingContext
} from './ports.js';
import { VoiceProviderRegistry } from './provider-registry.js';
import { isVoiceTerminalState, mergeProviderCallState } from './state-machine.js';
import type {
  VoiceAddressKind,
  VoiceBusinessRef,
  VoiceCall,
  VoiceCallCommand,
  VoiceCallState,
  VoiceCapability,
  VoiceCommandKind,
  VoiceDeploymentProfile,
  VoiceListInput,
  VoicePage,
  VoiceParkingSlot,
  VoicePolicy,
  VoiceProtectedAddress
} from './types.js';

export interface VoiceCallServiceOptions {
  unit_of_work: VoiceCallUnitOfWork;
  address_protector: VoiceAddressProtector;
  compliance: VoiceCompliancePort;
  event_port: VoiceEventPort;
  id?: (kind: string) => string;
  now?: () => Date;
  parking_ttl_ms?: number;
  placement?: VoiceCallPlacementPort;
}

export interface VoiceCallPlacementPort {
  reserve(input: {
    tenant_id: string;
    interaction_id: string;
    routing_partition_key: string;
    idempotency_key: string;
    preferred_cell_id?: string;
    preferred_owner_node_id?: string;
  }): Promise<ComponentPlacementReservation>;
  persistReserved(
    pg: PgQueryable,
    reservation: ComponentPlacementReservation
  ): Promise<void>;
  hasPlacement?(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
    }
  ): Promise<boolean>;
  releaseUncommitted(reservation: ComponentPlacementReservation): Promise<void>;
  requestState(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
      desired_state: 'active' | 'closed';
      reason: string;
    }
  ): Promise<void>;
  reconcileOne(input: {
    tenant_id: string;
    interaction_id: string;
    worker_id: string;
  }): Promise<'idle' | 'succeeded' | 'retry_wait' | 'failed'>;
  resolveOwner(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
      require_active?: boolean;
    }
  ): Promise<ComponentPlacementOwner>;
}

export interface VoiceProviderCallCommandExecutorOptions {
  calls: VoiceCallRepository;
  configuration: VoiceConfigurationRepository;
  address_protector: VoiceAddressProtector;
  provider_registry: VoiceProviderRegistry;
  parking?: VoiceParkingRepository;
  placement?: Pick<VoiceCallPlacementPort, 'resolveOwner'>;
  placement_pg?: PgQueryable;
  now?: () => Date;
}

export interface VoiceClearAddressInput {
  kind: VoiceAddressKind;
  value: string;
}

export interface CreateOutboundVoiceCallInput {
  tenant_id: string;
  profile_id: string;
  from: VoiceClearAddressInput;
  to: VoiceClearAddressInput;
  business_ref: VoiceBusinessRef;
  actor: string;
  idempotency_key: string;
  metadata: Record<string, unknown>;
  call_id?: string;
  placement_reservation?: ComponentPlacementReservation;
  placement_prepared?: boolean;
}

export interface CreateInboundVoiceCallInput {
  tenant_id: string;
  profile_id: string;
  provider_call_id: string;
  external_event_id: string;
  from: VoiceClearAddressInput;
  to: VoiceClearAddressInput;
  business_ref: VoiceBusinessRef;
  metadata: Record<string, unknown>;
  call_id?: string;
  placement_reservation?: ComponentPlacementReservation;
  placement_prepared?: boolean;
  owner_contract_facts?: VoiceCallOwnerContractFacts;
  provider_runtime_profile?: VoiceDeploymentProfile;
}

export interface VoiceCallOwnerContractFacts {
  route_snapshot_revision: number;
  availability_profile: 'VOICE-ORDINARY' | 'VOICE-HA-T1';
  auth_context_ref: string | null;
  media_control_profile: RustPbxMediaControlProfile;
}

interface VoiceProviderRuntimeBinding {
  profile_id: string;
  adapter: VoiceDeploymentProfile['adapter'];
  base_url: string;
  desired_version: string;
  config: Record<string, unknown>;
  secret_refs: Record<string, string>;
  profile_revision: number;
  config_hash: string;
}

export interface EnqueueVoiceCallActionInput {
  tenant_id: string;
  call_id: string;
  kind: Exclude<VoiceCommandKind, 'originate'>;
  payload: Record<string, unknown>;
  actor: string;
  idempotency_key: string;
}

const REQUEST_HASH_KEY = '_ivekit_request_hash';
const OWNER_CONTRACT_FACTS_KEY = '_ivekit_owner_contract_facts';
const PROVIDER_RUNTIME_BINDING_KEY = '_ivekit_provider_runtime_binding';
const CALL_CONTROL_CAPABILITY: Partial<Record<VoiceCommandKind, VoiceCapability>> = {
  originate: 'rwi',
  answer: 'rwi',
  hangup: 'rwi',
  dtmf: 'rwi',
  hold: 'rwi',
  resume: 'rwi',
  blind_transfer: 'rwi',
  warm_transfer: 'rwi',
  conference: 'rwi',
  park: 'rwi',
  pickup: 'rwi',
  recording_start: 'recording',
  recording_pause: 'recording',
  recording_resume: 'recording',
  recording_stop: 'recording',
  livekit_bridge_create: 'sipflow'
};

export class VoiceCallService {
  readonly #unitOfWork: VoiceCallUnitOfWork;
  readonly #addressProtector: VoiceAddressProtector;
  readonly #compliance: VoiceCompliancePort;
  readonly #eventPort: VoiceEventPort;
  readonly #id: (kind: string) => string;
  readonly #now: () => Date;
  readonly #parkingTtlMs: number;
  readonly #placement?: VoiceCallPlacementPort;

  constructor(options: VoiceCallServiceOptions) {
    this.#unitOfWork = options.unit_of_work;
    this.#addressProtector = options.address_protector;
    this.#compliance = options.compliance;
    this.#eventPort = options.event_port;
    this.#id = options.id ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
    this.#parkingTtlMs = boundedParkingTtl(options.parking_ttl_ms);
    this.#placement = options.placement;
  }

  async createOutbound(input: CreateOutboundVoiceCallInput): Promise<{ call: VoiceCall; command: VoiceCallCommand }> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const actor = boundedIdentifier(input.actor);
    const idempotencyKey = boundedIdempotencyKey(input.idempotency_key);
    const callId = input.call_id
      ? boundedIdentifier(input.call_id)
      : this.#newId('call');
    let reservation = input.placement_reservation;
    if (reservation && reservation.interaction_id !== callId) {
      throw validationError();
    }
    if (this.#placement && !reservation && input.placement_prepared !== true) {
      reservation = await this.#placement.reserve({
        tenant_id: tenantId,
        interaction_id: callId,
        routing_partition_key: `${input.business_ref.type}:${input.business_ref.id}`,
        idempotency_key: idempotencyKey
      });
    }
    let durable = false;
    try {
      const from = await this.#protectAddress(tenantId, input.from);
      const to = await this.#protectAddress(tenantId, input.to);
      const requestHash = callRequestHash(input, from, to);
      const compliance = await this.#compliance.authorize({
        tenant_id: tenantId,
        call_id: callId,
        command: 'originate',
        actor_identity: actor,
        business_ref: businessRef(input.business_ref)
      });
      if (!compliance.allowed || !compliance.evidence_ref) throw complianceDenied();
      const now = this.#timestamp();
      const result = await this.#unitOfWork.run(tenantId, async (context) => {
        const replay = await context.calls.findByIdempotencyKey(tenantId, idempotencyKey);
        if (replay) {
          assertReplayHash(replay, requestHash);
          const command = await context.commands.findCallByIdempotencyKey(
            tenantId,
            originateCommandKey(idempotencyKey)
          );
          if (!command || command.payload_hash !== requestHash) throw idempotencyConflict();
          if (this.#placement && reservation) {
            if (!context.pg) throw providerUnavailable();
            await this.#placement.persistReserved(context.pg, reservation);
            await this.#placement.requestState(context.pg, {
              tenant_id: tenantId,
              interaction_id: replay.id,
              desired_state: 'active',
              reason: 'voice_call_replay_backfill'
            });
          }
          return { call: replay, command, created: false };
        }
        const { policy, profile } = await this.#authorizeRuntime(
          context,
          tenantId,
          input.profile_id,
          'originate',
          {}
        );
        if (policy.require_outbound_consent && !compliance.evidence_ref) {
          throw complianceDenied();
        }
        const providerRuntimeBinding = freezeVoiceProviderRuntime(profile);
        const call: VoiceCall = {
          id: callId,
          tenant_id: tenantId,
          business_ref: businessRef(input.business_ref),
          provider_profile_id: boundedIdentifier(input.profile_id),
          provider_call_id: '',
          provider_dialog_id: '',
          media_call_id: null,
          direction: 'outbound',
          state: 'planned',
          from: projection(from),
          to: projection(to),
          idempotency_key: idempotencyKey,
          initiated_by: actor,
          metadata: {
            ...safeMetadata(input.metadata),
            [REQUEST_HASH_KEY]: requestHash,
            [PROVIDER_RUNTIME_BINDING_KEY]: providerRuntimeBinding
          },
          ringing_at: null,
          answered_at: null,
          ended_at: null,
          termination_reason: '',
          revision: 1,
          created_at: now,
          updated_at: now
        };
        if (this.#placement) {
          if (!reservation) throw providerUnavailable();
          call.metadata[OWNER_CONTRACT_FACTS_KEY] =
            outboundVoiceCallOwnerContractFacts(call, profile, reservation);
        }
        const insertedCall = await context.calls.insert(call, from, to);
        const command = await context.commands.insertCall(this.#newCommand({
          tenant_id: tenantId,
          call_id: insertedCall.id,
          kind: 'originate',
          idempotency_key: originateCommandKey(idempotencyKey),
          payload_hash: requestHash,
          payload: { compliance_evidence_ref: boundedText(compliance.evidence_ref, 2_048) }
        }));
        if (this.#placement) {
          if (!reservation) throw providerUnavailable();
          if (!context.pg) throw providerUnavailable();
          await this.#placement.persistReserved(context.pg, reservation);
          await this.#placement.requestState(context.pg, {
            tenant_id: tenantId,
            interaction_id: insertedCall.id,
            desired_state: 'active',
            reason: 'voice_call_durable'
          });
        }
        return { call: insertedCall, command, created: true };
      });
      durable = true;
      if (result.created) {
        await this.#eventPort.publish(tenantId, 'voice.call.created', {
          call_id: result.call.id,
          direction: result.call.direction,
          business_ref: result.call.business_ref,
          actor
        });
      }
      return { call: publicCall(result.call), command: result.command };
    } catch (error) {
      if (!durable && this.#placement && reservation) {
        await this.#placement.releaseUncommitted(reservation).catch(() => undefined);
      }
      throw error;
    }
  }

  async createInbound(input: CreateInboundVoiceCallInput): Promise<VoiceCall> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const profileId = boundedIdentifier(input.profile_id);
    const providerCallId = boundedIdentifier(input.provider_call_id);
    const externalEventId = boundedIdentifier(input.external_event_id);
    const callId = input.call_id
      ? boundedIdentifier(input.call_id)
      : this.#newId('call');
    let reservation = input.placement_reservation;
    if (reservation && reservation.interaction_id !== callId) {
      throw validationError();
    }
    if (this.#placement && !reservation && input.placement_prepared !== true) {
      throw providerUnavailable();
    }
    let durable = false;
    try {
    const from = await this.#protectAddress(tenantId, input.from);
    const to = await this.#protectAddress(tenantId, input.to);
    const ownerContractFacts = input.owner_contract_facts === undefined
      ? null
      : parseVoiceCallOwnerContractFacts(input.owner_contract_facts);
    const requestedRuntimeBinding = input.provider_runtime_profile === undefined
      ? null
      : freezeVoiceProviderRuntime(input.provider_runtime_profile);
    if (requestedRuntimeBinding &&
        (requestedRuntimeBinding.profile_id !== profileId ||
          input.provider_runtime_profile?.tenant_id !== tenantId)) {
      throw validationError();
    }
    const requestHash = canonicalVoicePayloadHash({ profile_id: profileId, provider_call_id: providerCallId,
      external_event_id: externalEventId, from_hmac: from.hmac, to_hmac: to.hmac,
      owner_contract_facts: ownerContractFacts });
    const idempotencyKey = `inbound:${profileId}:${externalEventId}`;
    const now = this.#timestamp();
    const call = await this.#unitOfWork.run(tenantId, async (context) => {
      const replay = await context.calls.findByIdempotencyKey(tenantId, idempotencyKey);
      if (replay) {
        assertReplayHash(replay, requestHash);
        if (this.#placement && reservation) {
          if (!context.pg) throw providerUnavailable();
          await this.#placement.persistReserved(context.pg, reservation);
          await this.#placement.requestState(context.pg, {
            tenant_id: tenantId,
            interaction_id: replay.id,
            desired_state: 'active',
            reason: 'voice_inbound_replay_backfill'
          });
        }
        return { call: replay, created: false };
      }
      const { profile } = await this.#authorizeRuntime(
        context,
        tenantId,
        profileId,
        null
      );
      const providerRuntimeBinding = requestedRuntimeBinding ??
        freezeVoiceProviderRuntime(profile);
      if (requestedRuntimeBinding &&
          (profile.revision !== requestedRuntimeBinding.profile_revision ||
            voiceProfileConfigHash(profile) !== requestedRuntimeBinding.config_hash)) {
        throw providerUnavailable();
      }
      const inserted = await context.calls.insert({
        id: callId, tenant_id: tenantId, business_ref: businessRef(input.business_ref),
        provider_profile_id: profileId, provider_call_id: providerCallId, provider_dialog_id: '',
        media_call_id: null, direction: 'inbound', state: 'ringing', from: projection(from), to: projection(to),
        idempotency_key: idempotencyKey, initiated_by: `provider:${profileId}`,
        metadata: {
          ...safeInboundMetadata(input.metadata),
          [REQUEST_HASH_KEY]: requestHash,
          [PROVIDER_RUNTIME_BINDING_KEY]: providerRuntimeBinding,
          ...(ownerContractFacts
            ? { [OWNER_CONTRACT_FACTS_KEY]: ownerContractFacts }
            : {})
        },
        ringing_at: now, answered_at: null, ended_at: null, termination_reason: '',
        revision: 1, created_at: now, updated_at: now
      }, from, to);
      if (this.#placement) {
        if (!reservation || !context.pg) throw providerUnavailable();
        await this.#placement.persistReserved(context.pg, reservation);
        await this.#placement.requestState(context.pg, {
          tenant_id: tenantId,
          interaction_id: inserted.id,
          desired_state: 'active',
          reason: 'voice_inbound_durable'
        });
      }
      return { call: inserted, created: true };
    });
    durable = true;
    if (call.created) {
      await this.#eventPort.publish(tenantId, 'voice.call.created', {
        call_id: call.call.id, direction: 'inbound', business_ref: call.call.business_ref
      });
    }
    return publicCall(call.call);
    } catch (error) {
      if (!durable && this.#placement && reservation) {
        await this.#placement.releaseUncommitted(reservation).catch(() => undefined);
      }
      throw error;
    }
  }

  async enqueueAction(input: EnqueueVoiceCallActionInput): Promise<VoiceCallCommand> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const callId = boundedIdentifier(input.call_id);
    const actor = boundedIdentifier(input.actor);
    const kind = actionKind(input.kind);
    let payload: Record<string, unknown>;
    if (kind === 'blind_transfer' || kind === 'warm_transfer') {
      const target = clearAddressFromTarget(input.payload.target);
      const { target: _target, ...remaining } = plainRecord(input.payload);
      payload = safeActionPayload(remaining);
      const protectedTarget = await this.#protectAddress(tenantId, target);
      payload = { ...payload, target_address: protectedTarget };
    } else if (kind === 'dtmf') {
      payload = dtmfActionPayload(input.payload);
    } else if (kind === 'conference') {
      payload = conferenceActionPayload(input.payload);
    } else if (kind === 'park' || kind === 'pickup') {
      payload = parkingActionPayload(input.payload);
    } else if (kind === 'livekit_bridge_create') {
      payload = { sip_trunk_id: boundedIdentifier(input.payload.sip_trunk_id) };
    } else {
      payload = safeActionPayload(input.payload);
    }
    const key = boundedIdempotencyKey(input.idempotency_key);
    const payloadHash = canonicalVoicePayloadHash({ call_id: callId, kind, payload });
    const recordingAction = kind.startsWith('recording_');
    if (recordingAction) {
      const authorized = await this.#compliance.authorize({
        tenant_id: tenantId, call_id: callId, command: kind, actor_identity: actor
      });
      if (!authorized.allowed || !authorized.evidence_ref) throw complianceDenied();
      payload.compliance_evidence_ref = boundedText(authorized.evidence_ref, 2_048);
    }
    const result = await this.#unitOfWork.run(tenantId, async (context) => {
      const existing = await context.commands.findCallByIdempotencyKey(tenantId, key);
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw idempotencyConflict();
        return { command: existing, created: false };
      }
      const call = required(await context.calls.get(tenantId, callId, { for_update: true }));
      validateActionState(call.state, kind);
      const policy = kind === 'hangup'
        ? null
        : (await this.#authorizeRuntime(
            context,
            tenantId,
            call.provider_profile_id,
            kind,
            payload
          )).policy;
      if (recordingAction && policy?.recording_mode === 'disabled') throw complianceDenied();
      const parkingSlot = kind === 'park'
        ? await this.#prepareParkingReservation(context, call, String(payload.slot))
        : kind === 'pickup'
          ? await this.#requireRetrievableParkingSlot(context, call, String(payload.slot))
          : null;
      const command = await context.commands.insertCall(this.#newCommand({
        tenant_id: tenantId, call_id: call.id, kind, idempotency_key: key,
        payload_hash: payloadHash, payload
      }));
      if (kind === 'park') {
        await context.parking.insert(this.#newParkingSlot(call, command, String(payload.slot)));
      } else if (kind === 'pickup' && parkingSlot) {
        const now = this.#timestamp();
        await context.parking.update({
          ...parkingSlot,
          state: 'retrieving',
          pickup_call_id: call.id,
          pickup_command_id: command.id,
          revision: parkingSlot.revision + 1,
          updated_at: now
        }, parkingSlot.revision);
      }
      return { command, created: true };
    });
    if (result.created) {
      await this.#eventPort.publish(tenantId, 'voice.call.command_created', {
        call_id: callId, command_id: result.command.id, kind, actor
      });
    }
    return result.command;
  }

  async getCall(tenantIdInput: string, callIdInput: string): Promise<VoiceCall> {
    const tenantId = boundedIdentifier(tenantIdInput);
    const call = await this.#unitOfWork.run(tenantId, ({ calls }) => calls.get(tenantId, boundedIdentifier(callIdInput)));
    return publicCall(required(call));
  }

  async listCalls(input: VoiceListInput & {
    state?: VoiceCallState;
    business_ref?: VoiceBusinessRef;
  }): Promise<VoicePage<VoiceCall>> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const page = await this.#unitOfWork.run(tenantId, ({ calls }) => calls.list(input));
    return { ...page, items: page.items.map(publicCall) };
  }

  async listParkingSlots(input: VoiceListInput & {
    profile_id?: string;
    state?: VoiceParkingSlot['state'];
  }): Promise<VoicePage<VoiceParkingSlot>> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const profileId = input.profile_id === undefined ? undefined : boundedIdentifier(input.profile_id);
    const state = input.state === undefined ? undefined : parkingState(input.state);
    return this.#unitOfWork.run(tenantId, ({ parking }) => parking.list({
      ...input,
      tenant_id: tenantId,
      ...(profileId ? { profile_id: profileId } : {}),
      ...(state ? { state } : {})
    }));
  }

  async #authorizeRuntime(
    context: VoiceCallUnitOfWorkContext,
    tenantId: string,
    profileIdInput: string,
    command: VoiceCommandKind | null,
    payload: Record<string, unknown> = {}
  ): Promise<{
    policy: VoicePolicy;
    profile: VoiceDeploymentProfile;
  }> {
    const profileId = boundedIdentifier(profileIdInput);
    const profile = required(await context.configuration.getProfile(tenantId, profileId));
    if (profile.status !== 'enabled' && profile.status !== 'degraded') throw new VoiceError({ code: 'capability_unavailable', status: 501 });
    if (command) {
      const capability = CALL_CONTROL_CAPABILITY[command];
      const snapshot = await context.configuration.getLatestCapabilitySnapshot(tenantId, profileId);
      if (!capability || !snapshot || snapshot.status !== 'ready'
        || snapshot.config_hash !== voiceProfileConfigHash(profile)
        || snapshot.capabilities[capability] !== true
        || snapshot.capability_schema_version !== VOICE_CAPABILITY_SCHEMA_VERSION
        || !supportsVoiceCommand(snapshot.action_capabilities, command, payload)) {
        throw new VoiceError({
          code: 'capability_unavailable', status: 501,
          details: { capability, command }
        });
      }
    }
    const policy = required(await context.configuration.getPolicy(tenantId));
    if (policy.status !== 'active') throw complianceDenied();
    return { policy, profile };
  }

  async #protectAddress(tenantId: string, input: VoiceClearAddressInput): Promise<VoiceProtectedAddress> {
    const kind = addressKind(input.kind);
    const value = normalizedAddress(kind, input.value);
    const protectedAddress = await this.#addressProtector.protect(tenantId, value, kind);
    return { kind, ...protectedAddress };
  }

  async #prepareParkingReservation(
    context: VoiceCallUnitOfWorkContext,
    call: VoiceCall,
    slot: string
  ): Promise<null> {
    const existing = await context.parking.getBySlot(
      call.tenant_id, call.provider_profile_id, slot, { for_update: true }
    );
    if (!existing) return null;
    const now = this.#now();
    if (new Date(existing.expires_at).getTime() > now.getTime()) throw parkingConflict(slot, existing.state);
    await context.parking.update({
      ...existing,
      state: 'expired',
      release_reason: 'parking_ttl_expired',
      revision: existing.revision + 1,
      updated_at: now.toISOString(),
      released_at: now.toISOString()
    }, existing.revision);
    return null;
  }

  async #requireRetrievableParkingSlot(
    context: VoiceCallUnitOfWorkContext,
    pickupCall: VoiceCall,
    slot: string
  ): Promise<VoiceParkingSlot> {
    const parking = await context.parking.getBySlot(
      pickupCall.tenant_id, pickupCall.provider_profile_id, slot, { for_update: true }
    );
    if (!parking) throw new VoiceError({
      code: 'not_found', status: 404, details: { resource: 'voice_parking_slot', slot }
    });
    if (parking.state !== 'parked' || new Date(parking.expires_at).getTime() <= this.#now().getTime()) {
      throw parkingConflict(slot, parking.state);
    }
    if (parking.parked_call_id === pickupCall.id) {
      throw new VoiceError({ code: 'invalid_call_transition', status: 409, details: { slot } });
    }
    const parkedCall = required(await context.calls.get(
      pickupCall.tenant_id, parking.parked_call_id, { for_update: true }
    ));
    if (parkedCall.provider_profile_id !== pickupCall.provider_profile_id) {
      throw new VoiceError({ code: 'protocol_mismatch', status: 409, details: { slot } });
    }
    validateActionState(parkedCall.state, 'park');
    return parking;
  }

  #newParkingSlot(call: VoiceCall, command: VoiceCallCommand, slot: string): VoiceParkingSlot {
    const now = this.#now();
    const timestamp = now.toISOString();
    return {
      id: this.#newId('parking-slot'),
      tenant_id: call.tenant_id,
      profile_id: call.provider_profile_id,
      slot,
      state: 'parking',
      parked_call_id: call.id,
      park_command_id: command.id,
      pickup_call_id: null,
      pickup_command_id: null,
      expires_at: new Date(now.getTime() + this.#parkingTtlMs).toISOString(),
      release_reason: '',
      revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
      released_at: null
    };
  }

  #newCommand(input: Pick<VoiceCallCommand,
    'tenant_id' | 'call_id' | 'kind' | 'idempotency_key' | 'payload_hash' | 'payload'>): VoiceCallCommand {
    const now = this.#timestamp();
    return {
      id: this.#newId('call-command'), ...input, state: 'pending', attempt_count: 0, max_attempts: 5,
      next_attempt_at: null, lease_until: null, worker_id: '', provider_command_id: '',
      result: {}, error_code: '', error_message: '', created_at: now, updated_at: now, completed_at: null
    };
  }

  #newId(kind: string): string {
    return boundedIdentifier(this.#id(kind));
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

export class VoiceProviderCallCommandExecutor {
  readonly #calls: VoiceCallRepository;
  readonly #configuration: VoiceConfigurationRepository;
  readonly #addressProtector: VoiceAddressProtector;
  readonly #registry: VoiceProviderRegistry;
  readonly #parking?: VoiceParkingRepository;
  readonly #placement?: Pick<VoiceCallPlacementPort, 'resolveOwner'>;
  readonly #placementPg?: PgQueryable;
  readonly #now: () => Date;

  constructor(options: VoiceProviderCallCommandExecutorOptions) {
    this.#calls = options.calls;
    this.#configuration = options.configuration;
    this.#addressProtector = options.address_protector;
    this.#registry = options.provider_registry;
    this.#parking = options.parking;
    this.#placement = options.placement;
    this.#placementPg = options.placement_pg;
    this.#now = options.now ?? (() => new Date());
  }

  async execute(command: VoiceCallCommand): Promise<{
    provider_command_id: string;
    result: Record<string, unknown>;
  }> {
    const call = required(await this.#calls.get(command.tenant_id, command.call_id));
    if (command.kind === 'originate' && call.provider_call_id) {
      return {
        provider_command_id: command.provider_command_id || call.provider_call_id,
        result: safeVoiceProviderPayload({
          provider_call_id: call.provider_call_id,
          accepted: true,
          replayed: true
        })
      };
    }
    const parkingExecution = await this.#parkingExecution(command, call);
    if (parkingExecution.replayed) return parkingExecution.replayed;
    const frozenProfile = voiceCallProviderRuntime(call);
    const profile = frozenProfile ??
      required(await this.#configuration.getProfile(
        command.tenant_id,
        call.provider_profile_id
      ));
    let clearAddress: string | undefined;
    if (command.kind === 'originate') {
      const address = required(await this.#calls.getProtectedAddress(command.tenant_id, call.id, 'to'));
      clearAddress = await this.#addressProtector.reveal(command.tenant_id, address.ciphertext, address.kind);
    } else if (command.kind === 'blind_transfer' || command.kind === 'warm_transfer') {
      const address = protectedAddressFromPayload(command.payload.target_address);
      clearAddress = await this.#addressProtector.reveal(command.tenant_id, address.ciphertext, address.kind);
    }
    let adapter: Awaited<ReturnType<VoiceProviderRegistry['create']>> | null = null;
    let providerInvocationStarted = false;
    const startedAt = performance.now();
    try {
      const routed = await this.#routedExecution(
        call,
        profile,
        parkingExecution.context
      );
      adapter = await this.#registry.create(routed.profile, { purpose: 'execute' });
      providerInvocationStarted = true;
      const executed = await adapter.execute({
        call, command, clear_address: clearAddress,
        ...(parkingExecution.context ? { parking: parkingExecution.context } : {}),
        ...(routed.owner_contracts
          ? { owner_contracts: routed.owner_contracts }
          : {})
      });
      if (parkingExecution.context && executed.accepted === false) {
        throw new VoiceError({ code: 'provider_unavailable', status: 502 });
      }
      if (command.kind === 'originate') {
        if (!executed.provider_call_id) {
          throw providerExecutionUnknown(executed.provider_command_id);
        }
        try {
          await this.#convergeOriginate(call, executed.provider_call_id);
        } catch (error) {
          if (error instanceof VoiceError && error.code === 'protocol_mismatch') throw error;
          throw providerExecutionUnknown(executed.provider_command_id);
        }
      }
      if (parkingExecution.context) {
        try {
          await this.#convergeParking(command);
        } catch {
          throw providerExecutionUnknown(executed.provider_command_id);
        }
      }
      observeVoiceCommand({
        adapter: profile.adapter,
        kind: command.kind,
        result: 'succeeded',
        duration_seconds: (performance.now() - startedAt) / 1_000
      });
      if (command.kind === 'originate') {
        observeVoiceCall({ adapter: profile.adapter, direction: call.direction, state: call.state });
      }
      return {
        provider_command_id: executed.provider_command_id,
        result: safeVoiceProviderPayload({
          ...(executed.provider_call_id ? { provider_call_id: executed.provider_call_id } : {}),
          accepted: executed.accepted,
          ...(parkingExecution.context ? { parking_slot: parkingExecution.context.slot.slot } : {})
        })
      };
    } catch (error) {
      const executionError = providerInvocationStarted && !(error instanceof VoiceError)
        ? providerExecutionUnknown('')
        : error;
      if (parkingExecution.context && isDefiniteProviderFailure(executionError)) {
        try {
          await this.#settleParkingFailure(command, executionError);
        } catch {
          throw providerExecutionUnknown(providerCommandIdFromExecutionError(executionError));
        }
      }
      observeVoiceCommand({
        adapter: profile.adapter,
        kind: command.kind,
        result: executionError instanceof VoiceError && executionError.code === 'provider_timeout'
          ? 'uncertain'
          : 'failed',
        error_code: executionError instanceof VoiceError ? executionError.code : 'provider_unavailable',
        duration_seconds: (performance.now() - startedAt) / 1_000
      });
      throw executionError;
    } finally {
      clearAddress = undefined;
      await adapter?.close().catch(() => undefined);
    }
  }

  async #routedExecution(
    call: VoiceCall,
    profile: VoiceDeploymentProfile,
    parking: VoiceProviderParkingContext | null
  ): Promise<{
    profile: VoiceDeploymentProfile;
    owner_contracts?: VoiceProviderOwnerContracts;
  }> {
    if (!this.#placement) return { profile };
    if (!this.#placementPg) throw providerUnavailable();
    const relatedCalls = uniqueCalls([
      call,
      parking?.parked_call,
      parking?.pickup_call
    ]);
    const resolved = await Promise.all(relatedCalls.map(async (relatedCall) => ({
      call: relatedCall,
      owner: await this.#resolveOwner(relatedCall)
    })));
    const primary = required(
      resolved.find((item) => item.call.id === call.id)
    ).owner;
    const routedProfile = routeVoiceProfileToOwner(profile, primary);
    const primaryEndpoint = routedRustPbxHttpUrl(primary.provider_endpoint);
    const ownerContracts: VoiceProviderOwnerContracts = {};
    for (const item of resolved) {
      if (item.owner.region_id !== primary.region_id ||
          item.owner.zone_id !== primary.zone_id ||
          item.owner.cell_id !== primary.cell_id ||
          item.owner.owner_node_id !== primary.owner_node_id ||
          routedRustPbxHttpUrl(item.owner.provider_endpoint) !== primaryEndpoint) {
        throw providerUnavailable();
      }
      const providerCallId = item.call.provider_call_id || item.call.id;
      const frozenFacts = voiceCallOwnerContractFacts(item.call);
      const mediaControlProfile = frozenFacts?.media_control_profile ??
        resolveRustPbxMediaControlProfile(profile);
      const availabilityProfile = frozenFacts?.availability_profile ??
        ownerAvailabilityProfile(profile);
      const contract = {
        reservation_id: item.owner.reservation_id,
        interaction_id: item.call.id,
        owner_epoch: item.owner.owner_epoch,
        route_snapshot_revision: frozenFacts?.route_snapshot_revision ??
          item.owner.snapshot_version,
        availability_profile: availabilityProfile,
        auth_context_ref: frozenFacts?.auth_context_ref ??
          (availabilityProfile === 'VOICE-HA-T1'
            ? outboundAuthContextReference(item.call, profile)
            : null),
        tenant_id: item.call.tenant_id,
        cell_id: item.owner.cell_id,
        owner_node_id: item.owner.owner_node_id,
        media_control_profile: mediaControlProfile
      };
      const existing = ownerContracts[providerCallId];
      if (existing && (
        existing.reservation_id !== contract.reservation_id ||
        existing.interaction_id !== contract.interaction_id ||
        existing.owner_epoch !== contract.owner_epoch ||
        existing.route_snapshot_revision !== contract.route_snapshot_revision ||
        existing.availability_profile !== contract.availability_profile ||
        existing.auth_context_ref !== contract.auth_context_ref ||
        existing.tenant_id !== contract.tenant_id ||
        existing.cell_id !== contract.cell_id ||
        existing.owner_node_id !== contract.owner_node_id ||
        canonicalVoicePayloadHash(existing.media_control_profile) !==
          canonicalVoicePayloadHash(contract.media_control_profile)
      )) {
        throw providerUnavailable();
      }
      ownerContracts[providerCallId] = contract;
    }
    return {
      profile: routedProfile,
      owner_contracts: ownerContracts
    };
  }

  async #resolveOwner(call: VoiceCall): Promise<ComponentPlacementOwner> {
    try {
      return await this.#placement!.resolveOwner(this.#placementPg!, {
        tenant_id: call.tenant_id,
        interaction_id: call.id
      });
    } catch (error) {
      throw new VoiceError({
        code: 'provider_unavailable',
        retryable: true,
        status: 503,
        details: {
          placement_error_code: boundedText(
            String((error as { code?: unknown })?.code || 'placement_owner_unavailable'),
            128
          )
        }
      });
    }
  }

  async #convergeOriginate(initial: VoiceCall, providerCallId: string): Promise<void> {
    let current = initial;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (current.provider_call_id && current.provider_call_id !== providerCallId) {
        throw new VoiceError({ code: 'protocol_mismatch', status: 502 });
      }
      const transition = mergeProviderCallState(current.state, 'dialing', {
        ringing_at: current.ringing_at,
        answered_at: current.answered_at,
        ended_at: current.ended_at,
        occurred_at: this.#now().toISOString()
      });
      if (current.provider_call_id === providerCallId && !transition.changed) return;
      try {
        await this.#calls.update({
          ...current,
          provider_call_id: providerCallId,
          state: transition.state,
          ringing_at: transition.ringing_at,
          answered_at: transition.answered_at,
          ended_at: transition.ended_at,
          revision: current.revision + 1,
          updated_at: this.#now().toISOString()
        }, current.revision);
        return;
      } catch (error) {
        if (!(error instanceof VoiceError) || error.code !== 'revision_conflict') throw error;
        current = required(await this.#calls.get(current.tenant_id, current.id));
      }
    }
    throw new VoiceError({ code: 'revision_conflict', retryable: true, status: 409 });
  }

  async #parkingExecution(
    command: VoiceCallCommand,
    call: VoiceCall
  ): Promise<{
    context: VoiceProviderParkingContext | null;
    replayed: { provider_command_id: string; result: Record<string, unknown> } | null;
  }> {
    if (command.kind !== 'park' && command.kind !== 'pickup') {
      return { context: null, replayed: null };
    }
    if (!this.#parking) throw new VoiceError({ code: 'capability_unavailable', status: 501 });
    const slot = command.kind === 'park'
      ? await this.#parking.getByParkCommand(command.tenant_id, command.id)
      : await this.#parking.getByPickupCommand(command.tenant_id, command.id);
    if (!slot) throw new VoiceError({ code: 'protocol_mismatch', status: 500 });
    const terminalState = command.kind === 'park' ? 'parked' : 'released';
    if (slot.state === terminalState) {
      return {
        context: null,
        replayed: {
          provider_command_id: command.provider_command_id
            || `${command.id}:${command.kind === 'park' ? 'hold' : 'bridge'}`,
          result: safeVoiceProviderPayload({
            accepted: true, replayed: true, parking_slot: slot.slot
          })
        }
      };
    }
    const expectedState = command.kind === 'park' ? 'parking' : 'retrieving';
    if (slot.state !== expectedState) throw new VoiceError({
      code: 'protocol_mismatch', status: 409,
      details: { parking_slot: slot.slot, state: slot.state }
    });
    const parkedCall = command.kind === 'park'
      ? call
      : required(await this.#calls.get(command.tenant_id, slot.parked_call_id));
    if (parkedCall.provider_profile_id !== call.provider_profile_id) {
      throw new VoiceError({ code: 'protocol_mismatch', status: 409 });
    }
    return {
      context: {
        slot,
        parked_call: parkedCall,
        pickup_call: command.kind === 'pickup' ? call : null
      },
      replayed: null
    };
  }

  async #convergeParking(command: VoiceCallCommand): Promise<void> {
    if (!this.#parking || (command.kind !== 'park' && command.kind !== 'pickup')) return;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = command.kind === 'park'
        ? await this.#parking.getByParkCommand(command.tenant_id, command.id)
        : await this.#parking.getByPickupCommand(command.tenant_id, command.id);
      if (!current) throw new VoiceError({ code: 'protocol_mismatch', status: 500 });
      const target = command.kind === 'park' ? 'parked' : 'released';
      if (current.state === target) return;
      const expected = command.kind === 'park' ? 'parking' : 'retrieving';
      if (current.state !== expected) throw new VoiceError({ code: 'protocol_mismatch', status: 409 });
      const now = this.#now().toISOString();
      try {
        await this.#parking.update({
          ...current,
          state: target,
          release_reason: command.kind === 'pickup' ? 'picked_up' : '',
          revision: current.revision + 1,
          updated_at: now,
          released_at: command.kind === 'pickup' ? now : null
        }, current.revision);
        return;
      } catch (error) {
        if (!(error instanceof VoiceError) || error.code !== 'revision_conflict' || attempt === 1) throw error;
      }
    }
  }

  async #settleParkingFailure(command: VoiceCallCommand, error: unknown): Promise<void> {
    if (!this.#parking || (command.kind !== 'park' && command.kind !== 'pickup')) return;
    const current = command.kind === 'park'
      ? await this.#parking.getByParkCommand(command.tenant_id, command.id)
      : await this.#parking.getByPickupCommand(command.tenant_id, command.id);
    if (!current) throw new VoiceError({ code: 'protocol_mismatch', status: 500 });
    const expected = command.kind === 'park' ? 'parking' : 'retrieving';
    if (current.state !== expected) return;
    const now = this.#now().toISOString();
    const reason = error instanceof VoiceError ? error.code : 'provider_unavailable';
    await this.#parking.update({
      ...current,
      state: command.kind === 'park' ? 'failed' : 'parked',
      release_reason: command.kind === 'park' ? reason : `pickup_failed:${reason}`,
      revision: current.revision + 1,
      updated_at: now,
      released_at: command.kind === 'park' ? now : null
    }, current.revision);
  }
}

function ownerAvailabilityProfile(
  profile: VoiceDeploymentProfile
): 'VOICE-ORDINARY' | 'VOICE-HA-T1' {
  const value = profile.config?.availability_profile;
  if (value === undefined || value === 'VOICE-ORDINARY') {
    return 'VOICE-ORDINARY';
  }
  if (value === 'VOICE-HA-T1') return value;
  throw new VoiceError({
    code: 'capability_unavailable',
    status: 503,
    retryable: false
  });
}

function outboundAuthContextReference(
  call: VoiceCall,
  profile: VoiceDeploymentProfile
): string {
  if (!Number.isSafeInteger(profile.revision) || profile.revision < 1) {
    throw new VoiceError({
      code: 'capability_unavailable',
      status: 503,
      retryable: false
    });
  }
  const digest = createHash('sha256')
    .update([
      call.tenant_id,
      call.id,
      call.initiated_by,
      profile.id,
      profile.adapter,
      String(profile.revision)
    ].join('\0'))
    .digest('hex');
  return `auth-context:${digest}`;
}

function outboundVoiceCallOwnerContractFacts(
  call: VoiceCall,
  profile: VoiceDeploymentProfile,
  reservation: ComponentPlacementReservation
): VoiceCallOwnerContractFacts {
  const routeSnapshotRevision = reservation.value?.record?.snapshot_version;
  if (!Number.isSafeInteger(routeSnapshotRevision) ||
      routeSnapshotRevision < 1) {
    throw providerUnavailable();
  }
  const availabilityProfile = ownerAvailabilityProfile(profile);
  return {
    route_snapshot_revision: routeSnapshotRevision,
    availability_profile: availabilityProfile,
    auth_context_ref: availabilityProfile === 'VOICE-HA-T1'
      ? outboundAuthContextReference(call, profile)
      : null,
    media_control_profile: resolveRustPbxMediaControlProfile(profile)
  };
}

function voiceCallOwnerContractFacts(
  call: VoiceCall
): VoiceCallOwnerContractFacts | null {
  const value = call.metadata[OWNER_CONTRACT_FACTS_KEY];
  if (value === undefined) return null;
  try {
    return parseVoiceCallOwnerContractFacts(value);
  } catch {
    throw providerUnavailable();
  }
}

function parseVoiceCallOwnerContractFacts(
  value: unknown
): VoiceCallOwnerContractFacts {
  const record = plainRecord(value);
  const expectedKeys = new Set([
    'route_snapshot_revision',
    'availability_profile',
    'auth_context_ref',
    'media_control_profile'
  ]);
  const keys = Object.keys(record);
  if (keys.length !== expectedKeys.size ||
      keys.some((key) => !expectedKeys.has(key)) ||
      !Number.isSafeInteger(record.route_snapshot_revision) ||
      Number(record.route_snapshot_revision) < 1) {
    throw validationError();
  }
  const availabilityProfile = record.availability_profile;
  if (availabilityProfile !== 'VOICE-ORDINARY' &&
      availabilityProfile !== 'VOICE-HA-T1') {
    throw validationError();
  }
  const authContextRef = record.auth_context_ref;
  let checkedAuthContextRef: string | null;
  if (availabilityProfile === 'VOICE-ORDINARY') {
    if (authContextRef !== null) throw validationError();
    checkedAuthContextRef = null;
  } else {
    if (typeof authContextRef !== 'string' ||
        !/^auth-context:[a-f0-9]{64}$/.test(authContextRef)) {
      throw validationError();
    }
    checkedAuthContextRef = authContextRef;
  }
  let mediaControlProfile: RustPbxMediaControlProfile;
  try {
    mediaControlProfile = parseRustPbxMediaControlProfile(
      record.media_control_profile
    );
  } catch {
    throw validationError();
  }
  return {
    route_snapshot_revision: Number(record.route_snapshot_revision),
    availability_profile: availabilityProfile,
    auth_context_ref: checkedAuthContextRef,
    media_control_profile: mediaControlProfile
  };
}

function freezeVoiceProviderRuntime(
  profile: VoiceDeploymentProfile
): VoiceProviderRuntimeBinding {
  validateVoiceDeploymentProfile(profile);
  const binding: VoiceProviderRuntimeBinding = {
    profile_id: profile.id,
    adapter: profile.adapter,
    base_url: profile.base_url,
    desired_version: profile.desired_version,
    config: structuredClone(profile.config),
    secret_refs: Object.fromEntries(
      Object.entries(profile.secret_refs)
        .sort(([left], [right]) => left.localeCompare(right))
    ),
    profile_revision: profile.revision,
    config_hash: voiceProfileConfigHash(profile)
  };
  parseVoiceProviderRuntimeBinding(binding, profile.tenant_id);
  return binding;
}

function voiceCallProviderRuntime(
  call: VoiceCall
): VoiceDeploymentProfile | null {
  const value = call.metadata[PROVIDER_RUNTIME_BINDING_KEY];
  if (value === undefined) return null;
  try {
    const profile = parseVoiceProviderRuntimeBinding(value, call.tenant_id);
    if (profile.id !== call.provider_profile_id) throw validationError();
    return profile;
  } catch {
    throw providerUnavailable();
  }
}

function parseVoiceProviderRuntimeBinding(
  value: unknown,
  tenantId: string
): VoiceDeploymentProfile {
  const record = plainRecord(value);
  const expectedKeys = new Set([
    'profile_id',
    'adapter',
    'base_url',
    'desired_version',
    'config',
    'secret_refs',
    'profile_revision',
    'config_hash'
  ]);
  const keys = Object.keys(record);
  if (keys.length !== expectedKeys.size ||
      keys.some((key) => !expectedKeys.has(key))) {
    throw validationError();
  }
  const profileId = boundedIdentifier(record.profile_id);
  if (profileId !== record.profile_id) throw validationError();
  const adapters: VoiceDeploymentProfile['adapter'][] = [
    'rustpbx',
    'livekit_sip',
    'active_call',
    'livekit_agents',
    'controlled'
  ];
  if (!adapters.includes(record.adapter as VoiceDeploymentProfile['adapter'])) {
    throw validationError();
  }
  const adapter = record.adapter as VoiceDeploymentProfile['adapter'];
  const baseUrl = runtimeBindingString(record.base_url, 2_048);
  const desiredVersion = runtimeBindingString(record.desired_version, 256);
  if (!Number.isSafeInteger(record.profile_revision) ||
      Number(record.profile_revision) < 1 ||
      typeof record.config_hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.config_hash)) {
    throw validationError();
  }
  const config = structuredClone(plainRecord(record.config));
  canonicalVoicePayloadHash(config);
  assertVoiceConfigContainsNoSecrets(config);
  if (Buffer.byteLength(JSON.stringify(config), 'utf8') > 64 * 1024) {
    throw validationError();
  }
  const rawSecretRefs = plainRecord(record.secret_refs);
  if (Object.keys(rawSecretRefs).length > 64) throw validationError();
  const secretRefs: Record<string, string> = {};
  for (const [key, ref] of Object.entries(rawSecretRefs)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key) ||
        typeof ref !== 'string' ||
        !/^env:\/\/[A-Z][A-Z0-9_]*$/.test(ref)) {
      throw validationError();
    }
    secretRefs[key] = ref;
  }
  const profile: VoiceDeploymentProfile = {
    id: profileId,
    tenant_id: boundedIdentifier(tenantId),
    name: 'frozen-call-runtime',
    adapter,
    status: 'enabled',
    base_url: baseUrl,
    desired_version: desiredVersion,
    config,
    secret_refs: secretRefs,
    revision: Number(record.profile_revision),
    created_by: 'converact-runtime-binding',
    updated_by: 'converact-runtime-binding',
    created_at: '1970-01-01T00:00:00.000Z',
    updated_at: '1970-01-01T00:00:00.000Z'
  };
  validateVoiceDeploymentProfile(profile);
  if (voiceProfileConfigHash(profile) !== record.config_hash) {
    throw validationError();
  }
  return profile;
}

function runtimeBindingString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' ||
      value.length > maxLength ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw validationError();
  }
  return value;
}

function routeVoiceProfileToOwner(
  profile: VoiceDeploymentProfile,
  owner: ComponentPlacementOwner
): VoiceDeploymentProfile {
  if (profile.adapter !== 'rustpbx' ||
      owner.interaction_kind !== 'sip_voice' ||
      owner.owner_component !== 'rustpbx') {
    throw providerUnavailable();
  }
  const config = { ...profile.config };
  if (typeof config.rwi_url === 'string' && config.rwi_url.trim()) {
    config.rwi_url = routedRustPbxRwiUrl(
      owner.provider_endpoint,
      config.rwi_url
    );
  }
  return {
    ...profile,
    base_url: routedRustPbxHttpUrl(owner.provider_endpoint),
    config
  };
}

function uniqueCalls(
  calls: Array<VoiceCall | null | undefined>
): VoiceCall[] {
  const unique = new Map<string, VoiceCall>();
  for (const call of calls) {
    if (call) unique.set(call.id, call);
  }
  return [...unique.values()];
}

function routedRustPbxHttpUrl(providerEndpoint: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(providerEndpoint);
  } catch {
    throw providerUnavailable();
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw providerUnavailable();
  }
  if (endpoint.protocol === 'ws:') endpoint.protocol = 'http:';
  if (endpoint.protocol === 'wss:') endpoint.protocol = 'https:';
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw providerUnavailable();
  }
  return endpoint.toString().replace(/\/$/, '');
}

function routedRustPbxRwiUrl(
  providerEndpoint: string,
  configuredRwiUrl: string
): string {
  let owner: URL;
  let configured: URL;
  try {
    owner = new URL(providerEndpoint);
    configured = new URL(configuredRwiUrl);
  } catch {
    throw providerUnavailable();
  }
  if (owner.username || owner.password || owner.hash ||
      configured.username || configured.password || configured.hash ||
      !['ws:', 'wss:'].includes(configured.protocol)) {
    throw providerUnavailable();
  }
  if (owner.protocol === 'http:') owner.protocol = 'ws:';
  if (owner.protocol === 'https:') owner.protocol = 'wss:';
  if (owner.protocol !== 'ws:' && owner.protocol !== 'wss:') {
    throw providerUnavailable();
  }
  owner.pathname = configured.pathname;
  owner.search = configured.search;
  return owner.toString();
}

function providerExecutionUnknown(providerCommandId: string): VoiceError {
  return new VoiceError({
    code: 'provider_timeout',
    retryable: true,
    status: 504,
    details: providerCommandId ? { provider_command_id: providerCommandId } : {}
  });
}

function providerUnavailable(): VoiceError {
  return new VoiceError({
    code: 'provider_unavailable',
    retryable: true,
    status: 503
  });
}

function isDefiniteProviderFailure(error: unknown): error is VoiceError {
  return error instanceof VoiceError && error.code !== 'provider_timeout' && !error.retryable;
}

function providerCommandIdFromExecutionError(error: unknown): string {
  if (!(error instanceof VoiceError)) return '';
  const value = error.details.provider_command_id;
  return typeof value === 'string' ? value : '';
}

function callRequestHash(
  input: CreateOutboundVoiceCallInput,
  from: VoiceProtectedAddress,
  to: VoiceProtectedAddress
): string {
  return canonicalVoicePayloadHash({
    profile_id: boundedIdentifier(input.profile_id), business_ref: businessRef(input.business_ref),
    actor: boundedIdentifier(input.actor), from_kind: from.kind, from_hmac: from.hmac,
    to_kind: to.kind, to_hmac: to.hmac, metadata: safeMetadata(input.metadata)
  });
}

function projection(address: VoiceProtectedAddress): VoiceCall['from'] {
  return { kind: address.kind, redacted: address.redacted };
}

function publicCall(call: VoiceCall): VoiceCall {
  const metadata = Object.fromEntries(Object.entries(call.metadata).filter(([key]) => !key.startsWith('_ivekit_')));
  return { ...call, metadata };
}

function assertReplayHash(call: VoiceCall, expected: string): void {
  if (call.metadata[REQUEST_HASH_KEY] !== expected) throw idempotencyConflict();
}

function safeMetadata(value: unknown): Record<string, unknown> {
  const record = plainRecord(value);
  assertVoiceConfigContainsNoSecrets(record);
  canonicalVoicePayloadHash(record);
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > 64 * 1024) throw validationError();
  if (containsAddress(record)) throw new VoiceError({ code: 'invalid_address', status: 422 });
  return { ...record };
}

function safeInboundMetadata(value: unknown): Record<string, unknown> {
  const result = safeMetadata(value);
  for (const key of ['tenant_id', 'tenantId', 'profile_id', 'profileId']) delete result[key];
  return result;
}

function safeActionPayload(value: unknown): Record<string, unknown> {
  return safeMetadata(value);
}

function containsAddress(value: unknown): boolean {
  if (typeof value === 'string') return /^sips?:[^\s@]+@[^\s@]+$/i.test(value.trim())
    || /^\+?[\d\s().-]{7,}$/.test(value.trim());
  if (Array.isArray(value)) return value.some(containsAddress);
  if (isRecord(value)) return Object.values(value).some(containsAddress);
  return false;
}

function clearAddressFromTarget(value: unknown): VoiceClearAddressInput {
  const target = boundedText(value, 1_024);
  if (/^sips?:/i.test(target)) return { kind: 'sip_uri', value: target };
  if (/^\+/.test(target)) return { kind: 'e164', value: target };
  return { kind: 'extension', value: target };
}

function normalizedAddress(kind: VoiceAddressKind, value: unknown): string {
  const input = boundedText(value, 1_024);
  if (kind === 'e164') {
    const normalized = input.replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new VoiceError({ code: 'invalid_address', status: 422 });
    return normalized;
  }
  if (kind === 'extension') {
    if (!/^\d{1,20}$/.test(input)) throw new VoiceError({ code: 'invalid_address', status: 422 });
    return input;
  }
  if (!/^sips?:[^\s@]+@[^\s@]+$/i.test(input)) throw new VoiceError({ code: 'invalid_address', status: 422 });
  return input;
}

function addressKind(value: unknown): VoiceAddressKind {
  if (value !== 'e164' && value !== 'extension' && value !== 'sip_uri') throw new VoiceError({ code: 'invalid_address', status: 422 });
  return value;
}

function actionKind(value: unknown): Exclude<VoiceCommandKind, 'originate'> {
  const allowed: Exclude<VoiceCommandKind, 'originate'>[] = [
    'answer', 'hangup', 'dtmf', 'hold', 'resume', 'blind_transfer', 'warm_transfer',
    'conference', 'park', 'pickup', 'recording_start', 'recording_pause',
    'recording_resume', 'recording_stop', 'livekit_bridge_create'
  ];
  if (!allowed.includes(value as Exclude<VoiceCommandKind, 'originate'>)) throw validationError();
  return value as Exclude<VoiceCommandKind, 'originate'>;
}

export function requiredCapabilityForVoiceCommand(command: VoiceCommandKind): VoiceCapability {
  const capability = CALL_CONTROL_CAPABILITY[command];
  if (!capability) throw new VoiceError({ code: 'capability_unavailable', status: 501 });
  return capability;
}

function protectedAddressFromPayload(value: unknown): VoiceProtectedAddress {
  if (!isRecord(value)) throw new VoiceError({ code: 'invalid_address', status: 422 });
  const kind = addressKind(value.kind);
  const ciphertext = boundedText(value.ciphertext, 4_096);
  const hmac = boundedText(value.hmac, 256);
  const redacted = boundedText(value.redacted, 256);
  return { kind, ciphertext, hmac, redacted };
}

function validateActionState(state: VoiceCallState, kind: VoiceCommandKind): void {
  if (isVoiceTerminalState(state)) throw new VoiceError({ code: 'terminal_call_state', status: 409 });
  const allowed: Partial<Record<VoiceCommandKind, VoiceCallState[]>> = {
    answer: ['dialing', 'ringing'],
    hangup: ['planned', 'queued', 'dialing', 'ringing', 'active', 'held', 'transferring'],
    dtmf: ['active'], hold: ['active'], resume: ['held'],
    blind_transfer: ['active', 'held'], warm_transfer: ['active', 'held'],
    conference: ['active', 'held'], park: ['active', 'held'], pickup: ['active', 'held'],
    recording_start: ['active', 'held'], recording_pause: ['active', 'held'],
    recording_resume: ['active', 'held'], recording_stop: ['active', 'held'],
    livekit_bridge_create: ['active', 'held']
  };
  if (!allowed[kind]?.includes(state)) throw new VoiceError({ code: 'invalid_call_transition', status: 409 });
}

function dtmfDigits(value: unknown): string {
  const digits = boundedText(value, 32);
  if (!/^[0-9A-D*#]+$/i.test(digits)) throw validationError();
  return digits.toUpperCase();
}

function dtmfActionPayload(value: unknown): Record<string, unknown> {
  const input = plainRecord(value);
  if (Object.keys(input).some((key) => key !== 'digits' && key !== 'leg_id')) throw validationError();
  const payload: Record<string, unknown> = { digits: dtmfDigits(input.digits) };
  if (input.leg_id !== undefined) payload.leg_id = boundedIdentifier(input.leg_id);
  return payload;
}

function conferenceActionPayload(value: unknown): Record<string, unknown> {
  const input = plainRecord(value);
  const operation = input.operation ?? 'add';
  if (typeof operation !== 'string' || !['create', 'add', 'remove', 'destroy'].includes(operation)) {
    throw validationError();
  }
  const conferenceId = boundedIdentifier(input.conference_id);
  const allowed = operation === 'create'
    ? new Set(['operation', 'conference_id', 'backend', 'max_members', 'record'])
    : new Set(['operation', 'conference_id']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw validationError();
  const payload: Record<string, unknown> = { operation, conference_id: conferenceId };
  if (operation !== 'create') return payload;
  if (input.backend !== undefined) {
    if (input.backend !== 'internal' && input.backend !== 'external') throw validationError();
    payload.backend = input.backend;
  }
  if (input.max_members !== undefined) {
    if (!Number.isInteger(input.max_members) || Number(input.max_members) < 2 || Number(input.max_members) > 1_000) {
      throw validationError();
    }
    payload.max_members = input.max_members;
  }
  if (input.record !== undefined) {
    if (typeof input.record !== 'boolean') throw validationError();
    payload.record = input.record;
  }
  return payload;
}

function parkingActionPayload(value: unknown): Record<string, unknown> {
  const input = plainRecord(value);
  if (Object.keys(input).some((key) => key !== 'slot')) throw validationError();
  const slot = boundedText(input.slot, 32);
  if (!/^[A-Za-z0-9][A-Za-z0-9_*#-]{0,31}$/.test(slot)) throw validationError();
  return { slot };
}

function parkingState(value: unknown): VoiceParkingSlot['state'] {
  const allowed: VoiceParkingSlot['state'][] = [
    'parking', 'parked', 'retrieving', 'released', 'failed', 'expired'
  ];
  if (!allowed.includes(value as VoiceParkingSlot['state'])) throw validationError();
  return value as VoiceParkingSlot['state'];
}

function businessRef(value: unknown): VoiceBusinessRef {
  if (!isRecord(value)) throw validationError();
  return { type: boundedIdentifier(value.type), id: boundedIdentifier(value.id) };
}

function originateCommandKey(callKey: string): string {
  return `call:${callKey}:originate`;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new VoiceError({ code: 'not_found', status: 404 });
  return value;
}

function boundedIdempotencyKey(value: unknown): string {
  return boundedText(value, 256);
}

function boundedIdentifier(value: unknown): string {
  return boundedText(value, 256);
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string') throw validationError();
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw validationError();
  return result;
}

function boundedParkingTtl(value: number | undefined): number {
  const resolved = value ?? 30 * 60_000;
  if (!Number.isInteger(resolved) || resolved < 60_000 || resolved > 24 * 60 * 60_000) {
    throw validationError();
  }
  return resolved;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw validationError();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function idempotencyConflict(): VoiceError {
  return new VoiceError({ code: 'idempotency_conflict', status: 409 });
}

function complianceDenied(): VoiceError {
  return new VoiceError({ code: 'compliance_denied', status: 403 });
}

function parkingConflict(slot: string, state: VoiceParkingSlot['state']): VoiceError {
  return new VoiceError({
    code: 'revision_conflict', status: 409,
    details: { resource: 'voice_parking_slot', slot, state }
  });
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}
