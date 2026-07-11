import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { EgressManager } from '../src/agent-runtime/call-center/egress-manager.js';
import { createLiveKitMediaModule } from '../src/agent-runtime/livekit/index.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { getPgTenantContext } from '../src/db-pg-tenant.js';

test('createLiveKitMediaModule exposes reusable media capabilities', async () => {
  const db = createDatabase(':memory:');
  let participantJoined = '';
  const media = createLiveKitMediaModule({
    db,
    participantEvents: {
      notifyParticipantJoined(roomName, identity) {
        participantJoined = `${roomName}:${identity}`;
      }
    }
  });

  assert.equal(typeof media.rooms.createRoom, 'function');
  assert.equal(typeof media.tokens.issueParticipantToken, 'function');
  assert.equal(typeof media.tokens.issueSupervisorToken, 'function');
  assert.equal(typeof media.joins.prepareJoin, 'function');
  assert.equal(typeof media.recordings.startRecording, 'function');
  assert.equal(typeof media.participants.listByRoom, 'function');
  assert.equal(typeof media.dispatch.dispatchAiAgent, 'function');
  assert.equal(typeof media.webhooks.handleWebhook, 'function');
  assert.ok(media.gateways.has('webrtc'));

  await media.webhooks.handleWebhook(
    JSON.stringify({
      event: 'participant_joined',
      room: { name: 'room-events' },
      participant: { identity: 'agent_1' }
    })
  );
  assert.equal(participantJoined, 'room-events:agent_1');

  db.close();
});

test('signed LiveKit webhook processing derives the RLS tenant from room metadata', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit webhook RLS context' });
  let callbackTenant = '';
  const media = createLiveKitMediaModule({
    db,
    participantEvents: {
      notifyParticipantJoined() {
        callbackTenant = getPgTenantContext().tenantId || '';
      }
    }
  });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'livekit-webhook-rls-room'
  });

  await media.webhooks.handleWebhook(JSON.stringify({
    event: 'participant_joined',
    room: {
      name: room.room_name,
      metadata: JSON.stringify({ tenant_id: tenant.id, purpose: 'video_service' })
    },
    participant: { identity: 'customer_rls', metadata: JSON.stringify({ role: 'customer' }) }
  }));

  assert.equal(callbackTenant, tenant.id);
  assert.equal(getPgTenantContext().tenantId, undefined);
  db.close();
});

test('media module tracks participant lifecycle from LiveKit webhooks', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Participants Test' });
  const media = createLiveKitMediaModule({ db });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'tenant_media-participants-demo'
  });

  await media.webhooks.handleWebhook(
    JSON.stringify({
      event: 'participant_joined',
      room: { name: room.room_name },
      participant: {
        identity: 'customer_1',
        metadata: JSON.stringify({ role: 'customer', display_name: 'Customer One' })
      }
    })
  );
  const joined = media.participants.getParticipant(room.room_name, 'customer_1');
  assert.equal(joined?.tenant_id, tenant.id);
  assert.equal(joined?.role, 'customer');
  assert.equal(joined?.status, 'joined');
  assert.equal(joined?.metadata.display_name, 'Customer One');

  await media.webhooks.handleWebhook(
    JSON.stringify({
      event: 'participant_left',
      room: { name: room.room_name },
      participant: { identity: 'customer_1' }
    })
  );
  const left = media.participants.getParticipant(room.room_name, 'customer_1');
  assert.equal(left?.status, 'left');
  assert.equal(left?.left_at != null, true);
  assert.equal(media.participants.listByRoom(room.room_name, { includeLeft: true }).length, 1);
  assert.equal(media.participants.listByRoom(room.room_name).length, 0);

  db.close();
});

