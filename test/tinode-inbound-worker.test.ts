import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TinodeInboundService,
  TinodeInboundWorker,
  tinodeInboundWorkerConfig,
  type TinodeInboundRunSummary
} from '../src/agent-runtime/collaboration/tinode-inbound-worker.js';
import {
  TinodeInboundAttachmentImportError
} from '../src/agent-runtime/collaboration/tinode-inbound-attachment-import.js';

const CLAIM = {
  tenant_id: 'tenant-inbound',
  session_id: 'session-inbound',
  binding_id: 'binding-inbound',
  provider_topic_id: 'grpInbound',
  claim_token: 'claim-token',
  lease_until: '2026-07-12T13:01:00.000Z',
  cursor: {
    id: 'cursor-inbound',
    last_data_seq: 0,
    last_del_id: 0
  }
};

const EMPTY_RESULT: TinodeInboundRunSummary = {
  tenants: 0,
  claimed: 0,
  packets: 0,
  retried: 0,
  projected: 0,
  ignored: 0,
  dead_letter: 0,
  failed: 0
};

test('Tinode inbound worker config requires provider authentication and validates bounds', () => {
  assert.equal(tinodeInboundWorkerConfig({} as NodeJS.ProcessEnv).enabled, false);
  assert.equal(tinodeInboundWorkerConfig({
    TINODE_WS_URL: 'wss://tinode.example.com/v0/channels',
    CONVERACT_TINODE_INBOUND_WORKER_ENABLED: '1'
  } as NodeJS.ProcessEnv).enabled, false);

  assert.deepEqual(tinodeInboundWorkerConfig({
    TINODE_WS_URL: 'wss://tinode.example.com/v0/channels',
    TINODE_API_KEY: 'browser-api-key',
    TINODE_ROOT_API_KEY: 'root-api-key',
    TINODE_AUTH_TOKEN: 'service-token',
    CONVERACT_TINODE_INBOUND_WORKER_ENABLED: '1',
    CONVERACT_TINODE_INBOUND_INTERVAL_MS: '7000',
    CONVERACT_TINODE_INBOUND_TENANT_LIMIT: '40',
    CONVERACT_TINODE_INBOUND_PULL_LIMIT: '80',
    CONVERACT_TINODE_INBOUND_CLAIM_LEASE_MS: '45000',
    CONVERACT_TINODE_INBOUND_RETRY_DELAY_MS: '9000',
    CONVERACT_TINODE_INBOUND_DEAD_LETTER_MAX_ATTEMPTS: '4',
    CONVERACT_TINODE_ATTACHMENT_ALLOWED_HOSTS: 'files.example.com,cdn.example.com'
  } as NodeJS.ProcessEnv), {
    enabled: true,
    intervalMs: 7_000,
    tenantLimit: 40,
    pullLimit: 80,
    claimLeaseMs: 45_000,
    retryDelayMs: 9_000,
    deadLetterMaxAttempts: 4,
    allowedAttachmentHosts: ['files.example.com', 'cdn.example.com']
  });
  assert.equal(tinodeInboundWorkerConfig({
    TINODE_WS_URL: 'wss://tinode.example.com/v0/channels',
    TINODE_AUTH_TOKEN: 'service-token',
    CONVERACT_TINODE_INBOUND_WORKER_ENABLED: '1'
  } as NodeJS.ProcessEnv).enabled, false);

  assert.throws(() => tinodeInboundWorkerConfig({
    TINODE_WS_URL: 'wss://tinode.example.com/v0/channels',
    TINODE_AUTH_TOKEN: 'service-token',
    CONVERACT_TINODE_INBOUND_INTERVAL_MS: '10'
  } as NodeJS.ProcessEnv), /INTERVAL_MS/);
});

