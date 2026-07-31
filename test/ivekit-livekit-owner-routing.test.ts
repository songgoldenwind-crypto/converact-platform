import assert from 'node:assert/strict';
import test from 'node:test';

import { createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import {
  LiveKitModerationService,
  type LiveKitModerationProvider
} from '../src/agent-runtime/livekit/livekit-moderation-service.js';
import {
  MediaCallService,
  type MediaCallPlacementPort
} from '../src/agent-runtime/livekit/media-call-service.js';
import { MediaCallStore } from '../src/agent-runtime/livekit/media-call-store.js';
import { LiveKitRecordingService } from '../src/agent-runtime/livekit/recording-service.js';
import {
  liveKitConfigForPlacement,
  type LiveKitPlacementContext
} from '../src/agent-runtime/livekit/token-service.js';
import { createTenant } from '../src/platform/tenant-core.js';

const PLACEMENT: LiveKitPlacementContext = {
  interaction_id: 'mcall-livekit-a',
  reservation_id: 'reservation-livekit-a',
  region_id: 'region-a',
  zone_id: 'zone-a',
  cell_id: 'cell-a',
  owner_node_id: 'livekit-a',
  owner_epoch: '12884901889',
  profile_id: 'cell-10k-v1',
  snapshot_version: 9,
  livekit_url: 'wss://livekit-a.internal:7880'
};

test('LiveKit owner placement preserves credentials and selects its admin endpoint', () => {
  assert.deepEqual(
    liveKitConfigForPlacement({
      url: 'ws://livekit-global:7880',
      publicUrl: 'wss://livekit.example.com',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
      sipBridgeTarget: 'sip:bridge@livekit-sip:5060',
      webhookApiKey: 'api-key',
      nodeEnv: 'production'
    }, PLACEMENT),
    {
      url: 'https://livekit-a.internal:7880',
      publicUrl: 'wss://livekit-a.internal:7880',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
      sipBridgeTarget: 'sip:bridge@livekit-sip:5060',
      webhookApiKey: 'api-key',
      nodeEnv: 'production'
    }
  );
});

test('LiveKit Egress start and stop resolve the durable media-call owner', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit owner recording' });
  const resolved: string[] = [];
  const clientUrls: string[] = [];
  const service = new LiveKitRecordingService(
    db,
    {
      livekitUrl: 'ws://livekit-global:7880',
      livekitApiKey: 'api-key',
      livekitApiSecret: 'api-secret',
      minioBucket: 'recordings'
    },
    {
      async resolveLiveKitConfig(input, base) {
        resolved.push(`${input.tenant_id}:${input.media_call_id}:${input.room_name}`);
        return liveKitConfigForPlacement(base, PLACEMENT);
      },
      createEgressClient(config) {
        clientUrls.push(String(config.url));
        return {
          async startRoomCompositeEgress() {
            return { egressId: 'EG_owner_a' };
          },
          async stopEgress() {}
        };
      }
    }
  );

  try {
    const recording = await service.startRecording(
      tenant.id,
      null,
      'room-owner-a',
      {
        mediaCallId: 'mcall_owner_a',
        businessRef: {
          tenant_id: tenant.id,
          type: 'service_order',
          id: 'order-owner-a'
        }
      }
    );
    await service.stopRecording(recording.egress_id);

    assert.deepEqual(resolved, [
      `${tenant.id}:mcall_owner_a:room-owner-a`,
      `${tenant.id}:mcall_owner_a:room-owner-a`
    ]);
    assert.deepEqual(clientUrls, [
      'https://livekit-a.internal:7880',
      'https://livekit-a.internal:7880'
    ]);
  } finally {
    db.close();
  }
});

