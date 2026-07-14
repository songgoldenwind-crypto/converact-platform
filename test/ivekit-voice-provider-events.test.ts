import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RustPbxEventsAdapter,
  RustPbxRouterAdapter,
  VoiceError,
  VoiceProviderEventService,
  VoiceProviderEventWorker,
  VoiceRecordingService,
  VoiceRouterDecisionService,
  type VoiceCall,
  type VoiceProviderEvent,
  type VoiceRecording
} from '../src/agent-runtime/ivekit/voice/index.js';

const NOW = '2026-07-13T06:00:00.000Z';

test('provider event inbox resolves calls, persists before projection, and replays by id or canonical payload', async () => {
  const fixture = eventFixture();
  const normalized = new RustPbxEventsAdapter().normalize('http', {
    event_id: 'external-a', event: 'call.answered', call_id: 'provider-call-a', occurred_at: NOW
  });
  const first = await fixture.service.ingest({
    tenant_id: 'tenant-a', profile_id: 'profile-a', event: normalized
  });
  const replayById = await fixture.service.ingest({
    tenant_id: 'tenant-a', profile_id: 'profile-a', event: normalized
  });
  const replayByHash = await fixture.service.ingest({
    tenant_id: 'tenant-a', profile_id: 'profile-a',
    event: { ...normalized, external_event_id: 'external-b', safe_payload: { ...normalized.safe_payload, event_id: 'external-b' } }
  });

  assert.equal(first.replayed, false);
  assert.equal(replayById.replayed, true);
  assert.equal(replayByHash.replayed, true);
  assert.equal(first.event.call_id, 'call-a');
  assert.deepEqual(fixture.operations, ['find:provider-call-a', 'insert', 'find:provider-call-a', 'insert', 'find:provider-call-a', 'insert']);
  assert.equal(fixture.call.state, 'planned');

  const unmatched = await fixture.service.ingest({
    tenant_id: 'tenant-a', profile_id: 'profile-a',
    event: {
      ...normalized, external_event_id: 'external-unmatched', provider_call_id: 'provider-call-unmatched',
      safe_payload: { ...normalized.safe_payload, event_id: 'external-unmatched', call_id: 'provider-call-unmatched' }
    }
  });
  assert.equal(unmatched.event.call_id, null);
  assert.equal(unmatched.event.processing_state, 'pending');
});

test('provider event worker converges call state before completing the durable event', async () => {
  const fixture = workerFixture(providerEvent({
    event_type: 'call.answered', provider_state: 'answered', occurred_at: NOW
  }));
  const result = await fixture.worker.runOnce('tenant-a');

  assert.deepEqual(result, { claimed: 1, processed: 1, retry_wait: 0, failed: 0, stale: 0 });
  assert.equal(fixture.call.state, 'active');
  assert.equal(fixture.call.answered_at, NOW);
  assert.deepEqual(fixture.operations, ['claim', 'get-call-lock', 'update-call', 'complete']);
});

test('provider event worker associates events that arrived before the call row', async () => {
  const fixture = workerFixture(providerEvent({ call_id: null }));
  const result = await fixture.worker.runOnce('tenant-a');
  assert.equal(result.processed, 1);
  assert.deepEqual(fixture.operations, ['claim', 'find-call-provider-lock', 'update-call', 'complete']);
});

test('provider event worker treats late events as no-ops and CDR enriches without reviving terminal calls', async () => {
  const late = workerFixture(providerEvent({ event_type: 'call.ringing', provider_state: 'ringing' }), call({ state: 'active' }));
  await late.worker.runOnce('tenant-a');
  assert.equal(late.call.state, 'active');

  const cdrEvent = new RustPbxEventsAdapter().normalize('cdr', {
    cdr_id: 'cdr-a', call_id: 'provider-call-a', state: 'completed', duration_ms: 12_000,
    hangup_reason: 'normal_clearing', recording_id: 'recording-provider-a',
    recording_object_ref: 'object://voice/recording-a', recording_evidence_ref: 'evidence://recording-a',
    recording_checksum: 'sha256:recording-a', captured_at: NOW, occurred_at: NOW
  });
  const cdr = workerFixture(providerEvent({
    external_event_id: cdrEvent.external_event_id, event_type: cdrEvent.event_type,
    provider_state: cdrEvent.provider_state, occurred_at: cdrEvent.occurred_at,
    safe_payload: { ...cdrEvent.safe_payload, provider_call_id: cdrEvent.provider_call_id }
  }), call({ state: 'completed', ended_at: '2026-07-13T05:00:00.000Z' }));
  await cdr.worker.runOnce('tenant-a');

  assert.equal(cdr.call.state, 'completed');
  assert.equal(cdr.call.ended_at, '2026-07-13T05:00:00.000Z');
  assert.equal(cdr.call.termination_reason, 'normal_clearing');
  assert.equal(cdr.call.metadata.cdr_duration_ms, 12_000);
  assert.equal(cdr.recordings.length, 1);
  assert.equal(cdr.recordings[0]?.object_ref, 'object://voice/recording-a');
  assert.equal(cdr.recordings[0]?.retention_until, '2026-08-12T06:00:00.000Z');
});