test('Tinode inbound service projects data before deletes and releases the durable claim', async () => {
  const calls: string[] = [];
  const processed: string[] = [];
  const store = {
    async discoverTenantIds() {
      calls.push('discover');
      return ['tenant-inbound'];
    },
    async claimNext() {
      calls.push('claim');
      return CLAIM;
    },
    async processEvent(_claim: unknown, event: any, project: (pg: any, eventId: string) => Promise<any>) {
      processed.push(event.dedupe_key);
      const result = await project({}, `event-${event.dedupe_key}`);
      return { event_id: `event-${event.dedupe_key}`, ...result, message_id: result.message_id || '', replayed: false };
    },
    async retryDueDeadLetters() { return []; },
    async releaseClaim() {
      calls.push('release');
    },
    async recordFailure() {
      calls.push('failure');
    }
  };
  const service = new TinodeInboundService({
    store: store as any,
    source: {
      async pull(input) {
        assert.deepEqual(input, {
          provider_topic_id: 'grpInbound',
          last_data_seq: 0,
          last_del_id: 0,
          limit: 25
        });
        return [
          { meta: { topic: 'grpInbound', del: { clear: 1, delseq: [{ low: 1, hi: 3 }] } } },
          { data: { topic: 'grpInbound', seq: 2, from: 'usrCustomer', content: 'second' } },
          { data: { topic: 'grpInbound', seq: 1, from: 'usrCustomer', content: 'first' } }
        ];
      }
    },
    projector: {
      async project(_pg, _claim, event) {
        calls.push(`project:${event.dedupe_key}`);
        return { status: event.kind === 'delete' ? 'ignored' : 'projected', message_id: `message-${event.dedupe_key}` };
      }
    } as any,
    config: {
      tenantLimit: 10,
      pullLimit: 25,
      claimLeaseMs: 60_000,
      retryDelayMs: 5_000,
      deadLetterMaxAttempts: 3,
      allowedAttachmentHosts: ['files.example.com']
    }
  });

  assert.deepEqual(await service.runDue(), {
    tenants: 1,
    claimed: 1,
    packets: 3,
    retried: 0,
    projected: 2,
    ignored: 1,
    dead_letter: 0,
    failed: 0
  });
  assert.deepEqual(processed, ['data:1', 'data:2', 'delete:1']);
  assert.deepEqual(calls, [
    'discover',
    'claim',
    'project:data:1',
    'project:data:2',
    'project:delete:1',
    'release'
  ]);
});

test('Tinode inbound service records provider failure and leaves cursor retry to the store', async () => {
  const failures: unknown[] = [];
  let released = false;
  const service = new TinodeInboundService({
    store: {
      async discoverTenantIds() { return ['tenant-inbound']; },
      async claimNext() { return CLAIM; },
      async processEvent() { throw new Error('not reached'); },
      async retryDueDeadLetters() { return []; },
      async releaseClaim() { released = true; },
      async recordFailure(claim: unknown, error: unknown, delay: number) {
        failures.push({ claim, error: error instanceof Error ? error.message : String(error), delay });
      }
    } as any,
    source: {
      async pull() { throw new Error('token=must-not-leak provider unavailable'); }
    },
    projector: {} as any,
    config: {
      tenantLimit: 10,
      pullLimit: 25,
      claimLeaseMs: 60_000,
      retryDelayMs: 8_000,
      deadLetterMaxAttempts: 3,
      allowedAttachmentHosts: []
    }
  });

  assert.deepEqual(await service.runDue(), {
    tenants: 1,
    claimed: 1,
    packets: 0,
    retried: 0,
    projected: 0,
    ignored: 0,
    dead_letter: 0,
    failed: 1
  });
  assert.equal(released, false);
  assert.deepEqual(failures, [{ claim: CLAIM, error: 'token=must-not-leak provider unavailable', delay: 8_000 }]);
});

test('Tinode inbound service dead-letters a poison packet and continues with the next sequence', async () => {
  const calls: string[] = [];
  const service = new TinodeInboundService({
    store: {
      async discoverTenantIds() { return ['tenant-inbound']; },
      async claimNext() { return CLAIM; },
      async processEvent(_claim: unknown, event: any, project: (pg: any, id: string) => Promise<any>) {
        calls.push(`process:${event.dedupe_key}`);
        const projected = await project({}, `event-${event.dedupe_key}`);
        return { event_id: 'event-valid', ...projected, message_id: projected.message_id || '', replayed: false };
      },
      async retryDueDeadLetters() { return []; },
      async rejectEvent(_claim: unknown, event: any) {
        calls.push(`reject:${event.dedupe_key}:${event.error_code}`);
        assert.equal(JSON.stringify(event).includes('private-inline-bytes'), false);
        return { event_id: 'event-rejected', status: 'dead_letter', message_id: '', replayed: false };
      },
      async releaseClaim() { calls.push('release'); },
      async recordFailure() { calls.push('failure'); }
    } as any,
    source: {
      async pull() {
        return [
          {
            data: {
              topic: 'grpInbound',
              seq: 1,
              from: 'usrCustomer',
              content: { txt: '', ent: [{ tp: 'IM', data: { val: 'private-inline-bytes' } }] }
            }
          },
          { data: { topic: 'grpInbound', seq: 2, from: 'usrCustomer', content: 'continues' } }
        ];
      }
    },
    projector: {
      async project() {
        calls.push('project:data:2');
        return { status: 'projected', message_id: 'message-2' };
      }
    } as any,
    config: {
      tenantLimit: 10,
      pullLimit: 25,
      claimLeaseMs: 60_000,
      retryDelayMs: 8_000,
      deadLetterMaxAttempts: 3,
      allowedAttachmentHosts: []
    }
  });

  assert.deepEqual(await service.runDue(), {
    tenants: 1,
    claimed: 1,
    packets: 2,
    retried: 0,
    projected: 1,
    ignored: 0,
    dead_letter: 1,
    failed: 0
  });
  assert.deepEqual(calls, [
    'reject:data:1:embedded_attachment_not_supported',
    'process:data:2',
    'project:data:2',
    'release'
  ]);
});