test('media module marks joined participants left when room finishes', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Room Finished Participants' });
  const media = createLiveKitMediaModule({ db });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'tenant_media-room-finished-participants'
  });

  await media.webhooks.handleWebhook(
    JSON.stringify({
      event: 'participant_joined',
      room: { name: room.room_name },
      participant: {
        identity: 'agent_finish',
        metadata: JSON.stringify({ role: 'agent' })
      }
    })
  );
  await media.webhooks.handleWebhook(
    JSON.stringify({
      event: 'participant_joined',
      room: { name: room.room_name },
      participant: {
        identity: 'customer_finish',
        metadata: JSON.stringify({ role: 'customer' })
      }
    })
  );

  await media.webhooks.handleWebhook(
    JSON.stringify({
      event: 'room_finished',
      room: { name: room.room_name }
    })
  );

  assert.equal(media.rooms.getRoomByName(room.room_name)?.status, 'closed');
  assert.equal(media.participants.listByRoom(room.room_name).length, 0);
  assert.deepEqual(
    media
      .participants
      .listByRoom(room.room_name, { includeLeft: true })
      .map((participant) => [participant.identity, participant.status, participant.left_at != null])
      .sort(),
    [
      ['agent_finish', 'left', true],
      ['customer_finish', 'left', true]
    ]
  );

  db.close();
});

test('media module records participant_left even when the joined webhook was missed', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Missed Join Participant Left' });
  const media = createLiveKitMediaModule({ db });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'tenant_media-missed-join-left'
  });

  await media.webhooks.handleWebhook(
    JSON.stringify({
      event: 'participant_left',
      room: { name: room.room_name },
      participant: {
        identity: 'customer_missed_join',
        metadata: JSON.stringify({ role: 'customer', display_name: 'Late customer' })
      }
    })
  );

  const participant = media.participants.getParticipant(room.room_name, 'customer_missed_join');
  assert.equal(participant?.tenant_id, tenant.id);
  assert.equal(participant?.role, 'customer');
  assert.equal(participant?.status, 'left');
  assert.equal(participant?.metadata.display_name, 'Late customer');
  assert.equal(participant?.left_at != null, true);
  assert.equal(media.participants.listByRoom(room.room_name).length, 0);

  db.close();
});

test('media module preserves participant metadata when leave webhooks omit it', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Leave Metadata Preservation' });
  const media = createLiveKitMediaModule({ db });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'tenant_media-leave-metadata-preservation'
  });

  await media.webhooks.handleWebhook(
    JSON.stringify({
      event: 'participant_joined',
      room: { name: room.room_name },
      participant: {
        identity: 'external_user_1',
        metadata: JSON.stringify({ role: 'customer', display_name: 'Customer Preserved' })
      }
    })
  );

  await media.webhooks.handleWebhook(
    JSON.stringify({
      event: 'participant_left',
      room: { name: room.room_name },
      participant: { identity: 'external_user_1' }
    })
  );

  const participant = media.participants.getParticipant(room.room_name, 'external_user_1');
  assert.equal(participant?.status, 'left');
  assert.equal(participant?.role, 'customer');
  assert.equal(participant?.metadata.display_name, 'Customer Preserved');

  db.close();
});

test('media module ignores late LiveKit webhooks for closed rooms', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Closed Room Webhooks' });
  const notifications: string[] = [];
  const media = createLiveKitMediaModule({
    db,
    participantEvents: {
      notifyParticipantJoined(roomName, identity) {
        notifications.push(`${roomName}:${identity}`);
      }
    }
  });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'tenant_media-closed-webhook-room'
  });
  media.rooms.closeRoom(room.room_name);

  await media.webhooks.handleWebhook(
    JSON.stringify({
      event: 'room_started',
      room: { name: room.room_name, sid: 'late-room-sid' }
    })
  );
  assert.equal(media.rooms.getRoomByName(room.room_name)?.status, 'closed');

  await media.webhooks.handleWebhook(
    JSON.stringify({
      event: 'participant_joined',
      room: { name: room.room_name },
      participant: {
        identity: 'customer_late',
        metadata: JSON.stringify({ role: 'customer' })
      }
    })
  );
  assert.equal(media.participants.getParticipant(room.room_name, 'customer_late'), null);
  assert.deepEqual(notifications, []);

  db.close();
});

