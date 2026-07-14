import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import {
  createControlledVoiceProviderState,
  startControlledVoiceProvider
} from '../scripts/ivekit-controlled-voice-provider.js';
import { withPgTenant } from '../src/db-pg-tenant.js';
import { MediaCallService } from '../src/agent-runtime/livekit/media-call-service.js';
import { MediaCallStore } from '../src/agent-runtime/livekit/media-call-store.js';
import {
  EncryptedVoiceAddressProtector,
  EnvVoiceSecretResolver,
  PostgresVoiceCallStore,
  PostgresVoiceCommandStore,
  PostgresVoiceConfigurationStore,
  PostgresVoiceProviderEventStore,
  PostgresVoiceProviderEventUnitOfWork,
  PostgresVoiceCallUnitOfWork,
  PostgresVoiceRecordingStore,
  LiveKitSipBridgeAdapter,
  RustPbxEventsAdapter,
  RustPbxRouterAdapter,
  RustPbxVoiceProviderFactory,
  VoiceCommandWorker,
  VoiceLiveKitBridgeCommandExecutor,
  VoiceLiveKitBridgeCommandReconciler,
  VoiceLiveKitBridgeService,
  VoiceProviderCallCommandExecutor,
  VoiceProviderEventService,
  VoiceProviderEventWorker,
  VoiceProviderRegistry,
  VoiceRecordingService,
  VoiceReconciliationWorker,
  VoiceRouterDecisionService,
  voiceProfileConfigHash,
  routeIveKitVoiceApi
} from '../src/agent-runtime/ivekit/voice/index.js';

const adminUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_DATABASE_URL || '';
const runtimeUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_DATABASE_URL || '';
const postgresTest = adminUrl && runtimeUrl ? test : test.skip;
const TENANT_A = 'ivekit_voice_acceptance_a';
const TENANT_B = 'ivekit_voice_acceptance_b';
const API_KEY = 'ivekit-voice-controlled-postgres-key';
const PROVIDER_TOKEN = 'ivekit-voice-controlled-provider-token';

