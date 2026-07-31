import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { startIveKitApplication } from '../src/agent-runtime/converact/application.js';
import { IveKitTenantEventStore } from '../src/agent-runtime/converact/tenant-event-store.js';
import { MemoryPg } from '../src/db-pg.js';
import { initWebSocket, shutdownWebSocket } from '../src/ws.js';

test('iveKit application starts and stops every worker once', async () => {
  const events: string[] = [];
  const worker = (name: string) => {
    events.push(`start:${name}`);
    return {
      async stop() {
        events.push(`stop:${name}`);
      }
    };
  };

  const application = startIveKitApplication({
    pg: new MemoryPg(),
    adapters: {
      startTinode: () => worker('tinode'),
      startTinodeInbound: () => worker('tinode-inbound'),
      startFileScan: () => worker('file-scan'),
      startFileDerivative: () => worker('file-derivative'),
      startFileCleanup: () => worker('file-cleanup'),
      startAttachment: () => worker('attachment'),
      startQuality: () => worker('quality'),
      startTranslation: () => worker('translation'),
      startMediaTimeout: () => worker('media-timeout'),
      startEventRetention: () => worker('event-retention'),
      startContactCenter: () => worker('contact-center')
    }
  });

  await application.stop();
  await application.stop();

  assert.deepEqual(events, [
    'start:tinode',
    'start:tinode-inbound',
    'start:file-scan',
    'start:file-derivative',
    'start:file-cleanup',
    'start:attachment',
    'start:quality',
    'start:translation',
    'start:media-timeout',
    'start:event-retention',
    'start:contact-center',
    'stop:contact-center',
    'stop:event-retention',
    'stop:media-timeout',
    'stop:translation',
    'stop:quality',
    'stop:attachment',
    'stop:file-cleanup',
    'stop:file-derivative',
    'stop:file-scan',
    'stop:tinode-inbound',
    'stop:tinode'
  ]);
});

test('iveKit application injects SIP placement into the voice command runtime', async () => {
  const handle = { async stop() {} };
  const voicePlacement = { resolveOwner: async () => { throw new Error('not used'); } };
  const mediaPlacement = { resolveOwner: async () => { throw new Error('not used'); } };
  let voiceCommandInput: any;
  const key = Buffer.alloc(32, 7).toString('base64');
  const application = startIveKitApplication({
    pg: new MemoryPg(),
    env: {
      OPC_IVEKIT_VOICE_WORKERS_ENABLED: '1',
      OPC_IVEKIT_VOICE_ADDRESS_KEY: key,
      OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY: key
    },
    placement: {
      coordinator: {} as never,
      media: mediaPlacement as never,
      voice: voicePlacement as never,
      worker_id: 'placement-worker-a'
    },
    adapters: {
      startTinode: () => handle,
      startTinodeInbound: () => handle,
      startFileScan: () => handle,
      startFileDerivative: () => handle,
      startFileCleanup: () => handle,
      startAttachment: () => handle,
      startQuality: () => handle,
      startTranslation: () => handle,
      startMediaTimeout: () => handle,
      startPlacement: () => handle,
      startEventRetention: () => handle,
      startContactCenter: () => handle,
      startVoiceCommand: (input) => {
        voiceCommandInput = input;
        return handle;
      },
      startVoiceEvent: () => handle,
      startVoiceReconciliation: () => handle
    }
  });

  assert.equal(voiceCommandInput.placement, voicePlacement);
  assert.equal(voiceCommandInput.media_placement, mediaPlacement);
  await application.stop();
});

