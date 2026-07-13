import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import {
  VoiceError,
  type VoiceCall,
  type VoiceCallCommand,
  type VoiceConfigurationCommand,
  type VoiceDeploymentProfile,
  type VoiceDid,
  type VoiceLiveKitBridge,
  type VoiceProviderEvent,
  type VoiceRecording
} from '../src/agent-runtime/ivekit/voice/index.js';
import { PostgresVoiceCallStore } from '../src/agent-runtime/ivekit/voice/postgres/call-store.js';
import { PostgresVoiceCommandStore } from '../src/agent-runtime/ivekit/voice/postgres/command-store.js';
import { PostgresVoiceConfigurationStore } from '../src/agent-runtime/ivekit/voice/postgres/configuration-store.js';
import { PostgresVoiceProviderEventStore } from '../src/agent-runtime/ivekit/voice/postgres/provider-event-store.js';
import { PostgresVoiceRecordingStore } from '../src/agent-runtime/ivekit/voice/postgres/recording-store.js';

interface RecordedQuery {
  text: string;
  params: unknown[];
}

class RecordingPg implements PgQueryable {
  readonly calls: RecordedQuery[] = [];

  constructor(
    private readonly respond: (text: string, params: unknown[], callIndex: number) => unknown[] = () => []
  ) {}

  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    const rows = this.respond(text, params, this.calls.length - 1) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

test('Voice configuration store decodes profiles, uses tuple cursors, and hides DID lookup material', async () => {
  const pg = new RecordingPg((sql) => {
    if (/FROM ivekit_voice_deployment_profiles profile/i.test(sql) && /ORDER BY profile\.created_at DESC/i.test(sql)) {
      return [profileRow('profile-a'), profileRow('profile-b')];
    }
    if (/FROM ivekit_voice_dids did/i.test(sql)) return [didRow()];
    return [];
  });
  const store = new PostgresVoiceConfigurationStore(pg);

  const profiles = await store.listProfiles({ tenant_id: 'tenant-a', limit: 1 });
  assert.equal(profiles.items.length, 1);
  assert.equal(profiles.items[0].adapter, 'rustpbx');
  assert.deepEqual(profiles.items[0].config, { region: 'cn' });
  assert.equal(typeof profiles.next_cursor, 'string');

  const profileQuery = pg.calls.find((call) => /ORDER BY profile\.created_at DESC/i.test(call.text))!;
  assert.match(profileQuery.text, /\(profile\.created_at, profile\.id\) < \(\$2::timestamptz, \$3\)/i);
  assert.match(profileQuery.text, /ORDER BY profile\.created_at DESC, profile\.id DESC/i);
  assert.equal(profileQuery.params[0], 'tenant-a');
  assert.equal(profileQuery.text.includes('tenant-a'), false);

  const did = await store.getDid('tenant-a', 'did-a');
  assert.deepEqual(did?.e164, { kind: 'e164', redacted: '+86******8000' });
  const didSelect = pg.calls.find((call) => /FROM ivekit_voice_dids did/i.test(call.text))!;
  assert.doesNotMatch(didSelect.text, /e164_ciphertext|e164_hmac/i);
});

test('Voice configuration writes are parameterized and optimistic conflicts are stable', async () => {
  const insertedDid = didRecord();
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_voice_dids/i.test(sql)) return [didRow()];
    return [];
  });
  const store = new PostgresVoiceConfigurationStore(pg);
  await store.insertDid(insertedDid, {
    kind: 'e164',
    redacted: '+86******8000',
    ciphertext: 'v1.nonce.tag.ciphertext',
    hmac: 'a'.repeat(64)
  });
  const insert = pg.calls.find((call) => /INSERT INTO ivekit_voice_dids/i.test(call.text))!;
  assert.equal(insert.text.includes('v1.nonce.tag.ciphertext'), false);
  assert.equal(insert.params.includes('v1.nonce.tag.ciphertext'), true);
  assert.equal(insert.params.includes('a'.repeat(64)), true);

  await assert.rejects(
    () => store.updateProfile(profileRecord(), 4),
    (error: unknown) => error instanceof VoiceError && error.code === 'revision_conflict'
  );
  const update = pg.calls.find((call) => /UPDATE ivekit_voice_deployment_profiles/i.test(call.text))!;
  assert.match(update.text, /WHERE tenant_id = \$1 AND id = \$2 AND revision = \$\d+/i);
  assert.equal(update.params[0], 'tenant-a');
  assert.equal(update.params[1], 'profile-a');
  assert.equal(update.params.at(-1), 4);
});

