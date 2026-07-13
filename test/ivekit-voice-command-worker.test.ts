import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  VoiceCommandWorker,
  VoiceError,
  VoiceProviderRegistry,
  voiceProfileConfigHash,
  type VoiceCallCommand,
  type VoiceCapability,
  type VoiceCapabilitySnapshot,
  type VoiceCommandReleaseInput,
  type VoiceCommandRepository,
  type VoiceConfigurationCommand,
  type VoiceConfigurationRepository,
  type VoiceDeploymentProfile,
  type VoiceProviderAdapter,
  type VoiceProviderFactory,
  type VoiceRoute,
  type VoiceSipTrunk
} from '../src/agent-runtime/ivekit/voice/index.js';

test('Voice command worker runs one shared call/configuration batch and shutdown waits', async () => {
  const gate = deferred<void>();
  const call = callCommand({ id: 'call-command-a', kind: 'answer' });
  const config = configurationCommand({ id: 'config-command-a', resource_type: 'sip_trunk', operation: 'apply' });
  const fixture = workerFixture({ callCommands: [call], configurationCommands: [config] });
  let callExecutions = 0;
  const worker = new VoiceCommandWorker({
    commands: fixture.commands,
    configuration: fixture.configuration,
    provider_registry: fixture.registry,
    call_executor: async () => {
      callExecutions += 1;
      await gate.promise;
      return { provider_command_id: 'provider-call-a', result: { accepted: true } };
    },
    worker_id: 'worker-a', batch_size: 10, lease_ms: 5_000,
    now: () => new Date('2026-07-13T00:00:00.000Z'), random: () => 0.5
  });

  const first = worker.runOnce('tenant-a');
  const concurrent = worker.runOnce('tenant-a');
  await waitFor(() => callExecutions === 1);
  let shutdownComplete = false;
  const shutdown = worker.shutdown().then(() => { shutdownComplete = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(shutdownComplete, false);
  gate.resolve();
  const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
  await shutdown;

  assert.deepEqual(firstResult, concurrentResult);
  assert.equal(fixture.callClaims, 1);
  assert.equal(fixture.configurationClaims, 1);
  assert.equal(fixture.managementApplies, 1);
  assert.equal(fixture.completed.map((item) => item.command_id).sort().join(','), 'call-command-a,config-command-a');
  assert.equal(firstResult.succeeded, 2);
});

test('Voice command worker gates capabilities and classifies retry, uncertain, and stale leases', async () => {
  const commands = [
    configurationCommand({ id: 'capability-denied', profile_id: 'profile-disabled', resource_type: 'sip_trunk', resource_id: 'trunk-disabled', operation: 'apply' }),
    configurationCommand({ id: 'retryable-test', profile_id: 'profile-retry', resource_type: 'sip_trunk', resource_id: 'trunk-retry', operation: 'test', attempt_count: 1 }),
    configurationCommand({ id: 'uncertain-route', profile_id: 'profile-timeout', resource_type: 'route', resource_id: 'route-timeout', operation: 'apply' }),
    configurationCommand({ id: 'expired-lease', profile_id: 'profile-ok', resource_type: 'sip_trunk', resource_id: 'trunk-ok', operation: 'apply', state: 'processing' }),
    configurationCommand({ id: 'completion-db-failure', profile_id: 'profile-ok', resource_type: 'sip_trunk', resource_id: 'trunk-ok', operation: 'apply' })
  ];
  const fixture = workerFixture({
    configurationCommands: commands,
    staleCompletionId: 'expired-lease',
    completionFailureId: 'completion-db-failure'
  });
  fixture.capabilities.set('profile-disabled', capabilitySnapshot('profile-disabled', false, fixture.profiles.get('profile-disabled')!));
  const worker = new VoiceCommandWorker({
    commands: fixture.commands,
    configuration: fixture.configuration,
    provider_registry: fixture.registry,
    worker_id: 'worker-b', batch_size: 10, lease_ms: 5_000,
    retry_base_ms: 1_000, retry_max_ms: 30_000,
    now: () => new Date('2026-07-13T00:00:00.000Z'), random: () => 0.5
  });
  const result = await worker.runOnce('tenant-a');

  assert.equal(releaseFor(fixture.released, 'capability-denied').state, 'failed');
  assert.equal(releaseFor(fixture.released, 'capability-denied').error_code, 'capability_unavailable');
  const retry = releaseFor(fixture.released, 'retryable-test');
  assert.equal(retry.state, 'retry_wait');
  assert.equal(retry.next_attempt_at?.toISOString(), '2026-07-13T00:00:02.000Z');
  assert.equal(releaseFor(fixture.released, 'uncertain-route').state, 'uncertain');
  assert.equal(releaseFor(fixture.released, 'uncertain-route').error_code, 'provider_timeout');
  assert.equal(releaseFor(fixture.released, 'completion-db-failure').state, 'uncertain');
  assert.equal(result.stale, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.retry_wait, 1);
  assert.equal(result.uncertain, 2);
  await worker.shutdown();
});

test('Voice command worker never retries ambiguous LiveKit bridge timeouts', async () => {
  const command = callCommand({ id: 'bridge-timeout', kind: 'livekit_bridge_create', attempt_count: 1 });
  const fixture = workerFixture({ callCommands: [command] });
  const worker = new VoiceCommandWorker({
    commands: fixture.commands,
    configuration: fixture.configuration,
    provider_registry: fixture.registry,
    call_executor: async () => {
      throw new VoiceError({ code: 'provider_timeout', retryable: true, status: 504 });
    },
    worker_id: 'worker-bridge', batch_size: 10, lease_ms: 5_000,
    now: () => new Date('2026-07-13T00:00:00.000Z'), random: () => 0.5
  });
  const result = await worker.runOnce('tenant-a');
  assert.equal(releaseFor(fixture.released, 'bridge-timeout').state, 'uncertain');
  assert.equal(result.uncertain, 1);
  assert.equal(result.retry_wait, 0);
});

test('Voice command worker rejects unsafe runtime bounds', () => {
  const fixture = workerFixture({});
  assert.throws(() => new VoiceCommandWorker({
    commands: fixture.commands, configuration: fixture.configuration,
    provider_registry: fixture.registry, worker_id: 'worker', batch_size: 0, lease_ms: 5_000
  }), hasVoiceCode('validation_failed'));
  assert.throws(() => new VoiceCommandWorker({
    commands: fixture.commands, configuration: fixture.configuration,
    provider_registry: fixture.registry, worker_id: 'worker', batch_size: 10, lease_ms: 999
  }), hasVoiceCode('validation_failed'));
});

function workerFixture(input: {
  callCommands?: VoiceCallCommand[];
  configurationCommands?: VoiceConfigurationCommand[];
  staleCompletionId?: string;
  completionFailureId?: string;
}) {
  const completed: Array<{ command_id: string; state: string }> = [];
  const released: VoiceCommandReleaseInput[] = [];
  let callClaims = 0;
  let configurationClaims = 0;
  let managementApplies = 0;
  const profiles = new Map<string, VoiceDeploymentProfile>();
  const capabilities = new Map<string, VoiceCapabilitySnapshot>();
  for (const profileId of ['profile-a', 'profile-disabled', 'profile-retry', 'profile-timeout', 'profile-ok']) {
    const profile = deploymentProfile(profileId);
    profiles.set(profileId, profile);
    capabilities.set(profileId, capabilitySnapshot(profileId, true, profile));
  }
  const trunk = sipTrunk();
  const route = voiceRoute();

  const commands = {
    async findCallByIdempotencyKey() { return null; },
    async insertCall(value) { return value; },
    async claimCallDue() { callClaims += 1; return input.callCommands ?? []; },
    async claimCallUncertain() { return []; },
    async findConfigurationByIdempotencyKey() { return null; },
    async insertConfiguration(value) { return value; },
    async claimConfigurationDue() { configurationClaims += 1; return input.configurationCommands ?? []; },
    async claimConfigurationUncertain() { return []; },
    async completeCall(value) { completed.push({ command_id: value.command_id, state: value.state }); return callCommand({ id: value.command_id }); },
    async completeConfiguration(value) {
      if (value.command_id === input.staleCompletionId) throw new VoiceError({ code: 'lease_lost', status: 409 });
      if (value.command_id === input.completionFailureId) throw new Error('database unavailable');
      completed.push({ command_id: value.command_id, state: value.state });
      return configurationCommand({ id: value.command_id });
    },
    async releaseCall(value) { released.push(value); return callCommand({ id: value.command_id, state: value.state }); },
    async releaseConfiguration(value) { released.push(value); return configurationCommand({ id: value.command_id, state: value.state }); }
  } as VoiceCommandRepository;

  const configuration = {
    async getProfile(_tenantId: string, profileId: string) { return profiles.get(profileId) ?? null; },
    async getLatestCapabilitySnapshot(_tenantId: string, profileId: string) { return capabilities.get(profileId) ?? null; },
    async getTrunk(_tenantId: string, resourceId: string) {
      return { ...trunk, id: resourceId, profile_id: resourceProfile(resourceId, 'trunk') };
    },
    async getRoute(_tenantId: string, resourceId: string) {
      return { ...route, id: resourceId, profile_id: resourceProfile(resourceId, 'route') };
    },
    async listRouteVersions(_tenantId: string, resourceId: string) { return [{
      id: 'route-version-a', tenant_id: 'tenant-a', route_id: resourceId, version: 1,
      rules: route.draft_rules, payload_hash: 'a'.repeat(64), deployment_state: 'pending',
      provider_revision: '', published_by: 'admin', published_at: '2026-07-13T00:00:00.000Z'
    }]; }
  } as VoiceConfigurationRepository;

  const registry = new VoiceProviderRegistry();
  registry.register('rustpbx', {
    async create(profile) {
      return providerAdapter(profile.id, {
        apply() { managementApplies += 1; },
        mode: profile.id === 'profile-retry' ? 'retry' : profile.id === 'profile-timeout' ? 'timeout' : 'ok'
      });
    }
  } as VoiceProviderFactory);

  return {
    commands, configuration, registry, profiles, capabilities, completed, released,
    get callClaims() { return callClaims; },
    get configurationClaims() { return configurationClaims; },
    get managementApplies() { return managementApplies; }
  };
}

function providerAdapter(profileId: string, input: { apply(): void; mode: 'ok' | 'retry' | 'timeout' }): VoiceProviderAdapter {
  const fail = () => {
    if (input.mode === 'retry') throw new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 });
    if (input.mode === 'timeout') throw new VoiceError({ code: 'provider_timeout', retryable: true, status: 504 });
  };
  return {
    async preflight() { return providerCapabilities(profileId); },
    async execute() { return { provider_command_id: 'provider-command', accepted: true }; },
    async reconcile() { return { state: 'succeeded' }; },
    normalizeEvent() { throw new Error('not used'); },
    async close() {},
    management: {
      async preflight() { return providerCapabilities(profileId); },
      async applyTrunk() { fail(); input.apply(); return applied(); },
      async testTrunk() { fail(); return { ready: true, error_code: '', safe_diagnostics: {} }; },
      async applyExtension() { fail(); input.apply(); return applied(); },
      async applyRoute() { fail(); input.apply(); return applied(); },
      async lookupDialog() { return { state: 'unknown', provider_state: '', safe_diagnostics: {} }; },
      async lookupRecording() { return { state: 'unknown', object_ref: '', safe_diagnostics: {} }; }
    }
  };
}

