import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  VoiceReconciliationWorker,
  VoiceProviderRegistry,
  type VoiceCall,
  type VoiceCallCommand,
  type VoiceCallRepository,
  type VoiceCallUnitOfWork,
  type VoiceCallUnitOfWorkContext,
  type VoiceCommandRepository,
  type VoiceConfigurationCommand,
  type VoiceConfigurationRepository,
  type VoiceDeploymentProfile,
  type VoiceProviderAdapter,
  type VoiceProviderFactory
} from '../src/agent-runtime/converact/voice/index.js';

test('Voice reconciliation converges uncertain commands without resubmitting provider actions', async () => {
  const fixture = reconciliationFixture();
  const worker = new VoiceReconciliationWorker({
    unit_of_work: fixture.unitOfWork,
    provider_registry: fixture.registry,
    worker_id: 'reconcile-worker', batch_size: 10, lease_ms: 5_000,
    reconcile_delay_ms: 2_000, max_reconcile_age_ms: 60_000,
    now: () => new Date('2026-07-13T00:02:00.000Z')
  });
  const result = await worker.runOnce('tenant-a');

  assert.equal(fixture.executeCalls, 0);
  assert.equal(fixture.reconcileCalls, 5);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.pending, 1);
  assert.equal(result.unknown, 1);
  assert.equal(fixture.calls.get('call-succeeded')?.state, 'dialing');
  assert.equal(fixture.calls.get('call-succeeded')?.provider_call_id, 'provider-call-succeeded');
  assert.equal(fixture.calls.get('call-failed')?.state, 'failed');
  assert.equal(fixture.calls.get('call-unknown-old')?.state, 'failed');
  assert.equal(fixture.completed.find((item) => item.command_id === 'command-unknown-old')?.error_code, 'provider_result_unknown');
  assert.equal(fixture.released.find((item) => item.command_id === 'command-pending')?.state, 'uncertain');
  assert.equal(fixture.released.find((item) => item.command_id === 'command-pending')?.next_attempt_at?.toISOString(), '2026-07-13T00:02:02.000Z');
  assert.equal(fixture.released.find((item) => item.command_id === 'command-unknown-recent')?.state, 'uncertain');
  await worker.shutdown();
});

test('Voice reconciliation delegates LiveKit bridge commands to the specialized reconciler', async () => {
  const fixture = reconciliationFixture();
  fixture.commands[0]!.kind = 'livekit_bridge_create';
  let specializedCalls = 0;
  const worker = new VoiceReconciliationWorker({
    unit_of_work: fixture.unitOfWork,
    provider_registry: fixture.registry,
    command_reconciler: async ({ call, command }) => {
      if (command.kind !== 'livekit_bridge_create') return null;
      specializedCalls += 1;
      return { state: 'succeeded', provider_state: call.state, media_call_id: 'media-specialized' };
    },
    worker_id: 'reconcile-worker', batch_size: 10, lease_ms: 5_000,
    reconcile_delay_ms: 2_000, max_reconcile_age_ms: 60_000,
    now: () => new Date('2026-07-13T00:02:00.000Z')
  });
  const result = await worker.runOnce('tenant-a');
  assert.equal(specializedCalls, 1);
  assert.equal(fixture.reconcileCalls, 4);
  assert.equal(result.succeeded, 1);
  assert.equal(fixture.calls.get('call-succeeded')?.media_call_id, 'media-specialized');
});

test('Voice reconciliation releases a command when its call cannot be loaded', async () => {
  const fixture = reconciliationFixture();
  fixture.calls.delete('call-succeeded');
  const worker = new VoiceReconciliationWorker({
    unit_of_work: fixture.unitOfWork,
    provider_registry: fixture.registry,
    worker_id: 'reconcile-worker', batch_size: 10, lease_ms: 5_000,
    reconcile_delay_ms: 2_000, max_reconcile_age_ms: 60_000,
    now: () => new Date('2026-07-13T00:02:00.000Z')
  });

  const result = await worker.runOnce('tenant-a');
  assert.equal(result.pending, 2);
  assert.equal(
    fixture.released.find((item) => item.command_id === 'command-succeeded')?.state,
    'uncertain'
  );
});

