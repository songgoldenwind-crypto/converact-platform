import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDatabase, run } from '../src/db.js';
import { LiveKitRecordingService } from '../src/agent-runtime/livekit/recording-service.js';
import { createLiveKitMediaModule } from '../src/agent-runtime/livekit/index.js';
import { routeMediaApi } from '../src/agent-runtime/livekit/media-http.js';
import { LiveKitRoomStore } from '../src/agent-runtime/livekit/room-store.js';
import { createTenant } from '../src/platform/tenant-core.js';

const EGRESS_CONFIG = {
  livekitUrl: 'ws://livekit.example.test:7880',
  livekitApiKey: 'test-key',
  livekitApiSecret: 'test-secret',
  minioBucket: 'recordings'
};

test('legacy recording requests remain room composite', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Legacy Egress' });
  const calls: string[] = [];
  const service = new LiveKitRecordingService(db, EGRESS_CONFIG, {
    createEgressClient: () => ({
      async startRoomCompositeEgress() {
        calls.push('room_composite');
        return { egressId: 'EG_legacy' };
      },
      async startTrackCompositeEgress() {
        calls.push('track_composite');
        return { egressId: 'EG_unexpected' };
      },
      async startTrackEgress() {
        calls.push('track');
        return { egressId: 'EG_unexpected' };
      },
      async stopEgress() {}
    })
  });

  try {
    const recording = await service.startRecording(tenant.id, null, 'room-legacy', {
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-legacy' }
    });

    assert.equal(recording.recording_mode, 'room_composite');
    assert.deepEqual(calls, ['room_composite']);
    assert.equal(service.listEgressJobs(recording.id).length, 1);
  } finally {
    db.close();
  }
});

test('track recording creates one durable provider job per unique track', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Track Egress' });
  const starts: Array<{ trackId: string; filepath: string }> = [];
  const service = new LiveKitRecordingService(db, EGRESS_CONFIG, {
    createEgressClient: () => ({
      async startRoomCompositeEgress() {
        throw new Error('unexpected room composite');
      },
      async startTrackCompositeEgress() {
        throw new Error('unexpected track composite');
      },
      async startTrackEgress(_roomName, output, trackId) {
        const filepath = String((output as { filepath?: string }).filepath || '');
        starts.push({ trackId, filepath });
        return { egressId: `EG_${trackId}` };
      },
      async stopEgress() {}
    })
  });

  try {
    const recording = await service.startRecording(tenant.id, null, 'room-tracks', {
      format: 'webm',
      recordingMode: 'track',
      tracks: [
        { trackId: 'TR_audio', kind: 'audio', source: 'microphone' },
        { trackId: 'TR_video', kind: 'video', source: 'camera' }
      ],
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-tracks' }
    });
    const jobs = service.listEgressJobs(recording.id);

    assert.equal(recording.recording_mode, 'track');
    assert.equal(recording.egress_id, 'EG_TR_audio');
    assert.deepEqual(starts.map((entry) => entry.trackId), ['TR_audio', 'TR_video']);
    assert.ok(starts.every((entry) => entry.filepath.endsWith('.webm')));
    assert.notEqual(starts[0]?.filepath, starts[1]?.filepath);
    assert.deepEqual(jobs.map((job) => job.track_id), ['TR_audio', 'TR_video']);
    assert.deepEqual(jobs.map((job) => job.status), ['recording', 'recording']);
    assert.deepEqual(jobs.map((job) => job.egress_id), ['EG_TR_audio', 'EG_TR_video']);
  } finally {
    db.close();
  }
});

test('each provider job binds and activates an independent Egress Cell reservation', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Egress Cell Admission' });
  const reserved: string[] = [];
  const activated: string[] = [];
  const closed: string[] = [];
  const service = new LiveKitRecordingService(db, EGRESS_CONFIG, {
    createEgressClient: () => ({
      async startRoomCompositeEgress() { throw new Error('unexpected room composite'); },
      async startTrackEgress(_roomName, _output, trackId) { return { egressId: `EG_${trackId}` }; },
      async stopEgress() {}
    }),
    async reserveEgressJob(input) {
      reserved.push(`${input.job_id}:${input.recording_mode}`);
      return {
        job_id: input.job_id,
        reservation_id: `reservation-${input.job_id}`,
        owner_epoch: '12884901889',
        value: { job_id: input.job_id }
      };
    },
    async activateEgressJob(reservation) {
      activated.push(reservation.job_id);
    },
    async closeEgressJob(reservation) {
      closed.push(reservation.job_id);
    }
  });

  try {
    const recording = await service.startRecording(tenant.id, null, 'room-egress-admission', {
      recordingMode: 'track',
      tracks: [
        { trackId: 'TR_audio', kind: 'audio', source: 'microphone' },
        { trackId: 'TR_video', kind: 'video', source: 'camera' }
      ],
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-egress-admission' }
    });
    const jobs = service.listEgressJobs(recording.id);

    assert.deepEqual(reserved.map((entry) => entry.split(':')[1]), ['track', 'track']);
    assert.deepEqual(activated, jobs.map((job) => job.id));
    assert.deepEqual(closed, []);
    assert.deepEqual(jobs.map((job) => job.reservation_id), jobs.map((job) => `reservation-${job.id}`));
    assert.deepEqual(jobs.map((job) => job.owner_epoch), ['12884901889', '12884901889']);
  } finally {
    db.close();
  }
});

