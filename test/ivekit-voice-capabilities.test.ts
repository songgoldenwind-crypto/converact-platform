import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ControlledVoiceProviderFactory,
  VoiceDeploymentProfileService,
  VoiceError,
  VoiceProviderRegistry,
  type VoiceCall,
  type VoiceCallCommand,
  type VoiceCapability,
  type VoiceCapabilitySnapshot,
  type VoiceConfigurationRepository,
  type VoiceDeploymentProfile
} from '../src/agent-runtime/ivekit/voice/index.js';

const ALL_CAPABILITIES: VoiceCapability[] = [
  'management_http',
  'json_rpc_routing',
  'step_ivr',
  'rwi',
  'webrtc_extension',
  'recording',
  'sipflow',
  'queue',
  'postgres_backend'
];

test('Voice provider registry is explicit and enforces execution profile status', async () => {
  const factory = new ControlledVoiceProviderFactory({ now: () => new Date('2026-07-13T05:00:00.000Z') });
  const registry = new VoiceProviderRegistry({ controlled: factory });

  const preflightAdapter = await registry.create(profile({ status: 'disabled' }), { purpose: 'preflight' });
  assert.equal((await preflightAdapter.preflight()).provider, 'controlled');
  await preflightAdapter.close();

  await assert.rejects(
    () => registry.create(profile({ status: 'disabled' }), { purpose: 'execute' }),
    hasVoiceCode('capability_unavailable')
  );
  await assert.rejects(
    () => registry.create(profile({ status: 'archived' }), { purpose: 'preflight' }),
    hasVoiceCode('capability_unavailable')
  );
  await assert.rejects(
    () => registry.create(profile({ adapter: 'active_call', status: 'enabled' }), { purpose: 'execute' }),
    hasVoiceCode('capability_unavailable')
  );
});

test('Voice deployment profile service stores refs, rejects direct secrets, and preserves revisions', async () => {
  const repository = new ConfigurationRepositoryFake();
  const service = new VoiceDeploymentProfileService({
    repository: repository as unknown as VoiceConfigurationRepository,
    registry: new VoiceProviderRegistry({ controlled: new ControlledVoiceProviderFactory() })
  });
  const valid = profile();
  assert.deepEqual((await service.create(valid)).secret_refs, {
    rwi: 'env://RUSTPBX_RWI_TOKEN'
  });

  await assert.rejects(
    () => service.create(profile({ id: 'profile-direct-secret', secret_refs: { rwi: 'clear-secret' } })),
    hasVoiceCode('secret_ref_invalid')
  );
  await assert.rejects(
    () => service.create(profile({ id: 'profile-config-secret', config: { api_token: 'clear-secret' } })),
    hasVoiceCode('secret_ref_invalid')
  );
  await assert.rejects(
    () => service.create(profile({ id: 'profile-url-secret', base_url: 'https://admin:clear-secret@pbx.internal' })),
    hasVoiceCode('secret_ref_invalid')
  );
  await assert.rejects(
    () => service.create(profile({ id: 'profile-query-secret', base_url: 'https://pbx.internal?token=clear-secret' })),
    hasVoiceCode('secret_ref_invalid')
  );

  repository.updateError = new VoiceError({ code: 'revision_conflict' });
  await assert.rejects(
    () => service.update(valid, 9),
    hasVoiceCode('revision_conflict')
  );
});

