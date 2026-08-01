import assert from 'node:assert/strict';
import test from 'node:test';

import { routeConveractFabricMediaApi } from '../src/agent-runtime/converact/media-http.js';
import type {
  CreateRealtimeAudioTapGrantInput,
  RealtimeAudioTapGrant
} from '../src/agent-runtime/converact/voice/realtime-audio-tap-grant.js';
import { MediaCallService } from '../src/agent-runtime/livekit/media-call-service.js';
import { MediaCallStore } from '../src/agent-runtime/livekit/media-call-store.js';
import { createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken, type AuthRole } from '../src/middleware/auth.js';

const JWT_SECRET = 'converact-livekit-audio-tap-api-secret-32-bytes';

test('media call host controls consent-scoped LiveKit audio tap grants', async () => {
  const previousSecret = process.env.CONVERACT_JWT_SECRET;
  process.env.CONVERACT_JWT_SECRET = JWT_SECRET;
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const calls = new MediaCallService(new MediaCallStore(pg));
  const snapshot = await activeCall(calls);
  const grantInputs: CreateRealtimeAudioTapGrantInput[] = [];
  const revokeInputs: Record<string, unknown>[] = [];
  const grant = audioTapGrant(snapshot.call.id, snapshot.call.room_name);
  const grants = {
    async grant(input: CreateRealtimeAudioTapGrantInput) {
      grantInputs.push(structuredClone(input));
      return { grant, replayed: false };
    },
    async list(input: Record<string, unknown>) {
      assert.deepEqual(input, {
        tenant_id: 'tenant-a',
        interaction_id: snapshot.call.id,
        limit: 25,
        cursor: ''
      });
      return { items: [grant], next_cursor: null };
    },
    async revoke(input: Record<string, unknown>) {
      revokeInputs.push(structuredClone(input));
      return {
        ...grant,
        status: 'revoked' as const,
        revision: 2,
        revoked_by: 'host-a',
        revocation_reason: 'customer withdrew consent'
      };
    }
  };
  const options = {
    pg,
    realtime_audio_tap_grants: grants
  } as never;

  try {
    const created = await mediaRoute(
      db,
      'POST',
      `/api/ivekit/media/calls/${snapshot.call.id}/realtime-audio-tap-grants`,
      {
        purpose: 'live_translation',
        consent_ref: 'consent-livekit-a',
        source_language: 'en',
        target_languages: ['zh-CN'],
        features: ['streaming_asr', 'streaming_translation'],
        tracks: [
          { media_source: 'livekit', participant_id: 'host-a', track_id: '*' },
          { media_source: 'livekit', participant_id: 'customer-a', track_id: '*' }
        ],
        expires_at: '2026-07-23T05:30:00.000Z'
      },
      {
        ...jwtHeaders('host-a', 'operator'),
        'Idempotency-Key': 'grant-livekit-call-a'
      },
      options
    ) as { status: number; data: { grant: RealtimeAudioTapGrant; replayed: boolean } };

    assert.equal(created.status, 201);
    assert.equal(created.data.grant.id, 'grant-livekit-a');
    assert.equal(created.data.replayed, false);
    assert.deepEqual(grantInputs, [{
      tenant_id: 'tenant-a',
      interaction_id: snapshot.call.id,
      media_session_id: snapshot.call.room_name,
      purpose: 'live_translation',
      consent_ref: 'consent-livekit-a',
      source_language: 'en',
      target_languages: ['zh-CN'],
      features: ['streaming_asr', 'streaming_translation'],
      tracks: [
        { media_source: 'livekit', participant_id: 'host-a', track_id: '*' },
        { media_source: 'livekit', participant_id: 'customer-a', track_id: '*' }
      ],
      expires_at: '2026-07-23T05:30:00.000Z',
      actor: 'host-a',
      idempotency_key: 'grant-livekit-call-a'
    }]);

    const page = await mediaRoute(
      db,
      'GET',
      `/api/ivekit/media/calls/${snapshot.call.id}/realtime-audio-tap-grants?limit=25`,
      null,
      jwtHeaders('host-a', 'operator'),
      options
    ) as { data: { items: RealtimeAudioTapGrant[] } };
    assert.equal(page.data.items[0]?.id, 'grant-livekit-a');

    const revoked = await mediaRoute(
      db,
      'POST',
      `/api/ivekit/media/calls/${snapshot.call.id}/realtime-audio-tap-grants/grant-livekit-a/revoke`,
      { revision: 1, reason: 'customer withdrew consent' },
      jwtHeaders('host-a', 'operator'),
      options
    ) as { data: RealtimeAudioTapGrant };
    assert.equal(revoked.data.status, 'revoked');
    assert.deepEqual(revokeInputs, [{
      tenant_id: 'tenant-a',
      interaction_id: snapshot.call.id,
      grant_id: 'grant-livekit-a',
      expected_revision: 1,
      actor: 'host-a',
      reason: 'customer withdrew consent'
    }]);

    await assert.rejects(
      () => mediaRoute(
        db,
        'POST',
        `/api/ivekit/media/calls/${snapshot.call.id}/realtime-audio-tap-grants`,
        {
          purpose: 'live_captions',
          consent_ref: 'consent-outsider',
          source_language: 'en',
          target_languages: [],
          features: ['streaming_asr'],
          tracks: [
            { media_source: 'livekit', participant_id: 'outsider-a', track_id: '*' }
          ],
          expires_at: '2026-07-23T05:30:00.000Z'
        },
        {
          ...jwtHeaders('host-a', 'operator'),
          'Idempotency-Key': 'grant-outsider'
        },
        options
      ),
      hasStatus(422)
    );
    await assert.rejects(
      () => mediaRoute(
        db,
        'GET',
        `/api/ivekit/media/calls/${snapshot.call.id}/realtime-audio-tap-grants`,
        null,
        jwtHeaders('customer-a', 'operator'),
        options
      ),
      hasStatus(403)
    );
  } finally {
    db.close();
    restoreEnv('CONVERACT_JWT_SECRET', previousSecret);
  }
});