test('provider event worker retries transient failures and dead-ends malformed events', async () => {
  const transient = workerFixture(providerEvent());
  transient.failGet = new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 });
  assert.deepEqual(await transient.worker.runOnce('tenant-a'), {
    claimed: 1, processed: 0, retry_wait: 1, failed: 0, stale: 0
  });
  assert.equal(transient.released[0]?.state, 'retry_wait');

  const malformed = workerFixture(providerEvent({ event_type: 'call.unknown', provider_state: 'unknown' }));
  assert.deepEqual(await malformed.worker.runOnce('tenant-a'), {
    claimed: 1, processed: 0, retry_wait: 0, failed: 1, stale: 0
  });
  assert.deepEqual(malformed.released[0], { state: 'failed', error_code: 'protocol_mismatch' });
});

test('recording projection requires active policy, evidence, checksum, object and consent', async () => {
  const fixture = workerFixture(providerEvent({
    event_type: 'call.cdr', provider_state: 'completed', safe_payload: {
      provider_call_id: 'provider-call-a', recording_id: 'recording-provider-a',
      recording_object_ref: 'object://voice/recording-a', recording_evidence_ref: 'evidence://provider',
      recording_checksum: 'sha256:recording-a', duration_ms: 1_000, captured_at: NOW
    }
  }));
  fixture.policy.recording_mode = 'consent_required';
  fixture.consents.length = 0;
  await fixture.worker.runOnce('tenant-a');
  assert.deepEqual(fixture.released[0], { state: 'failed', error_code: 'compliance_denied' });
  assert.equal(fixture.recordings.length, 0);
});

test('recording projection retries provider lookup until durable evidence is available', async () => {
  const event = providerEvent({
    event_type: 'call.cdr', provider_state: 'completed',
    safe_payload: { provider_call_id: 'provider-call-a', recording_id: 'recording-provider-a' }
  });
  const processing = workerFixture(event, call(), {
    async recording_lookup() { return { state: 'processing' as const }; }
  });
  await processing.worker.runOnce('tenant-a');
  assert.deepEqual(processing.released[0], { state: 'retry_wait', error_code: 'provider_unavailable' });

  const available = workerFixture(event, call(), {
    async recording_lookup() {
      return {
        state: 'available' as const, object_ref: 'object://voice/recording-a',
        evidence_ref: 'evidence://recording-a', checksum: 'sha256:recording-a', captured_at: NOW
      };
    }
  });
  await available.worker.runOnce('tenant-a');
  assert.equal(available.recordings[0]?.status, 'available');
});

test('Router decisions bind DID HMAC and immutable published route to trusted tenant/profile', async () => {
  const route = {
    id: 'route-a', tenant_id: 'tenant-a', profile_id: 'profile-a', name: 'inbound', direction: 'inbound' as const,
    status: 'active' as const, draft_revision: 2, draft_rules: {}, current_published_version: 3,
    created_by: 'admin', updated_by: 'admin', created_at: NOW, updated_at: NOW
  };
  const version = {
    id: 'route-version-a', tenant_id: 'tenant-a', route_id: 'route-a', version: 3,
    rules: { action: 'forward_sip', target: 'sip:1001@pbx.internal' }, payload_hash: 'a'.repeat(64),
    deployment_state: 'applied' as const, provider_revision: '3', published_by: 'admin', published_at: NOW
  };
  const protectedAddress = {
    kind: 'e164' as const, redacted: '+86******8000', ciphertext: 'ciphertext', hmac: 'hmac-a'
  };
  const configuration = {
    async findDidByAddressHmac(tenantId: string, hmac: string) {
      return tenantId === 'tenant-a' && hmac === 'hmac-a'
        ? { id: 'did-a', tenant_id: tenantId, trunk_id: 'trunk-a', route_id: 'route-a', e164: protectedAddress,
          provider_ref: '', status: 'active' as const, metadata: {}, revision: 1, created_at: NOW, updated_at: NOW }
        : null;
    },
    async getTrunk() { return { profile_id: 'profile-a', status: 'active' }; },
    async getRoute() { return route; },
    async listRouteVersions() { return [version]; },
    async getLatestCapabilitySnapshot() { return { capabilities: { json_rpc_routing: true } }; }
  };
  const service = new VoiceRouterDecisionService({
    configuration: configuration as never,
    address_protector: { async protect() { return protectedAddress; }, async reveal() { return '+8613800138000'; } },
    router_adapter: new RustPbxRouterAdapter()
  });
  const request = new RustPbxRouterAdapter().normalizeRequest({
    call_id: 'provider-call-a', from: 'sip:caller@carrier.test', to: 'sip:+8613800138000@pbx.test',
    source_addr: '10.0.0.1', direction: 'inbound', method: 'INVITE', uri: 'sip:+8613800138000@pbx.test'
  });

  assert.deepEqual(await service.decide({ tenant_id: 'tenant-a', profile_id: 'profile-a', request }), {
    action: 'forward', targets: ['sip:1001@pbx.internal'], strategy: 'sequential', record: false,
    timeout: 30, max_ring_time: 30, headers: {}
  });
  assert.deepEqual(await service.decide({ tenant_id: 'tenant-b', profile_id: 'profile-a', request }), {
    action: 'reject', status: 404, reason: 'route_not_found'
  });
});

