import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RUSTPBX_RWI_EFFECTIVE_CAPABILITIES,
  RUSTPBX_RWI_PROTOCOL_CAPABILITIES,
  RustPbxVoiceProviderAdapter,
  VoiceError,
  voiceProfileConfigHash,
  type VoiceCall,
  type VoiceCallCommand,
  type VoiceCapability,
  type VoiceDeploymentProfile,
  type VoiceManagementPort
} from '../src/agent-runtime/ivekit/voice/index.js';

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
  assert.deepEqual(rwi.events.slice(0, 2), ['connect', 'preflight']);
  await adapter.close();
  assert.equal(rwi.events.at(-1), 'close');
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

test('RustPBX provider reconciles by provider call id then durable RWI action id', async () => {
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

  assert.equal(active.state, 'succeeded');
  assert.equal(fallback.state, 'succeeded');
  assert.equal(fallback.provider_call_id, 'provider-call-from-action');
  assert.deepEqual(lookedUp, ['provider-call-a', 'rwi-action-b']);
});

function fakeRwi() {
  const state = {
    mode: 'success' as 'success' | 'uncertain',
    events: [] as string[],
    commands: [] as Array<{ command_id: string; payload: Record<string, unknown> }>,
    async connect() { state.events.push('connect'); },
    async preflight() {
      state.events.push('preflight');
      return {
        ready: true as const,
        protocol: 'rwi-v1' as const,
        commands: ['call.originate'],
        capability_source: 'pinned_baseline' as const,
        runtime_version_verified: false as const,
        protocol_capabilities: RUSTPBX_RWI_PROTOCOL_CAPABILITIES,
        effective_capabilities: RUSTPBX_RWI_EFFECTIVE_CAPABILITIES,
        limitations: []
      };
    },
    async execute(input: { command_id: string; payload: Record<string, unknown> }) {
      state.commands.push(input);
      if (state.mode === 'uncertain') {
        return { state: 'uncertain' as const, action_id: input.command_id, error_code: 'timeout' };
      }
      return {
        state: 'succeeded' as const,
        action_id: input.command_id,
        result: { call_id: 'provider-call-a', accepted: true }
      };
    },
    async close() { state.events.push('close'); }
  };
  return state;
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
        state: 'succeeded', provider_state: 'active',
        ...(input.provider_call_id === 'rwi-action-b'
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