test('system worker receives a one-track token only for an active call participant', async () => {
  const previousSecret = process.env.CONVERACT_JWT_SECRET;
  process.env.CONVERACT_JWT_SECRET = JWT_SECRET;
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const calls = new MediaCallService(new MediaCallStore(pg));
  const snapshot = await activeCall(calls);
  const authorizations: Record<string, unknown>[] = [];
  const options = {
    pg,
    livekit_realtime_audio_tap_authorizer: {
      async authorize(input: Record<string, unknown>) {
        authorizations.push(structuredClone(input));
        return input.participant_id === 'customer-a' ? 'signed-track-token' : null;
      }
    },
    livekit_realtime_audio_tap_gateway_url:
      'ws://ivekit-internal:3000/api/ivekit/realtime-audio-tap/livekit'
  } as never;

  try {
    const authorized = await mediaRoute(
      db,
      'POST',
      `/api/ivekit/media/calls/${snapshot.call.id}/realtime-audio-tap-authorizations`,
      { participant_id: 'customer-a', track_id: 'TR_customer_microphone' },
      jwtHeaders('livekit-worker-a', 'system'),
      options
    ) as {
      status: number;
      data: {
        token: string;
        gateway_url: string;
        protocol: string;
        audio: { encoding: string; sample_rate: number; channels: number };
      };
    };

    assert.equal(authorized.status, 201);
    assert.equal(authorized.data.token, 'signed-track-token');
    assert.equal(
      authorized.data.gateway_url,
      'ws://ivekit-internal:3000/api/ivekit/realtime-audio-tap/livekit'
    );
    assert.equal(authorized.data.protocol, 'ivekit.livekit-audio-tap.v1');
    assert.deepEqual(authorized.data.audio, {
      encoding: 'pcm_s16le',
      sample_rate: 16_000,
      channels: 1
    });
    assert.deepEqual(authorizations, [{
      tenant_id: 'tenant-a',
      interaction_id: snapshot.call.id,
      media_session_id: snapshot.call.room_name,
      participant_id: 'customer-a',
      track_id: 'TR_customer_microphone'
    }]);

    await assert.rejects(
      () => mediaRoute(
        db,
        'POST',
        `/api/ivekit/media/calls/${snapshot.call.id}/realtime-audio-tap-authorizations`,
        { participant_id: 'customer-a', track_id: 'TR_customer_microphone' },
        jwtHeaders('host-a', 'operator'),
        options
      ),
      hasStatus(403)
    );
    await assert.rejects(
      () => mediaRoute(
        db,
        'POST',
        `/api/ivekit/media/calls/${snapshot.call.id}/realtime-audio-tap-authorizations`,
        { participant_id: 'outsider-a', track_id: 'TR_outsider_microphone' },
        jwtHeaders('livekit-worker-a', 'system'),
        options
      ),
      hasStatus(404)
    );

    await calls.transition({
      tenant_id: 'tenant-a',
      call_id: snapshot.call.id,
      action: 'end',
      actor_identity: 'host-a',
      idempotency_key: 'end-media-call-a'
    });
    await assert.rejects(
      () => mediaRoute(
        db,
        'POST',
        `/api/ivekit/media/calls/${snapshot.call.id}/realtime-audio-tap-authorizations`,
        { participant_id: 'customer-a', track_id: 'TR_customer_microphone' },
        jwtHeaders('livekit-worker-a', 'system'),
        options
      ),
      hasStatus(409)
    );
  } finally {
    db.close();
    restoreEnv('CONVERACT_JWT_SECRET', previousSecret);
  }
});

