import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LiveKitSipBridgeAdapter,
  VoiceError,
  VoiceLiveKitBridgeCommandExecutor,
  VoiceLiveKitBridgeCommandReconciler,
  VoiceLiveKitBridgeService,
  createLiveKitSipBridgeAdapter,
  type VoiceCall,
  type VoiceCallCommand,
  type VoiceLiveKitBridge
} from '../src/agent-runtime/ivekit/voice/index.js';
import { MediaCallService } from '../src/agent-runtime/livekit/media-call-service.js';
import { MediaCallStore } from '../src/agent-runtime/livekit/media-call-store.js';
import { MemoryPg } from '../src/db-pg.js';

const NOW = '2026-07-13T07:00:00.000Z';
const CLEAR_NUMBER = '+8613800138000';

test('LiveKit SIP factory resolves refs only for client construction and preflight validates trunk safely', async () => {
  const resolved: Array<{ ref: unknown; purpose: string }> = [];
  const clients: unknown[][] = [];
  const sip = sipClient();
  const adapter = await createLiveKitSipBridgeAdapter({
    profile_id: 'profile-livekit', config_hash: 'a'.repeat(64), host: 'https://livekit.internal',
    api_key_ref: 'env://LIVEKIT_SIP_API_KEY', api_secret_ref: 'env://LIVEKIT_SIP_API_SECRET',
    secret_resolver: {
      async resolve(ref, purpose) {
        resolved.push({ ref, purpose });
        return purpose === 'livekit_sip_api_key' ? 'livekit-api-key' : 'livekit-api-secret';
      }
    },
    client_factory(...args) { clients.push(args); return sip.client; },
    bridges: bridgeRepository().repository
  });
  const preflight = await adapter.preflight({ sip_trunk_provider_ref: 'trunk-a' });

  assert.equal(preflight.ready, true);
  assert.equal(preflight.provider_version, '2.15.4');
  assert.deepEqual(resolved, [
    { ref: 'env://LIVEKIT_SIP_API_KEY', purpose: 'livekit_sip_api_key' },
    { ref: 'env://LIVEKIT_SIP_API_SECRET', purpose: 'livekit_sip_api_secret' }
  ]);
  assert.deepEqual(clients[0], ['https://livekit.internal', 'livekit-api-key', 'livekit-api-secret']);
  assert.deepEqual(sip.listCalls, [{ trunkIds: ['trunk-a'] }]);
  const serialized = JSON.stringify(preflight);
  assert.equal(serialized.includes('livekit-api-key'), false);
  assert.equal(serialized.includes('livekit-api-secret'), false);
});

test('Voice LiveKit bridge creates Media Core first, persists pending, and dials once', async () => {
  const operations: string[] = [];
  const sip = sipClient(operations);
  const bridges = bridgeRepository(operations);
  const adapter = adapterFixture(sip.client, bridges.repository);
  const mediaCalls: Array<Record<string, unknown>> = [];
  const service = new VoiceLiveKitBridgeService({
    media_calls: {
      async ensureVoiceBridge(input) {
        operations.push('media-call');
        mediaCalls.push(input);
        return { media_call_id: 'media-call-a', room_name: 'ivekit-pstn-room-a' };
      }
    },
    bridge: adapter
  });
  const first = await service.create(bridgeCreateInput());
  const replay = await service.create(bridgeCreateInput());

  assert.equal(first.state, 'active');
  assert.equal(first.provider_participant_id, 'participant-id-a');
  assert.equal(first.provider_call_id, 'sip-call-a');
  assert.equal(replay.replayed, true);
  assert.equal(sip.createCalls.length, 1);
  assert.deepEqual(operations.slice(0, 5), ['media-call', 'bridge:pending', 'bridge:creating', 'sip-create', 'bridge:active']);
  assert.equal(mediaCalls[0]?.idempotency_key, 'bridge-key-a');
  const [trunkId, number, roomName, rawOptions] = sip.createCalls[0]!;
  const options = rawOptions as { participantIdentity: string; hidePhoneNumber: boolean };
  assert.equal(trunkId, 'trunk-a');
  assert.equal(number, CLEAR_NUMBER);
  assert.equal(roomName, 'ivekit-pstn-room-a');
  assert.equal(options.participantIdentity, 'voice-sip-call-a');
  assert.equal(options.hidePhoneNumber, true);
  assert.equal(JSON.stringify(options).includes(CLEAR_NUMBER), false);
  assert.equal(JSON.stringify(bridges.items).includes(CLEAR_NUMBER), false);
});