test('iveKit application stops remaining workers after one stop failure', async () => {
  const stopped: string[] = [];
  const application = startIveKitApplication({
    pg: new MemoryPg(),
    adapters: {
      startTinode: () => ({
        async stop() {
          stopped.push('tinode');
        }
      }),
      startTinodeInbound: () => ({
        async stop() {
          stopped.push('tinode-inbound');
        }
      }),
      startAttachment: () => ({
        async stop() {
          stopped.push('attachment');
          throw new Error('attachment stop failed');
        }
      }),
      startQuality: () => ({
        async stop() {
          stopped.push('quality');
        }
      }),
      startTranslation: () => ({
        async stop() {
          stopped.push('translation');
        }
      }),
      startMediaTimeout: () => ({
        async stop() {
          stopped.push('media-timeout');
        }
      }),
      startEventRetention: () => ({
        async stop() {
          stopped.push('event-retention');
        }
      }),
      startContactCenter: () => ({
        async stop() {
          stopped.push('contact-center');
        }
      })
    }
  });

  await assert.rejects(() => application.stop(), /failed to stop 1 iveKit worker/);
  assert.deepEqual(stopped, [
    'contact-center', 'event-retention', 'media-timeout', 'translation', 'quality',
    'attachment', 'tinode-inbound', 'tinode'
  ]);
});