test('media module records egress webhooks for business ref rooms', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Egress BusinessRef Webhook' });
  const completed: Array<{ id: string; businessRefId: string; roomName: string }> = [];
  const media = createLiveKitMediaModule({
    db,
    recordingEvents: {
      notifyRecordingCompleted(recording, context) {
        completed.push({
          id: recording.id,
          businessRefId: recording.business_ref?.id || '',
          roomName: context.roomName
        });
      }
    }
  });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'tenant_media-egress-business-ref-room',
    metadata: {
      business_ref: {
        type: 'service_order',
        id: 'order-egress-webhook',
        display_name: 'LED egress webhook order',
        metadata: { project: 'led' }
      }
    }
  });

  const result = await media.webhooks.handleWebhook(
    JSON.stringify({
      event: 'egress_ended',
      room: { name: room.room_name },
      egressInfo: {
        egressId: 'egress-webhook-business-ref',
        fileResults: [
          {
            fileType: 'mp4',
            location: 's3://recordings/order-egress-webhook.mp4',
            duration: 120000,
            size: 2048
          }
        ]
      }
    })
  );

  assert.equal(result.recording?.business_ref?.type, 'service_order');
  assert.equal(result.recording?.business_ref?.id, 'order-egress-webhook');
  assert.equal(result.recording?.storage_url, 's3://recordings/order-egress-webhook.mp4');
  assert.equal(result.recording?.egress_id, 'egress-webhook-business-ref');
  assert.deepEqual(completed, [
    {
      id: result.recording?.id || '',
      businessRefId: 'order-egress-webhook',
      roomName: room.room_name
    }
  ]);
  db.close();
});

test('media module egress webhook updates existing recordings by egress id', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Egress Upsert' });
  const media = createLiveKitMediaModule({ db });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'tenant_media-egress-upsert-room',
    metadata: {
      business_ref: {
        type: 'service_order',
        id: 'order-egress-upsert'
      }
    }
  });
  const started = await media.recordings.startRecording(tenant.id, null, room.room_name, {
    format: 'mp4',
    hasVideo: true,
    businessRef: {
      tenant_id: tenant.id,
      type: 'service_order',
      id: 'order-egress-upsert'
    }
  });

  const result = await media.webhooks.handleWebhook(
    JSON.stringify({
      event: 'egress_ended',
      room: { name: room.room_name },
      egressInfo: {
        egressId: started.egress_id,
        fileResults: [
          {
            fileType: 'mp4',
            location: 's3://recordings/order-egress-upsert-final.mp4',
            duration: 3000,
            size: 8192
          }
        ]
      }
    })
  );

  assert.equal(result.recording?.id, started.id);
  assert.equal(result.recording?.storage_url, 's3://recordings/order-egress-upsert-final.mp4');
  assert.equal(result.recording?.duration_ms, 3000);
  assert.equal(result.recording?.file_size_bytes, 8192);
  assert.equal(media.recordings.listRecordings(tenant.id).length, 1);
  db.close();
});

test('media module blocks public media actions for closed rooms', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Closed Module Actions' });
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    status: 'active',
    phone: '+81300007777'
  });
  const media = createLiveKitMediaModule({ db });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    call_session_id: session.id,
    room_name: 'tenant_media-closed-module-actions'
  });
  media.rooms.closeRoom(room.room_name);

  await assert.rejects(
    () =>
      media.tokens.issueParticipantToken({
        room_name: room.room_name,
        identity: 'agent_after_close',
        role: 'agent',
        tenant_id: tenant.id
      }),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /room is closed/);
      return true;
    }
  );

  await assert.rejects(
    () =>
      media.tokens.issueSupervisorToken({
        room_name: room.room_name,
        identity: 'supervisor_after_close',
        mode: 'listen',
        tenant_id: tenant.id
      }),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /room is closed/);
      return true;
    }
  );

  await assert.rejects(
    () =>
      media.joins.prepareJoin('webrtc', {
        tenantId: tenant.id,
        roomName: room.room_name,
        identity: 'customer_after_close',
        role: 'customer',
        media: 'video'
      }),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /room is closed/);
      return true;
    }
  );

  await assert.rejects(
    () => media.dispatch.dispatchAiAgent(room.room_name, { tenant_id: tenant.id }, 'support-ai'),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /room is closed/);
      return true;
    }
  );

  await assert.rejects(
    () => media.recordings.startRecording(tenant.id, session.id, room.room_name, { format: 'mp4', hasVideo: true }),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /room is closed/);
      return true;
    }
  );

  db.close();
});

