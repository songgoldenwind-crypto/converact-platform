import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RUSTPBX_RWI_EFFECTIVE_CAPABILITIES,
  RUSTPBX_RWI_PROTOCOL_CAPABILITIES,
  RustPbxVoiceProviderAdapter,
  VoiceError,
  normalizeVoiceActionCapabilities,
  voiceProfileConfigHash,
  type VoiceCall,
  type VoiceCallCommand,
  type VoiceCapability,
  type VoiceDeploymentProfile,
  type VoiceManagementPort
} from '../src/agent-runtime/converact/voice/index.js';

test('RustPBX provider composes management and RWI capabilities without overstating support', async () => {
  const profile = rustPbxProfile();
  const rwi = fakeRwi();
  const adapter = new RustPbxVoiceProviderAdapter({
    profile,
    management: fakeManagement(profile),
    rwi
  });

  const result = await adapter.preflight();

  assert.equal(result.provider, 'rustpbx');
  assert.equal(result.config_hash, voiceProfileConfigHash(profile));
  assert.equal(result.capabilities.management_http, true);
  assert.equal(result.capabilities.postgres_backend, true);
  assert.equal(result.capabilities.rwi, true);
  assert.equal(result.capabilities.step_ivr, false);
  assert.equal(result.capability_schema_version, 1);
  assert.equal(result.action_capabilities.commands.dtmf, true);
  assert.equal(result.action_capabilities.commands.conference, true);
  assert.equal(result.action_capabilities.commands.park, true);
  assert.equal(result.action_capabilities.commands.pickup, true);
  assert.equal(result.action_capabilities.commands.livekit_bridge_create, true);
  assert.equal(result.action_capabilities.conference_operations.destroy, true);
  assert.deepEqual(rwi.events.slice(0, 2), ['connect', 'preflight']);
  await adapter.close();
  assert.equal(rwi.events.at(-1), 'close');
});

test('RustPBX provider composes deterministic hold, unhold, and bridge parking actions', async () => {
  const profile = rustPbxProfile();
  const rwi = fakeRwi();
  const adapter = new RustPbxVoiceProviderAdapter({
    profile,
    management: fakeManagement(profile),
    rwi
  });
  const parkedCall = voiceCall({ id: 'parked-call', provider_call_id: 'provider-parked' });
  const pickupCall = voiceCall({ id: 'pickup-call', provider_call_id: 'provider-pickup' });
  const slot = {
    id: 'slot-a', tenant_id: 'tenant-a', profile_id: profile.id, slot: '701',
    state: 'parked' as const, parked_call_id: parkedCall.id, park_command_id: 'park-command',
    pickup_call_id: pickupCall.id, pickup_command_id: 'pickup-command',
    expires_at: '2026-07-13T13:00:00.000Z', release_reason: '', revision: 2,
    created_at: '2026-07-13T12:00:00.000Z', updated_at: '2026-07-13T12:00:00.000Z',
    released_at: null
  };

  const parked = await adapter.execute({
    call: parkedCall,
    command: voiceCommand({ id: 'park-command', call_id: parkedCall.id, kind: 'park' }),
    parking: { slot: { ...slot, state: 'parking' }, parked_call: parkedCall, pickup_call: null },
    owner_contracts: {
      'provider-parked': ownerContract('parked-call', 'reservation-parked', '12884901889')
    }
  });
  assert.equal(parked.provider_command_id, 'park-command:hold');
  assert.deepEqual(rwi.commands.at(-1), {
    command_id: 'park-command:hold', kind: 'hold', call_id: 'provider-parked', payload: {},
    ivekit_owners: {
      'provider-parked': ownerContract('parked-call', 'reservation-parked', '12884901889')
    }
  });

  const pickedUp = await adapter.execute({
    call: pickupCall,
    command: voiceCommand({ id: 'pickup-command', call_id: pickupCall.id, kind: 'pickup' }),
    parking: { slot, parked_call: parkedCall, pickup_call: pickupCall },
    owner_contracts: {
      'provider-parked': ownerContract('parked-call', 'reservation-parked', '12884901889'),
      'provider-pickup': ownerContract('pickup-call', 'reservation-pickup', '12884901890')
    }
  });
  assert.equal(pickedUp.provider_command_id, 'pickup-command:bridge');
  assert.deepEqual(rwi.commands.at(-1), {
    command_id: 'pickup-command:unhold', kind: 'resume',
    call_id: 'provider-parked', payload: {},
    ivekit_owners: {
      'provider-parked': ownerContract('parked-call', 'reservation-parked', '12884901889'),
      'provider-pickup': ownerContract('pickup-call', 'reservation-pickup', '12884901890')
    }
  });
  assert.deepEqual(rwi.bridges.at(-1), {
    command_id: 'pickup-command:bridge', leg_a: 'provider-parked', leg_b: 'provider-pickup',
    ivekit_owners: {
      'provider-parked': ownerContract('parked-call', 'reservation-parked', '12884901889'),
      'provider-pickup': ownerContract('pickup-call', 'reservation-pickup', '12884901890')
    }
  });
});

