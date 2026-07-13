import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  VoiceCallService,
  VoiceProviderCallCommandExecutor,
  VoiceProviderRegistry,
  VoiceError,
  voiceProfileConfigHash,
  type VoiceAddressProtector,
  type VoiceCall,
  type VoiceCallCommand,
  type VoiceCallRepository,
  type VoiceCallUnitOfWork,
  type VoiceCallUnitOfWorkContext,
  type VoiceCapability,
  type VoiceCommandRepository,
  type VoiceCompliancePort,
  type VoiceConfigurationRepository,
  type VoiceDeploymentProfile,
  type VoiceEventPort,
  type VoicePolicy,
  type VoiceProtectedAddress,
  type VoiceProviderAdapter
} from '../src/agent-runtime/ivekit/voice/index.js';

test('Voice call service atomically creates compliant outbound calls without plaintext persistence', async () => {
  const fixture = callFixture();
  const input = {
    tenant_id: 'tenant-a', profile_id: 'profile-a',
    from: { kind: 'e164' as const, value: '+8613800138000' },
    to: { kind: 'e164' as const, value: '+8613900139000' },
    business_ref: { type: 'order', id: 'order-a' }, actor: 'agent-a',
    idempotency_key: 'outbound-call-a', metadata: { campaign: 'summer' }
  };
  const created = await fixture.service.createOutbound(input);
  assert.equal(created.call.direction, 'outbound');
  assert.deepEqual(created.call.from, { kind: 'e164', redacted: '+86*******8000' });
  assert.deepEqual(created.call.to, { kind: 'e164', redacted: '+86*******9000' });
  assert.equal(created.command.kind, 'originate');
  assert.equal(created.command.state, 'pending');
  assert.equal(fixture.complianceCalls, 1);
  assert.equal(fixture.transactionCommits, 1);
  assert.equal(fixture.providerCalls, 0);
  assert.equal(JSON.stringify(created.command).includes('+8613900139000'), false);
  assert.equal(JSON.stringify(fixture.calls.get(created.call.id)).includes('+8613900139000'), false);
  assert.equal(fixture.protectedValues.map((item) => item.value).join(','), '+8613800138000,+8613900139000');
  assert.equal(fixture.events[0]?.type, 'voice.call.created');

  const replay = await fixture.service.createOutbound(input);
  assert.equal(replay.call.id, created.call.id);
  assert.equal(replay.command.id, created.command.id);
  assert.equal(fixture.calls.size, 1);
  await assert.rejects(() => fixture.service.createOutbound({
    ...input, to: { kind: 'e164', value: '+8613700137000' }
  }), hasVoiceCode('idempotency_conflict'));
});

test('Voice call service denies outbound calls before persistence when compliance fails', async () => {
  const fixture = callFixture({ complianceAllowed: false });
  await assert.rejects(() => fixture.service.createOutbound({
    tenant_id: 'tenant-a', profile_id: 'profile-a',
    from: { kind: 'extension', value: '1001' }, to: { kind: 'e164', value: '+8613900139000' },
    business_ref: { type: 'ticket', id: 'ticket-a' }, actor: 'agent-a',
    idempotency_key: 'denied-a', metadata: {}
  }), hasVoiceCode('compliance_denied'));
  assert.equal(fixture.calls.size, 0);
  assert.equal(fixture.commands.size, 0);
});

test('Voice provider command executor reveals addresses only for the provider call', async () => {
  const fixture = callFixture();
  const created = await fixture.service.createOutbound({
    tenant_id: 'tenant-a', profile_id: 'profile-a',
    from: { kind: 'extension', value: '1001' }, to: { kind: 'e164', value: '+8613900139000' },
    business_ref: { type: 'ticket', id: 'ticket-a' }, actor: 'agent-a',
    idempotency_key: 'executor-call-a', metadata: {}
  });
  let clearAddress = '';
  const registry = new VoiceProviderRegistry();
  registry.register('rustpbx', {
    async create() {
      return {
        management: {} as VoiceProviderAdapter['management'],
        async preflight() { throw new Error('not used'); },
        async execute(input) {
          clearAddress = input.clear_address || '';
          return { provider_command_id: 'provider-command-a', provider_call_id: 'provider-call-a', accepted: true };
        },
        async reconcile() { return { state: 'unknown' as const }; },
        normalizeEvent() { throw new Error('not used'); },
        async close() {}
      } as VoiceProviderAdapter;
    }
  });
  const executor = new VoiceProviderCallCommandExecutor({
    calls: fixture.callRepository,
    configuration: fixture.configuration,
    address_protector: fixture.addressProtector,
    provider_registry: registry
  });
  const result = await executor.execute(created.command);
  assert.equal(clearAddress, '+8613900139000');
  assert.equal(result.provider_command_id, 'provider-command-a');
  assert.equal(JSON.stringify(result).includes('+8613900139000'), false);
});

