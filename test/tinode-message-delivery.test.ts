import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type {
  ChatGateway,
  ChatParticipantInput,
  ChatPublishInput,
  ChatPublishResult,
  ChatTopicBinding,
  ChatTopicInput,
  ChatUserBinding,
  ChatUserInput
} from '../src/agent-runtime/collaboration/chat-gateway.js';
import { withCollaborationSessionLock } from '../src/agent-runtime/collaboration/collaboration-lock.js';
import { closeCollaborationSession } from '../src/agent-runtime/collaboration/collaboration-session-lifecycle.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import { TinodeProviderUserStore } from '../src/agent-runtime/collaboration/tinode-provider-user-store.js';
import { routeIveKitChatApi } from '../src/agent-runtime/converact/chat-http.js';
import {
  TinodeMessageDeliveryService,
  type TinodeDeliveryRunSummary
} from '../src/agent-runtime/collaboration/tinode-message-delivery.js';
import { MemoryPg } from '../src/db-pg.js';

class SequenceTinodeGateway implements ChatGateway {
  readonly provider = 'tinode' as const;
  readonly published: ChatPublishInput[] = [];
  beforePublish?: () => Promise<void>;

  constructor(private readonly outcomes: Array<ChatPublishResult | Error>) {}

  async ensureTopic(input: ChatTopicInput): Promise<ChatTopicBinding> {
    return {
      provider: 'tinode',
      provider_topic_id: `grp_${input.session_id}`,
      provider_status: 'bound',
      metadata: {}
    };
  }

  async ensureUser(input: ChatUserInput): Promise<ChatUserBinding> {
    return { provider_user_id: `usr_${input.identity}`, metadata: {} };
  }

  async addParticipant(_input: ChatParticipantInput): Promise<void> {}

  async removeParticipant(_input: ChatParticipantInput): Promise<void> {}

  async publishMessage(input: ChatPublishInput): Promise<ChatPublishResult> {
    this.published.push(input);
    const outcome = this.outcomes.shift();
    await this.beforePublish?.();
    if (outcome instanceof Error) throw outcome;
    return outcome || publishedResult(input.provider_topic_id, String(this.published.length));
  }
}

function publishedResult(providerTopicId: string, providerMessageId: string): ChatPublishResult {
  return {
    provider: 'tinode',
    provider_topic_id: providerTopicId,
    provider_message_id: providerMessageId,
    provider_sync_status: 'published',
    metadata: { protocol: 'fake_tinode' }
  };
}

async function fixture(options: {
  outcomes: Array<ChatPublishResult | Error>;
  maxAttempts?: number;
  onDeliveryUpdated?: (message: import('../src/agent-runtime/collaboration/types.js').CollaborationMessage) => void | Promise<void>;
}) {
  const pg = new MemoryPg();
  const module = createCollaborationModule({ pg });
  const session = await module.sessions.openSession({
    tenant_id: 'tenant_delivery',
    business_ref: {
      tenant_id: 'tenant_delivery',
      type: 'service_order',
      id: 'order_delivery'
    }
  });
  const gateway = new SequenceTinodeGateway(options.outcomes);
  let nowMs = Date.parse('2026-07-10T00:00:00.000Z');
  const service = new TinodeMessageDeliveryService({
    pg,
    gateway,
    now: () => new Date(nowMs),
    retryDelaysMs: [1_000, 2_000],
    maxAttempts: options.maxAttempts ?? 3,
    claimLeaseMs: 5_000,
    onDeliveryUpdated: options.onDeliveryUpdated
  });
  const input = {
    tenant_id: 'tenant_delivery',
    session_id: session.id,
    sender_identity: 'customer_1',
    message_type: 'text' as const,
    body: 'Call me at 555-456-7890',
    provider_topic_id: 'grp_delivery',
    provider_payload: 'Call me at 555-456-7890',
    idempotency_key: 'led-message-1'
  };
  return {
    pg,
    module,
    session,
    gateway,
    service,
    input,
    advance(ms: number) {
      nowMs += ms;
    }
  };
}