test('Voice reconciliation ages configuration unknowns without replaying provider apply', async () => {
  const commands = [
    uncertainConfigurationCommand('recent', '2026-07-13T00:01:30.000Z'),
    uncertainConfigurationCommand('old', '2026-07-12T23:00:00.000Z')
  ];
  const released: Array<{ command_id: string; state: string; error_code?: string }> = [];
  const completed: Array<{ command_id: string; state: string; error_code?: string }> = [];
  const commandRepository = {
    async claimCallUncertain() { return []; },
    async claimConfigurationUncertain() { return commands; },
    async releaseConfiguration(input) {
      released.push({
        command_id: input.command_id,
        state: input.state,
        error_code: input.error_code
      });
      return commands.find((command) => command.id === input.command_id)!;
    },
    async completeConfiguration(input) {
      completed.push({
        command_id: input.command_id,
        state: input.state,
        error_code: input.error_code
      });
      return commands.find((command) => command.id === input.command_id)!;
    }
  } as unknown as VoiceCommandRepository;
  const context = {
    calls: {} as VoiceCallRepository,
    commands: commandRepository,
    configuration: {} as VoiceConfigurationRepository,
    parking: {} as VoiceCallUnitOfWorkContext['parking']
  } satisfies VoiceCallUnitOfWorkContext;
  const unitOfWork: VoiceCallUnitOfWork = {
    async run<T>(_tenantId: string, operation: (value: VoiceCallUnitOfWorkContext) => Promise<T>) {
      return operation(context);
    }
  };
  const worker = new VoiceReconciliationWorker({
    unit_of_work: unitOfWork,
    provider_registry: new VoiceProviderRegistry(),
    worker_id: 'configuration-reconcile-worker',
    batch_size: 10,
    lease_ms: 5_000,
    reconcile_delay_ms: 2_000,
    max_reconcile_age_ms: 60_000,
    now: () => new Date('2026-07-13T00:02:00.000Z')
  });

  const result = await worker.runOnce('tenant-a');

  assert.deepEqual(result, {
    claimed: 2,
    succeeded: 0,
    failed: 1,
    pending: 0,
    unknown: 1,
    stale: 0
  });
  assert.deepEqual(released, [{
    command_id: 'configuration-recent',
    state: 'uncertain',
    error_code: 'provider_result_unknown'
  }]);
  assert.deepEqual(completed, [{
    command_id: 'configuration-old',
    state: 'failed',
    error_code: 'provider_result_unknown'
  }]);
});