test('provider start failure closes every reserved Egress Cell slot', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Egress Admission Compensation' });
  const closed: string[] = [];
  const service = new LiveKitRecordingService(db, EGRESS_CONFIG, {
    createEgressClient: () => ({
      async startRoomCompositeEgress() { throw new Error('unexpected room composite'); },
      async startTrackEgress(_roomName, _output, trackId) {
        if (trackId === 'TR_video') throw new Error('encoder unavailable');
        return { egressId: `EG_${trackId}` };
      },
      async stopEgress() {}
    }),
    async reserveEgressJob(input) {
      return {
        job_id: input.job_id,
        reservation_id: `reservation-${input.job_id}`,
        owner_epoch: '12884901889',
        value: { job_id: input.job_id }
      };
    },
    async activateEgressJob() {},
    async closeEgressJob(reservation) { closed.push(reservation.job_id); }
  });

  try {
    await assert.rejects(() => service.startRecording(tenant.id, null, 'room-admission-compensation', {
      recordingMode: 'track',
      tracks: [
        { trackId: 'TR_audio', kind: 'audio', source: 'microphone' },
        { trackId: 'TR_video', kind: 'video', source: 'camera' }
      ],
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-admission-compensation' }
    }));
    assert.equal(closed.length, 2);
  } finally {
    db.close();
  }
});

test('recording mode rejects invalid selectors before creating a recording', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Egress Validation' });
  const service = new LiveKitRecordingService(db, EGRESS_CONFIG);

  try {
    await assert.rejects(
      () => service.startRecording(tenant.id, null, 'room-empty-track', {
        recordingMode: 'track',
        tracks: [],
        businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-empty' }
      }),
      (error: unknown) => (error as Error & { status?: number }).status === 400
    );
    await assert.rejects(
      () => service.startRecording(tenant.id, null, 'room-duplicate-track', {
        recordingMode: 'track',
        tracks: [
          { trackId: 'TR_same', kind: 'audio', source: 'microphone' },
          { trackId: 'TR_same', kind: 'video', source: 'camera' }
        ],
        businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-duplicate' }
      }),
      (error: unknown) => (error as Error & { status?: number }).status === 400
    );
    await assert.rejects(
      () => service.startRecording(tenant.id, null, 'room-composite-selector', {
        recordingMode: 'room_composite',
        tracks: [{ trackId: 'TR_forbidden', kind: 'audio', source: 'microphone' }],
        businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-forbidden' }
      }),
      (error: unknown) => (error as Error & { status?: number }).status === 400
    );

    assert.equal(service.listRecordings(tenant.id).length, 0);
  } finally {
    db.close();
  }
});

test('track composite requires a selector and calls the matching provider API', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Track Composite Egress' });
  const selectors: Array<{ audioTrackId?: string; videoTrackId?: string }> = [];
  const service = new LiveKitRecordingService(db, EGRESS_CONFIG, {
    createEgressClient: () => ({
      async startRoomCompositeEgress() {
        throw new Error('unexpected room composite');
      },
      async startTrackCompositeEgress(_roomName, _output, options) {
        selectors.push(options || {});
        return { egressId: 'EG_track_composite' };
      },
      async startTrackEgress() {
        throw new Error('unexpected track');
      },
      async stopEgress() {}
    })
  });

  try {
    const recording = await service.startRecording(tenant.id, null, 'room-track-composite', {
      recordingMode: 'track_composite',
      audioTrackId: 'TR_audio',
      videoTrackId: 'TR_video',
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-track-composite' }
    });

    assert.equal(recording.recording_mode, 'track_composite');
    assert.deepEqual(selectors, [{ audioTrackId: 'TR_audio', videoTrackId: 'TR_video' }]);
  } finally {
    db.close();
  }
});