test('Tinode delivery persists and scans a message before a failed provider publish', async () => {
  const f = await fixture({ outcomes: [new Error('socket reset by peer')] });
  f.gateway.beforePublish = async () => {
    const messages = await f.module.sessions.listMessages({
      tenant_id: f.input.tenant_id,
      session_id: f.input.session_id
    });
    const policy = await f.module.sessions.listPolicyEvents({
      tenant_id: f.input.tenant_id,
      session_id: f.input.session_id
    });
    assert.equal(messages.length, 1);
    assert.equal(policy.some((event) => event.message_id === messages[0]?.id), true);
  };

  const result = await f.service.createAndDeliver(f.input);

  assert.equal(result.created, true);
  assert.equal(result.replayed, false);
  assert.equal(result.policy.matched, true);
  assert.equal(result.message.provider_delivery.status, 'retry_wait');
  assert.equal(result.message.provider_delivery.attempt_count, 1);
  assert.ok(result.message.provider_delivery.next_attempt_at);
  assert.equal(result.message.provider_delivery.last_error_code, 'provider_unavailable');
  assert.match(result.message.provider_delivery.last_error_message, /socket reset/);
  const attempts = await f.service.listAttempts({
    tenant_id: f.input.tenant_id,
    message_id: result.message.id
  });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.status, 'retry_wait');
});

test('Tinode delivery retries due work and does not republish a delivered message', async () => {
  const f = await fixture({
    outcomes: [
      new Error('temporary network failure'),
      publishedResult('grp_delivery', 'seq-2')
    ]
  });
  const created = await f.service.createAndDeliver(f.input);
  assert.equal(created.message.provider_delivery.status, 'retry_wait');

  f.advance(1_001);
  const firstRun = await f.service.runDue({ limit: 10 });
  assert.deepEqual(firstRun, {
    examined: 1,
    claimed: 1,
    delivered: 1,
    retry_wait: 0,
    failed: 0
  } satisfies TinodeDeliveryRunSummary);

  const delivered = await f.service.getMessage({
    tenant_id: f.input.tenant_id,
    message_id: created.message.id
  });
  assert.equal(delivered?.provider_delivery.status, 'delivered');
  assert.equal(delivered?.provider_delivery.attempt_count, 2);
  assert.equal(delivered?.provider_delivery.provider_message_id, 'seq-2');
  assert.equal(delivered?.provider_delivery.metadata.protocol, 'fake_tinode');
  assert.equal(delivered?.metadata.provider_metadata && (delivered.metadata.provider_metadata as Record<string, unknown>).protocol, 'fake_tinode');
  assert.ok(delivered?.provider_delivery.delivered_at);

  f.advance(10_000);
  assert.deepEqual(await f.service.runDue({ limit: 10 }), {
    examined: 0,
    claimed: 0,
    delivered: 0,
    retry_wait: 0,
    failed: 0
  } satisfies TinodeDeliveryRunSummary);
  assert.equal(f.gateway.published.length, 2);
});

test('delivery callback failures occur after commit and cannot republish the provider message', async () => {
  const f = await fixture({
    outcomes: [
      new Error('temporary network failure'),
      publishedResult('grp_delivery', 'seq-callback-committed')
    ],
    onDeliveryUpdated: (message) => {
      if (message.provider_delivery.status === 'delivered') {
        throw new Error('application callback failed');
      }
    }
  });
  const created = await f.service.createAndDeliver(f.input);
  assert.equal(created.message.provider_delivery.status, 'retry_wait');
  f.advance(1_001);

  await assert.rejects(
    () => f.service.runDue({ limit: 10 }),
    /application callback failed/
  );
  const committed = await f.service.getMessage({
    tenant_id: f.input.tenant_id,
    message_id: created.message.id
  });
  assert.equal(committed?.provider_delivery.status, 'delivered');
  assert.equal(committed?.provider_delivery.provider_message_id, 'seq-callback-committed');
  assert.equal((await f.service.runDue({ limit: 10 })).examined, 0);
  assert.equal(f.gateway.published.length, 2);
});

test('Tinode delivery rejects new messages after the collaboration session closes', async () => {
  const f = await fixture({ outcomes: [publishedResult('grp_delivery', 'seq-closed')] });
  await new CollaborationStore(f.pg).closeSession(f.input.session_id);

  await assert.rejects(
    () => f.service.createAndDeliver(f.input),
    (error: unknown) =>
      (error as { status?: number }).status === 409 &&
      /session is closed/.test(String((error as Error).message))
  );
  assert.equal(f.gateway.published.length, 0);
  assert.deepEqual(await f.module.sessions.listMessages({
    tenant_id: f.input.tenant_id,
    session_id: f.input.session_id
  }), []);
});