test('iveKit application publishes worker events and requeues attachment quality review', async () => {
  const published: Array<{ tenantId: string; type: string; data: unknown }> = [];
  const enqueued: Array<{ tenant_id: string; message_id: string }> = [];
  const translated: Array<{ tenant_id: string; session_id: string; source_type: string; source_ref_id: string }> = [];
  let tinodeInput: any;
  let tinodeInboundInput: any;
  let fileScanInput: any;
  let fileDerivativeInput: any;
  let fileCleanupInput: any;
  let attachmentInput: any;
  let qualityInput: any;
  let translationInput: any;
  let mediaTimeoutInput: any;
  const handle = { async stop() {} };
  const application = startIveKitApplication({
    pg: new MemoryPg(),
    publish: (tenantId, type, data) => {
      published.push({ tenantId, type, data });
    },
    qualityReviewEnqueuer: {
      enabled: true,
      async enqueueMessage(input) {
        enqueued.push(input);
      }
    },
    translationEnqueuer: {
      enabled: true,
      async enqueueSource(source) {
        translated.push(source);
      }
    },
    adapters: {
      startTinode: (input) => {
        tinodeInput = input;
        return handle;
      },
      startTinodeInbound: (input) => {
        tinodeInboundInput = input;
        return handle;
      },
      startFileScan: (input) => {
        fileScanInput = input;
        return handle;
      },
      startFileDerivative: (input) => {
        fileDerivativeInput = input;
        return handle;
      },
      startFileCleanup: (input) => {
        fileCleanupInput = input;
        return handle;
      },
      startAttachment: (input) => {
        attachmentInput = input;
        return handle;
      },
      startQuality: (input) => {
        qualityInput = input;
        return handle;
      },
      startTranslation: (input) => {
        translationInput = input;
        return handle;
      },
      startMediaTimeout: (input) => {
        mediaTimeoutInput = input;
        return handle;
      },
      startEventRetention: () => handle
    }
  });

  const delivery = {
    id: 'message-delivery-1',
    tenant_id: 'tenant-runtime',
    session_id: 'session-runtime',
    provider_delivery: { status: 'delivered' }
  };
  await tinodeInput.onDeliveryUpdated(delivery);
  const inboundInput = {
    claim: {
      tenant_id: 'tenant-runtime',
      session_id: 'session-runtime',
      binding_id: 'binding-runtime'
    },
    event: {
      kind: 'data',
      provider_sequence: 11,
      provider_delete_id: 0
    },
    result: {
      event_id: 'inbound-event-11',
      status: 'projected',
      message_id: 'message-inbound-11',
      replayed: false
    }
  };
  await tinodeInboundInput.onProjected({
    pg: new MemoryPg(),
    claim: inboundInput.claim,
    event: inboundInput.event,
    projection: { status: 'projected', message_id: 'message-inbound-11' }
  });
  await tinodeInboundInput.onProcessed(inboundInput);
  await fileScanInput.onProcessed({
    id: 'secure-file-1',
    tenant_id: 'tenant-runtime',
    session_id: 'session-runtime',
    status: 'quarantined',
    threat_status: 'infected',
    detected_mime: 'application/pdf',
    mime_conflict: false,
    failure_code: 'eicar_test_signature',
    scan_attempt_count: 1,
    scanner_name: 'clamav',
    scanner_mode: 'self_hosted',
    object_key: 'must-not-enter-event',
    filename: 'must-not-enter-event.pdf',
    sha256: 'f'.repeat(64),
    scan_metadata: { raw: 'must-not-enter-event' },
    lease_until: '2026-07-15T12:00:00.000Z',
    worker_id: 'must-not-enter-event'
  });
  const derivativeFile = {
    id: 'secure-file-2',
    tenant_id: 'tenant-runtime',
    session_id: 'session-runtime',
    status: 'ready',
    threat_status: 'clean',
    detected_mime: 'image/png',
    mime_conflict: false,
    failure_code: '',
    scan_attempt_count: 1,
    scanner_name: 'clamav',
    scanner_mode: 'self_hosted',
    object_key: 'must-not-enter-event',
    sha256: 'e'.repeat(64),
    scan_metadata: { raw: 'must-not-enter-event' }
  };
  await fileDerivativeInput.onProcessed({
    derivative: {
      secure_file_id: 'secure-file-2',
      session_id: 'session-runtime',
      derivative_kind: 'image_thumbnail',
      status: 'ready',
      mime: 'image/jpeg',
      size_bytes: 13,
      attempt_count: 1,
      error_code: '',
      provider_profile_id: 'ffmpeg-primary',
      object_key: 'must-not-enter-event',
      sha256: 'f'.repeat(64),
      provider_request_id: 'must-not-enter-event',
      provider_metadata: { raw: 'must-not-enter-event' }
    },
    file: derivativeFile
  });
  await fileDerivativeInput.onFileConverged(derivativeFile);
  await fileCleanupInput.onProcessed({
    file: {
      ...derivativeFile,
      id: 'secure-file-expired',
      status: 'expired',
      object_key: 'must-not-enter-event'
    },
    outcome: 'expired',
    error_code: ''
  });
  const processed = {
    attachment: {
      id: 'attachment-1',
      tenant_id: 'tenant-runtime',
      session_id: 'session-runtime',
      message_id: 'message-attachment-1'
    },
    job: { id: 'attachment-job-1' },
    policy: { matched: false }
  };
  await attachmentInput.onProcessed(processed);
  const completed = {
    job: {
      id: 'quality-job-1',
      tenant_id: 'tenant-runtime',
      session_id: 'session-runtime',
      message_id: 'message-quality-1'
    },
    findings: [{ id: 'finding-1' }]
  };
  await qualityInput.onCompleted(completed);
  await translationInput.onCompleted({
    job: {
      id: 'translation-job-1', tenant_id: 'tenant-runtime', session_id: 'session-runtime',
      message_id: 'message-translation-1', source_type: 'message', source_ref_id: 'message-translation-1',
      source_language: 'zh-CN', target_language: 'en-US', status: 'succeeded'
    },
    result: { translated_text: 'must-not-enter-event' }
  });
  await translationInput.onFailed({
    id: 'translation-job-2', tenant_id: 'tenant-runtime', session_id: 'session-runtime',
    message_id: 'message-translation-2', source_type: 'attachment', source_ref_id: 'attachment-2',
    target_language: 'ja-JP', status: 'failed', error_code: 'provider_http_503'
  });
  await mediaTimeoutInput.onTimedOut({ call: { tenant_id: 'tenant-runtime', id: 'call-timeout-1' }, participants: [] });
  assert.equal(attachmentInput.onProviderEvent, qualityInput.onProviderEvent);
  assert.equal(qualityInput.onProviderEvent, translationInput.onProviderEvent);
  await attachmentInput.onProviderEvent({
    tenant_id: 'tenant-runtime',
    type: 'collaboration.intelligence.provider.failed_over',
    data: {
      capability: 'ocr',
      from_profile_id: 'ocr-primary',
      to_profile_id: 'ocr-fallback',
      attempt_count: 2
    }
  });

  assert.deepEqual(published, [
    {
      tenantId: 'tenant-runtime',
      type: 'collaboration.message.delivery_updated',
      data: {
        session_id: 'session-runtime',
        message_id: 'message-delivery-1',
        delivery: { status: 'delivered' }
      }
    },
    {
      tenantId: 'tenant-runtime',
      type: 'collaboration.message.provider_synced',
      data: {
        session_id: 'session-runtime',
        binding_id: 'binding-runtime',
        event_id: 'inbound-event-11',
        event_kind: 'data',
        provider_sequence: 11,
        provider_delete_id: 0,
        status: 'projected',
        message_id: 'message-inbound-11',
        replayed: false
      }
    },
    {
      tenantId: 'tenant-runtime',
      type: 'collaboration.file.security_updated',
      data: {
        session_id: 'session-runtime',
        secure_file_id: 'secure-file-1',
        status: 'quarantined',
        threat_status: 'infected',
        detected_mime: 'application/pdf',
        mime_conflict: false,
        failure_code: 'eicar_test_signature',
        scan_attempt_count: 1,
        scanner_name: 'clamav',
        scanner_mode: 'self_hosted'
      }
    },
    {
      tenantId: 'tenant-runtime',
      type: 'collaboration.file.derivative_updated',
      data: {
        session_id: 'session-runtime',
        secure_file_id: 'secure-file-2',
        derivative_kind: 'image_thumbnail',
        status: 'ready',
        mime: 'image/jpeg',
        size_bytes: 13,
        attempt_count: 1,
        error_code: '',
        provider_profile_id: 'ffmpeg-primary',
        parent_status: 'ready'
      }
    },
    {
      tenantId: 'tenant-runtime',
      type: 'collaboration.file.security_updated',
      data: {
        session_id: 'session-runtime',
        secure_file_id: 'secure-file-2',
        status: 'ready',
        threat_status: 'clean',
        detected_mime: 'image/png',
        mime_conflict: false,
        failure_code: '',
        scan_attempt_count: 1,
        scanner_name: 'clamav',
        scanner_mode: 'self_hosted'
      }
    },
    {
      tenantId: 'tenant-runtime',
      type: 'collaboration.file.cleanup_updated',
      data: {
        session_id: 'session-runtime',
        secure_file_id: 'secure-file-expired',
        status: 'expired',
        outcome: 'expired',
        error_code: ''
      }
    },
    {
      tenantId: 'tenant-runtime',
      type: 'collaboration.attachment.processed',
      data: {
        session_id: 'session-runtime',
        message_id: 'message-attachment-1',
        ...processed
      }
    },
    {
      tenantId: 'tenant-runtime',
      type: 'collaboration.quality_review.completed',
      data: {
        session_id: 'session-runtime',
        message_id: 'message-quality-1',
        ...completed
      }
    },
    {
      tenantId: 'tenant-runtime',
      type: 'collaboration.translation.completed',
      data: {
        job_id: 'translation-job-1', session_id: 'session-runtime',
        message_id: 'message-translation-1', source_type: 'message',
        source_ref_id: 'message-translation-1', source_language: 'zh-CN',
        target_language: 'en-US', status: 'succeeded'
      }
    },
    {
      tenantId: 'tenant-runtime',
      type: 'collaboration.translation.failed',
      data: {
        job_id: 'translation-job-2', session_id: 'session-runtime',
        message_id: 'message-translation-2', source_type: 'attachment',
        source_ref_id: 'attachment-2', target_language: 'ja-JP',
        status: 'failed', error_code: 'provider_http_503'
      }
    },
    {
      tenantId: 'tenant-runtime',
      type: 'ivekit.media.call.updated',
      data: { call: { tenant_id: 'tenant-runtime', id: 'call-timeout-1' }, participants: [] }
    },
    {
      tenantId: 'tenant-runtime',
      type: 'collaboration.intelligence.provider.failed_over',
      data: {
        capability: 'ocr',
        from_profile_id: 'ocr-primary',
        to_profile_id: 'ocr-fallback',
        attempt_count: 2
      }
    }
  ]);
  const completedEvent = published.find((event) => event.type === 'collaboration.translation.completed');
  const failedEvent = published.find((event) => event.type === 'collaboration.translation.failed');
  assert.ok(completedEvent);
  assert.ok(failedEvent);
  assert.doesNotMatch(JSON.stringify([completedEvent, failedEvent]), /must-not-enter-event|translated_text/);
  const fileSecurityEvents = published.filter((event) => event.type === 'collaboration.file.security_updated');
  const derivativeEvent = published.find((event) => event.type === 'collaboration.file.derivative_updated');
  const cleanupEvent = published.find((event) => event.type === 'collaboration.file.cleanup_updated');
  assert.equal(fileSecurityEvents.length, 2);
  assert.ok(derivativeEvent);
  assert.ok(cleanupEvent);
  assert.doesNotMatch(
    JSON.stringify([...fileSecurityEvents, derivativeEvent, cleanupEvent]),
    /must-not-enter-event|object_key|filename|sha256|scan_metadata|provider_request_id|provider_metadata|lease_until|worker_id/
  );
  assert.deepEqual(enqueued, [{
    tenant_id: 'tenant-runtime',
    message_id: 'message-inbound-11'
  }, {
    tenant_id: 'tenant-runtime',
    message_id: 'message-attachment-1'
  }]);
  assert.deepEqual(translated, [{
    tenant_id: 'tenant-runtime',
    session_id: 'session-runtime',
    source_type: 'message',
    source_ref_id: 'message-inbound-11'
  }, {
    tenant_id: 'tenant-runtime',
    session_id: 'session-runtime',
    source_type: 'attachment',
    source_ref_id: 'attachment-1'
  }]);
  const beforeMutationCorrection = published.length;
  await tinodeInboundInput.onProcessed({
    claim: inboundInput.claim,
    event: {
      kind: 'data',
      provider_sequence: 12,
      provider_delete_id: 0
    },
    result: {
      event_id: 'inbound-event-12',
      status: 'ignored',
      message_id: 'message-corrected-1',
      replayed: false,
      provider_mutation: {
        mutation_id: 'mutation-corrected-1',
        mutation_version: 2,
        action: 'edit',
        message_id: 'message-corrected-1',
        status: 'delivered',
        previous_status: 'dead_letter'
      }
    }
  });
  assert.deepEqual(published.slice(beforeMutationCorrection), [{
    tenantId: 'tenant-runtime',
    type: 'collaboration.message.provider_mutation_updated',
    data: {
      session_id: 'session-runtime',
      message_id: 'message-corrected-1',
      mutation_id: 'mutation-corrected-1',
      mutation_version: 2,
      action: 'edit',
      provider: 'tinode',
      status: 'delivered',
      reconciled_from_status: 'dead_letter'
    }
  }, {
    tenantId: 'tenant-runtime',
    type: 'collaboration.message.provider_synced',
    data: {
      session_id: 'session-runtime',
      binding_id: 'binding-runtime',
      event_id: 'inbound-event-12',
      event_kind: 'data',
      provider_sequence: 12,
      provider_delete_id: 0,
      status: 'ignored',
      message_id: 'message-corrected-1',
      replayed: false
    }
  }]);
  await application.stop();
});