test('Router decisions reject unavailable IVR/queue dependencies unless a safe fallback is published', async () => {
  const rules = { action: 'start_ivr', target: 'flow-a' };
  const service = new VoiceRouterDecisionService({
    configuration: routerConfiguration(rules) as never,
    address_protector: fixedAddressProtector(), router_adapter: new RustPbxRouterAdapter(),
    available_dependencies: []
  });
  const request = new RustPbxRouterAdapter().normalizeRequest({
    call_id: 'provider-call-a', from: 'sip:caller@carrier.test', to: '+8613800138000', source_addr: '10.0.0.1',
    direction: 'inbound', method: 'INVITE', uri: 'sip:+8613800138000@pbx.test'
  });
  assert.deepEqual(await service.decide({ tenant_id: 'tenant-a', profile_id: 'profile-a', request }), {
    action: 'reject', status: 503, reason: 'route_dependency_unavailable'
  });

  const fallback = new VoiceRouterDecisionService({
    configuration: routerConfiguration({ ...rules, fallback: { action: 'forward_sip', target: 'sip:operator@pbx.internal' } }) as never,
    address_protector: fixedAddressProtector(), router_adapter: new RustPbxRouterAdapter(), available_dependencies: []
  });
  assert.equal((await fallback.decide({ tenant_id: 'tenant-a', profile_id: 'profile-a', request })).action, 'forward');
});

function eventFixture() {
  const operations: string[] = [];
  const callRecord = call();
  const events: VoiceProviderEvent[] = [];
  const calls = {
    async findByProviderCallId(tenantId: string, profileId: string, providerCallId: string) {
      operations.push(`find:${providerCallId}`);
      return tenantId === callRecord.tenant_id && profileId === callRecord.provider_profile_id
        && providerCallId === callRecord.provider_call_id ? callRecord : null;
    }
  };
  const repository = {
    async insert(event: VoiceProviderEvent) {
      operations.push('insert');
      const found = events.find((candidate) => candidate.tenant_id === event.tenant_id
        && candidate.profile_id === event.profile_id
        && (candidate.external_event_id === event.external_event_id || candidate.canonical_hash === event.canonical_hash));
      if (found) {
        if (found.canonical_hash !== event.canonical_hash) throw new VoiceError({ code: 'idempotency_conflict' });
        return { event: found, replayed: true };
      }
      events.push(event);
      return { event, replayed: false };
    }
  };
  let id = 0;
  return {
    operations, call: callRecord,
    service: new VoiceProviderEventService({
      events: repository as never, calls: calls as never, id: () => `event-${++id}`, now: () => new Date(NOW)
    })
  };
}