test('Tinode delivery does not retry queued messages after the collaboration session closes', async () => {
  const f = await fixture({
    outcomes: [
      new Error('temporary network failure'),
      publishedResult('grp_delivery', 'seq-must-not-publish')
    ]
  });
  const created = await f.service.createAndDeliver(f.input);
  assert.equal(created.message.provider_delivery.status, 'retry_wait');
  await new CollaborationStore(f.pg).closeSession(f.input.session_id);
  f.advance(1_001);

  assert.deepEqual(await f.service.runDue({ limit: 10 }), {
    examined: 0,
    claimed: 0,
    delivered: 0,
    retry_wait: 0,
    failed: 0
  } satisfies TinodeDeliveryRunSummary);
  await assert.rejects(
    () => f.service.retryMessage({
      tenant_id: f.input.tenant_id,
      message_id: created.message.id
    }),
    (error: unknown) =>
      (error as { status?: number }).status === 409 &&
      /session is closed/.test(String((error as Error).message))
  );
  assert.equal(f.gateway.published.length, 1);
});

test('Tinode lifecycle close terminalizes queued provider delivery', async () => {
  const f = await fixture({ outcomes: [new Error('temporary network failure')] });
  const store = new CollaborationStore(f.pg);
  await store.addParticipant({
    tenant_id: f.input.tenant_id,
    session_id: f.input.session_id,
    identity: f.input.sender_identity,
    role: 'customer'
  });
  const binding = await store.ensureChatBinding({
    tenant_id: f.input.tenant_id,
    session_id: f.input.session_id,
    provider: 'tinode',
    provider_topic_id: f.input.provider_topic_id
  });
  await new TinodeProviderUserStore(f.pg).upsert({
    tenant_id: f.input.tenant_id,
    session_id: f.input.session_id,
    binding_id: binding.id,
    provider_user_id: 'usr_customer_1',
    identity: f.input.sender_identity
  });
  const created = await f.service.createAndDeliver(f.input);
  assert.equal(created.message.provider_delivery.status, 'retry_wait');

  const closed = await closeCollaborationSession({
    pg: f.pg,
    tenant_id: f.input.tenant_id,
    session_id: f.input.session_id,
    actor_identity: f.input.sender_identity,
    gateway: f.gateway
  });
  assert.equal(closed.ok, true);
  const message = await f.service.getMessage({
    tenant_id: f.input.tenant_id,
    message_id: created.message.id
  });
  assert.equal(message?.provider_delivery.status, 'failed');
  assert.equal(message?.provider_delivery.last_error_code, 'session_closed');
  assert.equal((await f.service.runDue({ limit: 10 })).examined, 0);
  assert.equal(f.gateway.published.length, 1);
});

test('Tinode retry delivery holds a shared collaboration session lock while publishing', async () => {
  const f = await fixture({
    outcomes: [
      new Error('temporary network failure'),
      publishedResult('grp_delivery', 'seq-after-lock')
    ]
  });
  await f.service.createAndDeliver(f.input);
  f.advance(1_001);
  let publishEntered!: () => void;
  let releasePublish!: () => void;
  const entered = new Promise<void>((resolve) => {
    publishEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releasePublish = resolve;
  });
  f.gateway.beforePublish = async () => {
    publishEntered();
    await gate;
  };

  const retry = f.service.runDue({ limit: 10 });
  await entered;
  await assert.rejects(
    () => withCollaborationSessionLock(f.pg, {
      tenantId: f.input.tenant_id,
      sessionId: f.input.session_id,
      mode: 'exclusive'
    }, async () => undefined),
    (error: unknown) =>
      (error as { code?: string }).code === 'collaboration_session_busy'
  );
  releasePublish();
  assert.equal((await retry).delivered, 1);
});

