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
      startMediaTimeout: () => worker('media-timeout'),
      startEventRetention: () => worker('event-retention')
    }
  });

  await application.stop();
  await application.stop();

  assert.deepEqual(events, [
    'start:tinode',
    'start:tinode-inbound',
    'start:attachment',
    'start:quality',
    'start:media-timeout',
    'start:event-retention',
    'stop:event-retention',
    'stop:media-timeout',
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
      startMediaTimeout: () => ({
        async stop() {
          stopped.push('media-timeout');
        }
      }),
      startEventRetention: () => ({
        async stop() {
          stopped.push('event-retention');
        }
      })
    }
  });

  await assert.rejects(() => application.stop(), /failed to stop 1 iveKit worker/);
  assert.deepEqual(stopped, ['event-retention', 'media-timeout', 'quality', 'attachment', 'tinode-inbound', 'tinode']);
});

test('iveKit application publishes worker events and requeues attachment quality review', async () => {
  const published: Array<{ tenantId: string; type: string; data: unknown }> = [];
  const enqueued: Array<{ tenant_id: string; message_id: string }> = [];
  let tinodeInput: any;
  let tinodeInboundInput: any;
  let attachmentInput: any;
  let qualityInput: any;
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
      type: 'ivekit.media.call.updated',
      data: { call: { tenant_id: 'tenant-runtime', id: 'call-timeout-1' }, participants: [] }
    }
  ]);
  assert.deepEqual(enqueued, [{
    tenant_id: 'tenant-runtime',
    message_id: 'message-inbound-11'
  }, {
    tenant_id: 'tenant-runtime',
    message_id: 'message-attachment-1'
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