test('RustPBX provider attaches the current owner contract to ordinary RWI commands', async () => {
  const profile = rustPbxProfile();
  const rwi = fakeRwi();
  const adapter = new RustPbxVoiceProviderAdapter({
    profile,
    management: fakeManagement(profile),
    rwi
  });
  const call = voiceCall({ provider_call_id: 'provider-call-owned' });

  await adapter.execute({
    call,
    command: voiceCommand({ id: 'answer-owned', kind: 'answer' }),
    owner_contracts: {
      'provider-call-owned': ownerContract(call.id, 'reservation-owned', '12884901889')
    }
  });

  assert.deepEqual(rwi.commands.at(-1), {
    command_id: 'answer-owned',
    kind: 'answer',
    call_id: 'provider-call-owned',
    payload: {},
    ivekit_owners: {
      'provider-call-owned': ownerContract(call.id, 'reservation-owned', '12884901889')
    }
  });
});

test('RustPBX provider treats pickup transport loss after unhold as uncertain', async () => {
  const profile = rustPbxProfile();
  const parkedCall = voiceCall({ id: 'parked-call', provider_call_id: 'provider-parked' });
  const pickupCall = voiceCall({ id: 'pickup-call', provider_call_id: 'provider-pickup' });
  const slot = parkingSlot(profile, parkedCall, pickupCall);

  for (const scenario of ['bridge', 'rollback'] as const) {
    const rwi = fakeRwi();
    rwi.throwBridge = scenario === 'bridge';
    rwi.failBridge = scenario === 'rollback';
    rwi.throwRollback = scenario === 'rollback';
    const adapter = new RustPbxVoiceProviderAdapter({
      profile,
      management: fakeManagement(profile),
      rwi
    });

    await assert.rejects(
      () => adapter.execute({
        call: pickupCall,
        command: voiceCommand({ id: `pickup-${scenario}`, call_id: pickupCall.id, kind: 'pickup' }),
        parking: { slot, parked_call: parkedCall, pickup_call: pickupCall }
      }),
      (error: unknown) => error instanceof VoiceError
        && error.code === 'provider_timeout'
        && error.details.provider_command_id === `pickup-${scenario}:${scenario === 'bridge' ? 'bridge' : 'rollback-hold'}`
    );
  }
});

test('RustPBX provider reveals call targets only in the RWI command and preserves uncertain action ids', async () => {
  const profile = rustPbxProfile();
  const rwi = fakeRwi();
  const adapter = new RustPbxVoiceProviderAdapter({
    profile,
    management: fakeManagement(profile),
    rwi
  });
  const call = voiceCall();
  const command = voiceCommand({ kind: 'originate', payload: { compliance_evidence_ref: 'evidence-a' } });

  const executed = await adapter.execute({ call, command, clear_address: '+8613800138000' });

  assert.equal(executed.provider_command_id, command.id);
  assert.equal(executed.provider_call_id, 'provider-call-a');
  assert.equal(rwi.commands[0]?.call_id, call.id);
  assert.deepEqual(rwi.commands[0]?.payload, {
    destination: '+8613800138000'
  });

  rwi.mode = 'uncertain';
  await assert.rejects(
    () => adapter.execute({
      call,
      command: voiceCommand({ id: 'command-timeout', kind: 'hold' })
    }),
    (error: unknown) => error instanceof VoiceError
      && error.code === 'provider_timeout'
      && error.details.provider_command_id === 'command-timeout'
  );
});

test('RustPBX provider preserves safe RWI failure semantics', async () => {
  const profile = rustPbxProfile();
  const rwi = fakeRwi();
  const adapter = new RustPbxVoiceProviderAdapter({
    profile,
    management: fakeManagement(profile),
    rwi
  });
  const expected = [
    ['provider_call_not_found', 'not_found', 404],
    ['invalid_call_transition', 'invalid_call_transition', 409],
    ['capability_unavailable', 'capability_unavailable', 501],
    ['provider_auth_failed', 'provider_auth_failed', 403],
    ['call_control_conflict', 'revision_conflict', 409]
  ] as const;
  for (const [providerCode, voiceCode, status] of expected) {
    rwi.mode = 'failed';
    rwi.errorCode = providerCode;
    await assert.rejects(
      () => adapter.execute({
        call: voiceCall(),
        command: voiceCommand({ id: `command-${providerCode}`, kind: 'hold' })
      }),
      (error: unknown) => error instanceof VoiceError
        && error.code === voiceCode
        && error.status === status
        && error.details.provider_command_id === `command-${providerCode}`
    );
  }
});