test('Tinode inbound service stores terminal attachment imports as safe dead letters', async () => {
  const rejected: unknown[] = [];
  const service = new TinodeInboundService({
    store: {
      async discoverTenantIds() { return ['tenant-inbound']; },
      async claimNext() { return CLAIM; },
      async retryDueDeadLetters() { return []; },
      async processEvent() { throw new Error('must not project'); },
      async rejectEvent(_claim: unknown, event: unknown) {
        rejected.push(event);
        return { event_id: 'event-import-rejected', status: 'dead_letter', message_id: '', replayed: false };
      },
      async releaseClaim() {},
      async recordFailure() { throw new Error('must not delay cursor'); }
    } as any,
    source: {
      async pull() {
        return [{
          data: {
            topic: 'grpInbound', seq: 5, from: 'usrCustomer',
            content: {
              txt: 'file',
              ent: [{
                tp: 'EX',
                data: { ref: 'https://files.example.com/private.bin', name: 'private.bin' }
              }]
            }
          }
        }];
      }
    },
    projector: {} as any,
    prepareEvent: async () => {
      throw new TinodeInboundAttachmentImportError('attachment_too_large', false);
    },
    config: {
      tenantLimit: 10, pullLimit: 25, claimLeaseMs: 60_000,
      retryDelayMs: 8_000, deadLetterMaxAttempts: 3,
      allowedAttachmentHosts: ['files.example.com']
    }
  });

  const summary = await service.runDue();
  assert.equal(summary.dead_letter, 1);
  assert.equal(summary.failed, 0);
  assert.equal(JSON.stringify(rejected).includes('files.example.com'), false);
  assert.match(JSON.stringify(rejected), /attachment_too_large/);
});

test('Tinode inbound service retries due projection dead letters inside the binding claim', async () => {
  const calls: string[] = [];
  const retryEvent = {
    kind: 'data' as const,
    provider_sequence: 7,
    provider_delete_id: 0 as const,
    dedupe_key: 'data:7',
    payload_hash: 'a'.repeat(64),
    payload: {
      topic: 'grpInbound',
      seq: 7,
      from: 'usrCustomer',
      ts: '',
      head: { opc_message_id: '', opc_idempotency_key: '', replace: '' },
      body: 'retry me',
      attachments: []
    }
  };
  const service = new TinodeInboundService({
    store: {
      async discoverTenantIds() { return ['tenant-inbound']; },
      async claimNext() { return CLAIM; },
      async retryDueDeadLetters(_claim: unknown, options: any, project: any) {
        assert.deepEqual(options, { limit: 25, maxAttempts: 3, retryDelayMs: 8_000 });
        const projection = await project({}, retryEvent, 'event-retry-7');
        return [{
          event: retryEvent,
          result: { event_id: 'event-retry-7', ...projection, message_id: projection.message_id || '', replayed: true }
        }];
      },
      async processEvent() { throw new Error('not reached'); },
      async rejectEvent() { throw new Error('not reached'); },
      async releaseClaim() { calls.push('release'); },
      async recordFailure() { calls.push('failure'); }
    } as any,
    source: {
      async pull() { return []; }
    },
    projector: {
      async project() {
        calls.push('project:data:7');
        return { status: 'projected', message_id: 'message-7' };
      }
    } as any,
    config: {
      tenantLimit: 10,
      pullLimit: 25,
      claimLeaseMs: 60_000,
      retryDelayMs: 8_000,
      deadLetterMaxAttempts: 3,
      allowedAttachmentHosts: []
    }
  });

  assert.deepEqual(await service.runDue(), {
    tenants: 1,
    claimed: 1,
    packets: 0,
    retried: 1,
    projected: 1,
    ignored: 0,
    dead_letter: 0,
    failed: 0
  });
  assert.deepEqual(calls, ['project:data:7', 'release']);
});

test('Tinode inbound worker coalesces overlapping runs', async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const worker = new TinodeInboundWorker({
    config: { enabled: true, intervalMs: 1_000 },
    runBatch: async () => {
      calls += 1;
      await gate;
      return EMPTY_RESULT;
    }
  });

  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.equal(calls, 1);
  release?.();
  assert.deepEqual(await first, EMPTY_RESULT);
  assert.deepEqual(await second, EMPTY_RESULT);
  assert.equal(calls, 1);
  await worker.stop();
});
