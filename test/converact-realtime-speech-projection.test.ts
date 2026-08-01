import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import { MemoryPg } from '../src/db-pg.js';
import { createDatabase } from '../src/db.js';
import { signAccessToken } from '../src/middleware/auth.js';
import { routeConveractFabricMediaApi } from '../src/agent-runtime/converact/media-http.js';
import {
  RealtimeSpeechStore,
  type RealtimeSpeechFinalSegment,
  type RealtimeSpeechStorePort
} from '../src/agent-runtime/converact/voice/realtime-speech-store.js';
import {
  RealtimeSpeechProjection
} from '../src/agent-runtime/converact/voice/realtime-speech-projection.js';
import type {
  RealtimeSpeechTranslationEvent
} from '../src/agent-runtime/converact/voice/realtime-speech-translation.js';
import { createConveractFabricHttpSdk } from '../sdk/converact/src/http-sdk.js';

test('realtime speech projection keeps partials ephemeral and persists final segments only', async () => {
  const store = new ControlledStore();
  const ephemeral: unknown[] = [];
  const durable: unknown[] = [];
  const projection = new RealtimeSpeechProjection({
    store,
    broadcastEphemeral: async (event) => { ephemeral.push(event); },
    publishFinal: async (event) => { durable.push(event); }
  });

  const partial = speechEvent('transcript.partial', {
    source_text: 'partial customer words', final: false
  });
  const partialResult = await projection.project(context(), partial);
  assert.deepEqual(partialResult, { status: 'ephemeral', projection: null, replayed: false });
  assert.equal(store.upserts.length, 0);
  assert.equal(durable.length, 0);
  assert.match(JSON.stringify(ephemeral[0]), /partial customer words/);
  assert.deepEqual(
    (ephemeral[0] as { audience_user_ids: string[] }).audience_user_ids,
    ['participant-a']
  );

  const final = speechEvent('transcript.final', {
    event_id: 'event-final-a', source_text: 'final customer words', final: true
  });
  const finalResult = await projection.project(context(), final);
  assert.equal(finalResult.status, 'persisted');
  assert.equal(finalResult.projection?.interaction_id, 'interaction-a');
  assert.equal(store.upserts.length, 1);
  assert.equal(store.upserts[0]?.consent_ref, 'consent-a');
  assert.equal(store.upserts[0]?.provider_profile_id, 'speech-cloud');
  assert.equal(store.upserts[0]?.provider_version, '2026-07');
  assert.equal(store.upserts[0]?.source_text, 'final customer words');
  assert.equal(ephemeral.length, 2);
  assert.equal(durable.length, 1);
  const durableJson = JSON.stringify(durable[0]);
  assert.match(durableJson, /projection-a|interaction-a|segment-a/);
  assert.doesNotMatch(durableJson, /final customer words|source_text|translated_text|secret/i);
  assert.equal(
    (durable[0] as { data: { call_id: string } }).data.call_id,
    'interaction-a'
  );
});

test('realtime speech projection uses final identity idempotently and emits no duplicate durable event', async () => {
  const store = new ControlledStore();
  store.replayed = true;
  const ephemeral: unknown[] = [];
  const durable: unknown[] = [];
  const projection = new RealtimeSpeechProjection({
    store,
    broadcastEphemeral: (event) => { ephemeral.push(event); },
    publishFinal: (event) => { durable.push(event); }
  });

  const result = await projection.project(context(), speechEvent('translation.final', {
    event_id: 'event-translation-a',
    target_language: 'en-US',
    source_text: 'source words',
    translated_text: 'translated words',
    final: true
  }));

  assert.equal(result.replayed, true);
  assert.equal(durable.length, 0);
  assert.equal(ephemeral.length, 0);
  assert.equal(store.upserts[0]?.kind, 'translation');
  assert.equal(store.upserts[0]?.target_language, 'en-US');
});

