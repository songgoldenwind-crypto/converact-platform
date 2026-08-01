import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ControlledRealtimeVoiceAiFactory,
  REALTIME_VOICE_AI_CAPABILITIES,
  RealtimeVoiceAiRegistry,
  RealtimeVoiceAiService,
  VoiceError,
  projectRealtimeVoiceAiEvent,
  type RealtimeVoiceAiProfile
} from '../src/agent-runtime/converact/voice/index.js';

test('Realtime Voice AI registry supports every provider family and enforces profile state', async () => {
  const factory = new ControlledRealtimeVoiceAiFactory({
    now: () => new Date('2026-07-14T01:00:00.000Z')
  });
  const registry = new RealtimeVoiceAiRegistry({
    active_call: factory,
    livekit_agents: factory,
    self_hosted: factory,
    third_party: factory
  });
  const service = new RealtimeVoiceAiService({ registry });

  for (const provider of ['active_call', 'livekit_agents', 'self_hosted', 'third_party'] as const) {
    const capabilities = await service.capabilities(profile({ provider }));
    assert.equal(capabilities.provider, provider);
    assert.deepEqual(
      Object.keys(capabilities.capabilities).sort(),
      [...REALTIME_VOICE_AI_CAPABILITIES].sort()
    );
  }

  await assert.rejects(
    () => service.startSession(profile({ status: 'disabled' }), startInput()),
    hasVoiceCode('capability_unavailable')
  );
  await assert.rejects(
    () => service.capabilities(profile({ config: null as unknown as Record<string, unknown> })),
    hasVoiceCode('validation_failed')
  );
  await assert.rejects(
    () => service.capabilities(profile({ secret_refs: null as unknown as Record<string, string> })),
    hasVoiceCode('validation_failed')
  );
  assert.throws(
    () => registry.register('active_call', factory),
    hasVoiceCode('validation_failed')
  );
});

test('controlled Realtime Voice AI adapter is idempotent and enforces the session lifecycle', async () => {
  const factory = new ControlledRealtimeVoiceAiFactory({
    now: () => new Date('2026-07-14T01:00:00.000Z')
  });
  const service = new RealtimeVoiceAiService({
    registry: new RealtimeVoiceAiRegistry({ active_call: factory })
  });
  const configured = profile();

  const first = await service.startSession(configured, startInput());
  const replay = await service.startSession(configured, startInput());
  assert.deepEqual(replay, first);
  assert.equal(first.provider_session_id.startsWith('controlled-ai:'), true);
  assert.equal(factory.getSession(first.provider_session_id)?.state, 'active');

  await assert.rejects(
    () => service.startSession(configured, startInput({ language: 'en-US' })),
    hasVoiceCode('idempotency_conflict')
  );
  await service.sendDtmf(configured, {
    tenant_id: 'tenant-a', call_id: 'call-a', provider_session_id: first.provider_session_id,
    digits: '12#', idempotency_key: 'dtmf-a'
  });
  await service.interrupt(configured, {
    tenant_id: 'tenant-a', call_id: 'call-a', provider_session_id: first.provider_session_id,
    reason: 'caller_barge_in', idempotency_key: 'interrupt-a'
  });
  await service.endSession(configured, {
    tenant_id: 'tenant-a', call_id: 'call-a', provider_session_id: first.provider_session_id,
    reason: 'completed', idempotency_key: 'end-a'
  });
  assert.equal(factory.getSession(first.provider_session_id)?.state, 'ended');
  assert.deepEqual(factory.getSession(first.provider_session_id)?.dtmf, ['12#']);

  await assert.rejects(
    () => service.sendDtmf(configured, {
      tenant_id: 'tenant-a', call_id: 'call-a', provider_session_id: first.provider_session_id,
      digits: '9', idempotency_key: 'dtmf-after-end'
    }),
    hasVoiceCode('terminal_call_state')
  );
  await assert.rejects(
    () => service.sendDtmf(configured, {
      tenant_id: 'tenant-a', call_id: 'call-a', provider_session_id: 'missing',
      digits: 'not-dtmf', idempotency_key: 'bad-dtmf'
    }),
    hasVoiceCode('validation_failed')
  );
});