test('provider events remain replayable when realtime publication fails', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant-provider-event-journal';
  const events = new IveKitTenantEventStore(pg, {
    cursor_secret: 'provider-event-journal-test-secret'
  });
  const before = await events.headCursor(tenantId);
  let attachmentInput: any;
  const handle = { async stop() {} };
  const application = startIveKitApplication({
    pg,
    publish: async (_tenantId, type) => {
      if (type.startsWith('collaboration.intelligence.provider.')) {
        throw new Error('realtime event transport unavailable');
      }
    },
    adapters: {
      startTinode: () => handle,
      startTinodeInbound: () => handle,
      startAttachment: (input) => {
        attachmentInput = input;
        return handle;
      },
      startQuality: () => handle,
      startTranslation: () => handle,
      startMediaTimeout: () => handle,
      startEventRetention: () => handle,
      startContactCenter: () => handle
    }
  });

  await attachmentInput.onProviderEvent({
    tenant_id: tenantId,
    type: 'collaboration.intelligence.provider.route_exhausted',
    data: {
      capability: 'ocr',
      attempts: [{ profile_id: 'ocr-primary', status: 'skipped', code: 'circuit_open' }],
      retry_at: '2026-07-15T12:00:00.000Z',
      provider_invoked: false,
      failover_attempted: false
    }
  });

  const replay = await events.list({
    tenant_id: tenantId,
    user_id: 'provider-auditor',
    role: 'admin',
    cursor: before,
    limit: 10
  });
  assert.deepEqual(replay.items.map((event) => event.type), [
    'collaboration.intelligence.provider.route_exhausted'
  ]);
  assert.deepEqual(replay.items[0]?.data, {
    capability: 'ocr',
    attempts: [{ profile_id: 'ocr-primary', status: 'skipped', code: 'circuit_open' }],
    retry_at: '2026-07-15T12:00:00.000Z',
    provider_invoked: false,
    failover_attempted: false
  });
  await application.stop();
});

