import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  LiveKitRealtimeAudioTapGrantAuthorizer,
  RealtimeAudioTapGrantAuthorizer,
  RealtimeAudioTapGrantService,
  type RealtimeAudioTapGrant,
  type RealtimeAudioTapGrantRepository
} from '../src/agent-runtime/ivekit/voice/realtime-audio-tap-grant.js';
import {
  createLiveKitRealtimeAudioTapTokenCodec
} from '../src/agent-runtime/ivekit/voice/livekit-realtime-audio-tap-token.js';
import { createRealtimeAudioTapTokenCodec } from '../src/agent-runtime/ivekit/voice/realtime-audio-tap-token.js';

const NOW = new Date('2026-07-23T04:00:00.000Z');

test('realtime audio tap grant service creates an explicit consent-scoped grant', async () => {
  const repository = new MemoryGrantRepository();
  const service = new RealtimeAudioTapGrantService({
    repository,
    now: () => NOW,
    id: () => 'tap-grant-a'
  });
  const result = await service.grant({
    tenant_id: 'tenant-a',
    interaction_id: 'call-a',
    media_session_id: 'sip-call-a',
    purpose: 'live_translation',
    consent_ref: 'consent-a',
    source_language: 'zh-CN',
    target_languages: ['en-US'],
    features: ['streaming_asr', 'streaming_translation', 'word_timestamps'],
    tracks: [
      { leg: 'caller', participant_id: 'customer-a', track_id: 'call-a:caller' },
      { leg: 'callee', participant_id: 'agent-a', track_id: 'call-a:callee' }
    ],
    expires_at: '2026-07-23T04:30:00.000Z',
    actor: 'operator-a',
    idempotency_key: 'grant-call-a'
  });

  assert.equal(result.replayed, false);
  assert.equal(result.grant.id, 'tap-grant-a');
  assert.equal(result.grant.status, 'active');
  assert.equal(result.grant.consent_ref, 'consent-a');
  assert.equal(result.grant.request_hash.length, 64);
  assert.deepEqual(result.grant.target_languages, ['en-US']);
  assert.deepEqual(result.grant.features, [
    'streaming_asr',
    'streaming_translation',
    'word_timestamps'
  ]);
});

test('realtime audio tap grant rejects implicit consent and invalid translation scope', async () => {
  const service = new RealtimeAudioTapGrantService({
    repository: new MemoryGrantRepository(),
    now: () => NOW
  });
  const base = {
    tenant_id: 'tenant-a',
    interaction_id: 'call-a',
    media_session_id: 'sip-call-a',
    purpose: 'live_translation' as const,
    consent_ref: 'consent-a',
    source_language: 'zh',
    target_languages: ['en'],
    features: ['streaming_asr', 'streaming_translation'] as const,
    tracks: [
      { leg: 'caller' as const, participant_id: 'customer-a', track_id: 'call-a:caller' }
    ],
    expires_at: '2026-07-23T04:30:00.000Z',
    actor: 'operator-a',
    idempotency_key: 'grant-call-a'
  };

  await assert.rejects(
    () => service.grant({ ...base, consent_ref: '' }),
    /audio_tap_grant_invalid/
  );
  await assert.rejects(
    () => service.grant({
      ...base,
      target_languages: [],
      features: ['streaming_asr']
    }),
    /audio_tap_grant_invalid/
  );
});

test('grant authorizer issues a short token only for the exact active media session', async () => {
  const repository = new MemoryGrantRepository();
  const service = new RealtimeAudioTapGrantService({
    repository,
    now: () => NOW,
    id: () => 'tap-grant-a'
  });
  await service.grant({
    tenant_id: 'tenant-a',
    interaction_id: 'call-a',
    media_session_id: 'sip-call-a',
    purpose: 'live_captions',
    consent_ref: 'consent-a',
    source_language: 'zh',
    target_languages: [],
    features: ['streaming_asr'],
    tracks: [
      { leg: 'caller', participant_id: 'customer-a', track_id: 'call-a:caller' }
    ],
    expires_at: '2026-07-23T04:30:00.000Z',
    actor: 'operator-a',
    idempotency_key: 'grant-call-a'
  });
  const codec = createRealtimeAudioTapTokenCodec({
    secret: Buffer.alloc(32, 9),
    now: () => NOW,
    nonce: () => 'grant-nonce-00000000001',
    ttl_seconds: 60
  });
  const authorizer = new RealtimeAudioTapGrantAuthorizer({
    repository,
    token_codec: codec,
    now: () => NOW
  });

  const token = await authorizer.authorize({
    tenant_id: 'tenant-a',
    interaction_id: 'call-a',
    media_session_id: 'sip-call-a'
  });
  assert.ok(token);
  const claims = codec.verify(token!, { expected_media_session_id: 'sip-call-a' });
  assert.equal(claims.consent_ref, 'consent-a');
  assert.equal(claims.purpose, 'live_captions');
  assert.equal(await authorizer.authorize({
    tenant_id: 'tenant-a',
    interaction_id: 'call-a',
    media_session_id: 'another-session'
  }), null);
});