test('media module accepts injected LiveKit config for reuse outside OPC env', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Injected Config' });
  const media = createLiveKitMediaModule({
    db,
    config: {
      url: 'ws://livekit.injected.example',
      publicUrl: 'wss://media.injected.example',
      apiKey: null,
      apiSecret: null,
      sipBridgeTarget: 'sip:bridge@livekit.injected.example',
      webhookApiKey: null
    }
  });
  await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'room-injected-config'
  });

  const token = await media.tokens.issueParticipantToken({
    room_name: 'room-injected-config',
    identity: 'customer_injected',
    role: 'customer',
    tenant_id: tenant.id
  });

  assert.equal(token.configured, false);
  assert.equal(token.livekit_url, 'wss://media.injected.example');
  db.close();
});

test('media module starts recordings for arbitrary business refs without call sessions', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit BusinessRef Recording' });
  const media = createLiveKitMediaModule({ db });
  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'tenant_media-business-ref-recording',
    metadata: {
      business_ref: {
        type: 'service_order',
        id: 'order_video_1'
      }
    }
  });

  const recording = await media.recordings.startRecording(tenant.id, null, room.room_name, {
    format: 'webm',
    hasVideo: true,
    businessRef: {
      tenant_id: tenant.id,
      type: 'service_order',
      id: 'order_video_1',
      display_name: 'LED order #1',
      metadata: { project: 'led' }
    }
  });

  assert.equal(recording.call_session_id, '');
  assert.equal(recording.business_ref?.tenant_id, tenant.id);
  assert.equal(recording.business_ref?.type, 'service_order');
  assert.equal(recording.business_ref?.id, 'order_video_1');
  assert.equal(recording.business_ref?.display_name, 'LED order #1');
  assert.deepEqual(recording.business_ref?.metadata, { project: 'led' });
  assert.match(recording.storage_url, /service_order\/order_video_1/);

  const listed = media.recordings.listRecordings(tenant.id);
  assert.equal(listed[0]?.business_ref?.id, 'order_video_1');
  db.close();
});

test('media module keeps dev LiveKit behavior for rooms, tokens, joins, and recordings', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'LiveKit Media Test' });
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    status: 'active',
    phone: '+81300004444'
  });
  const compatSession = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    status: 'active',
    phone: '+81300005555'
  });
  const media = createLiveKitMediaModule({ db });

  const room = await media.rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    call_session_id: session.id,
    room_name: 'tenant_media-video_service-demo'
  });
  assert.equal(room.room_name, 'tenant_media-video_service-demo');
  assert.equal(room.purpose, 'video_service');

  const token = await media.tokens.issueParticipantToken({
    room_name: room.room_name,
    identity: 'agent_1',
    role: 'agent',
    tenant_id: tenant.id
  });
  assert.equal(token.configured, false);
  assert.equal(token.token, `dev-token:${room.room_name}:agent_1:agent`);

  const joinPlan = await media.joins.prepareJoin('webrtc', {
    tenantId: tenant.id,
    roomName: room.room_name,
    identity: 'customer_1',
    role: 'customer',
    media: 'video'
  });
  assert.equal(joinPlan.mode, 'webrtc');
  assert.equal(joinPlan.channel, 'webrtc');
  if (joinPlan.mode === 'webrtc') {
    assert.equal(
      joinPlan.joinPath,
      `/video?room=${encodeURIComponent(room.room_name)}&tenant_id=${encodeURIComponent(tenant.id)}`
    );
  }

  await assert.rejects(
    () =>
      media.joins.prepareJoin('sip_volte', {
        tenantId: tenant.id,
        roomName: room.room_name,
        identity: 'customer_2',
        role: 'customer',
        media: 'video'
      }),
    /not active/
  );

  const recording = await media.recordings.startRecording(tenant.id, session.id, room.room_name, {
    format: 'mp4',
    hasVideo: true
  });
  assert.equal(recording.tenant_id, tenant.id);
  assert.equal(recording.call_session_id, session.id);
  assert.equal(recording.format, 'mp4');
  assert.equal(recording.has_video, 1);

  const compat = new EgressManager(db, {
    livekitUrl: '',
    livekitApiKey: '',
    livekitApiSecret: ''
  });
  const compatRecording = await compat.startRecording(tenant.id, compatSession.id, room.room_name);
  assert.equal(compatRecording.source, 'livekit_egress');

  db.close();
});