test('multi-track start failure compensates earlier provider jobs', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Egress Compensation' });
  const stopped: string[] = [];
  let recordingId = '';
  const service = new LiveKitRecordingService(db, EGRESS_CONFIG, {
    createEgressClient: () => ({
      async startRoomCompositeEgress() {
        throw new Error('unexpected room composite');
      },
      async startTrackCompositeEgress() {
        throw new Error('unexpected track composite');
      },
      async startTrackEgress(_roomName, _output, trackId) {
        if (trackId === 'TR_video') throw new Error('provider unavailable');
        return { egressId: 'EG_audio_started' };
      },
      async stopEgress(egressId) {
        stopped.push(egressId);
      }
    })
  });

  try {
    await assert.rejects(
      () => service.startRecording(tenant.id, null, 'room-compensation', {
        recordingMode: 'track',
        tracks: [
          { trackId: 'TR_audio', kind: 'audio', source: 'microphone' },
          { trackId: 'TR_video', kind: 'video', source: 'camera' }
        ],
        businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-compensation' }
      }),
      (error: unknown) => {
        const typed = error as Error & { recording_id?: string; code?: string };
        recordingId = String(typed.recording_id || '');
        assert.equal(typed.code, 'livekit_egress_start_failed');
        return true;
      }
    );

    assert.deepEqual(stopped, ['EG_audio_started']);
    assert.equal(service.getRecording(recordingId)?.status, 'failed');
    assert.deepEqual(
      service.listEgressJobs(recordingId).map((job) => job.status),
      ['failed', 'failed']
    );
  } finally {
    db.close();
  }
});

test('stop by primary egress id stops every active child job', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Egress Stop All' });
  const stopped: string[] = [];
  const service = new LiveKitRecordingService(db, EGRESS_CONFIG, {
    createEgressClient: () => ({
      async startRoomCompositeEgress() {
        throw new Error('unexpected room composite');
      },
      async startTrackCompositeEgress() {
        throw new Error('unexpected track composite');
      },
      async startTrackEgress(_roomName, _output, trackId) {
        return { egressId: `EG_${trackId}` };
      },
      async stopEgress(egressId) {
        stopped.push(egressId);
      }
    })
  });

  try {
    const recording = await service.startRecording(tenant.id, null, 'room-stop-all', {
      recordingMode: 'track',
      tracks: [
        { trackId: 'TR_audio', kind: 'audio', source: 'microphone' },
        { trackId: 'TR_video', kind: 'video', source: 'camera' }
      ],
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-stop-all' }
    });
    const result = await service.stopRecording(recording.egress_id);

    assert.deepEqual(stopped, ['EG_TR_audio', 'EG_TR_video']);
    assert.equal(result?.status, 'stopping');
    assert.deepEqual(
      service.listEgressJobs(recording.id).map((job) => job.status),
      ['stopping', 'stopping']
    );
  } finally {
    db.close();
  }
});

test('multi-track webhooks complete child jobs before completing the parent recording', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Egress Webhook Aggregate' });
  let completed = 0;
  const room = await new LiveKitRoomStore(db).createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'room-webhook-aggregate',
    metadata: { business_ref: { type: 'order', id: 'order-webhook-aggregate' } }
  });
  const recordingService = new LiveKitRecordingService(db, EGRESS_CONFIG, {
      createEgressClient: () => ({
        async startRoomCompositeEgress() {
          throw new Error('unexpected room composite');
        },
        async startTrackCompositeEgress() {
          throw new Error('unexpected track composite');
        },
        async startTrackEgress(_roomName, _output, trackId) {
          return { egressId: `EG_${trackId}` };
        },
        async stopEgress() {}
      })
  });
  const media = createLiveKitMediaModule({
    db,
    recordingEvents: {
      async notifyRecordingCompleted() {
        completed += 1;
      }
    }
  });
  try {
    const recording = await recordingService.startRecording(tenant.id, null, room.room_name, {
      recordingMode: 'track',
      tracks: [
        { trackId: 'TR_audio', kind: 'audio', source: 'microphone' },
        { trackId: 'TR_video', kind: 'video', source: 'camera' }
      ],
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-webhook-aggregate' }
    });

    const first = await media.webhooks.handleWebhook(JSON.stringify({
      event: 'egress_ended',
      room: { name: room.room_name },
      egressInfo: {
        egressId: 'EG_TR_audio',
        fileResults: [{ fileType: 'ogg', location: 's3://recordings/audio.ogg', duration: 3000, size: 1000 }]
      }
    }));
    assert.equal(first.recording?.status, 'recording');
    assert.equal(completed, 0);
    assert.deepEqual(
      recordingService.listEgressJobs(recording.id).map((job) => job.status),
      ['completed', 'recording']
    );

    const second = await media.webhooks.handleWebhook(JSON.stringify({
      event: 'egress_ended',
      room: { name: room.room_name },
      egressInfo: {
        egressId: 'EG_TR_video',
        fileResults: [{ fileType: 'webm', location: 's3://recordings/video.webm', duration: 3200, size: 9000 }]
      }
    }));
    assert.equal(second.recording?.status, 'completed');
    assert.equal(second.recording?.duration_ms, 3200);
    assert.equal(second.recording?.file_size_bytes, 10000);
    assert.equal(completed, 1);

    const replay = await media.webhooks.handleWebhook(JSON.stringify({
      event: 'egress_ended',
      room: { name: room.room_name },
      egressInfo: {
        egressId: 'EG_TR_video',
        fileResults: [{ fileType: 'webm', location: 's3://recordings/video.webm', duration: 3200, size: 9000 }]
      }
    }));
    assert.equal(replay.idempotent_replay, true);
    assert.equal(completed, 1);
  } finally {
    db.close();
  }
});