test('LiveKit SIP transfer uses the SDK without persisting the clear target', async () => {
  const sip = sipClient();
  const bridges = bridgeRepository();
  bridges.items.push(bridgeRecord({
    status: 'active', sip_participant_id: 'participant-id-a', provider_bridge_id: 'sip-call-a'
  }));
  const adapter = adapterFixture(sip.client, bridges.repository);
  const result = await adapter.transfer({
    tenant_id: 'tenant-a', bridge_id: 'bridge-a', room_name: 'ivekit-pstn-room-a',
    participant_identity: 'voice-sip-call-a', clear_target: 'sip:1002@pbx.internal',
    idempotency_key: 'transfer-key-a'
  });
  assert.deepEqual(sip.transferCalls, [[
    'ivekit-pstn-room-a', 'voice-sip-call-a', 'sip:1002@pbx.internal', { playDialtone: false }
  ]]);
  assert.deepEqual(result, { provider_state: 'transferring' });
  assert.equal(JSON.stringify(bridges.items).includes('sip:1002@pbx.internal'), false);
});

test('ambiguous SIP timeout leaves bridge creating for reconciliation and replay never redials', async () => {
  const sip = sipClient();
  sip.create = (...args: unknown[]) => {
    sip.createCalls.push(args);
    return new Promise(() => undefined);
  };
  const bridges = bridgeRepository();
  const adapter = adapterFixture(sip.client, bridges.repository, { timeout_ms: 10 });
  const service = new VoiceLiveKitBridgeService({
    media_calls: fixedMediaCalls(), bridge: adapter
  });
  await assert.rejects(() => service.create(bridgeCreateInput()), hasVoiceCode('provider_timeout'));
  assert.equal(bridges.items[0]?.status, 'creating');
  const replay = await service.create(bridgeCreateInput());
  assert.equal(replay.state, 'creating');
  assert.equal(replay.replayed, true);
  assert.equal(sip.createCalls.length, 1);
});

test('malformed SIP success remains ambiguous and replay never redials', async () => {
  const sip = sipClient();
  sip.create = async (...args: unknown[]) => {
    sip.createCalls.push(args);
    return { participantId: 'participant-id-a' } as never;
  };
  const bridges = bridgeRepository();
  const service = new VoiceLiveKitBridgeService({
    media_calls: fixedMediaCalls(), bridge: adapterFixture(sip.client, bridges.repository)
  });

  await assert.rejects(() => service.create(bridgeCreateInput()), hasVoiceCode('provider_timeout'));
  assert.equal(bridges.items[0]?.status, 'creating');
  const replay = await service.create(bridgeCreateInput());
  assert.equal(replay.state, 'creating');
  assert.equal(replay.replayed, true);
  assert.equal(sip.createCalls.length, 1);
});

test('definite SIP errors fail bridge with sanitized stable errors', async () => {
  const sip = sipClient();
  sip.create = async () => { throw Object.assign(new Error('api-secret leaked by sdk'), { status: 403 }); };
  const bridges = bridgeRepository();
  const adapter = adapterFixture(sip.client, bridges.repository);
  const service = new VoiceLiveKitBridgeService({ media_calls: fixedMediaCalls(), bridge: adapter });
  await assert.rejects(() => service.create(bridgeCreateInput()), (error: unknown) =>
    error instanceof VoiceError && error.code === 'provider_auth_failed'
      && !JSON.stringify(error).includes('api-secret'));
  assert.equal(bridges.items[0]?.status, 'failed');
  assert.equal(JSON.stringify(bridges.items).includes('api-secret'), false);
});