test('Tinode delivery uses a client idempotency key without duplicate policy or provider work', async () => {
  const f = await fixture({ outcomes: [publishedResult('grp_delivery', 'seq-1')] });
  const first = await f.service.createAndDeliver(f.input);
  const replay = await f.service.createAndDeliver(f.input);

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.message.id, first.message.id);
  assert.equal(replay.message.provider_delivery.status, 'delivered');
  assert.equal(f.gateway.published.length, 1);
  const messages = await f.module.sessions.listMessages({
    tenant_id: f.input.tenant_id,
    session_id: f.input.session_id
  });
  const policy = await f.module.sessions.listPolicyEvents({
    tenant_id: f.input.tenant_id,
    session_id: f.input.session_id
  });
  assert.equal(messages.length, 1);
  assert.equal(policy.length, 1);

  await assert.rejects(
    f.service.createAndDeliver({ ...f.input, body: 'different body', provider_payload: 'different body' }),
    (error: Error & { status?: number }) => error.status === 409 && /idempotency/i.test(error.message)
  );
});

test('Tinode delivery becomes terminal after the configured attempt limit', async () => {
  const f = await fixture({
    outcomes: [new Error('network down'), new Error('network still down')],
    maxAttempts: 2
  });
  const created = await f.service.createAndDeliver(f.input);
  assert.equal(created.message.provider_delivery.status, 'retry_wait');

  f.advance(1_001);
  const summary = await f.service.runDue({ limit: 10 });
  assert.equal(summary.failed, 1);
  const failed = await f.service.getMessage({
    tenant_id: f.input.tenant_id,
    message_id: created.message.id
  });
  assert.equal(failed?.provider_delivery.status, 'failed');
  assert.equal(failed?.provider_delivery.attempt_count, 2);

  f.advance(10_000);
  assert.equal((await f.service.runDue({ limit: 10 })).claimed, 0);
  assert.equal(f.gateway.published.length, 2);
});

test('Tinode delivery ignores a stale completion after a lease reclaim', async () => {
  const f = await fixture({
    outcomes: [
      publishedResult('grp_delivery', 'seq-stale'),
      publishedResult('grp_delivery', 'seq-current')
    ]
  });
  let enteredResolve: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  let releaseResolve: (() => void) | undefined;
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  f.gateway.beforePublish = async () => {
    enteredResolve?.();
    await release;
  };

  const stale = f.service.createAndDeliver(f.input);
  await entered;
  f.advance(5_001);
  assert.equal((await f.service.runDue({ limit: 10 })).claimed, 0);

  f.gateway.beforePublish = undefined;
  f.advance(1_001);
  assert.equal((await f.service.runDue({ limit: 10 })).delivered, 1);
  releaseResolve?.();
  await stale;

  const message = await f.service.getMessage({
    tenant_id: f.input.tenant_id,
    message_id: (await f.module.sessions.listMessages({
      tenant_id: f.input.tenant_id,
      session_id: f.input.session_id
    }))[0]!.id
  });
  assert.equal(message?.provider_delivery.status, 'delivered');
  assert.equal(message?.provider_delivery.provider_message_id, 'seq-current');
  const attempts = await f.service.listAttempts({
    tenant_id: f.input.tenant_id,
    message_id: message!.id
  });
  assert.deepEqual(attempts.map((attempt) => attempt.status), ['lease_expired', 'delivered']);
});

test('Tinode delivery redacts provider credentials from persisted errors', async () => {
  const f = await fixture({
    outcomes: [new Error('authorization=Bearer super-secret token=abc123 password=hunter2')]
  });
  const result = await f.service.createAndDeliver(f.input);
  const errorMessage = result.message.provider_delivery.last_error_message;
  assert.equal(errorMessage.includes('super-secret'), false);
  assert.equal(errorMessage.includes('abc123'), false);
  assert.equal(errorMessage.includes('hunter2'), false);
  assert.match(errorMessage, /\[redacted\]/);
});

test('Tinode delivery migration exposes the durable outbox contract', () => {
  const migration = readFileSync('src/migrations/025_collaboration_message_delivery.sql', 'utf8');

  assert.match(migration, /provider_delivery_status/i);
  assert.match(migration, /provider_delivery_attempts/i);
  assert.match(migration, /provider_delivery_claim_token_hash/i);
  assert.match(migration, /collaboration_message_delivery_attempts/i);
  assert.match(migration, /idempotency_key/i);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
  assert.match(migration, /CREATE UNIQUE INDEX[\s\S]+idempotency_key/i);
});