test('Voice call store writes protected addresses but only decodes projections', async () => {
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_voice_calls/i.test(sql)) return [callRow()];
    if (/FROM ivekit_voice_calls call/i.test(sql)) return [callRow()];
    if (/FROM ivekit_voice_calls\s+WHERE/i.test(sql)) return [{
      kind: 'e164', ciphertext: 'cipher-to', hmac: 'hmac-to', redacted: '+86******8000'
    }];
    return [];
  });
  const store = new PostgresVoiceCallStore(pg);
  const call = await store.insert(callRecord(), protectedAddress('from'), protectedAddress('to'));
  assert.deepEqual(call.from, { kind: 'e164', redacted: '+86******8000' });
  assert.deepEqual(call.to, { kind: 'extension', redacted: '**01' });

  const insert = pg.calls.find((item) => /INSERT INTO ivekit_voice_calls/i.test(item.text))!;
  assert.equal(insert.params.includes('cipher-from'), true);
  assert.equal(insert.params.includes('hmac-from'), true);
  const selected = await store.get('tenant-a', 'call-a', { for_update: true });
  assert.equal(selected?.business_ref.id, 'ORDER-1');
  const select = pg.calls.find((item) => /FROM ivekit_voice_calls call/i.test(item.text))!;
  assert.match(select.text, /FOR UPDATE/i);
  assert.doesNotMatch(select.text, /address_ciphertext|address_hmac/i);

  const protectedTo = await store.getProtectedAddress('tenant-a', 'call-a', 'to');
  assert.deepEqual(protectedTo, {
    kind: 'e164', ciphertext: 'cipher-to', hmac: 'hmac-to', redacted: '+86******8000'
  });
  const protectedSelect = pg.calls.find((item) => /to_address_ciphertext AS ciphertext/i.test(item.text))!;
  assert.equal(protectedSelect.params[0], 'tenant-a');
  assert.equal(protectedSelect.params[1], 'call-a');

  const conflictPg = new RecordingPg();
  await assert.rejects(
    () => new PostgresVoiceCallStore(conflictPg).update(callRecord(), 9),
    (error: unknown) => error instanceof VoiceError && error.code === 'revision_conflict'
  );
});

test('Voice command store reloads idempotent inserts and fences claims by worker', async () => {
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_voice_call_commands/i.test(sql)) return [];
    if (/FROM ivekit_voice_call_commands command/i.test(sql) && /idempotency_key/i.test(sql)) {
      return [callCommandRow()];
    }
    if (/WITH candidate AS/i.test(sql) && /ivekit_voice_call_commands/i.test(sql)) {
      return [callCommandRow({ state: 'processing', worker_id: 'worker-a', attempt_count: 1 })];
    }
    if (/UPDATE ivekit_voice_call_commands/i.test(sql) && /worker_id/i.test(sql)) {
      return [callCommandRow({ state: 'succeeded', worker_id: '' })];
    }
    return [];
  });
  const store = new PostgresVoiceCommandStore(pg);

  const replay = await store.insertCall(callCommandRecord());
  assert.equal(replay.id, 'command-a');
  const insert = pg.calls.find((call) => /INSERT INTO ivekit_voice_call_commands/i.test(call.text))!;
  assert.match(insert.text, /ON CONFLICT \(tenant_id, idempotency_key\) DO NOTHING/i);
  assert.equal(pg.calls.some((call) => /FROM ivekit_voice_call_commands command/i.test(call.text)), true);

  const claimed = await store.claimCallDue({
    tenant_id: 'tenant-a',
    worker_id: 'worker-a',
    now: new Date('2026-07-13T04:00:00.000Z'),
    lease_ms: 30_000,
    limit: 500
  });
  assert.equal(claimed[0].worker_id, 'worker-a');
  const claim = pg.calls.find((call) => /WITH candidate AS/i.test(call.text))!;
  assert.match(claim.text, /FOR UPDATE SKIP LOCKED/i);
  assert.match(claim.text, /state = 'processing'[\s\S]*lease_until <=/i);
  assert.equal(claim.params.at(-1), 200);

  await store.completeCall({
    tenant_id: 'tenant-a',
    command_id: 'command-a',
    worker_id: 'worker-a',
    state: 'succeeded',
    result: { accepted: true }
  });
  const complete = pg.calls.find((call) => (
    /UPDATE ivekit_voice_call_commands/i.test(call.text) && /completed_at = CURRENT_TIMESTAMP/i.test(call.text)
  ))!;
  assert.match(complete.text, /WHERE tenant_id = \$1 AND id = \$2 AND worker_id = \$3/i);
});