function reconciliationFixture() {
  const outcomes: Record<string, { state: 'pending' | 'succeeded' | 'failed' | 'unknown'; provider_state: string; provider_call_id?: string }> = {
    'command-succeeded': { state: 'succeeded', provider_state: 'dialing', provider_call_id: 'provider-call-succeeded' },
    'command-failed': { state: 'failed', provider_state: 'failed' },
    'command-pending': { state: 'pending', provider_state: 'trying' },
    'command-unknown-recent': { state: 'unknown', provider_state: 'not_found' },
    'command-unknown-old': { state: 'unknown', provider_state: 'not_found' }
  };
  const commands = [
    uncertainCommand('succeeded', '2026-07-13T00:01:30.000Z'),
    uncertainCommand('failed', '2026-07-13T00:01:30.000Z'),
    uncertainCommand('pending', '2026-07-13T00:01:30.000Z'),
    uncertainCommand('unknown-recent', '2026-07-13T00:01:30.000Z'),
    uncertainCommand('unknown-old', '2026-07-12T23:00:00.000Z')
  ];
  const calls = new Map(commands.map((command) => [command.call_id, voiceCall(command.call_id)]));
  const completed: Array<{ command_id: string; state: string; error_code?: string }> = [];
  const released: Array<{ command_id: string; state: string; next_attempt_at?: Date | null }> = [];
  let executeCalls = 0;
  let reconcileCalls = 0;
  const profile = deploymentProfile();

  const callRepository = {
    async get(_tenantId: string, callId: string) { return calls.get(callId) ?? null; },
    async update(call: VoiceCall, expected: number) {
      const current = calls.get(call.id);
      assert.equal(current?.revision, expected);
      calls.set(call.id, call);
      return call;
    }
  } as VoiceCallRepository;
  const commandRepository = {
    async claimCallUncertain() { return commands; },
    async completeCall(input) {
      completed.push({ command_id: input.command_id, state: input.state, error_code: input.error_code });
      return commands.find((command) => command.id === input.command_id)!;
    },
    async releaseCall(input) {
      released.push({ command_id: input.command_id, state: input.state, next_attempt_at: input.next_attempt_at });
      return commands.find((command) => command.id === input.command_id)!;
    }
  } as unknown as VoiceCommandRepository;
  const configuration = {
    async getProfile() { return profile; }
  } as unknown as VoiceConfigurationRepository;
  const context: VoiceCallUnitOfWorkContext = {
    calls: callRepository, commands: commandRepository, configuration,
    parking: {} as VoiceCallUnitOfWorkContext['parking']
  };
  const unitOfWork: VoiceCallUnitOfWork = {
    async run<T>(_tenantId: string, operation: (context: VoiceCallUnitOfWorkContext) => Promise<T>): Promise<T> {
      return operation(context);
    }
  };
  const registry = new VoiceProviderRegistry();
  registry.register('rustpbx', {
    async create() {
      return {
        management: {} as VoiceProviderAdapter['management'],
        async preflight() { throw new Error('not used'); },
        async execute() { executeCalls += 1; throw new Error('execute must not run'); },
        async reconcile({ command }) { reconcileCalls += 1; return outcomes[command.id]; },
        normalizeEvent() { throw new Error('not used'); },
        async close() {}
      } as VoiceProviderAdapter;
    }
  } as VoiceProviderFactory);
  return {
    unitOfWork, registry, calls, commands, completed, released,
    get executeCalls() { return executeCalls; },
    get reconcileCalls() { return reconcileCalls; }
  };
}

function uncertainCommand(label: string, createdAt: string): VoiceCallCommand {
  return {
    id: `command-${label}`, tenant_id: 'tenant-a', call_id: `call-${label}`, kind: 'originate',
    state: 'processing', idempotency_key: `key-${label}`, payload_hash: 'a'.repeat(64), payload: {},
    attempt_count: 1, max_attempts: 5, next_attempt_at: null,
    lease_until: '2026-07-13T00:03:00.000Z', worker_id: 'reconcile-worker', provider_command_id: '',
    result: {}, error_code: 'provider_timeout', error_message: '', created_at: createdAt,
    updated_at: createdAt, completed_at: null
  };
}

function uncertainConfigurationCommand(
  label: string,
  createdAt: string
): VoiceConfigurationCommand {
  return {
    id: `configuration-${label}`,
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    resource_type: 'sip_trunk',
    resource_id: 'trunk-a',
    operation: 'apply',
    state: 'processing',
    idempotency_key: `configuration-key-${label}`,
    payload_hash: 'b'.repeat(64),
    payload: { source_revision: 1 },
    attempt_count: 1,
    max_attempts: 5,
    next_attempt_at: null,
    lease_until: '2026-07-13T00:03:00.000Z',
    worker_id: 'configuration-reconcile-worker',
    provider_command_id: '',
    result: {},
    error_code: 'provider_timeout',
    error_message: '',
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null
  };
}

function voiceCall(id: string): VoiceCall {
  return {
    id, tenant_id: 'tenant-a', business_ref: { type: 'ticket', id }, provider_profile_id: 'profile-a',
    provider_call_id: '', provider_dialog_id: '', media_call_id: null, direction: 'outbound', state: 'planned',
    from: { kind: 'extension', redacted: '**01' }, to: { kind: 'e164', redacted: '+86*******9000' },
    idempotency_key: id, initiated_by: 'agent', metadata: {}, ringing_at: null, answered_at: null,
    ended_at: null, termination_reason: '', revision: 1,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function deploymentProfile(): VoiceDeploymentProfile {
  return {
    id: 'profile-a', tenant_id: 'tenant-a', name: 'PBX', adapter: 'rustpbx', status: 'enabled',
    base_url: 'https://pbx.internal', desired_version: '1', config: {}, secret_refs: {}, revision: 1,
    created_by: 'admin', updated_by: 'admin', created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}