async function activeCall(service: MediaCallService) {
  const created = await service.createCall({
    tenant_id: 'tenant-a',
    call_id: 'media-call-a',
    initiated_by: 'host-a',
    media: 'video',
    participant_identities: ['customer-a'],
    business_ref: {
      tenant_id: 'tenant-a',
      type: 'service_order',
      id: 'SO-A',
      metadata: {}
    }
  });
  await service.transition({
    tenant_id: 'tenant-a',
    call_id: created.call.id,
    action: 'ring',
    actor_identity: 'host-a',
    idempotency_key: 'ring-media-call-a'
  });
  await service.transition({
    tenant_id: 'tenant-a',
    call_id: created.call.id,
    action: 'accept',
    actor_identity: 'customer-a',
    idempotency_key: 'accept-media-call-a'
  });
  return (await service.transition({
    tenant_id: 'tenant-a',
    call_id: created.call.id,
    action: 'activate',
    actor_identity: 'host-a',
    idempotency_key: 'activate-media-call-a'
  })).snapshot;
}

function audioTapGrant(
  interactionId: string,
  mediaSessionId: string
): RealtimeAudioTapGrant {
  return {
    id: 'grant-livekit-a',
    tenant_id: 'tenant-a',
    interaction_id: interactionId,
    media_session_id: mediaSessionId,
    purpose: 'live_translation',
    consent_ref: 'consent-livekit-a',
    source_language: 'en',
    target_languages: ['zh-CN'],
    features: ['streaming_asr', 'streaming_translation'],
    tracks: [
      { media_source: 'livekit', participant_id: 'host-a', track_id: '*' },
      { media_source: 'livekit', participant_id: 'customer-a', track_id: '*' }
    ],
    status: 'active',
    expires_at: '2026-07-23T05:30:00.000Z',
    request_hash: 'hash-a',
    idempotency_key: 'grant-livekit-call-a',
    created_by: 'host-a',
    revoked_by: '',
    revocation_reason: '',
    revision: 1,
    created_at: '2026-07-23T05:00:00.000Z',
    updated_at: '2026-07-23T05:00:00.000Z',
    revoked_at: null
  };
}

function mediaRoute(
  db: unknown,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  options: never
) {
  const url = new URL(`http://localhost${path}`);
  return routeConveractFabricMediaApi(
    db,
    method,
    url.pathname,
    url,
    body,
    '',
    headers,
    options
  );
}

function jwtHeaders(identity: string, role: AuthRole): Record<string, string> {
  return {
    Authorization: `Bearer ${signAccessToken({
      sub: identity,
      tid: 'tenant-a',
      role
    })}`
  };
}

function hasStatus(expected: number) {
  return (error: unknown) => {
    assert.equal((error as { status?: number }).status, expected);
    return true;
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