test('Voice configuration commands use the same idempotent and leased queue contract', async () => {
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_voice_configuration_commands/i.test(sql)) return [configurationCommandRow()];
    if (/WITH candidate AS/i.test(sql)) return [configurationCommandRow({ state: 'processing', worker_id: 'worker-c' })];
    return [];
  });
  const store = new PostgresVoiceCommandStore(pg);
  assert.equal((await store.insertConfiguration(configurationCommandRecord())).resource_type, 'sip_trunk');
  await store.claimConfigurationDue({
    tenant_id: 'tenant-a',
    worker_id: 'worker-c',
    now: new Date('2026-07-13T04:00:00.000Z'),
    lease_ms: 30_000,
    limit: 10
  });
  const queries = pg.calls.map((call) => call.text).join('\n');
  assert.match(queries, /ON CONFLICT \(tenant_id, idempotency_key\) DO NOTHING/i);
  assert.match(queries, /ivekit_voice_configuration_commands[\s\S]*FOR UPDATE SKIP LOCKED/i);
});

test('Voice provider event store deduplicates, claims, and fences completion', async () => {
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_voice_provider_events/i.test(sql)) return [];
    if (/FROM ivekit_voice_provider_events event/i.test(sql) && /canonical_hash/i.test(sql)) return [providerEventRow()];
    if (/WITH candidate AS/i.test(sql)) return [providerEventRow({ processing_state: 'processing', worker_id: 'event-worker' })];
    if (/UPDATE ivekit_voice_provider_events/i.test(sql)) return [providerEventRow({ processing_state: 'processed' })];
    return [];
  });
  const store = new PostgresVoiceProviderEventStore(pg);
  const inserted = await store.insert(providerEventRecord());
  assert.equal(inserted.replayed, true);
  assert.equal(inserted.event.id, 'event-a');
  assert.match(
    pg.calls.find((call) => /INSERT INTO ivekit_voice_provider_events/i.test(call.text))!.text,
    /ON CONFLICT DO NOTHING/i
  );

  await store.claimDue({
    tenant_id: 'tenant-a', worker_id: 'event-worker',
    now: new Date('2026-07-13T04:00:00.000Z'), lease_ms: 30_000, limit: 10
  });
  await store.complete({ tenant_id: 'tenant-a', event_id: 'event-a', worker_id: 'event-worker' });
  const sql = pg.calls.map((call) => call.text).join('\n');
  assert.match(sql, /FOR UPDATE SKIP LOCKED/i);
  assert.match(sql, /WHERE tenant_id = \$1 AND id = \$2 AND worker_id = \$3/i);
});

test('Voice recording store decodes recordings and idempotently reloads LiveKit bridges', async () => {
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_voice_recordings/i.test(sql)) return [recordingRow()];
    if (/INSERT INTO ivekit_voice_livekit_bridges/i.test(sql)) return [];
    if (/FROM ivekit_voice_livekit_bridges bridge/i.test(sql)) return [bridgeRow()];
    if (/FROM ivekit_voice_recordings recording/i.test(sql)) return [recordingRow(), recordingRow({ id: 'recording-b' })];
    return [];
  });
  const store = new PostgresVoiceRecordingStore(pg);
  const recording = await store.insertRecording(recordingRecord());
  assert.equal(recording.duration_ms, 1200);

  const bridge = await store.insertBridge(bridgeRecord());
  assert.equal(bridge.room_name, 'voice-room-a');
  assert.match(
    pg.calls.find((call) => /INSERT INTO ivekit_voice_livekit_bridges/i.test(call.text))!.text,
    /ON CONFLICT \(tenant_id, idempotency_key\) DO NOTHING/i
  );

  const page = await store.listRecordings({ tenant_id: 'tenant-a', limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(typeof page.next_cursor, 'string');
  const list = pg.calls.find((call) => /ORDER BY recording\.created_at DESC/i.test(call.text))!;
  assert.match(list.text, /\(recording\.created_at, recording\.id\) < \(\$2::timestamptz, \$3\)/i);
});