test('Voice call service creates trusted inbound calls without accepting payload tenant authority', async () => {
  const fixture = callFixture();
  const created = await fixture.service.createInbound({
    tenant_id: 'tenant-a', profile_id: 'profile-a', provider_call_id: 'provider-call-a',
    external_event_id: 'event-a', from: { kind: 'e164', value: '+8613800138000' },
    to: { kind: 'extension', value: '1001' }, business_ref: { type: 'inbound', id: 'provider-call-a' },
    metadata: { tenant_id: 'attacker-tenant' }
  });
  assert.equal(created.tenant_id, 'tenant-a');
  assert.equal(created.state, 'ringing');
  assert.equal(created.metadata.tenant_id, undefined);
  assert.equal(fixture.commands.size, 0);
});

test('Voice call actions cover call control, recording, and LiveKit bridge without inline side effects', async () => {
  const fixture = callFixture();
  const active = fixture.seedCall('active');
  const held = fixture.seedCall('held');
  const ringing = fixture.seedCall('ringing');
  const cases: Array<{
    call: VoiceCall;
    kind: Exclude<VoiceCallCommand['kind'], 'originate'>;
    payload?: Record<string, unknown>;
  }> = [
    { call: ringing, kind: 'answer' },
    { call: active, kind: 'hangup' },
    { call: active, kind: 'dtmf', payload: { digits: '12#' } },
    { call: active, kind: 'hold' },
    { call: held, kind: 'resume' },
    { call: active, kind: 'blind_transfer', payload: { target: 'sip:1002@pbx.internal' } },
    { call: active, kind: 'warm_transfer', payload: { target: '+8613700137000' } },
    { call: active, kind: 'conference', payload: { conference_id: 'conference-a' } },
    { call: active, kind: 'park', payload: { slot: '701' } },
    { call: active, kind: 'pickup', payload: { slot: '701' } },
    { call: active, kind: 'recording_start' },
    { call: active, kind: 'recording_pause' },
    { call: active, kind: 'recording_resume' },
    { call: active, kind: 'recording_stop' },
    { call: active, kind: 'livekit_bridge_create' }
  ];
  for (const [index, item] of cases.entries()) {
    const command = await fixture.service.enqueueAction({
      tenant_id: 'tenant-a', call_id: item.call.id, kind: item.kind,
      payload: item.payload ?? {}, actor: 'agent-a', idempotency_key: `action-${index}`
    });
    assert.equal(command.kind, item.kind);
    assert.equal(command.state, 'pending');
  }
  assert.equal(fixture.providerCalls, 0);
  assert.equal(fixture.commands.size, cases.length);
  const transfers = [...fixture.commands.values()].filter((command) => command.kind.includes('transfer'));
  assert.equal(transfers.every((command) => !JSON.stringify(command.payload).includes('+8613700137000')), true);

  const terminal = fixture.seedCall('completed');
  await assert.rejects(() => fixture.service.enqueueAction({
    tenant_id: 'tenant-a', call_id: terminal.id, kind: 'hangup', payload: {},
    actor: 'agent-a', idempotency_key: 'terminal-action'
  }), hasVoiceCode('terminal_call_state'));
});