function applied() {
  return { provider_ref: 'provider-resource', provider_revision: 'revision-a', safe_diagnostics: {} };
}

function deploymentProfile(id: string): VoiceDeploymentProfile {
  return {
    id, tenant_id: 'tenant-a', name: id, adapter: 'rustpbx', status: 'enabled',
    base_url: 'https://pbx.internal', desired_version: '1', config: {}, secret_refs: {},
    revision: 1, created_by: 'admin', updated_by: 'admin',
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function capabilitySnapshot(profileId: string, management: boolean, profile: VoiceDeploymentProfile): VoiceCapabilitySnapshot {
  return {
    id: `snapshot-${profileId}`, tenant_id: 'tenant-a', profile_id: profileId,
    provider: 'rustpbx', provider_version: '1', status: management ? 'ready' : 'not_available',
    capabilities: capabilityMap(management), config_hash: voiceProfileConfigHash(profile),
    error_code: '', error_message: '', checked_at: '2026-07-13T00:00:00.000Z',
    created_at: '2026-07-13T00:00:00.000Z'
  };
}

function providerCapabilities(profileId: string) {
  const profile = deploymentProfile(profileId);
  return {
    profile_id: profileId, provider: 'rustpbx', provider_version: '1',
    capabilities: capabilityMap(true), checked_at: '2026-07-13T00:00:00.000Z',
    config_hash: voiceProfileConfigHash(profile)
  };
}

function capabilityMap(management: boolean): Record<VoiceCapability, boolean> {
  return {
    management_http: management, json_rpc_routing: management, step_ivr: false, rwi: false,
    webrtc_extension: false, recording: false, sipflow: false, queue: false,
    postgres_backend: true
  };
}

function callCommand(overrides: Partial<VoiceCallCommand> = {}): VoiceCallCommand {
  return {
    id: 'call-command', tenant_id: 'tenant-a', call_id: 'call-a', kind: 'answer', state: 'processing',
    idempotency_key: 'call-key', payload_hash: 'a'.repeat(64), payload: {}, attempt_count: 1,
    max_attempts: 5, next_attempt_at: null, lease_until: '2026-07-13T00:01:00.000Z',
    worker_id: 'worker', provider_command_id: '', result: {}, error_code: '', error_message: '',
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z', completed_at: null,
    ...overrides
  };
}

function configurationCommand(overrides: Partial<VoiceConfigurationCommand> = {}): VoiceConfigurationCommand {
  return {
    id: 'config-command', tenant_id: 'tenant-a', profile_id: 'profile-a',
    resource_type: 'sip_trunk', resource_id: 'trunk-a', operation: 'apply', state: 'processing',
    idempotency_key: 'config-key', payload_hash: 'b'.repeat(64), payload: {}, attempt_count: 1,
    max_attempts: 5, next_attempt_at: null, lease_until: '2026-07-13T00:01:00.000Z',
    worker_id: 'worker', provider_command_id: '', result: {}, error_code: '', error_message: '',
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z', completed_at: null,
    ...overrides
  };
}

function sipTrunk(): VoiceSipTrunk {
  return {
    id: 'trunk-a', tenant_id: 'tenant-a', profile_id: 'profile-a', name: 'Trunk', provider_ref: '',
    direction: 'both', transport: 'tls', codecs: ['PCMU'], max_channels: 10,
    credential_secret_ref: 'env://TRUNK_CREDENTIAL', desired_state: {}, status: 'draft', revision: 1,
    created_by: 'admin', updated_by: 'admin', created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function voiceRoute(): VoiceRoute {
  return {
    id: 'route-a', tenant_id: 'tenant-a', profile_id: 'profile-a', name: 'Route', direction: 'inbound',
    status: 'active', draft_revision: 2, draft_rules: { action: 'forward_sip' }, current_published_version: 1,
    created_by: 'admin', updated_by: 'admin', created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function resourceProfile(resourceId: string, prefix: string): string {
  const suffix = resourceId.replace(`${prefix}-`, '');
  return suffix === 'a' ? 'profile-a' : `profile-${suffix}`;
}

function releaseFor(releases: VoiceCommandReleaseInput[], commandId: string): VoiceCommandReleaseInput {
  const release = releases.find((item) => item.command_id === commandId);
  assert.ok(release);
  return release;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof VoiceError && error.code === code;
}