test('iveKit chat message API exposes durable failure and idempotent delivery status', async () => {
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'tinode-delivery-test-key';
  const pg = new MemoryPg();
  const module = createCollaborationModule({ pg });
  const session = await module.sessions.openSession({
    tenant_id: 'tenant_delivery_http',
    business_ref: {
      tenant_id: 'tenant_delivery_http',
      type: 'service_order',
      id: 'order_delivery_http'
    }
  });
  const gateway = new SequenceTinodeGateway([
    new Error('tinode unavailable'),
    publishedResult('grp_delivery_http', 'seq-http-2')
  ]);
  let nowMs = Date.parse('2026-07-10T00:00:00.000Z');
  const headers = {
    'X-API-Key': 'tinode-delivery-test-key',
    'X-Tenant-Id': 'tenant_delivery_http',
    'X-User-Id': 'led_backend',
    'Idempotency-Key': 'led-http-message-1'
  };
  const path = `/api/ivekit/chat/sessions/${session.id}/messages`;
  const options = {
    chatGateway: gateway,
    tinodeDelivery: {
      now: () => new Date(nowMs),
      retryDelaysMs: [1_000],
      maxAttempts: 3,
      claimLeaseMs: 5_000
    }
  };
  try {
    const posted = await routeIveKitChatApi(
      pg,
      'POST',
      path,
      new URL(`http://localhost${path}`),
      { sender_identity: 'customer_http', body: 'phone 555-123-4567' },
      '',
      headers,
      options
    ) as {
      status: number;
      data: {
        idempotency_replayed: boolean;
        message: { id: string; provider_delivery: { status: string; attempt_count: number } };
      };
    };
    assert.equal(posted.status, 202);
    assert.equal(posted.data.idempotency_replayed, false);
    assert.equal(posted.data.message.provider_delivery.status, 'retry_wait');
    assert.equal(posted.data.message.provider_delivery.attempt_count, 1);

    const replay = await routeIveKitChatApi(
      pg,
      'POST',
      path,
      new URL(`http://localhost${path}`),
      { sender_identity: 'customer_http', body: 'phone 555-123-4567' },
      '',
      headers,
      options
    ) as { status: number; data: { idempotency_replayed: boolean; message: { id: string } } };
    assert.equal(replay.status, 200);
    assert.equal(replay.data.idempotency_replayed, true);
    assert.equal(replay.data.message.id, posted.data.message.id);
    assert.equal(gateway.published.length, 1);

    const deliveryPath = `${path}/${posted.data.message.id}/delivery`;
    const delivery = await routeIveKitChatApi(
      pg,
      'GET',
      deliveryPath,
      new URL(`http://localhost${deliveryPath}`),
      null,
      '',
      headers,
      options
    ) as {
      data: {
        message_id: string;
        delivery: { status: string };
        attempts: Array<{ status: string }>;
      };
    };
    assert.equal(delivery.data.message_id, posted.data.message.id);
    assert.equal(delivery.data.delivery.status, 'retry_wait');
    assert.equal(delivery.data.attempts[0]?.status, 'retry_wait');

    nowMs += 1_001;
    const retried = await routeIveKitChatApi(
      pg,
      'POST',
      `${deliveryPath}/retry`,
      new URL(`http://localhost${deliveryPath}/retry`),
      null,
      '',
      headers,
      options
    ) as { data: { delivery: { status: string; provider_message_id: string }; attempts: unknown[] } };
    assert.equal(retried.data.delivery.status, 'delivered');
    assert.equal(retried.data.delivery.provider_message_id, 'seq-http-2');
    assert.equal(retried.data.attempts.length, 2);

    const crossTenant = await routeIveKitChatApi(
      pg,
      'GET',
      deliveryPath,
      new URL(`http://localhost${deliveryPath}`),
      null,
      '',
      { ...headers, 'X-Tenant-Id': 'tenant_delivery_other' },
      options
    );
    assert.deepEqual(crossTenant, {
      status: 404,
      data: { error: 'collaboration message not found' }
    });
  } finally {
    if (previousApiKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previousApiKey;
  }
});