function callFixture(options: { complianceAllowed?: boolean } = {}) {
  const profile = deploymentProfile();
  const policy = voicePolicy();
  const calls = new Map<string, VoiceCall>();
  const protectedAddresses = new Map<string, { from: VoiceProtectedAddress; to: VoiceProtectedAddress }>();
  const commands = new Map<string, VoiceCallCommand>();
  const events: Array<{ tenant_id: string; type: string; data: unknown }> = [];
  const protectedValues: Array<{ tenant_id: string; value: string; kind: string }> = [];
  const protectedPlaintext = new Map<string, string>();
  let id = 0;
  let complianceCalls = 0;
  let transactionCommits = 0;

  const callRepository = {
    async get(_tenantId: string, callId: string) { return calls.get(callId) ?? null; },
    async findByIdempotencyKey(_tenantId: string, key: string) {
      return [...calls.values()].find((call) => call.idempotency_key === key) ?? null;
    },
    async insert(call: VoiceCall, from: VoiceProtectedAddress, to: VoiceProtectedAddress) {
      calls.set(call.id, call);
      protectedAddresses.set(call.id, { from, to });
      return call;
    },
    async update(call: VoiceCall, expectedRevision: number) {
      const current = calls.get(call.id);
      if (!current || current.revision !== expectedRevision) throw new VoiceError({ code: 'revision_conflict', status: 409 });
      calls.set(call.id, call);
      return call;
    },
    async getProtectedAddress(_tenantId: string, callId: string, side: 'from' | 'to') {
      return protectedAddresses.get(callId)?.[side] ?? null;
    }
  } as VoiceCallRepository;
  const commandRepository = {
    async findCallByIdempotencyKey(_tenantId: string, key: string) { return commands.get(key) ?? null; },
    async insertCall(command: VoiceCallCommand) {
      const replay = commands.get(command.idempotency_key);
      if (replay && replay.payload_hash !== command.payload_hash) throw new VoiceError({ code: 'idempotency_conflict', status: 409 });
      if (replay) return replay;
      commands.set(command.idempotency_key, command);
      return command;
    }
  } as VoiceCommandRepository;
  const configuration = {
    async getProfile() { return profile; },
    async getLatestCapabilitySnapshot() {
      return {
        id: 'snapshot-a', tenant_id: 'tenant-a', profile_id: profile.id, provider: 'rustpbx',
        provider_version: '1', status: 'ready', capabilities: capabilityMap(),
        config_hash: voiceProfileConfigHash(profile), error_code: '', error_message: '',
        checked_at: '2026-07-13T00:00:00.000Z', created_at: '2026-07-13T00:00:00.000Z'
      };
    },
    async getPolicy() { return policy; },
    async listConsents() { return { items: [], next_cursor: null }; }
  } as unknown as VoiceConfigurationRepository;
  const context: VoiceCallUnitOfWorkContext = { calls: callRepository, commands: commandRepository, configuration };
  const unitOfWork: VoiceCallUnitOfWork = {
    async run<T>(_tenantId: string, operation: (context: VoiceCallUnitOfWorkContext) => Promise<T>): Promise<T> {
      const result = await operation(context);
      transactionCommits += 1;
      return result;
    }
  };
  const addressProtector: VoiceAddressProtector = {
    async protect(tenantId, value, kind) {
      protectedValues.push({ tenant_id: tenantId, value, kind });
      const protectedId = protectedValues.length;
      const suffix = value.endsWith('9000') ? '9000' : value.endsWith('8000') ? '8000' : value.slice(-4);
      const hmac = createHash('sha256').update(`${tenantId}:${kind}:${value}`).digest('hex');
      const ciphertext = `cipher:${protectedId}`;
      protectedPlaintext.set(ciphertext, value);
      return { kind, ciphertext, hmac, redacted: kind === 'e164' ? `+86*******${suffix}` : `**${suffix.slice(-2)}` };
    },
    async reveal(_tenantId, ciphertext) { return protectedPlaintext.get(ciphertext) || ''; }
  };
  const compliance: VoiceCompliancePort = {
    async authorize() {
      complianceCalls += 1;
      return { allowed: options.complianceAllowed !== false, reason: options.complianceAllowed === false ? 'denied' : '', evidence_ref: 'evidence://allowed' };
    }
  };
  const eventPort: VoiceEventPort = {
    publish(tenantId, type, data) { events.push({ tenant_id: tenantId, type, data }); }
  };
  const service = new VoiceCallService({
    unit_of_work: unitOfWork, address_protector: addressProtector,
    compliance, event_port: eventPort, id: (kind) => `${kind}-${++id}`,
    now: () => new Date('2026-07-13T00:00:00.000Z')
  });
  const seedCall = (state: VoiceCall['state']): VoiceCall => {
    const call: VoiceCall = {
      id: `seed-${state}-${++id}`, tenant_id: 'tenant-a', business_ref: { type: 'ticket', id: `ticket-${id}` },
      provider_profile_id: profile.id, provider_call_id: 'provider-call', provider_dialog_id: '', media_call_id: null,
      direction: 'inbound', state, from: { kind: 'e164', redacted: '+86*******8000' },
      to: { kind: 'extension', redacted: '**01' }, idempotency_key: `seed-${id}`, initiated_by: 'provider',
      metadata: {}, ringing_at: state === 'ringing' ? '2026-07-13T00:00:00.000Z' : null,
      answered_at: ['active', 'held'].includes(state) ? '2026-07-13T00:00:00.000Z' : null,
      ended_at: state === 'completed' ? '2026-07-13T00:01:00.000Z' : null,
      termination_reason: '', revision: 1,
      created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
    };
    calls.set(call.id, call);
    return call;
  };
  return {
    service, calls, commands, events, protectedValues, seedCall, providerCalls: 0,
    callRepository, configuration, addressProtector,
    get complianceCalls() { return complianceCalls; },
    get transactionCommits() { return transactionCommits; }
  };
}

function deploymentProfile(): VoiceDeploymentProfile {
  return {
    id: 'profile-a', tenant_id: 'tenant-a', name: 'PBX', adapter: 'rustpbx', status: 'enabled',
    base_url: 'https://pbx.internal', desired_version: '1', config: {}, secret_refs: {}, revision: 1,
    created_by: 'admin', updated_by: 'admin', created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function voicePolicy(): VoicePolicy {
  return {
    id: 'policy-a', tenant_id: 'tenant-a', require_outbound_consent: true,
    recording_mode: 'consent_required', recording_retention_days: 30,
    require_ai_disclosure: true, allowed_calling_windows: [], masking_policy: {}, status: 'active',
    revision: 1, created_by: 'admin', updated_by: 'admin',
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function capabilityMap(): Record<VoiceCapability, boolean> {
  return {
    management_http: true, json_rpc_routing: true, step_ivr: true, rwi: true,
    webrtc_extension: true, recording: true, sipflow: true, queue: true,
    postgres_backend: true
  };
}

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof VoiceError && error.code === code;
}