test('realtime speech store uses immutable payload idempotency, tenant paging, and interaction deletion', async () => {
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_realtime_speech_segments/i.test(sql)) return [segmentRow()];
    if (/SELECT \* FROM ivekit_realtime_speech_segments/i.test(sql)) return [segmentRow()];
    if (/DELETE FROM ivekit_realtime_speech_segments/i.test(sql)) return [{ id: 'projection-a' }];
    return [];
  });
  const store = new RealtimeSpeechStore(pg);
  const inserted = await store.upsertFinal(segmentInput());
  const page = await store.list({ tenant_id: 'tenant-a', interaction_id: 'interaction-a', limit: 25, cursor: '' });
  const deleted = await store.deleteByInteraction({ tenant_id: 'tenant-a', interaction_id: 'interaction-a' });

  assert.equal(inserted.replayed, false);
  assert.equal(page.items.length, 1);
  assert.equal(deleted, 1);
  const insert = pg.calls.find((call) => /INSERT INTO ivekit_realtime_speech_segments/i.test(call.text))!;
  assert.match(insert.text, /ON CONFLICT[\s\S]*DO NOTHING/i);
  assert.match(insert.text, /source_hash/i);
  const list = pg.calls.find((call) => /SELECT \* FROM ivekit_realtime_speech_segments/i.test(call.text))!;
  assert.match(list.text, /tenant_id = \$1 AND interaction_id = \$2/i);
  assert.match(list.text, /occurred_at, id/i);
  const deletion = pg.calls.find((call) => /DELETE FROM ivekit_realtime_speech_segments/i.test(call.text))!;
  assert.deepEqual(deletion.params, ['tenant-a', 'interaction-a']);
});

