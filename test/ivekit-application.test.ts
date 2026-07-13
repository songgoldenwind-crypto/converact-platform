import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { startIveKitApplication } from '../src/agent-runtime/ivekit/application.js';
import { MemoryPg } from '../src/db-pg.js';

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
    'stop:tinode-inbound',
    'stop:tinode'
  ]);
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
  ]);
  const completedEvent = published.find((event) => event.type === 'collaboration.translation.completed');
  const failedEvent = published.find((event) => event.type === 'collaboration.translation.failed');
  assert.ok(completedEvent);
  assert.ok(failedEvent);
  assert.doesNotMatch(JSON.stringify([completedEvent, failedEvent]), /must-not-enter-event|translated_text/);
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
  await application.stop();
});

test('OPC server delegates collaboration workers to iveKit application', () => {
  const source = readFileSync('src/server.ts', 'utf8');
  assert.match(source, /startIveKitApplication/);
  assert.doesNotMatch(source, /startTinodeSyncWorker/);
  assert.doesNotMatch(source, /startAttachmentProcessingWorker/);
  assert.doesNotMatch(source, /startQualityReviewWorker/);
});