test('Tinode late mutation correction remains replayable when realtime publication fails', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant-mutation-correction-journal';
  const events = new IveKitTenantEventStore(pg, {
    cursor_secret: 'mutation-correction-journal-test-secret'
  });
  const before = await events.headCursor(tenantId);
  let tinodeInboundInput: any;
  const handle = { async stop() {} };
  const application = startIveKitApplication({
    pg,
    publish: async (_tenantId, type) => {
      if (type === 'collaboration.message.provider_mutation_updated') {
        throw new Error('realtime event transport unavailable');
      }
    },
    adapters: {
      startTinode: () => handle,
      startTinodeInbound: (input) => {
        tinodeInboundInput = input;
        return handle;
      },
      startFileScan: () => handle,
      startFileDerivative: () => handle,
      startFileCleanup: () => handle,
      startAttachment: () => handle,
      startQuality: () => handle,
      startTranslation: () => handle,
      startMediaTimeout: () => handle,
      startEventRetention: () => handle,
      startContactCenter: () => handle
    }
  });
  const claim = {
    tenant_id: tenantId,
    session_id: 'session-mutation-correction',
    binding_id: 'binding-mutation-correction'
  };
  const event = {
    kind: 'data',
    provider_sequence: 42,
    provider_delete_id: 0
  };
  const providerMutation = {
    mutation_id: 'mutation-corrected-durable-1',
    mutation_version: 2,
    action: 'edit',
    message_id: 'message-corrected-durable-1',
    status: 'delivered',
    previous_status: 'dead_letter'
  };

  await tinodeInboundInput.onProjected({
    pg,
    claim,
    event,
    projection: {
      status: 'ignored',
      message_id: providerMutation.message_id,
      provider_mutation: providerMutation
    }
  });
  await assert.rejects(
    () => tinodeInboundInput.onProcessed({
      claim,
      event,
      result: {
        event_id: 'inbound-event-correction-42',
        status: 'ignored',
        message_id: providerMutation.message_id,
        replayed: false,
        provider_mutation: providerMutation
      }
    }),
    /realtime event transport unavailable/
  );

  const replay = await events.list({
    tenant_id: tenantId,
    user_id: 'mutation-auditor',
    role: 'admin',
    cursor: before,
    limit: 10
  });
  assert.deepEqual(replay.items.map((item) => ({ type: item.type, data: item.data })), [{
    type: 'collaboration.message.provider_mutation_updated',
    data: {
      session_id: claim.session_id,
      message_id: providerMutation.message_id,
      mutation_id: providerMutation.mutation_id,
      mutation_version: providerMutation.mutation_version,
      action: providerMutation.action,
      provider: 'tinode',
      status: 'delivered',
      reconciled_from_status: 'dead_letter'
    }
  }]);
  await application.stop();
});