function profileRecord(): VoiceDeploymentProfile {
  return {
    id: 'profile-a', tenant_id: 'tenant-a', name: 'PBX A', adapter: 'rustpbx', status: 'enabled',
    base_url: 'https://pbx.internal', desired_version: '1.0.0', config: { region: 'cn' },
    secret_refs: { rwi: 'env://RUSTPBX_RWI_TOKEN' }, revision: 5, created_by: 'admin',
    updated_by: 'admin', created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function profileRow(id: string): Record<string, unknown> {
  return { ...profileRecord(), id, config: JSON.stringify({ region: 'cn' }), created_at: new Date('2026-07-13T00:00:00.000Z') };
}

function didRecord(): VoiceDid {
  return {
    id: 'did-a', tenant_id: 'tenant-a', trunk_id: 'trunk-a', route_id: 'route-a',
    e164: { kind: 'e164', redacted: '+86******8000' }, provider_ref: 'provider-did-a',
    status: 'active', metadata: {}, revision: 1, created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function didRow(): Record<string, unknown> {
  const { e164: _e164, ...did } = didRecord();
  return { ...did, e164_redacted: '+86******8000' };
}

function protectedAddress(label: string): any {
  return {
    kind: label === 'from' ? 'e164' : 'extension',
    redacted: label === 'from' ? '+86******8000' : '**01',
    ciphertext: `cipher-${label}`,
    hmac: `hmac-${label}`
  };
}

function callRecord(): VoiceCall {
  return {
    id: 'call-a', tenant_id: 'tenant-a', business_ref: { type: 'order', id: 'ORDER-1' },
    provider_profile_id: 'profile-a', provider_call_id: '', provider_dialog_id: '', media_call_id: null,
    direction: 'outbound', state: 'planned', from: { kind: 'e164', redacted: '+86******8000' },
    to: { kind: 'extension', redacted: '**01' }, idempotency_key: 'call-key-a', initiated_by: 'agent-a',
    metadata: {}, ringing_at: null, answered_at: null, ended_at: null, termination_reason: '', revision: 1,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function callRow(): Record<string, unknown> {
  const { business_ref: _businessRef, from: _from, to: _to, ...call } = callRecord();
  return {
    ...call, business_ref_type: 'order', business_ref_id: 'ORDER-1',
    from_address_kind: 'e164', from_address_redacted: '+86******8000',
    to_address_kind: 'extension', to_address_redacted: '**01'
  };
}

function callCommandRecord(): VoiceCallCommand {
  return {
    id: 'command-a', tenant_id: 'tenant-a', call_id: 'call-a', kind: 'originate', state: 'pending',
    idempotency_key: 'command-key-a', payload_hash: 'a'.repeat(64), payload: {}, attempt_count: 0,
    max_attempts: 3, next_attempt_at: null, lease_until: null, worker_id: '', provider_command_id: '',
    result: {}, error_code: '', error_message: '', created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z', completed_at: null
  };
}

function callCommandRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...callCommandRecord(), ...overrides };
}

function configurationCommandRecord(): VoiceConfigurationCommand {
  return {
    id: 'configuration-a', tenant_id: 'tenant-a', profile_id: 'profile-a', resource_type: 'sip_trunk',
    resource_id: 'trunk-a', operation: 'apply', state: 'pending', idempotency_key: 'configuration-key-a',
    payload_hash: 'b'.repeat(64), payload: {}, attempt_count: 0, max_attempts: 3, next_attempt_at: null,
    lease_until: null, worker_id: '', provider_command_id: '', result: {}, error_code: '', error_message: '',
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z', completed_at: null
  };
}

function configurationCommandRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...configurationCommandRecord(), ...overrides };
}

function providerEventRecord(): VoiceProviderEvent {
  return {
    id: 'event-a', tenant_id: 'tenant-a', profile_id: 'profile-a', call_id: 'call-a',
    external_event_id: 'provider-event-a', canonical_hash: 'c'.repeat(64), event_type: 'call.ringing',
    provider_state: 'ringing', safe_payload: { state: 'ringing' }, processing_state: 'pending',
    attempt_count: 0, next_attempt_at: null, lease_until: null, worker_id: '', error_code: '',
    occurred_at: '2026-07-13T00:00:01.000Z', received_at: '2026-07-13T00:00:02.000Z', processed_at: null
  };
}

function providerEventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...providerEventRecord(), safe_payload: JSON.stringify({ state: 'ringing' }), ...overrides };
}

function recordingRecord(): VoiceRecording {
  return {
    id: 'recording-a', tenant_id: 'tenant-a', call_id: 'call-a', profile_id: 'profile-a',
    provider_recording_id: 'provider-recording-a', status: 'available', recording_mode: 'always',
    consent_id: null, object_ref: 'object://recording-a', evidence_ref: 'evidence-a', checksum: 'd'.repeat(64),
    duration_ms: 1200, retention_until: '2026-08-13T00:00:00.000Z', captured_at: '2026-07-13T00:00:00.000Z',
    deleted_at: null, metadata: {}, created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function recordingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...recordingRecord(), ...overrides };
}

function bridgeRecord(): VoiceLiveKitBridge {
  return {
    id: 'bridge-a', tenant_id: 'tenant-a', call_id: 'call-a', media_call_id: 'media-a',
    sip_participant_id: '', room_name: 'voice-room-a', provider_bridge_id: '', status: 'pending',
    idempotency_key: 'bridge-key-a', metadata: {}, created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z', ended_at: null
  };
}

function bridgeRow(): Record<string, unknown> {
  return { ...bridgeRecord() };
}