test('LiveKit SIP reconciliation activates an ambiguous bridge from room participant state', async () => {
  const sip = sipClient();
  const bridges = bridgeRepository();
  const pending = bridgeRecord({ status: 'creating' });
  bridges.items.push(pending);
  const adapter = adapterFixture(sip.client, bridges.repository, {
    participant_lookup: {
      async find(roomName, identity) {
        assert.equal(roomName, 'ivekit-pstn-room-a');
        assert.equal(identity, 'voice-sip-call-a');
        return { participant_id: 'participant-id-reconciled', provider_call_id: 'sip-call-reconciled' };
      }
    }
  });
  const result = await adapter.reconcile({ tenant_id: 'tenant-a', bridge_id: 'bridge-a' });
  assert.equal(result.state, 'active');
  assert.equal(bridges.items[0]?.sip_participant_id, 'participant-id-reconciled');
  assert.equal(bridges.items[0]?.provider_bridge_id, 'sip-call-reconciled');
});

test('LiveKit bridge command executor reveals the destination only at the SDK boundary', async () => {
  const sip = sipClient();
  const bridges = bridgeRepository();
  const adapter = adapterFixture(sip.client, bridges.repository);
  const service = new VoiceLiveKitBridgeService({ media_calls: fixedMediaCalls(), bridge: adapter });
  let storedCall = voiceCall();
  let reveals = 0;
  const executor = new VoiceLiveKitBridgeCommandExecutor({
    calls: {
      async get() { return storedCall; },
      async getProtectedAddress() {
        return { kind: 'e164' as const, ciphertext: 'cipher-number', hmac: 'f'.repeat(64), redacted: '+86******8000' };
      },
      async update(call: VoiceCall) { storedCall = call; return call; }
    } as never,
    configuration: {
      async getTrunk() {
        return { id: 'trunk-config-a', profile_id: 'profile-livekit', provider_ref: 'trunk-a', status: 'active' };
      },
      async getProfile() { return { adapter: 'livekit_sip', status: 'enabled' }; }
    } as never,
    address_protector: {
      async protect() { throw new Error('not used'); },
      async reveal(_tenant: string, ciphertext: string) {
        reveals += 1;
        assert.equal(ciphertext, 'cipher-number');
        return CLEAR_NUMBER;
      }
    },
    bridge: service
  });
  const result = await executor.execute(voiceCommand());
  assert.equal(reveals, 1);
  assert.equal(result.provider_command_id, 'bridge-a');
  assert.equal(storedCall.media_call_id, 'media-call-a');
  assert.equal(JSON.stringify(result).includes(CLEAR_NUMBER), false);
  assert.equal(JSON.stringify(voiceCommand()).includes(CLEAR_NUMBER), false);
  assert.equal(sip.createCalls[0]?.[1], CLEAR_NUMBER);
});

test('command executor treats Media Core link write failure as ambiguous and reconciles without redial', async () => {
  const sip = sipClient();
  const bridges = bridgeRepository();
  const adapter = adapterFixture(sip.client, bridges.repository);
  const service = new VoiceLiveKitBridgeService({ media_calls: fixedMediaCalls(), bridge: adapter });
  const call = voiceCall();
  const executor = new VoiceLiveKitBridgeCommandExecutor({
    calls: {
      async get() { return call; },
      async getProtectedAddress() {
        return { kind: 'e164' as const, ciphertext: 'cipher-number', hmac: 'f'.repeat(64), redacted: '+86******8000' };
      },
      async update() { throw new Error('database unavailable'); }
    } as never,
    configuration: {
      async getTrunk() {
        return { id: 'trunk-config-a', profile_id: 'profile-livekit', provider_ref: 'trunk-a', status: 'active' };
      },
      async getProfile() { return { adapter: 'livekit_sip', status: 'enabled' }; }
    } as never,
    address_protector: {
      async protect() { throw new Error('not used'); },
      async reveal() { return CLEAR_NUMBER; }
    },
    bridge: service
  });

  await assert.rejects(() => executor.execute(voiceCommand()), hasVoiceCode('provider_timeout'));
  assert.equal(bridges.items[0]?.status, 'active');
  assert.equal(sip.createCalls.length, 1);

  const reconciler = new VoiceLiveKitBridgeCommandReconciler({ bridges: bridges.repository, bridge: adapter });
  assert.deepEqual(await reconciler.reconcile({ call, command: voiceCommand() }), {
    state: 'succeeded', provider_state: 'active', media_call_id: 'media-call-a'
  });
  assert.equal(sip.createCalls.length, 1);
});