test('default provider event publication persists one durable event', async (t) => {
  const pg = new MemoryPg();
  const env = {
    OPC_IVEKIT_EVENT_REPLAY_ENABLED: '1',
    OPC_IVEKIT_EVENT_CURSOR_SECRET: 'provider-event-single-write-secret',
    OPC_IVEKIT_EVENT_RETENTION_WORKER_ENABLED: '0'
  };
  const events = new IveKitTenantEventStore(pg, { env });
  const server = createServer();
  initWebSocket(server, { eventStore: events });
  t.after(async () => {
    await shutdownWebSocket();
    server.close();
  });
  const before = await events.headCursor('tenant-provider-single');
  let attachmentInput: any;
  const handle = { async stop() {} };
  const application = startIveKitApplication({
    pg,
    env,
    adapters: {
      startAttachment: (input) => {
        attachmentInput = input;
        return handle;
      }
    }
  });

  await attachmentInput.onProviderEvent({
    tenant_id: 'tenant-provider-single',
    type: 'collaboration.intelligence.provider.selected',
    data: { capability: 'ocr', profile_id: 'ocr-primary', attempt_count: 1 }
  });

  const replay = await events.list({
    tenant_id: 'tenant-provider-single',
    user_id: 'provider-auditor',
    role: 'admin',
    cursor: before,
    limit: 10
  });
  assert.equal(replay.items.length, 1);
  assert.equal(replay.items[0]?.type, 'collaboration.intelligence.provider.selected');
  await application.stop();
});