test('Voice preflight persists all nine capabilities with an authoritative config hash', async () => {
  const repository = new ConfigurationRepositoryFake();
  const configured = profile({
    config: {
      controlled_capabilities: {
        management_http: true,
        rwi: true,
        recording: true,
        postgres_backend: true
      }
    }
  });
  repository.profiles.set(configured.id, configured);
  const service = new VoiceDeploymentProfileService({
    repository: repository as unknown as VoiceConfigurationRepository,
    registry: new VoiceProviderRegistry({ controlled: new ControlledVoiceProviderFactory({
      now: () => new Date('2026-07-13T05:00:00.000Z')
    }) }),
    id: () => 'snapshot-a',
    now: () => new Date('2026-07-13T05:00:00.000Z')
  });

  const snapshot = await service.preflight('tenant-a', configured.id);
  assert.equal(snapshot.status, 'ready');
  assert.match(snapshot.config_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(snapshot.capabilities).sort(), [...ALL_CAPABILITIES].sort());
  assert.equal(snapshot.capabilities.management_http, true);
  assert.equal(snapshot.capabilities.rwi, true);
  assert.equal(snapshot.capabilities.queue, false);
  assert.equal(repository.snapshots.length, 1);

  const sameConfigDifferentResolvedSecret = profile({
    ...configured,
    id: 'profile-b',
    secret_refs: { rwi: 'env://RUSTPBX_RWI_TOKEN' }
  });
  repository.profiles.set(sameConfigDifferentResolvedSecret.id, sameConfigDifferentResolvedSecret);
  const second = await service.preflight('tenant-a', sameConfigDifferentResolvedSecret.id);
  assert.equal(second.config_hash, snapshot.config_hash);

  const differentRef = profile({
    ...configured,
    id: 'profile-c',
    secret_refs: { rwi: 'env://RUSTPBX_RWI_TOKEN_SECONDARY' }
  });
  repository.profiles.set(differentRef.id, differentRef);
  const third = await service.preflight('tenant-a', differentRef.id);
  assert.notEqual(third.config_hash, snapshot.config_hash);
});

test('Voice preflight persists controlled failure classifications instead of losing diagnostics', async () => {
  for (const failure of [
    'provider_auth_failed',
    'provider_unavailable',
    'protocol_mismatch',
    'capability_unavailable'
  ] as const) {
    const repository = new ConfigurationRepositoryFake();
    const configured = profile({ id: `profile-${failure}`, config: { controlled_failure: failure } });
    repository.profiles.set(configured.id, configured);
    const service = new VoiceDeploymentProfileService({
      repository: repository as unknown as VoiceConfigurationRepository,
      registry: new VoiceProviderRegistry({ controlled: new ControlledVoiceProviderFactory() }),
      id: () => `snapshot-${failure}`
    });

    const snapshot = await service.preflight('tenant-a', configured.id);
    assert.equal(snapshot.error_code, failure);
    assert.equal(snapshot.status, failure === 'capability_unavailable' ? 'not_available' : 'failed');
    assert.equal(ALL_CAPABILITIES.every((capability) => snapshot.capabilities[capability] === false), true);
    assert.equal(repository.snapshots.length, 1);
  }
});

test('Controlled Voice adapter is deterministic across commands, reconciliation, management, and events', async () => {
  const factory = new ControlledVoiceProviderFactory({ now: () => new Date('2026-07-13T05:00:00.000Z') });
  const adapter = await factory.create(profile({ status: 'enabled' }));
  const input = { call: call(), command: command() };
  const first = await adapter.execute(input);
  const replay = await adapter.execute(input);
  assert.deepEqual(replay, first);
  assert.equal((await adapter.reconcile(input)).state, 'succeeded');

  assert.equal((await adapter.management.applyTrunk({ resource_id: 'trunk-a', desired_state: {} })).provider_ref, 'controlled:trunk-a');
  assert.equal((await adapter.management.testTrunk({ resource_id: 'trunk-a' })).ready, true);
  assert.equal((await adapter.management.applyExtension({ resource_id: 'extension-a', desired_state: {} })).provider_ref, 'controlled:extension-a');
  assert.equal((await adapter.management.applyRoute({ resource_id: 'route-a', desired_state: {} })).provider_ref, 'controlled:route-a');
  assert.equal((await adapter.management.lookupDialog({ provider_call_id: first.provider_call_id! })).state, 'succeeded');
  assert.equal((await adapter.management.lookupRecording({ provider_recording_id: 'recording-a' })).state, 'available');
  assert.deepEqual(adapter.normalizeEvent({ event_id: 'event-a', type: 'call.ringing', state: 'ringing' }), {
    external_event_id: 'event-a',
    event_type: 'call.ringing',
    provider_state: 'ringing',
    occurred_at: null,
    safe_payload: { event_id: 'event-a', type: 'call.ringing', state: 'ringing' }
  });
  await adapter.close();
});