test('LiveKit bridge command reconciler returns Media Core linkage without provider redial', async () => {
  const sip = sipClient();
  const bridges = bridgeRepository();
  bridges.items.push(bridgeRecord({
    status: 'active', media_call_id: 'media-call-reconciled',
    sip_participant_id: 'participant-id-a', provider_bridge_id: 'sip-call-a'
  }));
  const reconciler = new VoiceLiveKitBridgeCommandReconciler({
    bridges: bridges.repository,
    bridge: adapterFixture(sip.client, bridges.repository)
  });
  const result = await reconciler.reconcile({ call: voiceCall(), command: voiceCommand() });
  assert.deepEqual(result, {
    state: 'succeeded', provider_state: 'active', media_call_id: 'media-call-reconciled'
  });
  assert.equal(sip.createCalls.length, 0);
});

test('Media Core ensureVoiceBridge is deterministic and stores no phone data', async () => {
  const store = new MediaCallStore(new MemoryPg());
  const service = new MediaCallService(store, { now: () => new Date(NOW) });
  const input = {
    tenant_id: 'tenant-a', voice_call_id: 'call-a', initiated_by: 'agent-a',
    participant_identity: 'voice-sip-call-a', idempotency_key: 'bridge-key-a',
    business_ref: { tenant_id: 'tenant-a', type: 'order', id: 'order-a' }
  };
  const first = await service.ensureVoiceBridge(input);
  const replay = await service.ensureVoiceBridge(input);
  assert.deepEqual(replay, first);
  const snapshot = await service.getCall('tenant-a', first.media_call_id);
  assert.equal(snapshot?.call.media, 'voice');
  assert.equal(snapshot?.call.room_name, first.room_name);
  assert.equal(snapshot?.participants.some((item) => item.identity === 'voice-sip-call-a'), true);
  assert.equal(JSON.stringify(snapshot).includes(CLEAR_NUMBER), false);
});

function adapterFixture(
  client: ReturnType<typeof sipClient>['client'],
  bridges: ReturnType<typeof bridgeRepository>['repository'],
  patch: Partial<ConstructorParameters<typeof LiveKitSipBridgeAdapter>[0]> = {}
) {
  return new LiveKitSipBridgeAdapter({
    profile_id: 'profile-livekit', config_hash: 'a'.repeat(64), client, bridges,
    id: () => 'bridge-a', now: () => new Date(NOW), timeout_ms: 1_000, ...patch
  });
}

function bridgeCreateInput() {
  return {
    tenant_id: 'tenant-a', call_id: 'call-a', initiated_by: 'agent-a',
    business_ref: { type: 'order', id: 'order-a' }, participant_identity: 'voice-sip-call-a',
    sip_trunk_provider_ref: 'trunk-a', clear_destination: CLEAR_NUMBER,
    destination_fingerprint: 'f'.repeat(64), idempotency_key: 'bridge-key-a'
  };
}

function fixedMediaCalls() {
  return {
    async ensureVoiceBridge() { return { media_call_id: 'media-call-a', room_name: 'ivekit-pstn-room-a' }; }
  };
}