postgresTest('controlled RustPBX converges the PostgreSQL Voice foundation end to end', async (t) => {
  const admin = new Pool({ connectionString: adminUrl });
  const runtime = new Pool({ connectionString: runtimeUrl });
  const running = await startControlledVoiceProvider({
    host: '127.0.0.1',
    port: 0,
    state: createControlledVoiceProviderState({ token: PROVIDER_TOKEN })
  });
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = API_KEY;
  t.after(async () => {
    if (previousApiKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previousApiKey;
    await running.close();
    await runtime.end();
    await admin.end();
  });

  await admin.query('DELETE FROM tenants WHERE id = ANY($1::text[])', [[TENANT_A, TENANT_B]]);
  await admin.query(
    'INSERT INTO tenants (id, name) VALUES ($1, $2), ($3, $4)',
    [TENANT_A, 'Voice acceptance A', TENANT_B, 'Voice acceptance B']
  );

  const protector = new EncryptedVoiceAddressProtector({
    encryption_key: Buffer.alloc(32, 11).toString('base64'),
    hmac_key: Buffer.alloc(32, 12).toString('base64')
  });
  const secretResolver = new EnvVoiceSecretResolver({
    env: { CONTROLLED_VOICE_TOKEN: PROVIDER_TOKEN },
    allowlist: {
      rustpbx_management: ['CONTROLLED_VOICE_TOKEN'],
      rwi: ['CONTROLLED_VOICE_TOKEN']
    }
  });
  const registry = new VoiceProviderRegistry();
  registry.register('rustpbx', new RustPbxVoiceProviderFactory({
    secret_resolver: secretResolver
  }));
  const voiceOptions = { provider_registry: registry, address_protector: protector };
  const headers = {
    'x-api-key': API_KEY,
    'x-tenant-id': TENANT_A,
    'x-user-id': 'voice-acceptance-admin'
  };
  const invoke = (
    method: string,
    path: string,
    body: Record<string, unknown> = {},
    idempotencyKey = ''
  ) => routeIveKitVoiceApi(
    runtime,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    JSON.stringify(body),
    idempotencyKey ? { ...headers, 'idempotency-key': idempotencyKey } : headers,
    voiceOptions
  ) as Promise<{ status?: number; data: any }>;

  const profile = (await invoke('POST', '/api/ivekit/voice/profiles', {
    name: 'Controlled RustPBX',
    adapter: 'rustpbx',
    status: 'enabled',
    base_url: running.base_url,
    desired_version: 'controlled-rustpbx-v1',
    config: {
      rwi_url: running.rwi_url,
      internal_service: true,
      management_timeout_ms: 500,
      rwi_connect_timeout_ms: 500,
      rwi_command_timeout_ms: 500,
      rwi_heartbeat_timeout_ms: 2_000
    },
    secret_refs: {
      management_service_token: 'env://CONTROLLED_VOICE_TOKEN',
      rwi_token: 'env://CONTROLLED_VOICE_TOKEN'
    }
  })).data;
  const preflight = await invoke(
    'POST', `/api/ivekit/voice/profiles/${profile.id}/preflight`
  );
  assert.equal(preflight.data.status, 'ready');
  assert.equal(preflight.data.capabilities.management_http, true);
  assert.equal(preflight.data.capabilities.rwi, true);

  const trunk = (await invoke('POST', '/api/ivekit/voice/trunks', {
    profile_id: profile.id,
    name: 'Controlled trunk',
    direction: 'both',
    transport: 'tls',
    codecs: ['PCMU'],
    max_channels: 20,
    credential_secret_ref: 'env://CONTROLLED_TRUNK_CREDENTIAL',
    desired_state: { outbound_proxy: 'sip:controlled.invalid' }
  })).data;
  await invoke('POST', `/api/ivekit/voice/trunks/${trunk.id}/apply`, {}, 'apply-trunk-a');

  const route = (await invoke('POST', '/api/ivekit/voice/routes', {
    profile_id: profile.id,
    name: 'Controlled inbound route',
    direction: 'inbound',
    draft_rules: { action: 'reject', code: 486, reason: 'controlled_busy' }
  })).data;
  const published = await invoke(
    'POST', `/api/ivekit/voice/routes/${route.id}/publish`,
    { revision: route.draft_revision },
    'publish-route-a'
  );

  const clearDid = '+8613800138000';
  const did = (await invoke('POST', '/api/ivekit/voice/dids', {
    trunk_id: trunk.id,
    route_id: route.id,
    e164: clearDid,
    metadata: { purpose: 'controlled_acceptance' }
  })).data;
  await invoke('POST', `/api/ivekit/voice/dids/${did.id}/apply`, {}, 'apply-did-a');

  const extension = (await invoke('POST', '/api/ivekit/voice/extensions', {
    profile_id: profile.id,
    identity: 'acceptance-agent-a',
    extension: '1001',
    display_name: 'Acceptance Agent',
    credential_secret_ref: 'env://CONTROLLED_EXTENSION_CREDENTIAL',
    permissions: { outbound: true },
    webrtc_enabled: true
  })).data;
  await invoke(
    'POST', `/api/ivekit/voice/extensions/${extension.id}/apply`, {}, 'apply-extension-a'
  );

  const configuration = new PostgresVoiceConfigurationStore(runtime);
  const calls = new PostgresVoiceCallStore(runtime);
  const commands = new PostgresVoiceCommandStore(runtime);
  const callExecutor = new VoiceProviderCallCommandExecutor({
    calls,
    configuration,
    address_protector: protector,
    provider_registry: registry
  });
  const commandWorker = new VoiceCommandWorker({
    commands,
    configuration,
    provider_registry: registry,
    address_protector: protector,
    call_executor: (command) => callExecutor.execute(command),
    worker_id: 'voice-controlled-postgres-worker',
    batch_size: 25,
    lease_ms: 5_000,
    retry_jitter_ratio: 0
  });
  const configurationRun = await commandWorker.runOnce(TENANT_A);
  assert.deepEqual(configurationRun, {
    claimed: 4, succeeded: 4, failed: 0, retry_wait: 0, uncertain: 0, stale: 0
  });

  const storedTrunk = await configuration.getTrunk(TENANT_A, trunk.id);
  const storedDid = await configuration.getDid(TENANT_A, did.id);
  const storedExtension = await configuration.getExtension(TENANT_A, extension.id);
  const storedVersions = await configuration.listRouteVersions(TENANT_A, route.id);
  assert.equal(storedTrunk?.status, 'active');
  assert.equal(storedTrunk?.provider_ref, `controlled:trunk:${trunk.id}`);
  assert.equal(storedDid?.provider_ref, `controlled:did:${did.id}`);
  assert.equal(storedExtension?.revision, 2);
  assert.equal(storedVersions[0]?.deployment_state, 'applied');
  assert.equal(storedVersions[0]?.provider_revision, '1');
  assert.equal(
    running.state.resources.get(`did:${did.id}`)?.desired_state.e164,
    clearDid
  );
  const protectedDid = await admin.query<{
    e164_ciphertext: string;
    e164_redacted: string;
  }>(
    'SELECT e164_ciphertext, e164_redacted FROM ivekit_voice_dids WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, did.id]
  );
  assert.notEqual(protectedDid.rows[0]?.e164_ciphertext, clearDid);
  assert.equal(protectedDid.rows[0]?.e164_redacted, '+86******8000');
  await assert.rejects(
    () => withPgTenant(runtime, TENANT_A, (pg) => pg.query(
      `UPDATE ivekit_voice_route_versions
       SET rules = '{"action":"reject","code":404}'::jsonb
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_A, published.data.version.id]
    )),
    /route version payloads are immutable/i
  );

  const configurationTimeoutProfile = (await invoke('POST', '/api/ivekit/voice/profiles', {
    name: 'Controlled configuration timeout RustPBX',
    adapter: 'rustpbx',
    status: 'enabled',
    base_url: running.base_url,
    desired_version: 'controlled-rustpbx-v1',
    config: {
      internal_service: true,
      management_timeout_ms: 15
    },
    secret_refs: {
      management_service_token: 'env://CONTROLLED_VOICE_TOKEN'
    }
  })).data;
  assert.equal((await invoke(
    'POST', `/api/ivekit/voice/profiles/${configurationTimeoutProfile.id}/preflight`
  )).data.status, 'ready');
  const uncertainTrunk = (await invoke('POST', '/api/ivekit/voice/trunks', {
    profile_id: configurationTimeoutProfile.id,
    name: 'Controlled uncertain trunk',
    direction: 'outbound',
    transport: 'tls',
    codecs: ['PCMU'],
    max_channels: 2,
    credential_secret_ref: 'env://CONTROLLED_TRUNK_CREDENTIAL',
    desired_state: { outbound_proxy: 'sip:uncertain.controlled.invalid' }
  })).data;
  const uncertainApply = await invoke(
    'POST', `/api/ivekit/voice/trunks/${uncertainTrunk.id}/apply`, {},
    'apply-uncertain-trunk-a'
  );
  running.state.mode = 'delayed_timeout';
  running.state.response_delay_ms = 50;
  const uncertainConfigurationRun = await commandWorker.runOnce(TENANT_A);
  assert.equal(uncertainConfigurationRun.uncertain, 1);
  assert.equal(running.state.resources.get(`trunk:${uncertainTrunk.id}`)?.revision, 1);
  running.state.mode = 'success';
  const configurationReconciliationWorker = new VoiceReconciliationWorker({
    unit_of_work: new PostgresVoiceCallUnitOfWork(runtime),
    provider_registry: registry,
    worker_id: 'voice-controlled-configuration-reconciliation-worker',
    batch_size: 10,
    lease_ms: 5_000,
    reconcile_delay_ms: 100,
    max_reconcile_age_ms: 10_000,
    now: () => new Date(Date.now() + 20_000)
  });
  const uncertainConfigurationReconciled = await configurationReconciliationWorker.runOnce(TENANT_A);
  assert.equal(uncertainConfigurationReconciled.failed, 1);
  assert.equal(running.state.resources.get(`trunk:${uncertainTrunk.id}`)?.revision, 1);
  const uncertainConfigurationRow = await withPgTenant(runtime, TENANT_A, (pg) => pg.query<{
    state: string;
    error_code: string;
  }>(
    `SELECT state, error_code
     FROM ivekit_voice_configuration_commands
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, uncertainApply.data.id]
  ));
  assert.deepEqual(uncertainConfigurationRow.rows[0], {
    state: 'failed',
    error_code: 'provider_result_unknown'
  });

  const routerAdapter = new RustPbxRouterAdapter();
  const router = new VoiceRouterDecisionService({
    configuration,
    address_protector: protector,
    router_adapter: routerAdapter
  });
  const routeDecision = await router.decide({
    tenant_id: TENANT_A,
    profile_id: profile.id,
    request: routerAdapter.normalizeRequest({
      call_id: 'router-call-a',
      from: 'sip:1002@controlled.invalid',
      to: clearDid,
      source_addr: '127.0.0.1:5060',
      direction: 'inbound',
      method: 'INVITE',
      uri: `sip:${clearDid}@controlled.invalid`,
      headers: {}
    })
  });
  assert.deepEqual(routeDecision, { action: 'reject', status: 486, reason: 'controlled_busy' });

  await invoke('PATCH', '/api/ivekit/voice/policy', {
    revision: null,
    require_outbound_consent: true,
    recording_mode: 'always',
    recording_retention_days: 30,
    require_ai_disclosure: true,
    allowed_calling_windows: [],
    masking_policy: {},
    status: 'active'
  });
  await invoke('POST', '/api/ivekit/voice/consents', {
    subject_ref_type: 'order',
    subject_ref_id: 'VOICE-ACCEPTANCE-A',
    business_ref_type: 'order',
    business_ref_id: 'VOICE-ACCEPTANCE-A',
    consent_type: 'outbound_call',
    status: 'granted',
    evidence_ref: 'evidence://voice-acceptance-a',
    expires_at: null
  });
  const outbound = await invoke('POST', '/api/ivekit/voice/calls', {
    profile_id: profile.id,
    from: { kind: 'extension', value: '1001' },
    to: { kind: 'e164', value: '+8613900139000' },
    business_ref: { type: 'order', id: 'VOICE-ACCEPTANCE-A' },
    metadata: { source: 'controlled_postgres_acceptance' }
  }, 'outbound-call-a');
  const callId = outbound.data.call.id as string;
  const originateCommandId = outbound.data.command.id as string;
  const originateRun = await commandWorker.runOnce(TENANT_A);
  assert.equal(originateRun.succeeded, 1);
  assert.equal(running.state.action_counts.get(originateCommandId), 1);
  let storedCall = await calls.get(TENANT_A, callId);
  assert.equal(storedCall?.state, 'dialing');
  assert.equal(storedCall?.provider_call_id, `controlled-call:${originateCommandId}`);

  const eventRepository = new PostgresVoiceProviderEventStore(runtime);
  let eventSequence = 0;
  const eventService = new VoiceProviderEventService({
    events: eventRepository,
    calls,
    id: () => `controlled-provider-event-${++eventSequence}`
  });
  const providerEvents = new RustPbxEventsAdapter();
  for (const event of running.state.events) {
    await eventService.ingest({
      tenant_id: TENANT_A,
      profile_id: profile.id,
      event: providerEvents.normalize('rwi', event)
    });
  }
  const eventWorker = new VoiceProviderEventWorker({
    unit_of_work: new PostgresVoiceProviderEventUnitOfWork(runtime),
    recording_service: new VoiceRecordingService(),
    worker_id: 'voice-controlled-event-worker',
    batch_size: 25,
    lease_ms: 5_000,
    retry_jitter_ratio: 0
  });
  const lifecycleRun = await eventWorker.runOnce(TENANT_A);
  assert.equal(lifecycleRun.processed, 2);
  storedCall = await calls.get(TENANT_A, callId);
  assert.equal(storedCall?.state, 'active');

  const replayEvent = providerEvents.normalize('rwi', {
    event: 'call_state_change',
    event_id: 'controlled-replayed-ringing-a',
    call_id: storedCall!.provider_call_id,
    state: 'ringing',
    occurred_at: '2026-07-13T12:01:00.000Z'
  });
  assert.equal((await eventService.ingest({
    tenant_id: TENANT_A, profile_id: profile.id, event: replayEvent
  })).replayed, false);
  assert.equal((await eventService.ingest({
    tenant_id: TENANT_A, profile_id: profile.id, event: replayEvent
  })).replayed, true);
  for (const [eventId, state] of [
    ['controlled-out-of-order-answered-a', 'answered'],
    ['controlled-out-of-order-ringing-a', 'ringing']
  ] as const) {
    await eventService.ingest({
      tenant_id: TENANT_A,
      profile_id: profile.id,
      event: providerEvents.normalize('rwi', {
        event: 'call_state_change', event_id: eventId,
        call_id: storedCall!.provider_call_id, state,
        occurred_at: '2026-07-13T12:02:00.000Z'
      })
    });
  }
  assert.equal((await eventWorker.runOnce(TENANT_A)).processed, 3);
  storedCall = await calls.get(TENANT_A, callId);
  assert.equal(storedCall?.state, 'active');

  const liveKitProfile = (await invoke('POST', '/api/ivekit/voice/profiles', {
    name: 'Controlled LiveKit SIP',
    adapter: 'livekit_sip',
    status: 'enabled',
    base_url: 'https://livekit.controlled.invalid',
    desired_version: '2.15.4',
    config: {},
    secret_refs: {}
  })).data;
  const liveKitTrunkDraft = (await invoke('POST', '/api/ivekit/voice/trunks', {
    profile_id: liveKitProfile.id,
    name: 'Controlled LiveKit trunk',
    direction: 'outbound',
    transport: 'tls',
    codecs: ['PCMU'],
    max_channels: 20,
    credential_secret_ref: 'env://CONTROLLED_LIVEKIT_TRUNK',
    desired_state: {}
  })).data;
  const liveKitTrunk = await configuration.updateTrunk({
    ...liveKitTrunkDraft,
    provider_ref: 'controlled-livekit-trunk-a',
    status: 'active',
    revision: liveKitTrunkDraft.revision + 1,
    updated_by: 'voice-acceptance-admin',
    updated_at: new Date().toISOString()
  }, liveKitTrunkDraft.revision);
  const recordingRepository = new PostgresVoiceRecordingStore(runtime);
  const sipCalls: Array<{ trunk: string; number: string; room: string }> = [];
  const bridgeAdapter = new LiveKitSipBridgeAdapter({
    profile_id: liveKitProfile.id,
    config_hash: voiceProfileConfigHash(liveKitProfile),
    client: {
      async listSipOutboundTrunk() {
        return [{ sipTrunkId: 'controlled-livekit-trunk-a', name: 'Controlled' }];
      },
      async createSipParticipant(trunkId, number, roomName) {
        sipCalls.push({ trunk: trunkId, number, room: roomName });
        return {
          participantId: 'controlled-livekit-participant-a',
          participantIdentity: `voice-sip-${callId}`,
          roomName,
          sipCallId: 'controlled-livekit-call-a'
        };
      },
      async transferSipParticipant() {}
    },
    bridges: recordingRepository,
    participant_lookup: {
      async find() {
        return {
          participant_id: 'controlled-livekit-participant-a',
          provider_call_id: 'controlled-livekit-call-a'
        };
      }
    },
    id: () => 'controlled-livekit-bridge-a'
  });
  const bridgeExecutor = new VoiceLiveKitBridgeCommandExecutor({
    calls,
    configuration,
    address_protector: protector,
    bridge: new VoiceLiveKitBridgeService({
      media_calls: new MediaCallService(new MediaCallStore(runtime)),
      bridge: bridgeAdapter
    })
  });
  const bridgeCommand = await invoke(
    'POST', `/api/ivekit/voice/calls/${callId}/livekit-bridge`,
    { sip_trunk_id: liveKitTrunk.id },
    'livekit-bridge-a'
  );
  const bridgeWorker = new VoiceCommandWorker({
    commands,
    configuration,
    provider_registry: registry,
    address_protector: protector,
    call_executor: (command) => command.kind === 'livekit_bridge_create'
      ? bridgeExecutor.execute(command)
      : callExecutor.execute(command),
    worker_id: 'voice-controlled-bridge-worker',
    batch_size: 25,
    lease_ms: 5_000
  });
  const bridgeRun = await bridgeWorker.runOnce(TENANT_A);
  const storedBridgeCommand = await withPgTenant(runtime, TENANT_A, (pg) => pg.query<{
    state: string;
    error_code: string;
  }>(
    'SELECT state, error_code FROM ivekit_voice_call_commands WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, bridgeCommand.data.id]
  ));
  assert.deepEqual({
    run: bridgeRun,
    command: storedBridgeCommand.rows[0],
    sip_calls: sipCalls.length
  }, {
    run: { claimed: 1, succeeded: 0, failed: 0, retry_wait: 0, uncertain: 1, stale: 0 },
    command: { state: 'uncertain', error_code: 'provider_timeout' },
    sip_calls: 1
  });
  const bridgeReconciler = new VoiceLiveKitBridgeCommandReconciler({
    bridges: recordingRepository,
    bridge: bridgeAdapter
  });
  const bridgeReconciliationWorker = new VoiceReconciliationWorker({
    unit_of_work: new PostgresVoiceCallUnitOfWork(runtime),
    provider_registry: registry,
    command_reconciler: ({ call, command }) => bridgeReconciler.reconcile({ call, command }),
    worker_id: 'voice-controlled-bridge-reconciliation-worker',
    batch_size: 10,
    lease_ms: 5_000,
    reconcile_delay_ms: 100,
    max_reconcile_age_ms: 10_000
  });
  assert.equal((await bridgeReconciliationWorker.runOnce(TENANT_A)).succeeded, 1);
  assert.equal(sipCalls.length, 1);
  assert.equal(sipCalls[0]?.number, '+8613900139000');
  assert.equal(sipCalls[0]?.trunk, 'controlled-livekit-trunk-a');
  assert.equal(
    (await recordingRepository.findBridgeByIdempotencyKey(
      TENANT_A, bridgeCommand.data.idempotency_key
    ))?.status,
    'active'
  );
  storedCall = await calls.get(TENANT_A, callId);
  assert.ok(storedCall?.media_call_id);

  const ingestState = async (state: string, label: string) => eventService.ingest({
    tenant_id: TENANT_A,
    profile_id: profile.id,
    event: providerEvents.normalize('rwi', {
      event: 'call_state_change',
      event_id: `controlled-state-${label}`,
      call_id: storedCall!.provider_call_id,
      state
    })
  });
  const action = async (kind: string, payload: Record<string, unknown>, key: string) => {
    const response = await invoke(
      'POST', `/api/ivekit/voice/calls/${callId}/actions`,
      { action: kind, payload }, key
    );
    const run = await commandWorker.runOnce(TENANT_A);
    assert.equal(run.succeeded, 1, kind);
    assert.equal(running.state.action_counts.get(response.data.id), 1, kind);
    return response.data;
  };

  await action('hold', {}, 'hold-call-a');
  await ingestState('held', 'held-a');
  assert.equal((await eventWorker.runOnce(TENANT_A)).processed, 1);
  storedCall = await calls.get(TENANT_A, callId);
  assert.equal(storedCall?.state, 'held');

  await action('resume', {}, 'resume-call-a');
  await ingestState('active', 'active-a');
  assert.equal((await eventWorker.runOnce(TENANT_A)).processed, 1);
  storedCall = await calls.get(TENANT_A, callId);
  assert.equal(storedCall?.state, 'active');

  await action('recording_start', {}, 'recording-start-a');
  await action('blind_transfer', { target: '1002' }, 'blind-transfer-a');
  await ingestState('transferring', 'transferring-a');
  assert.equal((await eventWorker.runOnce(TENANT_A)).processed, 1);

  const providerCallId = storedCall!.provider_call_id;
  const cdr = providerEvents.normalize('cdr', {
    cdr_id: 'controlled-cdr-a',
    call_id: providerCallId,
    state: 'completed',
    ended_at: new Date().toISOString(),
    duration_ms: 12_345,
    hangup_reason: 'normal_clearing',
    recording_id: `recording:${providerCallId}`,
    recording_object_ref: `controlled://recording:${providerCallId}`,
    recording_evidence_ref: 'evidence://controlled-recording-a',
    recording_checksum: 'a'.repeat(64),
    captured_at: new Date().toISOString(),
    metadata: { source: 'controlled' }
  });
  await eventService.ingest({ tenant_id: TENANT_A, profile_id: profile.id, event: cdr });
  assert.equal((await eventWorker.runOnce(TENANT_A)).processed, 1);
  storedCall = await calls.get(TENANT_A, callId);
  assert.equal(storedCall?.state, 'completed');
  assert.equal(storedCall?.termination_reason, 'normal_clearing');
  assert.equal(storedCall?.metadata.cdr_duration_ms, 12_345);
  const recordings = await new PostgresVoiceRecordingStore(runtime).listRecordings({
    tenant_id: TENANT_A,
    call_id: callId,
    limit: 10
  });
  assert.equal(recordings.items.length, 1);
  assert.equal(recordings.items[0]?.status, 'available');
  assert.equal(recordings.items[0]?.retention_until !== null, true);

  running.state.mode = 'async_success_after_timeout';
  running.state.response_delay_ms = 50;
  const timeoutProfile = (await invoke('POST', '/api/ivekit/voice/profiles', {
    name: 'Controlled timeout RustPBX',
    adapter: 'rustpbx',
    status: 'enabled',
    base_url: running.base_url,
    desired_version: 'controlled-rustpbx-v1',
    config: {
      rwi_url: running.rwi_url,
      internal_service: true,
      management_timeout_ms: 500,
      rwi_connect_timeout_ms: 500,
      rwi_command_timeout_ms: 15,
      rwi_heartbeat_timeout_ms: 2_000
    },
    secret_refs: {
      management_service_token: 'env://CONTROLLED_VOICE_TOKEN',
      rwi_token: 'env://CONTROLLED_VOICE_TOKEN'
    }
  })).data;
  assert.equal((await invoke(
    'POST', `/api/ivekit/voice/profiles/${timeoutProfile.id}/preflight`
  )).data.status, 'ready');
  await invoke('POST', '/api/ivekit/voice/consents', {
    subject_ref_type: 'order',
    subject_ref_id: 'VOICE-TIMEOUT-A',
    business_ref_type: 'order',
    business_ref_id: 'VOICE-TIMEOUT-A',
    consent_type: 'outbound_call',
    status: 'granted',
    evidence_ref: 'evidence://voice-timeout-a',
    expires_at: null
  });
  const timeoutOutbound = await invoke('POST', '/api/ivekit/voice/calls', {
    profile_id: timeoutProfile.id,
    from: { kind: 'extension', value: '1001' },
    to: { kind: 'e164', value: '+8613700137000' },
    business_ref: { type: 'order', id: 'VOICE-TIMEOUT-A' },
    metadata: { scenario: 'timeout_reconciliation' }
  }, 'outbound-timeout-a');
  const timeoutCommandId = timeoutOutbound.data.command.id as string;
  const timeoutRun = await commandWorker.runOnce(TENANT_A);
  assert.equal(timeoutRun.uncertain, 1);
  assert.equal(running.state.action_counts.get(timeoutCommandId), 1);
  await waitFor(() => running.state.calls.has(`controlled-call:${timeoutCommandId}`));
  const reconciliationWorker = new VoiceReconciliationWorker({
    unit_of_work: new PostgresVoiceCallUnitOfWork(runtime),
    provider_registry: registry,
    worker_id: 'voice-controlled-reconciliation-worker',
    batch_size: 10,
    lease_ms: 5_000,
    reconcile_delay_ms: 100,
    max_reconcile_age_ms: 10_000
  });
  const reconciled = await reconciliationWorker.runOnce(TENANT_A);
  assert.equal(reconciled.succeeded, 1);
  const timeoutCall = await calls.get(TENANT_A, timeoutOutbound.data.call.id);
  assert.equal(timeoutCall?.state, 'active');
  assert.equal(timeoutCall?.provider_call_id, `controlled-call:${timeoutCommandId}`);
  assert.equal(running.state.action_counts.get(timeoutCommandId), 1);
  running.state.mode = 'success';

  const recoveryCommand = await invoke(
    'POST', `/api/ivekit/voice/trunks/${trunk.id}/test`, {}, 'recover-expired-lease-a'
  );
  await withPgTenant(runtime, TENANT_A, (pg) => pg.query(
    `UPDATE ivekit_voice_configuration_commands
     SET state = 'processing', worker_id = 'dead-worker',
         lease_until = CURRENT_TIMESTAMP - INTERVAL '1 second'
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, recoveryCommand.data.id]
  ));
  const restartedWorker = new VoiceCommandWorker({
    commands: new PostgresVoiceCommandStore(runtime),
    configuration: new PostgresVoiceConfigurationStore(runtime),
    provider_registry: registry,
    address_protector: protector,
    call_executor: (command) => callExecutor.execute(command),
    worker_id: 'voice-controlled-restarted-worker',
    batch_size: 10,
    lease_ms: 5_000
  });
  const recovered = await restartedWorker.runOnce(TENANT_A);
  assert.equal(recovered.succeeded, 1);
  const recoveredRow = await withPgTenant(runtime, TENANT_A, (pg) => pg.query<{
    state: string;
    attempt_count: number;
  }>(
    `SELECT state, attempt_count
     FROM ivekit_voice_configuration_commands
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, recoveryCommand.data.id]
  ));
  assert.equal(recoveredRow.rows[0]?.state, 'succeeded');
  assert.equal(Number(recoveredRow.rows[0]?.attempt_count) >= 1, true);

  assert.equal(await configuration.getProfile(TENANT_B, profile.id), null);
  assert.equal(await configuration.getDid(TENANT_B, did.id), null);
  assert.equal(await calls.get(TENANT_B, callId), null);
  const tenantBCommands = await withPgTenant(runtime, TENANT_B, (pg) => pg.query(
    'SELECT id FROM ivekit_voice_call_commands WHERE id = $1',
    [originateCommandId]
  ));
  assert.equal(tenantBCommands.rowCount, 0);
});

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('controlled condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