test('RustPBX provider reconciles only originate by its deterministic call id', async () => {
  const profile = rustPbxProfile();
  const lookedUp: string[] = [];
  const management = fakeManagement(profile, lookedUp);
  const adapter = new RustPbxVoiceProviderAdapter({ profile, management, rwi: null });

  const active = await adapter.reconcile({
    call: voiceCall({ provider_call_id: 'provider-call-a' }),
    command: voiceCommand({ provider_command_id: 'rwi-action-a' })
  });
  const fallback = await adapter.reconcile({
    call: voiceCall({ provider_call_id: '' }),
    command: voiceCommand({ provider_command_id: 'rwi-action-b' })
  });
  const controlFallback = await adapter.reconcile({
    call: voiceCall({ provider_call_id: '' }),
    command: voiceCommand({ kind: 'hold', provider_command_id: 'rwi-action-c' })
  });

  assert.equal(active.state, 'succeeded');
  assert.equal(fallback.state, 'succeeded');
  assert.equal(fallback.provider_call_id, 'call-a');
  assert.deepEqual(controlFallback, { state: 'unknown' });
  assert.deepEqual(lookedUp, ['provider-call-a', 'call-a']);
});

function fakeRwi() {
  const state = {
    mode: 'success' as 'success' | 'uncertain' | 'failed',
    errorCode: 'provider_command_failed',
    throwBridge: false,
    failBridge: false,
    throwRollback: false,
    events: [] as string[],
    commands: [] as Array<{
      command_id: string;
      kind: VoiceCallCommand['kind'];
      call_id: string;
      payload: Record<string, unknown>;
      ivekit_owners?: Record<string, ReturnType<typeof ownerContract>>;
    }>,
    bridges: [] as Array<{
      command_id: string;
      leg_a: string;
      leg_b: string;
      ivekit_owners?: Record<string, ReturnType<typeof ownerContract>>;
    }>,
    async connect() { state.events.push('connect'); },
    async preflight() {
      state.events.push('preflight');
      return {
        ready: true as const,
        protocol: 'rwi-v1' as const,
        commands: [
          'call.originate', 'call.answer', 'call.hangup', 'call.hold', 'call.unhold',
          'call.bridge',
          'call.send_dtmf', 'call.transfer', 'call.transfer.attended',
          'conference.create', 'conference.add', 'conference.remove', 'conference.destroy',
          'record.start', 'record.pause', 'record.resume', 'record.stop'
        ],
        capability_source: 'pinned_baseline' as const,
        runtime_version_verified: false as const,
        protocol_capabilities: RUSTPBX_RWI_PROTOCOL_CAPABILITIES,
        effective_capabilities: RUSTPBX_RWI_EFFECTIVE_CAPABILITIES,
        limitations: []
      };
    },
    async execute(input: {
      command_id: string;
      kind: VoiceCallCommand['kind'];
      call_id: string;
      payload: Record<string, unknown>;
      ivekit_owners?: Record<string, ReturnType<typeof ownerContract>>;
    }) {
      state.commands.push(input);
      if (state.throwRollback && input.command_id.endsWith(':rollback-hold')) {
        throw new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 });
      }
      if (state.mode === 'uncertain') {
        return { state: 'uncertain' as const, action_id: input.command_id, error_code: 'timeout' };
      }
      if (state.mode === 'failed') {
        return { state: 'failed' as const, action_id: input.command_id, error_code: state.errorCode };
      }
      return {
        state: 'succeeded' as const,
        action_id: input.command_id,
        result: { call_id: 'provider-call-a', accepted: true }
      };
    },
    async executeBridge(input: {
      command_id: string;
      leg_a: string;
      leg_b: string;
      ivekit_owners?: Record<string, ReturnType<typeof ownerContract>>;
    }) {
      state.bridges.push(input);
      if (state.throwBridge) {
        throw new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 });
      }
      if (state.failBridge) {
        return { state: 'failed' as const, action_id: input.command_id, error_code: state.errorCode };
      }
      if (state.mode === 'uncertain') {
        return { state: 'uncertain' as const, action_id: input.command_id, error_code: 'timeout' };
      }
      if (state.mode === 'failed') {
        return { state: 'failed' as const, action_id: input.command_id, error_code: state.errorCode };
      }
      return { state: 'succeeded' as const, action_id: input.command_id, result: { accepted: true } };
    },
    async close() { state.events.push('close'); }
  };
  return state;
}