test('Realtime Voice AI event projection persists only authorized bounded evidence', async () => {
  const factory = new ControlledRealtimeVoiceAiFactory();
  const service = new RealtimeVoiceAiService({
    registry: new RealtimeVoiceAiRegistry({ active_call: factory })
  });
  const configured = profile();
  const normalized = await service.normalizeEvent(configured, {
    event_id: 'event-a', type: 'transcript.final', provider_session_id: 'session-a',
    occurred_at: '2026-07-14T01:00:00.000Z', transcript: 'customer said hello',
    language: 'en-US', evidence_ref: 'evidence:transcript-a',
    metadata: {
      model: 'controlled', authorization: 'Bearer secret', raw_audio: 'bytes',
      nested: [{ prompt: 'hidden prompt', status: 'ok' }, { tool_output: 'hidden output' }]
    }
  });

  const denied = projectRealtimeVoiceAiEvent(normalized, {
    persist_transcripts: false, persist_partial_transcripts: false,
    allowed_tool_refs: [], max_transcript_chars: 64
  });
  assert.equal(denied.transcript_text, '');
  assert.equal(denied.transcript_persisted, false);
  assert.doesNotMatch(
    JSON.stringify(denied),
    /customer said hello|Bearer secret|bytes|hidden prompt|hidden output/
  );

  const allowed = projectRealtimeVoiceAiEvent(normalized, {
    persist_transcripts: true, persist_partial_transcripts: false,
    allowed_tool_refs: [], max_transcript_chars: 8
  });
  assert.equal(allowed.transcript_text, 'customer');
  assert.equal(allowed.transcript_persisted, true);
  assert.equal(allowed.safe_metadata.authorization, '[redacted]');
  assert.equal('raw_audio' in allowed.safe_metadata, false);
  assert.deepEqual(allowed.safe_metadata.nested, [{ status: 'ok' }, {}]);

  const nonTranscript = await service.normalizeEvent(configured, {
    event_id: 'event-session', type: 'session.started', provider_session_id: 'session-a',
    occurred_at: '2026-07-14T01:00:00.000Z', transcript: 'must not persist',
    metadata: { status: 'started' }
  });
  const projectedNonTranscript = projectRealtimeVoiceAiEvent(nonTranscript, {
    persist_transcripts: true, persist_partial_transcripts: true,
    allowed_tool_refs: [], max_transcript_chars: 64
  });
  assert.equal(projectedNonTranscript.transcript_text, '');
  assert.equal(projectedNonTranscript.transcript_persisted, false);

  const tool = await service.normalizeEvent(configured, {
    event_id: 'event-tool', type: 'tool.started', provider_session_id: 'session-a',
    occurred_at: '2026-07-14T01:00:01.000Z', tool_ref: 'lookup-order:v2',
    tool_call_id: 'tool-call-a', evidence_ref: 'evidence:tool-a',
    metadata: { arguments: { order_id: 'private' }, status: 'started' }
  });
  assert.equal(projectRealtimeVoiceAiEvent(tool, {
    persist_transcripts: false, persist_partial_transcripts: false,
    allowed_tool_refs: ['lookup-order:v2'], max_transcript_chars: 64
  }).tool_ref, 'lookup-order:v2');
  assert.throws(() => projectRealtimeVoiceAiEvent(tool, {
    persist_transcripts: false, persist_partial_transcripts: false,
    allowed_tool_refs: ['different-tool:v1'], max_transcript_chars: 64
  }), hasVoiceCode('compliance_denied'));
});

test('Realtime Voice AI foundation stays provider-neutral and outside Converact product modules', () => {
  for (const path of [
    'src/agent-runtime/converact/voice/realtime-ai.ts',
    'src/agent-runtime/converact/voice/realtime-ai-events.ts',
    'src/agent-runtime/converact/voice/adapters/controlled-realtime-ai.ts'
  ]) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /call-center|\.\.\/\.\.\/\.\.\/db|node:sqlite|from ['"][^'"]*db\.js/);
  }
});

function profile(overrides: Partial<RealtimeVoiceAiProfile> = {}): RealtimeVoiceAiProfile {
  return {
    id: 'voice-ai-a', tenant_id: 'tenant-a', name: 'Voice AI', provider: 'active_call',
    status: 'enabled', endpoint: 'https://voice-ai.internal', provider_version: 'v1',
    config: {}, secret_refs: { token: 'env://VOICE_AI_TOKEN' }, revision: 1,
    ...overrides
  };
}

function startInput(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-a', call_id: 'call-a', profile_id: 'voice-ai-a', language: 'zh-CN',
    tools: [{ tool_id: 'lookup-order', version: 2, schema_hash: 'a'.repeat(64) }],
    idempotency_key: 'start-a', ...overrides
  };
}

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof VoiceError && error.code === code;
}