test('LiveKit grant authorizer binds a short token to one consented participant track', async () => {
  const repository = new MemoryGrantRepository();
  const service = new RealtimeAudioTapGrantService({
    repository,
    now: () => NOW,
    id: () => 'tap-grant-livekit'
  });
  await service.grant({
    tenant_id: 'tenant-a',
    interaction_id: 'media-call-a',
    media_session_id: 'room-a',
    purpose: 'live_translation',
    consent_ref: 'consent-livekit',
    source_language: 'en',
    target_languages: ['zh-CN'],
    features: ['streaming_asr', 'streaming_translation'],
    tracks: [
      {
        media_source: 'livekit',
        participant_id: 'customer-a',
        track_id: '*'
      },
      {
        media_source: 'livekit',
        participant_id: 'agent-a',
        track_id: 'agent-microphone'
      }
    ],
    expires_at: '2026-07-23T04:30:00.000Z',
    actor: 'operator-a',
    idempotency_key: 'grant-media-call-a'
  });
  const codec = createLiveKitRealtimeAudioTapTokenCodec({
    secret: Buffer.alloc(32, 7),
    now: () => NOW,
    nonce: () => 'livekit-grant-nonce-0001',
    ttl_seconds: 45
  });
  const authorizer = new LiveKitRealtimeAudioTapGrantAuthorizer({
    repository,
    token_codec: codec,
    now: () => NOW
  });

  const token = await authorizer.authorize({
    tenant_id: 'tenant-a',
    interaction_id: 'media-call-a',
    media_session_id: 'room-a',
    participant_id: 'customer-a',
    track_id: 'customer-microphone'
  });
  assert.ok(token);
  const claims = codec.verify(token!, {
    expected_media_session_id: 'room-a',
    expected_participant_id: 'customer-a',
    expected_track_id: 'customer-microphone'
  });
  assert.equal(claims.consent_ref, 'consent-livekit');
  assert.deepEqual(claims.audience_user_ids, ['agent-a', 'customer-a']);
  assert.equal(await authorizer.authorize({
    tenant_id: 'tenant-a',
    interaction_id: 'media-call-a',
    media_session_id: 'room-a',
    participant_id: 'observer-a',
    track_id: 'observer-microphone'
  }), null);
  assert.equal(await authorizer.authorize({
    tenant_id: 'tenant-a',
    interaction_id: 'media-call-a',
    media_session_id: 'room-a',
    participant_id: 'agent-a',
    track_id: 'different-track'
  }), null);
});

test('realtime audio tap grant migration enforces expiry, one active session and RLS', async () => {
  const sql = await readFile(
    new URL('../src/migrations/099_ivekit_realtime_audio_tap_grants.sql', import.meta.url),
    'utf8'
  );
  assert.match(sql, /ivekit_realtime_audio_tap_grants/);
  assert.match(sql, /expires_at > created_at/);
  assert.match(sql, /WHERE status = 'active'/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /opc_current_tenant\(\)/);
  assert.doesNotMatch(sql, /sqlite/i);
});

class MemoryGrantRepository implements RealtimeAudioTapGrantRepository {
  readonly grants: RealtimeAudioTapGrant[] = [];

  async replaceActive(grant: RealtimeAudioTapGrant) {
    const replay = this.grants.find((candidate) =>
      candidate.tenant_id === grant.tenant_id &&
      candidate.idempotency_key === grant.idempotency_key
    );
    if (replay) return { grant: structuredClone(replay), replayed: true };
    for (const candidate of this.grants) {
      if (candidate.tenant_id === grant.tenant_id &&
          candidate.media_session_id === grant.media_session_id &&
          candidate.status === 'active') {
        candidate.status = 'revoked';
        candidate.revocation_reason = 'superseded';
      }
    }
    this.grants.push(structuredClone(grant));
    return { grant: structuredClone(grant), replayed: false };
  }

  async findActive(input: {
    tenant_id: string;
    interaction_id: string;
    media_session_id: string;
    now: string;
  }): Promise<RealtimeAudioTapGrant | null> {
    return structuredClone(this.grants.find((grant) =>
      grant.tenant_id === input.tenant_id &&
      grant.interaction_id === input.interaction_id &&
      grant.media_session_id === input.media_session_id &&
      grant.status === 'active' &&
      grant.expires_at > input.now
    ) || null);
  }

  async list(input: {
    tenant_id: string;
    interaction_id: string;
    limit: number;
    cursor: string;
  }) {
    const items = this.grants.filter((grant) =>
      grant.tenant_id === input.tenant_id &&
      grant.interaction_id === input.interaction_id &&
      (!input.cursor || grant.id < input.cursor)
    ).slice(0, input.limit).map((grant) => structuredClone(grant));
    return {
      items,
      next_cursor: items.length === input.limit ? items.at(-1)?.id || null : null
    };
  }

  async revoke(): Promise<RealtimeAudioTapGrant | null> {
    return null;
  }
}