function sipClient(operations: string[] = []) {
  const result = {
    listCalls: [] as unknown[], createCalls: [] as unknown[][], transferCalls: [] as unknown[][],
    async create(...args: unknown[]) {
      result.createCalls.push(args);
      operations.push('sip-create');
      const options = args[3] as { participantIdentity?: string } | undefined;
      return {
        participantId: 'participant-id-a', participantIdentity: options?.participantIdentity ?? 'voice-sip-call-a',
        roomName: String(args[2] ?? 'ivekit-pstn-room-a'), sipCallId: 'sip-call-a'
      };
    },
    client: null as unknown as {
      listSipOutboundTrunk(input?: unknown): Promise<unknown[]>;
      createSipParticipant(...args: unknown[]): Promise<unknown>;
      transferSipParticipant(...args: unknown[]): Promise<void>;
    }
  };
  result.client = {
      async listSipOutboundTrunk(input?: unknown) {
        result.listCalls.push(input);
        return [{ sipTrunkId: 'trunk-a', name: 'Primary trunk', authPassword: 'must-not-return' }];
      },
      createSipParticipant(...args: unknown[]) { return result.create(...args); },
      async transferSipParticipant(...args: unknown[]) { result.transferCalls.push(args); }
  };
  return result;
}

function bridgeRepository(operations: string[] = []) {
  const items: VoiceLiveKitBridge[] = [];
  return {
    items,
    repository: {
      async getBridge(_tenant: string, id: string) { return items.find((item) => item.id === id) ?? null; },
      async findBridgeByIdempotencyKey(_tenant: string, key: string) {
        return items.find((item) => item.idempotency_key === key) ?? null;
      },
      async insertBridge(input: VoiceLiveKitBridge) {
        const existing = items.find((item) => item.idempotency_key === input.idempotency_key);
        if (existing) return existing;
        items.push(input);
        operations.push(`bridge:${input.status}`);
        return input;
      },
      async updateBridge(input: VoiceLiveKitBridge) {
        const index = items.findIndex((item) => item.id === input.id);
        items[index] = input;
        operations.push(`bridge:${input.status}`);
        return input;
      }
    } as never
  };
}

function bridgeRecord(patch: Partial<VoiceLiveKitBridge> = {}): VoiceLiveKitBridge {
  return {
    id: 'bridge-a', tenant_id: 'tenant-a', call_id: 'call-a', media_call_id: 'media-call-a',
    sip_participant_id: '', room_name: 'ivekit-pstn-room-a', provider_bridge_id: '', status: 'pending',
    idempotency_key: 'bridge-key-a', metadata: {
      participant_identity: 'voice-sip-call-a', request_hash: 'request-hash-a',
      livekit_profile_id: 'profile-livekit'
    }, created_at: NOW, updated_at: NOW, ended_at: null, ...patch
  };
}

function voiceCall(): VoiceCall {
  return {
    id: 'call-a', tenant_id: 'tenant-a', business_ref: { type: 'order', id: 'order-a' },
    provider_profile_id: 'profile-rustpbx', provider_call_id: 'rustpbx-call-a', provider_dialog_id: '',
    media_call_id: null, direction: 'outbound', state: 'active',
    from: { kind: 'extension', redacted: '**01' }, to: { kind: 'e164', redacted: '+86******8000' },
    idempotency_key: 'call-key-a', initiated_by: 'agent-a', metadata: {}, ringing_at: NOW,
    answered_at: NOW, ended_at: null, termination_reason: '', revision: 1, created_at: NOW, updated_at: NOW
  };
}

function voiceCommand(): VoiceCallCommand {
  return {
    id: 'command-a', tenant_id: 'tenant-a', call_id: 'call-a', kind: 'livekit_bridge_create',
    state: 'processing', idempotency_key: 'bridge-key-a', payload_hash: 'a'.repeat(64),
    payload: { sip_trunk_id: 'trunk-config-a' }, attempt_count: 1, max_attempts: 5,
    next_attempt_at: null, lease_until: '2026-07-13T07:01:00.000Z', worker_id: 'worker-a',
    provider_command_id: '', result: {}, error_code: '', error_message: '', created_at: NOW,
    updated_at: NOW, completed_at: null
  };
}

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof VoiceError && error.code === code;
}