test('egress_ended preserves provider failure instead of reporting a completed recording', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Egress Failed Webhook' });
  let completed = 0;
  const room = await new LiveKitRoomStore(db).createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'room-failed-webhook',
    metadata: { business_ref: { type: 'order', id: 'order-failed-webhook' } }
  });
  const recordingService = new LiveKitRecordingService(db, EGRESS_CONFIG, {
    createEgressClient: () => ({
      async startRoomCompositeEgress() { return { egressId: 'EG_failed_webhook' }; },
      async stopEgress() {}
    })
  });
  const media = createLiveKitMediaModule({
    db,
    recordingEvents: {
      async notifyRecordingCompleted() { completed += 1; }
    }
  });
  try {
    const recording = await recordingService.startRecording(tenant.id, null, room.room_name, {
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-failed-webhook' }
    });

    const result = await media.webhooks.handleWebhook(JSON.stringify({
      event: 'egress_ended',
      room: { name: room.room_name },
      egressInfo: {
        egressId: 'EG_failed_webhook',
        status: 4,
        error: 'encoder exited'
      }
    }));

    assert.equal(result.recording?.status, 'failed');
    assert.equal(result.recording?.failure_code, 'livekit_egress_failed');
    assert.equal(recordingService.listEgressJobs(recording.id)[0]?.status, 'failed');
    assert.equal(recordingService.listEgressJobs(recording.id)[0]?.failure_code, 'livekit_egress_failed');
    assert.equal(completed, 0);
  } finally {
    db.close();
  }
});

test('multi-track retention deletes every child object and retries only failed children', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Egress Retention Manifest' });
  const deletedStorageUrls: string[] = [];
  let failVideo = true;
  const service = new LiveKitRecordingService(db, EGRESS_CONFIG, {
    createEgressClient: () => ({
      async startRoomCompositeEgress() { throw new Error('unexpected room composite'); },
      async startTrackEgress(_roomName, _output, trackId) {
        return { egressId: `EG_${trackId}` };
      },
      async stopEgress() {}
    }),
    deleteRecordingObject: async (recording) => {
      deletedStorageUrls.push(recording.storage_url);
      if (recording.storage_url.endsWith('/video.ogg') && failVideo) {
        return { status: 'delete_failed', source: 's3', error: 'temporary object-store failure' };
      }
      return { status: 'deleted', source: 's3' };
    }
  });

  try {
    const recording = await service.startRecording(tenant.id, null, 'room-retention-manifest', {
      recordingMode: 'track',
      tracks: [
        { trackId: 'TR_audio', kind: 'audio', source: 'microphone' },
        { trackId: 'TR_video', kind: 'video', source: 'camera' }
      ],
      retentionUntil: '2020-01-01T00:00:00.000Z',
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-retention-manifest' }
    });
    const jobs = service.listEgressJobs(recording.id);
    run(db, "UPDATE call_recordings SET status = 'completed' WHERE id = ?", [recording.id]);
    run(db, "UPDATE livekit_egress_jobs SET storage_url = ?, status = 'completed' WHERE id = ?", [
      's3://recordings/audio.ogg', jobs[0]!.id
    ]);
    run(db, "UPDATE livekit_egress_jobs SET storage_url = ?, status = 'completed' WHERE id = ?", [
      's3://recordings/video.ogg', jobs[1]!.id
    ]);

    const first = await service.cleanupExpiredRecordings(tenant.id, {
      before: '2026-07-17T00:00:00.000Z',
      dryRun: false
    });
    assert.equal(first.deleted, 0);
    assert.equal(first.failed, 1);
    assert.equal(service.getRecording(recording.id)?.status, 'completed');
    assert.deepEqual(
      service.listEgressJobs(recording.id).map((job) => job.object_status),
      ['deleted', 'delete_failed']
    );

    failVideo = false;
    const replay = await service.cleanupExpiredRecordings(tenant.id, {
      before: '2026-07-17T00:00:00.000Z',
      dryRun: false
    });
    assert.equal(replay.deleted, 1);
    assert.equal(replay.failed, 0);
    assert.equal(service.getRecording(recording.id)?.status, 'deleted');
    assert.deepEqual(deletedStorageUrls, [
      's3://recordings/audio.ogg',
      's3://recordings/video.ogg',
      's3://recordings/video.ogg'
    ]);
  } finally {
    db.close();
  }
});