function parkingSlot(
  profile: VoiceDeploymentProfile,
  parkedCall: VoiceCall,
  pickupCall: VoiceCall
) {
  return {
    id: 'slot-a', tenant_id: 'tenant-a', profile_id: profile.id, slot: '701',
    state: 'parked' as const, parked_call_id: parkedCall.id, park_command_id: 'park-command',
    pickup_call_id: pickupCall.id, pickup_command_id: 'pickup-command',
    expires_at: '2026-07-13T13:00:00.000Z', release_reason: '', revision: 2,
    created_at: '2026-07-13T12:00:00.000Z', updated_at: '2026-07-13T12:00:00.000Z',
    released_at: null
  };
}

function fakeManagement(
  profile: VoiceDeploymentProfile,
  lookedUp: string[] = []
): VoiceManagementPort {
  return {
    async preflight() {
      return {
        profile_id: profile.id,
        provider: 'rustpbx',
        provider_version: '0.9.0',
        capabilities: capabilities(),
        capability_schema_version: 1,
        action_capabilities: normalizeVoiceActionCapabilities(),
        checked_at: '2026-07-13T12:00:00.000Z',
        config_hash: voiceProfileConfigHash(profile)
      };
    },
    async applyTrunk() { throw new Error('not used'); },
    async testTrunk() { throw new Error('not used'); },
    async applyDid() { throw new Error('not used'); },
    async applyExtension() { throw new Error('not used'); },
    async applyRoute() { throw new Error('not used'); },
    async lookupDialog(input) {
      lookedUp.push(input.provider_call_id);
      return {
        state: input.provider_call_id === 'call-a' ? 'pending' : 'succeeded',
        provider_state: input.provider_call_id === 'call-a' ? 'ringing' : 'active',
        ...(input.provider_call_id === 'call-a'
          ? { provider_call_id: 'call-a' }
          : input.provider_call_id === 'rwi-action-c'
            ? { provider_call_id: 'provider-call-from-action' }
            : {}),
        safe_diagnostics: {}
      };
    },
    async lookupRecording() { return { state: 'unknown', object_ref: '', safe_diagnostics: {} }; }
  };
}

function capabilities(): Record<VoiceCapability, boolean> {
  return {
    management_http: true,
    json_rpc_routing: true,
    step_ivr: false,
    rwi: false,
    webrtc_extension: false,
    recording: true,
    sipflow: true,
    queue: false,
    postgres_backend: true
  };
}

function rustPbxProfile(): VoiceDeploymentProfile {
  return {
    id: 'profile-rustpbx', tenant_id: 'tenant-a', name: 'RustPBX', adapter: 'rustpbx',
    status: 'enabled', base_url: 'https://pbx.internal', desired_version: '0.9.0',
    config: {}, secret_refs: {}, revision: 1, created_by: 'admin', updated_by: 'admin',
    created_at: '2026-07-13T12:00:00.000Z', updated_at: '2026-07-13T12:00:00.000Z'
  };
}

function voiceCall(patch: Partial<VoiceCall> = {}): VoiceCall {
  return {
    id: 'call-a', tenant_id: 'tenant-a', business_ref: { type: 'order', id: 'order-a' },
    provider_profile_id: 'profile-rustpbx', provider_call_id: '', provider_dialog_id: '',
    media_call_id: null, direction: 'outbound', state: 'dialing',
    from: { kind: 'extension', redacted: '**01' }, to: { kind: 'e164', redacted: '+86******8000' },
    idempotency_key: 'call-a', initiated_by: 'agent-a', metadata: {}, ringing_at: null,
    answered_at: null, ended_at: null, termination_reason: '', revision: 1,
    created_at: '2026-07-13T12:00:00.000Z', updated_at: '2026-07-13T12:00:00.000Z',
    ...patch
  };
}

function ownerContract(
  interactionId: string,
  reservationId: string,
  ownerEpoch: string
) {
  return {
    interaction_id: interactionId,
    reservation_id: reservationId,
    owner_epoch: ownerEpoch,
    route_snapshot_revision: 7,
    availability_profile: 'VOICE-ORDINARY' as const,
    auth_context_ref: null,
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    owner_node_id: 'rustpbx-a',
    media_control_profile: {
      media_profile_id: 'g711-relay-v1' as const
    }
  };
}

function voiceCommand(patch: Partial<VoiceCallCommand> = {}): VoiceCallCommand {
  return {
    id: 'command-a', tenant_id: 'tenant-a', call_id: 'call-a', kind: 'originate',
    state: 'processing', idempotency_key: 'command-a', payload_hash: 'a'.repeat(64),
    payload: {}, attempt_count: 1, max_attempts: 5, next_attempt_at: null,
    lease_until: '2026-07-13T12:01:00.000Z', worker_id: 'worker-a', provider_command_id: '',
    result: {}, error_code: '', error_message: '', created_at: '2026-07-13T12:00:00.000Z',
    updated_at: '2026-07-13T12:00:00.000Z', completed_at: null,
    ...patch
  };
}