test('LiveKit moderation resolves the provider from the media-call owner', async () => {
  const pg = new MemoryPg();
  const store = new MediaCallStore(pg);
  const call = await store.insertCall({
    id: 'mcall_owner_moderation',
    tenant_id: 'tenant-owner-moderation',
    room_name: 'room-owner-moderation',
    media: 'video',
    initiated_by: 'host-owner',
    business_ref: {
      tenant_id: 'tenant-owner-moderation',
      type: 'service_order',
      id: 'order-owner-moderation',
      metadata: {}
    },
    title: '',
    metadata: {},
    ring_timeout_seconds: 30
  });
  await store.insertParticipant({
    tenant_id: call.tenant_id,
    call_id: call.id,
    identity: 'host-owner',
    role: 'host',
    status: 'joined'
  });
  await store.insertParticipant({
    tenant_id: call.tenant_id,
    call_id: call.id,
    identity: 'guest-owner',
    role: 'participant',
    status: 'joined'
  });
  await store.updateCall({
    ...call,
    status: 'active',
    accepted_at: new Date().toISOString(),
    started_at: new Date().toISOString()
  });
  const resolved: string[] = [];
  const operations: string[] = [];
  const provider: LiveKitModerationProvider = {
    async mutePublishedTrack(roomName, identity) {
      operations.push(`mute:${roomName}:${identity}`);
    },
    async removeParticipant() {},
    async closeRoom() {}
  };
  const service = new LiveKitModerationService(
    store,
    async (context) => {
      resolved.push(`${context.tenant_id}:${context.call_id}:${context.room_name}`);
      return provider;
    }
  );

  await service.mute({
    tenant_id: call.tenant_id,
    room_name: call.room_name,
    participant_identity: 'guest-owner',
    actor_identity: 'host-owner',
    idempotency_key: 'mute-owner-a',
    track_sid: 'TR_OWNER_A',
    source: 'microphone',
    muted: true
  });

  assert.deepEqual(resolved, [
    `${call.tenant_id}:${call.id}:${call.room_name}`
  ]);
  assert.deepEqual(operations, [
    `mute:${call.room_name}:guest-owner`
  ]);
});

test('PSTN LiveKit bridge reserves and activates the media owner exactly once', async () => {
  const pg = new MemoryPg();
  const events: string[] = [];
  const placement = placementFixture(events);
  const service = new MediaCallService(new MediaCallStore(pg), {
    placement,
    placementWorkerId: 'voice-bridge-owner-test'
  });
  const input = {
    tenant_id: 'tenant-voice-owner',
    voice_call_id: 'vcall-owner-a',
    initiated_by: 'agent-owner',
    participant_identity: 'voice-sip-owner',
    idempotency_key: 'bridge-owner-a',
    business_ref: {
      tenant_id: 'tenant-voice-owner',
      type: 'service_order',
      id: 'order-owner-a',
      metadata: {}
    }
  };

  const first = await service.ensureVoiceBridge(input);
  const replay = await service.ensureVoiceBridge(input);

  assert.deepEqual(replay, first);
  assert.deepEqual(events, [
    `reserve:${first.media_call_id}`,
    `persist:${first.media_call_id}`,
    `state:active:${first.media_call_id}`,
    `reconcile:${first.media_call_id}:voice-bridge-owner-test`
  ]);
});

test('PSTN bridge never releases a reservation after durable placement persistence', async () => {
  const events: string[] = [];
  const service = new MediaCallService(new MediaCallStore(new MemoryPg()), {
    placement: placementFixture(events, { failReconcile: true }),
    placementWorkerId: 'voice-bridge-owner-test'
  });

  await assert.rejects(
    () => service.ensureVoiceBridge({
      tenant_id: 'tenant-voice-owner-failure',
      voice_call_id: 'vcall-owner-failure',
      initiated_by: 'agent-owner',
      participant_identity: 'voice-sip-owner',
      idempotency_key: 'bridge-owner-failure',
      business_ref: {
        tenant_id: 'tenant-voice-owner-failure',
        type: 'service_order',
        id: 'order-owner-failure',
        metadata: {}
      }
    }),
    /controlled placement reconcile failure/
  );

  assert.equal(events.some((event) => event.startsWith('release:')), false);
});

function placementFixture(
  events: string[],
  options: { failReconcile?: boolean } = {}
): MediaCallPlacementPort {
  return {
    async reserve(input) {
      events.push(`reserve:${input.interaction_id}`);
      return {
        interaction_id: input.interaction_id,
        value: { interaction_id: input.interaction_id }
      };
    },
    async persistReserved(_pg, reservation) {
      events.push(`persist:${reservation.interaction_id}`);
    },
    async releaseUncommitted(reservation) {
      events.push(`release:${reservation.interaction_id}`);
    },
    async requestState(_pg, input) {
      events.push(`state:${input.desired_state}:${input.interaction_id}`);
    },
    async reconcileOne(input) {
      events.push(`reconcile:${input.interaction_id}:${input.worker_id}`);
      if (options.failReconcile) {
        throw new Error('controlled placement reconcile failure');
      }
      return { outcome: 'succeeded' };
    },
    async resolveOwner() {
      return PLACEMENT;
    }
  };
}