test('default provider event publication surfaces durable persistence failures', async () => {
  const pg = new MemoryPg();
  const query = pg.query.bind(pg);
  (pg as any).query = async (text: string, params: unknown[] = []) => {
    if (/INSERT INTO ivekit_tenant_events/i.test(text)) {
      throw new Error('forced tenant event persistence failure');
    }
    return query(text, params);
  };
  let attachmentInput: any;
  const handle = { async stop() {} };
  const application = startIveKitApplication({
    pg,
    env: {
      OPC_IVEKIT_EVENT_REPLAY_ENABLED: '1',
      OPC_IVEKIT_EVENT_CURSOR_SECRET: 'provider-event-persistence-secret',
      OPC_IVEKIT_EVENT_RETENTION_WORKER_ENABLED: '0'
    },
    adapters: {
      startAttachment: (input) => {
        attachmentInput = input;
        return handle;
      }
    }
  });

  await assert.rejects(
    () => attachmentInput.onProviderEvent({
      tenant_id: 'tenant-provider-persistence',
      type: 'collaboration.intelligence.provider.selected',
      data: { capability: 'ocr', profile_id: 'ocr-primary', attempt_count: 1 }
    }),
    /forced tenant event persistence failure/
  );
  await application.stop();
});

test('OPC server delegates collaboration workers to iveKit application', () => {
  const source = readFileSync('src/server.ts', 'utf8');
  assert.match(source, /startIveKitApplication/);
  assert.doesNotMatch(source, /startTinodeSyncWorker/);
  assert.doesNotMatch(source, /startAttachmentProcessingWorker/);
  assert.doesNotMatch(source, /startQualityReviewWorker/);
});