function workerFixture(
  event: VoiceProviderEvent,
  initialCall = call(),
  options: { recording_lookup?: ConstructorParameters<typeof VoiceRecordingService>[0]['lookup'] } = {}
) {
  const operations: string[] = [];
  const recordings: VoiceRecording[] = [];
  const consents = [{
    id: 'consent-a', tenant_id: 'tenant-a', subject_ref_type: 'call', subject_ref_id: 'call-a',
    business_ref_type: 'order', business_ref_id: 'order-a', consent_type: 'recording' as const,
    status: 'granted' as const, evidence_ref: 'evidence://consent-a', granted_by: 'customer', expires_at: null,
    created_at: NOW, updated_at: NOW
  }];
  const policy = {
    id: 'policy-a', tenant_id: 'tenant-a', require_outbound_consent: false,
    recording_mode: 'always' as 'disabled' | 'consent_required' | 'always', recording_retention_days: 30,
    require_ai_disclosure: false, allowed_calling_windows: [], masking_policy: {}, status: 'active' as const,
    revision: 1, created_by: 'admin', updated_by: 'admin', created_at: NOW, updated_at: NOW
  };
  const fixture = {
    call: initialCall, failGet: null as unknown, released: [] as Array<{ state: string; error_code: string }>,
    operations, recordings, consents, policy,
    worker: null as unknown as VoiceProviderEventWorker
  };
  const events = {
    async claimDue() { operations.push('claim'); return [event]; },
    async complete() { operations.push('complete'); return { ...event, processing_state: 'processed' as const }; },
    async release(input: { state: string; error_code: string }) {
      fixture.released.push({ state: input.state, error_code: input.error_code });
      return { ...event, processing_state: input.state };
    }
  };
  const calls = {
    async get() {
      operations.push('get-call-lock');
      if (fixture.failGet) throw fixture.failGet;
      return fixture.call;
    },
    async findByProviderCallId() { operations.push('find-call-provider-lock'); return fixture.call; },
    async update(next: VoiceCall) { operations.push('update-call'); fixture.call = next; return next; }
  };
  const configuration = {
    async getPolicy() { return policy; },
    async listConsents() { return { items: consents, next_cursor: null }; }
  };
  const recordingStore = {
    async getRecording(_tenant: string, id: string) { return recordings.find((item) => item.id === id) ?? null; },
    async insertRecording(recording: VoiceRecording) { recordings.push(recording); return recording; },
    async updateRecording(recording: VoiceRecording) {
      const index = recordings.findIndex((item) => item.id === recording.id);
      recordings[index] = recording;
      return recording;
    }
  };
  const unitOfWork = {
    async run<T>(_tenantId: string, operation: (context: never) => Promise<T>): Promise<T> {
      return operation({ calls, events, configuration, recordings: recordingStore } as never);
    }
  };
  fixture.worker = new VoiceProviderEventWorker({
    unit_of_work: unitOfWork, recording_service: new VoiceRecordingService({
      id: () => 'recording-a', now: () => new Date(NOW), lookup: options.recording_lookup
    }), worker_id: 'worker-a', retry_base_ms: 1_000, retry_jitter_ratio: 0,
    now: () => new Date(NOW)
  });
  return fixture;
}

function providerEvent(patch: Partial<VoiceProviderEvent> = {}): VoiceProviderEvent {
  return {
    id: 'event-a', tenant_id: 'tenant-a', profile_id: 'profile-a', call_id: 'call-a',
    external_event_id: 'external-a', canonical_hash: 'a'.repeat(64), event_type: 'call.ringing',
    provider_state: 'ringing', safe_payload: { provider_call_id: 'provider-call-a' }, processing_state: 'processing',
    attempt_count: 1, next_attempt_at: null, lease_until: '2026-07-13T06:01:00.000Z', worker_id: 'worker-a',
    error_code: '', occurred_at: NOW, received_at: NOW, processed_at: null, ...patch
  };
}

function call(patch: Partial<VoiceCall> = {}): VoiceCall {
  return {
    id: 'call-a', tenant_id: 'tenant-a', business_ref: { type: 'order', id: 'order-a' },
    provider_profile_id: 'profile-a', provider_call_id: 'provider-call-a', provider_dialog_id: '', media_call_id: null,
    direction: 'outbound', state: 'planned', from: { kind: 'extension', redacted: '**01' },
    to: { kind: 'e164', redacted: '+86******8000' }, idempotency_key: 'call-key', initiated_by: 'agent-a',
    metadata: {}, ringing_at: null, answered_at: null, ended_at: null, termination_reason: '', revision: 1,
    created_at: NOW, updated_at: NOW, ...patch
  };
}

function routerConfiguration(rules: Record<string, unknown>) {
  return {
    async findDidByAddressHmac() { return { id: 'did-a', trunk_id: 'trunk-a', route_id: 'route-a', status: 'active' }; },
    async getTrunk() { return { profile_id: 'profile-a', status: 'active' }; },
    async getRoute() {
      return { id: 'route-a', profile_id: 'profile-a', direction: 'inbound', status: 'active', current_published_version: 1 };
    },
    async listRouteVersions() { return [{ version: 1, rules, deployment_state: 'applied' }]; },
    async getLatestCapabilitySnapshot() { return { capabilities: { json_rpc_routing: true, step_ivr: true, queue: true } }; }
  };
}

function fixedAddressProtector() {
  return {
    async protect() { return { kind: 'e164' as const, redacted: '+86******8000', ciphertext: 'cipher', hmac: 'hmac-a' }; },
    async reveal() { return '+8613800138000'; }
  };
}