test('realtime speech projection migration provides RLS, final identity, retention, and no raw audio columns', () => {
  const sql = readFileSync('src/migrations/098_ivekit_realtime_speech_projection.sql', 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_realtime_speech_segments/i);
  assert.match(sql, /UNIQUE[\s\S]*tenant_id[\s\S]*interaction_id[\s\S]*provider_session_id[\s\S]*segment_id/i);
  assert.match(sql, /source_event_id|event_id/i);
  assert.match(sql, /consent_ref/i);
  assert.match(sql, /retention_until/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(sql, /raw_audio|audio_bytes|pcm_bytes|audio_payload/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE/i);
});

test('Converact Fabric SDK exposes paged final realtime speech projections', async () => {
  const calls: URL[] = [];
  const sdk = createConveractFabricHttpSdk({
    baseUrl: 'https://converact.example.test', tenantId: 'tenant-a', apiKey: 'sdk-key',
    fetch: async (input) => {
      calls.push(new URL(String(input)));
      return Response.json({ items: [], next_cursor: '', has_more: false });
    }
  });
  await sdk.media.listRealtimeSpeech('call/sdk', { limit: 25, cursor: 'cursor-a' });
  assert.equal(calls[0]?.pathname, '/api/ivekit/media/calls/call%2Fsdk/realtime-speech');
  assert.equal(calls[0]?.searchParams.get('limit'), '25');
  assert.equal(calls[0]?.searchParams.get('cursor'), 'cursor-a');
});

test('realtime speech HTTP projection is call-member scoped and preserves paging input', async () => {
  const previousSecret = process.env.CONVERACT_JWT_SECRET;
  process.env.CONVERACT_JWT_SECRET = 'realtime-speech-projection-secret-32-bytes';
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenantId = 'tenant-realtime-speech';
  const host = jwtHeaders(tenantId, 'host-a');
  const participant = jwtHeaders(tenantId, 'participant-a');
  const outsider = jwtHeaders(tenantId, 'outsider-a');
  const lists: unknown[] = [];
  const realtimeSpeechStore = {
    list: async (input: unknown) => {
      lists.push(input);
      return { items: [], next_cursor: 'cursor-next', has_more: true };
    },
    deleteByInteraction: async () => 0
  };
  try {
    const created = await mediaRoute('POST', '/api/ivekit/media/calls', {
      media: 'audio',
      participant_identities: ['participant-a'],
      business_ref: { type: 'service_order', id: 'speech-order-a' }
    }, host) as { data: { call: { id: string } } };
    const path = `/api/ivekit/media/calls/${created.data.call.id}/realtime-speech?limit=25&cursor=cursor-a`;

    await assert.rejects(() => mediaRoute('GET', path, null, outsider), hasStatus(404));
    assert.equal(lists.length, 0);

    const response = await mediaRoute('GET', path, null, participant) as {
      data: { items: unknown[]; next_cursor: string; has_more: boolean };
    };
    assert.deepEqual(response.data, { items: [], next_cursor: 'cursor-next', has_more: true });
    assert.deepEqual(lists, [{
      tenant_id: tenantId,
      interaction_id: created.data.call.id,
      limit: 25,
      cursor: 'cursor-a'
    }]);
  } finally {
    db.close();
    if (previousSecret === undefined) delete process.env.CONVERACT_JWT_SECRET;
    else process.env.CONVERACT_JWT_SECRET = previousSecret;
  }

  function mediaRoute(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>
  ) {
    const url = new URL(`http://localhost${path}`);
    return routeConveractFabricMediaApi(db, method, url.pathname, url, body, '', headers, {
      pg,
      realtimeSpeechStore
    });
  }
});

class ControlledStore implements RealtimeSpeechStorePort {
  readonly upserts: Parameters<RealtimeSpeechStorePort['upsertFinal']>[0][] = [];
  replayed = false;

  async upsertFinal(input: Parameters<RealtimeSpeechStorePort['upsertFinal']>[0]) {
    this.upserts.push(input);
    return { segment: projectedSegment(input), replayed: this.replayed };
  }

  async list() {
    return { items: [], next_cursor: '', has_more: false };
  }

  async deleteByInteraction() {
    return 0;
  }
}

class RecordingPg implements PgQueryable {
  readonly calls: Array<{ text: string; params: unknown[] }> = [];

  constructor(private readonly respond: (text: string, params: unknown[]) => unknown[]) {}

  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    const rows = this.respond(text, params) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

function context() {
  return {
    tenant_id: 'tenant-a', interaction_id: 'interaction-a', media_session_id: 'room-a',
    media_source: 'livekit' as const, participant_id: 'participant-a', track_id: 'track-a',
    purpose: 'live_captions' as const, consent_ref: 'consent-a',
    provider_profile_id: 'speech-cloud', provider: 'speech-cloud', provider_version: '2026-07',
    retention_until: '2026-08-23T00:00:00.000Z',
    audience_user_ids: ['participant-a']
  };
}

function speechEvent(
  type: RealtimeSpeechTranslationEvent['type'],
  overrides: Partial<RealtimeSpeechTranslationEvent> = {}
): RealtimeSpeechTranslationEvent {
  return {
    event_id: 'event-partial-a', type, provider_session_id: 'provider-session-a',
    sequence: 1, occurred_at: '2026-07-23T00:00:01.000Z', segment_id: 'segment-a',
    speaker_id: 'customer-a', source_language: 'zh-CN', target_language: '',
    source_text: '', translated_text: '', confidence: 0.98, start_ms: 0, end_ms: 900,
    provider_request_id: 'provider-request-a', latency_ms: { final: 120 },
    safe_metadata: { region: 'test' }, final: false,
    ...overrides
  };
}

function segmentInput(): Parameters<RealtimeSpeechStorePort['upsertFinal']>[0] {
  return {
    ...context(),
    source_event_id: 'event-final-a', provider_session_id: 'provider-session-a',
    sequence: 2, kind: 'transcript', segment_id: 'segment-a', speaker_id: 'customer-a',
    source_language: 'zh-CN', target_language: '', source_text: 'final customer words',
    translated_text: '', confidence: 0.98, start_ms: 0, end_ms: 900,
    provider_request_id: 'provider-request-a', latency_ms: { final: 120 },
    safe_metadata: { region: 'test' }, occurred_at: '2026-07-23T00:00:02.000Z'
  };
}

function segmentRow(): Record<string, unknown> {
  return {
    id: 'projection-a', ...segmentInput(), source_hash: 'a'.repeat(64),
    created_at: '2026-07-23T00:00:02.000Z'
  };
}

function projectedSegment(
  input: Parameters<RealtimeSpeechStorePort['upsertFinal']>[0]
): RealtimeSpeechFinalSegment {
  return {
    id: 'projection-a', ...input, created_at: input.occurred_at
  };
}

function jwtHeaders(tenantId: string, identity: string): Record<string, string> {
  return {
    Authorization: `Bearer ${signAccessToken({ sub: identity, tid: tenantId, role: 'operator' })}`
  };
}

function hasStatus(expected: number) {
  return (error: unknown) => {
    assert.equal((error as { status?: number }).status, expected);
    return true;
  };
}