test('Controlled Voice adapter models retryable timeout and uncertain reconciliation without duplicate originate', async () => {
  const factory = new ControlledVoiceProviderFactory();
  const adapter = await factory.create(profile({
    status: 'enabled',
    config: { controlled_command_mode: 'timeout_then_succeed' }
  }));
  const input = { call: call(), command: command() };

  await assert.rejects(() => adapter.execute(input), hasVoiceCode('provider_timeout'));
  assert.equal((await adapter.reconcile(input)).state, 'succeeded');
  await assert.rejects(() => adapter.execute(input), hasVoiceCode('provider_timeout'));
  assert.equal((await adapter.reconcile(input)).state, 'succeeded');
});

class ConfigurationRepositoryFake {
  readonly profiles = new Map<string, VoiceDeploymentProfile>();
  readonly snapshots: VoiceCapabilitySnapshot[] = [];
  updateError: Error | null = null;

  async insertProfile(input: VoiceDeploymentProfile): Promise<VoiceDeploymentProfile> {
    this.profiles.set(input.id, structuredClone(input));
    return structuredClone(input);
  }

  async updateProfile(input: VoiceDeploymentProfile): Promise<VoiceDeploymentProfile> {
    if (this.updateError) throw this.updateError;
    this.profiles.set(input.id, structuredClone(input));
    return structuredClone(input);
  }

  async getProfile(tenantId: string, id: string): Promise<VoiceDeploymentProfile | null> {
    const found = this.profiles.get(id);
    return found?.tenant_id === tenantId ? structuredClone(found) : null;
  }

  async insertCapabilitySnapshot(input: VoiceCapabilitySnapshot): Promise<VoiceCapabilitySnapshot> {
    this.snapshots.push(structuredClone(input));
    return structuredClone(input);
  }
}

function profile(overrides: Partial<VoiceDeploymentProfile> = {}): VoiceDeploymentProfile {
  return {
    id: 'profile-a', tenant_id: 'tenant-a', name: 'Controlled PBX', adapter: 'controlled',
    status: 'disabled', base_url: 'http://127.0.0.1:18080', desired_version: 'controlled-v1',
    config: {}, secret_refs: { rwi: 'env://RUSTPBX_RWI_TOKEN' }, revision: 1,
    created_by: 'admin-a', updated_by: 'admin-a', created_at: '2026-07-13T05:00:00.000Z',
    updated_at: '2026-07-13T05:00:00.000Z', ...overrides
  };
}

function call(): VoiceCall {
  return {
    id: 'call-a', tenant_id: 'tenant-a', business_ref: { type: 'order', id: 'ORDER-1' },
    provider_profile_id: 'profile-a', provider_call_id: '', provider_dialog_id: '', media_call_id: null,
    direction: 'outbound', state: 'planned', from: { kind: 'extension', redacted: '**01' },
    to: { kind: 'e164', redacted: '+86******8000' }, idempotency_key: 'call-a', initiated_by: 'agent-a',
    metadata: {}, ringing_at: null, answered_at: null, ended_at: null, termination_reason: '',
    revision: 1, created_at: '2026-07-13T05:00:00.000Z', updated_at: '2026-07-13T05:00:00.000Z'
  };
}

function command(): VoiceCallCommand {
  return {
    id: 'command-a', tenant_id: 'tenant-a', call_id: 'call-a', kind: 'originate', state: 'processing',
    idempotency_key: 'command-a', payload_hash: 'a'.repeat(64), payload: {}, attempt_count: 1,
    max_attempts: 3, next_attempt_at: null, lease_until: '2026-07-13T05:01:00.000Z', worker_id: 'worker-a',
    provider_command_id: '', result: {}, error_code: '', error_message: '', created_at: '2026-07-13T05:00:00.000Z',
    updated_at: '2026-07-13T05:00:00.000Z', completed_at: null
  };
}

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof VoiceError && error.code === code;
}