test('a child Egress job can be exported without exposing its storage URL', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Egress Job Export' });
  const resolvedStorageUrls: string[] = [];
  const service = new LiveKitRecordingService(db, EGRESS_CONFIG, {
    createEgressClient: () => ({
      async startRoomCompositeEgress() { throw new Error('unexpected room composite'); },
      async startTrackEgress(_roomName, _output, trackId) {
        return { egressId: `EG_${trackId}` };
      },
      async stopEgress() {}
    }),
    resolveRecordingObject: async (recording) => {
      resolvedStorageUrls.push(recording.storage_url);
      return { status: 'readable', source: 's3', content: Buffer.from(recording.storage_url) };
    }
  });

  try {
    const recording = await service.startRecording(tenant.id, null, 'room-job-export', {
      recordingMode: 'track',
      tracks: [
        { trackId: 'TR_audio', kind: 'audio', source: 'microphone' },
        { trackId: 'TR_video', kind: 'video', source: 'camera' }
      ],
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-job-export' }
    });
    const videoJob = service.listEgressJobs(recording.id)[1]!;
    run(db, 'UPDATE livekit_egress_jobs SET storage_url = ? WHERE id = ?', [
      's3://recordings/video.ogg', videoJob.id
    ]);

    const exported = await service.exportJobObject(recording.id, videoJob.id);
    assert.equal(exported?.readable, true);
    assert.equal(exported?.filename, `${videoJob.id}.ogg`);
    assert.deepEqual(exported?.content, Buffer.from('s3://recordings/video.ogg'));
    assert.deepEqual(resolvedStorageUrls, ['s3://recordings/video.ogg']);
  } finally {
    db.close();
  }
});

test('media HTTP lists opaque child jobs and exports a tenant-scoped job object', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Egress Job HTTP' });
  const media = createLiveKitMediaModule({ db });
  try {
    const room = await media.rooms.createRoom({
      tenant_id: tenant.id,
      purpose: 'video_service',
      room_name: 'room-job-http'
    });
    const recording = await media.recordings.startRecording(tenant.id, null, room.room_name, {
      recordingMode: 'track',
      tracks: [{ trackId: 'TR_audio', kind: 'audio', source: 'microphone' }],
      businessRef: { tenant_id: tenant.id, type: 'order', id: 'order-job-http' }
    });
    const job = media.recordings.listEgressJobs(recording.id)[0]!;
    run(db, 'UPDATE livekit_egress_jobs SET storage_url = ? WHERE id = ?', [
      's3://recordings/private-audio.ogg', job.id
    ]);
    const options = {
      resolveRecordingObject: async (object: { storage_url: string }) => ({
        status: 'readable' as const,
        source: 's3' as const,
        content: Buffer.from(object.storage_url)
      })
    };

    const listed = await routeMediaApi(
      db,
      'GET',
      `/api/media/livekit/recordings/${recording.id}/jobs`,
      new URL(`http://localhost/api/media/livekit/recordings/${recording.id}/jobs?tenant_id=${tenant.id}`),
      null,
      '',
      {},
      options
    ) as Array<Record<string, unknown>>;
    assert.equal(listed.length, 1);
    assert.equal('storage_url' in listed[0]!, false);

    const exported = await routeMediaApi(
      db,
      'GET',
      `/api/media/livekit/recordings/${recording.id}/jobs/${job.id}/export`,
      new URL(`http://localhost/api/media/livekit/recordings/${recording.id}/jobs/${job.id}/export?tenant_id=${tenant.id}`),
      null,
      '',
      {},
      options
    ) as { data: Buffer; filename: string };
    assert.deepEqual(exported.data, Buffer.from('s3://recordings/private-audio.ogg'));
    assert.equal(exported.filename, `${job.id}.ogg`);
  } finally {
    db.close();
  }
});
