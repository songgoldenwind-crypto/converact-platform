import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

import { canonicalSha256 } from '../canonical-json.js';

export interface TinodeShardInput {
  endpoint: string;
  api_key: string;
  run_id: string;
  shard_id: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  worker_id: string;
  lease_epoch: string;
  auth_for_ordinal(ordinal: number): {
    scheme: 'token' | 'basic';
    secret: string;
  } | Promise<{ scheme: 'token' | 'basic'; secret: string }>;
  topic_for_ordinal(ordinal: number): string | Promise<string>;
  messages_per_interaction: number;
  body_for_message(ordinal: number, messageIndex: number): string;
  presence_enabled: boolean;
  typing_enabled: boolean;
  receipts_enabled: boolean;
  maximum_reconnects: number;
  reconnect_delay_ms: number;
  request_timeout_ms: number;
  send_to_ack_p95_limit_ms: number;
  send_to_ack_p99_limit_ms: number;
  send_to_delivery_p95_limit_ms: number;
  send_to_delivery_p99_limit_ms: number;
  delivery_settle_ms: number;
  offline_recovery_message_count: number;
  offline_recovery_p99_limit_ms: number;
  concurrency: number;
}

export interface TinodeShardResult {
  protocol: 'tinode_websocket';
  evidence_level: 'controlled';
  status: 'controlled_pass' | 'controlled_failed';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  attempted_count: number;
  accepted_count: number;
  active_peak_count: number;
  closed_count: number;
  socket_attempt_count: number;
  reconnect_count: number;
  published_message_count: number;
  presence_query_count: number;
  typing_note_count: number;
  receipt_note_count: number;
  send_to_ack_sample_count: number;
  send_to_ack_p50_ms: number;
  send_to_ack_p95_ms: number;
  send_to_ack_p99_ms: number;
  delivered_message_count: number;
  send_to_delivery_sample_count: number;
  send_to_delivery_p50_ms: number;
  send_to_delivery_p95_ms: number;
  send_to_delivery_p99_ms: number;
  durable_message_loss_count: number;
  duplicate_message_count: number;
  out_of_order_message_count: number;
  offline_recovery_attempt_count: number;
  offline_recovery_success_count: number;
  offline_recovered_message_count: number;
  offline_recovery_duplicate_count: number;
  offline_recovery_out_of_order_count: number;
  offline_recovery_wire_out_of_order_count: number;
  offline_recovery_p99_ms: number;
  offline_recovery_journal_sha256: string;
  quality_gate_passed: boolean;
  quality_reasons: string[];
  error_count: number;
  errors: string[];
  elapsed_ms: number;
  journal_sha256: string;
}

export interface TinodeConnectionShardInput {
  endpoint: string;
  api_key: string;
  run_id: string;
  shard_id: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  worker_id: string;
  lease_epoch: string;
  auth_for_ordinal(ordinal: number): {
    scheme: 'token' | 'basic';
    secret: string;
  } | Promise<{ scheme: 'token' | 'basic'; secret: string }>;
  topic_for_ordinal(ordinal: number): string | Promise<string>;
  presence_enabled: boolean;
  typing_enabled: boolean;
  maximum_reconnects: number;
  reconnect_delay_ms: number;
  request_timeout_ms: number;
  connection_hold_ms: number;
  activity_interval_ms: number;
  concurrency: number;
}

export interface TinodeConnectionShardResult {
  protocol: 'tinode_websocket';
  evidence_level: 'controlled';
  status: 'controlled_pass' | 'controlled_failed';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  attempted_count: number;
  accepted_count: number;
  active_peak_count: number;
  closed_count: number;
  socket_attempt_count: number;
  reconnect_count: number;
  presence_query_count: number;
  activity_note_count: number;
  error_count: number;
  errors: string[];
  elapsed_ms: number;
  journal_sha256: string;
}

interface TinodeClientResult {
  accepted: boolean;
  socketAttempts: number;
  reconnects: number;
  published: number;
  presenceQueries: number;
  typingNotes: number;
  receiptNotes: number;
  sendToAckLatencies: number[];
  delivered: number;
  sendToDeliveryLatencies: number[];
  duplicateMessages: number;
  outOfOrderMessages: number;
  errors: string[];
  journal: Array<{
    ordinal: number;
    message_index: number;
    message_id: string;
    topic: string;
    provider_sequence: string;
  }>;
}

interface TinodeOpenedConnection {
  ordinal: number;
  topic: string;
  session: TinodeWireSession | null;
  socketAttempts: number;
  reconnects: number;
  presenceQueries: number;
  activityNotes: number;
  errors: string[];
}

interface TinodeDelivery {
  messageId: string;
  sequence: number;
  receivedAt: number;
}

interface TinodeOfflineRecoveryResult {
  attempted: number;
  succeeded: number;
  recovered: number;
  duplicateCount: number;
  outOfOrderCount: number;
  wireOutOfOrderCount: number;
  recoveryLatencies: number[];
  errors: string[];
  journal: Array<{
    message_id: string;
    provider_sequence: string;
  }>;
}

export async function runTinodeInteractionShard(input: TinodeShardInput): Promise<TinodeShardResult> {
  validateInput(input);
  const startedAt = performance.now();
  let active = 0;
  let activePeak = 0;
  const ordinals = Array.from(
    { length: input.ordinal_end_exclusive - input.ordinal_start },
    (_, index) => input.ordinal_start + index
  );
  const results = await mapConcurrent(ordinals, input.concurrency, (ordinal) => runInteraction(
    input,
    ordinal,
    () => {
      active += 1;
      activePeak = Math.max(activePeak, active);
    },
    () => { active = Math.max(0, active - 1); }
  ));
  const offlineRecovery = input.offline_recovery_message_count > 0
    ? await runOfflineRecoveryProbe(input, input.ordinal_start)
    : emptyOfflineRecovery();
  const protocolErrors = [
    ...results.flatMap((result) => result.errors),
    ...offlineRecovery.errors
  ];
  const journal = results.flatMap((result) => result.journal)
    .sort((left, right) => left.ordinal - right.ordinal || left.message_index - right.message_index);
  const accepted = results.filter((result) => result.accepted).length;
  const published = sum(results, (result) => result.published);
  const expectedMessages = ordinals.length * input.messages_per_interaction;
  const expectedPresenceQueries = input.presence_enabled ? ordinals.length : 0;
  const expectedTypingNotes = input.typing_enabled ? ordinals.length : 0;
  const expectedReceiptNotes = input.receipts_enabled ? expectedMessages * 2 : 0;
  const presenceQueries = sum(results, (result) => result.presenceQueries);
  const typingNotes = sum(results, (result) => result.typingNotes);
  const receiptNotes = sum(results, (result) => result.receiptNotes);
  const sendToAckLatencies = results.flatMap((result) => result.sendToAckLatencies);
  const sendToAckP50 = quantile(sendToAckLatencies, 0.5);
  const sendToAckP95 = quantile(sendToAckLatencies, 0.95);
  const sendToAckP99 = quantile(sendToAckLatencies, 0.99);
  const delivered = sum(results, (result) => result.delivered);
  const sendToDeliveryLatencies = results.flatMap(
    (result) => result.sendToDeliveryLatencies
  );
  const sendToDeliveryP50 = quantile(sendToDeliveryLatencies, 0.5);
  const sendToDeliveryP95 = quantile(sendToDeliveryLatencies, 0.95);
  const sendToDeliveryP99 = quantile(sendToDeliveryLatencies, 0.99);
  const durableLoss = Math.max(0, expectedMessages - delivered);
  const duplicateMessages = sum(results, (result) => result.duplicateMessages);
  const outOfOrderMessages = sum(results, (result) => result.outOfOrderMessages);
  const performanceErrors: string[] = [];
  if (sendToAckLatencies.length !== expectedMessages) {
    performanceErrors.push(
      `Tinode send-to-ack sample count ${sendToAckLatencies.length} does not equal ${expectedMessages}`
    );
  }
  if (sendToAckP95 > input.send_to_ack_p95_limit_ms) {
    performanceErrors.push(
      `Tinode send-to-ack P95 ${sendToAckP95}ms exceeds ${input.send_to_ack_p95_limit_ms}ms`
    );
  }
  if (sendToAckP99 > input.send_to_ack_p99_limit_ms) {
    performanceErrors.push(
      `Tinode send-to-ack P99 ${sendToAckP99}ms exceeds ${input.send_to_ack_p99_limit_ms}ms`
    );
  }
  if (sendToDeliveryLatencies.length !== expectedMessages) {
    performanceErrors.push(
      `Tinode send-to-delivery sample count ${sendToDeliveryLatencies.length} does not equal ${expectedMessages}`
    );
  }
  if (sendToDeliveryP95 > input.send_to_delivery_p95_limit_ms) {
    performanceErrors.push(
      `Tinode send-to-delivery P95 ${sendToDeliveryP95}ms exceeds ${input.send_to_delivery_p95_limit_ms}ms`
    );
  }
  if (sendToDeliveryP99 > input.send_to_delivery_p99_limit_ms) {
    performanceErrors.push(
      `Tinode send-to-delivery P99 ${sendToDeliveryP99}ms exceeds ${input.send_to_delivery_p99_limit_ms}ms`
    );
  }
  if (durableLoss > 0) {
    performanceErrors.push(`Tinode durable message loss count is ${durableLoss}`);
  }
  if (duplicateMessages > 0) {
    performanceErrors.push(`Tinode duplicate message count is ${duplicateMessages}`);
  }
  if (outOfOrderMessages > 0) {
    performanceErrors.push(`Tinode out-of-order message count is ${outOfOrderMessages}`);
  }
  const offlineRecoveryP99 = quantile(offlineRecovery.recoveryLatencies, 0.99);
  if (input.offline_recovery_message_count > 0) {
    if (offlineRecovery.succeeded !== 1 ||
        offlineRecovery.recovered !== input.offline_recovery_message_count) {
      performanceErrors.push(
        `Tinode offline recovery restored ${offlineRecovery.recovered} of ` +
        `${input.offline_recovery_message_count} messages`
      );
    }
    if (offlineRecovery.duplicateCount > 0) {
      performanceErrors.push(
        `Tinode offline recovery duplicate count is ${offlineRecovery.duplicateCount}`
      );
    }
    if (offlineRecovery.outOfOrderCount > 0) {
      performanceErrors.push(
        `Tinode offline recovery out-of-order count is ${offlineRecovery.outOfOrderCount}`
      );
    }
    if (offlineRecoveryP99 > input.offline_recovery_p99_limit_ms) {
      performanceErrors.push(
        `Tinode offline recovery P99 ${offlineRecoveryP99}ms exceeds ` +
        `${input.offline_recovery_p99_limit_ms}ms`
      );
    }
  }
  const errors = protocolErrors.slice(0, 1_000);
  return {
    protocol: 'tinode_websocket',
    evidence_level: 'controlled',
    status: accepted === ordinals.length && published === expectedMessages &&
      presenceQueries === expectedPresenceQueries && typingNotes === expectedTypingNotes &&
      receiptNotes === expectedReceiptNotes && protocolErrors.length === 0 && performanceErrors.length === 0
      ? 'controlled_pass'
      : 'controlled_failed',
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    attempted_count: ordinals.length,
    accepted_count: accepted,
    active_peak_count: activePeak,
    closed_count: results.length,
    socket_attempt_count: sum(results, (result) => result.socketAttempts),
    reconnect_count: sum(results, (result) => result.reconnects),
    published_message_count: published,
    presence_query_count: presenceQueries,
    typing_note_count: typingNotes,
    receipt_note_count: receiptNotes,
    send_to_ack_sample_count: sendToAckLatencies.length,
    send_to_ack_p50_ms: sendToAckP50,
    send_to_ack_p95_ms: sendToAckP95,
    send_to_ack_p99_ms: sendToAckP99,
    delivered_message_count: delivered,
    send_to_delivery_sample_count: sendToDeliveryLatencies.length,
    send_to_delivery_p50_ms: sendToDeliveryP50,
    send_to_delivery_p95_ms: sendToDeliveryP95,
    send_to_delivery_p99_ms: sendToDeliveryP99,
    durable_message_loss_count: durableLoss,
    duplicate_message_count: duplicateMessages,
    out_of_order_message_count: outOfOrderMessages,
    offline_recovery_attempt_count: offlineRecovery.attempted,
    offline_recovery_success_count: offlineRecovery.succeeded,
    offline_recovered_message_count: offlineRecovery.recovered,
    offline_recovery_duplicate_count: offlineRecovery.duplicateCount,
    offline_recovery_out_of_order_count: offlineRecovery.outOfOrderCount,
    offline_recovery_wire_out_of_order_count: offlineRecovery.wireOutOfOrderCount,
    offline_recovery_p99_ms: offlineRecoveryP99,
    offline_recovery_journal_sha256: canonicalSha256(offlineRecovery.journal),
    quality_gate_passed: performanceErrors.length === 0,
    quality_reasons: performanceErrors,
    error_count: protocolErrors.length,
    errors,
    elapsed_ms: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
    journal_sha256: canonicalSha256(journal)
  };
}

async function runOfflineRecoveryProbe(
  input: TinodeShardInput,
  ordinal: number
): Promise<TinodeOfflineRecoveryResult> {
  const result = emptyOfflineRecovery();
  result.attempted = 1;
  const auth = await input.auth_for_ordinal(ordinal);
  const topic = await input.topic_for_ordinal(ordinal);
  const endpoint = endpointWithApiKey(input.endpoint, input.api_key);
  const maximumTracked = Math.max(100, input.offline_recovery_message_count * 4 + 10);
  let publisher: TinodeWireSession | null = null;
  let subscriber: TinodeWireSession | null = null;
  let recoverySubscriber: TinodeWireSession | null = null;
  try {
    publisher = new TinodeWireSession(endpoint, input.request_timeout_ms, maximumTracked);
    subscriber = new TinodeWireSession(endpoint, input.request_timeout_ms, maximumTracked);
    await connectTinodeSession(publisher, auth, topic);
    await connectTinodeSession(subscriber, auth, topic);

    const markerIdentity = `${input.run_id}/tinode_im/${ordinal}/offline-marker`;
    const markerWireId = wireMessageId(markerIdentity);
    const markerCtrl = await publisher.request('pub', {
      topic,
      noecho: false,
      head: {
        'x-opc-message-id': markerWireId,
        'x-opc-idempotency-key': markerWireId
      },
      content: 'Converact Fabric offline recovery marker'
    });
    const markerSequence = positiveSequence(markerCtrl, 'offline marker');
    const markerDelivery = await subscriber.waitForData(markerWireId);
    if (markerDelivery.sequence !== markerSequence) {
      throw new Error('Tinode offline marker acknowledgement and delivery sequence differ');
    }
    await subscriber.closeGracefully();
    subscriber = null;

    const expected: Array<{
      wireId: string;
      messageId: string;
      sequence: number;
    }> = [];
    for (let index = 0; index < input.offline_recovery_message_count; index += 1) {
      const messageId =
        `${input.run_id}/tinode_im/${ordinal}/offline-recovery/${index}`;
      const wireId = wireMessageId(messageId);
      const ctrl = await publisher.request('pub', {
        topic,
        noecho: false,
        head: {
          'x-opc-message-id': wireId,
          'x-opc-idempotency-key': wireId
        },
        content: `Converact Fabric offline recovery ${index}`
      });
      const sequence = positiveSequence(ctrl, `offline recovery ${index}`);
      expected.push({ wireId, messageId, sequence });
      result.journal.push({
        message_id: messageId,
        provider_sequence: String(sequence)
      });
    }

    const recoveryStartedAt = performance.now();
    recoverySubscriber = new TinodeWireSession(
      endpoint,
      input.request_timeout_ms,
      maximumTracked
    );
    await recoverySubscriber.open();
    await recoverySubscriber.request('hi', {
      ver: '0.22',
      ua: 'Converact Fabric capacity generator'
    });
    await recoverySubscriber.request('login', auth);
    await recoverySubscriber.request('sub', {
      topic,
      get: {
        what: 'data',
        data: {
          since: markerSequence + 1,
          limit: input.offline_recovery_message_count + 10
        }
      }
    });
    for (const message of expected) {
      const delivery = await recoverySubscriber.waitForData(message.wireId);
      if (delivery.sequence !== message.sequence) {
        throw new Error('Tinode offline recovery sequence differs from publish acknowledgement');
      }
      result.recovered += 1;
    }
    result.recoveryLatencies.push(
      roundMilliseconds(performance.now() - recoveryStartedAt)
    );
    if (input.delivery_settle_ms > 0) await delay(input.delivery_settle_ms);
    const stats = recoverySubscriber.deliveryStats(
      expected.map((message) => message.wireId)
    );
    result.duplicateCount = stats.duplicateCount;
    result.wireOutOfOrderCount = stats.outOfOrderCount;
    result.outOfOrderCount = countSequenceRegressions(
      expected.map((message) => message.sequence)
    );
    if (result.recovered === input.offline_recovery_message_count &&
        result.duplicateCount === 0 && result.outOfOrderCount === 0) {
      result.succeeded = 1;
    }
  } catch (error) {
    result.errors.push(
      `offline recovery: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    for (const session of [recoverySubscriber, subscriber, publisher]) {
      session?.close();
    }
  }
  return result;
}

async function connectTinodeSession(
  session: TinodeWireSession,
  auth: { scheme: 'token' | 'basic'; secret: string },
  topic: string
): Promise<void> {
  await session.open();
  await session.request('hi', { ver: '0.22', ua: 'Converact Fabric capacity generator' });
  await session.request('login', auth);
  await session.request('sub', { topic });
}

function emptyOfflineRecovery(): TinodeOfflineRecoveryResult {
  return {
    attempted: 0,
    succeeded: 0,
    recovered: 0,
    duplicateCount: 0,
    outOfOrderCount: 0,
    wireOutOfOrderCount: 0,
    recoveryLatencies: [],
    errors: [],
    journal: []
  };
}

export async function runTinodeConnectionShard(
  input: TinodeConnectionShardInput
): Promise<TinodeConnectionShardResult> {
  validateConnectionInput(input);
  const startedAt = performance.now();
  const ordinals = Array.from(
    { length: input.ordinal_end_exclusive - input.ordinal_start },
    (_, index) => input.ordinal_start + index
  );
  const opened = await mapConcurrent(
    ordinals,
    input.concurrency,
    (ordinal) => openConnection(input, ordinal)
  );
  const active = opened.filter(
    (connection): connection is TinodeOpenedConnection & { session: TinodeWireSession } =>
      connection.session !== null
  );
  const activityErrors: string[] = [];
  const holdDeadline = performance.now() + input.connection_hold_ms;
  do {
    await mapConcurrent(active, input.concurrency, async (connection) => {
      try {
        if (input.presence_enabled) {
          await connection.session.request('get', {
            topic: connection.topic,
            what: 'sub desc'
          });
          connection.presenceQueries += 1;
        }
        if (input.typing_enabled) {
          connection.session.note({ topic: connection.topic, what: 'kp' });
          connection.activityNotes += 1;
        }
      } catch (error) {
        activityErrors.push(
          `ordinal ${connection.ordinal}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
    const remaining = holdDeadline - performance.now();
    if (remaining > 0) await delay(Math.min(input.activity_interval_ms, remaining));
  } while (performance.now() < holdDeadline && activityErrors.length === 0);

  let closed = 0;
  await mapConcurrent(active, input.concurrency, async (connection) => {
    try {
      await connection.session.closeGracefully();
      closed += 1;
    } catch (error) {
      connection.session.close();
      activityErrors.push(
        `ordinal ${connection.ordinal}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
  const protocolErrors = [
    ...opened.flatMap((connection) => connection.errors),
    ...activityErrors
  ];
  const expectedActivityCycles = input.typing_enabled || input.presence_enabled ? 1 : 0;
  const status = active.length === ordinals.length &&
    closed === ordinals.length &&
    protocolErrors.length === 0 &&
    (expectedActivityCycles === 0 ||
      active.every((connection) =>
        (!input.typing_enabled || connection.activityNotes > 0) &&
        (!input.presence_enabled || connection.presenceQueries > 0)))
    ? 'controlled_pass'
    : 'controlled_failed';
  return {
    protocol: 'tinode_websocket',
    evidence_level: 'controlled',
    status,
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    attempted_count: ordinals.length,
    accepted_count: active.length,
    active_peak_count: active.length,
    closed_count: closed,
    socket_attempt_count: sum(opened, (connection) => connection.socketAttempts),
    reconnect_count: sum(opened, (connection) => connection.reconnects),
    presence_query_count: sum(opened, (connection) => connection.presenceQueries),
    activity_note_count: sum(opened, (connection) => connection.activityNotes),
    error_count: protocolErrors.length,
    errors: protocolErrors.slice(0, 1_000),
    elapsed_ms: roundMilliseconds(performance.now() - startedAt),
    journal_sha256: canonicalSha256(active
      .map((connection) => ({
        ordinal: connection.ordinal,
        topic: connection.topic
      }))
      .sort((left, right) => left.ordinal - right.ordinal))
  };
}

async function openConnection(
  input: TinodeConnectionShardInput,
  ordinal: number
): Promise<TinodeOpenedConnection> {
  const auth = await input.auth_for_ordinal(ordinal);
  const topic = await input.topic_for_ordinal(ordinal);
  if (!auth.secret) throw new Error(`Tinode auth secret is missing for ordinal ${ordinal}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(topic)) {
    throw new Error(`Tinode topic is invalid for ordinal ${ordinal}`);
  }
  const result: TinodeOpenedConnection = {
    ordinal,
    topic,
    session: null,
    socketAttempts: 0,
    reconnects: 0,
    presenceQueries: 0,
    activityNotes: 0,
    errors: []
  };
  for (let attempt = 0; attempt <= input.maximum_reconnects; attempt += 1) {
    result.socketAttempts += 1;
    const session = new TinodeWireSession(
      endpointWithApiKey(input.endpoint, input.api_key),
      input.request_timeout_ms
    );
    try {
      await session.open();
      await session.request('hi', { ver: '0.22', ua: 'Converact Fabric capacity generator' });
      await session.request('login', auth);
      await session.request('sub', { topic });
      result.session = session;
      return result;
    } catch (error) {
      session.close();
      if (attempt < input.maximum_reconnects) {
        result.reconnects += 1;
        await delay(input.reconnect_delay_ms);
        continue;
      }
      result.errors.push(
        `ordinal ${ordinal}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return result;
}

async function runInteraction(
  input: TinodeShardInput,
  ordinal: number,
  becameActive: () => void,
  becameInactive: () => void
): Promise<TinodeClientResult> {
  const auth = await input.auth_for_ordinal(ordinal);
  const topic = await input.topic_for_ordinal(ordinal);
  if (!auth.secret) throw new Error(`Tinode auth secret is missing for ordinal ${ordinal}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(topic)) {
    throw new Error(`Tinode topic is invalid for ordinal ${ordinal}`);
  }
  const result: TinodeClientResult = {
    accepted: false,
    socketAttempts: 0,
    reconnects: 0,
    published: 0,
    presenceQueries: 0,
    typingNotes: 0,
    receiptNotes: 0,
    sendToAckLatencies: [],
    delivered: 0,
    sendToDeliveryLatencies: [],
    duplicateMessages: 0,
    outOfOrderMessages: 0,
    errors: [],
    journal: []
  };
  let nextMessage = 0;
  let attempts = 0;
  while (true) {
    attempts += 1;
    result.socketAttempts += 1;
    const session = new TinodeWireSession(
      endpointWithApiKey(input.endpoint, input.api_key),
      input.request_timeout_ms,
      Math.max(100, input.messages_per_interaction * 4)
    );
    const attemptMessageIds: string[] = [];
    let deliveryStatsRecorded = false;
    let active = false;
    try {
      await session.open();
      active = true;
      becameActive();
      await session.request('hi', { ver: '0.22', ua: 'Converact Fabric capacity generator' });
      await session.request('login', auth);
      await session.request('sub', { topic });
      result.accepted = true;
      if (input.presence_enabled) {
        await session.request('get', { topic, what: 'sub desc' });
        result.presenceQueries += 1;
      }
      if (input.typing_enabled) {
        session.note({ topic, what: 'kp' });
        result.typingNotes += 1;
      }
      while (nextMessage < input.messages_per_interaction) {
        const messageId = `${input.run_id}/tinode_im/${ordinal}/message/${nextMessage}`;
        const messageWireId = wireMessageId(messageId);
        attemptMessageIds.push(messageWireId);
        const body = input.body_for_message(ordinal, nextMessage);
        if (typeof body !== 'string' || body.length === 0 || body.length > 65_536) {
          throw new Error(`Tinode message body is invalid for ordinal ${ordinal}`);
        }
        const sendStartedAt = performance.now();
        const ctrl = await session.request('pub', {
          topic,
          noecho: false,
          head: {
            'x-opc-message-id': messageWireId,
            'x-opc-idempotency-key': messageWireId
          },
          content: body
        });
        result.sendToAckLatencies.push(roundMilliseconds(performance.now() - sendStartedAt));
        const sequence = String(ctrl.params?.seq || ctrl.params?.seq_id || '');
        if (!/^\d+$/.test(sequence)) throw new Error('Tinode publish acknowledgement has no sequence');
        const delivery = await session.waitForData(messageWireId);
        if (delivery.sequence !== Number(sequence)) {
          throw new Error('Tinode publish acknowledgement and delivery sequence differ');
        }
        result.sendToDeliveryLatencies.push(
          roundMilliseconds(delivery.receivedAt - sendStartedAt)
        );
        result.delivered += 1;
        result.journal.push({
          ordinal,
          message_index: nextMessage,
          message_id: messageId,
          topic,
          provider_sequence: sequence
        });
        result.published += 1;
        nextMessage += 1;
        if (input.receipts_enabled) {
          session.note({ topic, what: 'recv', seq: Number(sequence) });
          session.note({ topic, what: 'read', seq: Number(sequence) });
          result.receiptNotes += 2;
        }
      }
      if (input.delivery_settle_ms > 0) await delay(input.delivery_settle_ms);
      recordDeliveryStats(session, attemptMessageIds, result);
      deliveryStatsRecorded = true;
      await session.closeGracefully();
      if (active) becameInactive();
      return result;
    } catch (error) {
      if (!deliveryStatsRecorded) recordDeliveryStats(session, attemptMessageIds, result);
      session.close();
      if (active) becameInactive();
      if (attempts <= input.maximum_reconnects) {
        result.reconnects += 1;
        await delay(input.reconnect_delay_ms);
        continue;
      }
      result.errors.push(`ordinal ${ordinal}: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }
}

export class TinodeWireSession {
  #socket: WebSocket | null = null;
  #nextId = 1;
  #pending = new Map<string, {
    resolve: (value: Record<string, any>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  #deliveries = new Map<string, TinodeDelivery[]>();
  #deliveryOrder: TinodeDelivery[] = [];
  #deliveryWaiters = new Map<string, {
    resolve: (value: TinodeDelivery) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly endpoint: string,
    private readonly timeoutMs: number,
    private readonly maximumTrackedDeliveries = 1_000
  ) {}

  async open(): Promise<void> {
    const socket = new WebSocket(this.endpoint);
    this.#socket = socket;
    socket.on('message', (raw) => this.#handleMessage(raw));
    socket.on('close', () => this.#rejectAll(new Error('Tinode WebSocket closed')));
    socket.on('error', (error) => this.#rejectAll(error));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('Tinode WebSocket open timeout'));
      }, this.timeoutMs);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  request(
    kind: 'hi' | 'acc' | 'login' | 'sub' | 'set' | 'get' | 'pub',
    payload: Record<string, unknown>
  ): Promise<Record<string, any>> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Tinode WebSocket is not open'));
    }
    const id = `load-${this.#nextId++}`;
    const promise = new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Tinode ${kind} acknowledgement timed out`));
      }, this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    try {
      socket.send(JSON.stringify({ [kind]: { id, ...payload } }));
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) clearTimeout(pending.timer);
      this.#pending.delete(id);
      return Promise.reject(error);
    }
    return promise;
  }

  note(payload: Record<string, unknown>): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Tinode WebSocket is not open');
    socket.send(JSON.stringify({ note: payload }));
  }

  waitForData(messageId: string): Promise<TinodeDelivery> {
    const existing = this.#deliveries.get(messageId)?.[0];
    if (existing) return Promise.resolve(existing);
    if (this.#deliveryWaiters.has(messageId)) {
      return Promise.reject(new Error('Tinode message already has a delivery waiter'));
    }
    return new Promise<TinodeDelivery>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#deliveryWaiters.delete(messageId);
        reject(new Error('Tinode message delivery timed out'));
      }, this.timeoutMs);
      this.#deliveryWaiters.set(messageId, { resolve, reject, timer });
    });
  }

  deliveryStats(messageIds: readonly string[]): {
    duplicateCount: number;
    outOfOrderCount: number;
  } {
    const expected = new Set(messageIds);
    let duplicateCount = 0;
    for (const messageId of expected) {
      duplicateCount += Math.max(0, (this.#deliveries.get(messageId)?.length || 0) - 1);
    }
    let outOfOrderCount = 0;
    let previous = -1;
    for (const delivery of this.#deliveryOrder) {
      if (!expected.has(delivery.messageId)) continue;
      if (previous >= 0 && delivery.sequence < previous) outOfOrderCount += 1;
      previous = delivery.sequence;
    }
    return { duplicateCount, outOfOrderCount };
  }

  async flush(): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Tinode WebSocket is not open');
    const deadline = Date.now() + this.timeoutMs;
    while (socket.bufferedAmount > 0) {
      if (Date.now() >= deadline) throw new Error('Tinode WebSocket send queue did not drain');
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async closeGracefully(): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Tinode WebSocket is not open');
    await this.flush();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('Tinode WebSocket close handshake timed out'));
      }, this.timeoutMs);
      socket.once('close', () => {
        clearTimeout(timer);
        this.#socket = null;
        resolve();
      });
      socket.close(1000, 'complete');
    });
  }

  close(): void {
    this.#rejectAll(new Error('Tinode session closed'));
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.close(1000, 'complete');
    else if (this.#socket?.readyState === WebSocket.CONNECTING) this.#socket.terminate();
    this.#socket = null;
  }

  #handleMessage(raw: WebSocket.RawData): void {
    let packet: Record<string, any>;
    try {
      packet = JSON.parse(String(raw));
    } catch {
      return;
    }
    const data = packet.data;
    const messageId = String(data?.head?.['x-opc-message-id'] || '');
    const sequence = Number(data?.seq);
    if (messageId && Number.isSafeInteger(sequence) && sequence > 0) {
      const delivery: TinodeDelivery = {
        messageId,
        sequence,
        receivedAt: performance.now()
      };
      this.#deliveryOrder.push(delivery);
      const deliveries = this.#deliveries.get(messageId) || [];
      deliveries.push(delivery);
      this.#deliveries.set(messageId, deliveries);
      if (this.#deliveryOrder.length > this.maximumTrackedDeliveries) {
        this.#rejectAll(new Error('Tinode tracked delivery limit exceeded'));
        this.#socket?.close(1009, 'delivery limit');
        return;
      }
      const waiter = this.#deliveryWaiters.get(messageId);
      if (waiter) {
        this.#deliveryWaiters.delete(messageId);
        clearTimeout(waiter.timer);
        waiter.resolve(delivery);
      }
    }
    const meta = packet.meta;
    if (meta?.id) {
      const pending = this.#pending.get(String(meta.id));
      if (pending) {
        this.#pending.delete(String(meta.id));
        clearTimeout(pending.timer);
        pending.resolve(meta);
      }
      return;
    }
    const ctrl = packet.ctrl;
    if (!ctrl?.id) return;
    const pending = this.#pending.get(String(ctrl.id));
    if (!pending) return;
    this.#pending.delete(String(ctrl.id));
    clearTimeout(pending.timer);
    if (Number(ctrl.code || 0) >= 300) {
      pending.reject(new Error(`Tinode request rejected with ${ctrl.code}: ${ctrl.text || 'error'}`));
      return;
    }
    pending.resolve(ctrl);
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
    for (const [messageId, waiter] of this.#deliveryWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.#deliveryWaiters.delete(messageId);
    }
  }
}

function recordDeliveryStats(
  session: TinodeWireSession,
  messageIds: readonly string[],
  result: TinodeClientResult
): void {
  const stats = session.deliveryStats(messageIds);
  result.duplicateMessages += stats.duplicateCount;
  result.outOfOrderMessages += stats.outOfOrderCount;
}

function positiveSequence(ctrl: Record<string, any>, label: string): number {
  const sequence = Number(ctrl.params?.seq || ctrl.params?.seq_id || 0);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`Tinode ${label} acknowledgement has no sequence`);
  }
  return sequence;
}

function wireMessageId(messageId: string): string {
  return `converact-${canonicalSha256(messageId)}`;
}

function validateInput(input: TinodeShardInput): void {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') throw new Error('Tinode endpoint must use ws or wss');
  if (!input.api_key || !input.run_id || !input.worker_id) throw new Error('Tinode API key, run ID and worker ID are required');
  if (!Number.isInteger(input.ordinal_start) || !Number.isInteger(input.ordinal_end_exclusive) ||
      input.ordinal_start < 0 || input.ordinal_end_exclusive <= input.ordinal_start) {
    throw new Error('Tinode shard ordinal range is invalid');
  }
  const expectedShardId = `interaction/tinode_im/${input.ordinal_start}-${input.ordinal_end_exclusive}`;
  if (input.shard_id !== expectedShardId) throw new Error(`Tinode shard ID must be ${expectedShardId}`);
  if (!/^[1-9][0-9]{0,18}$/.test(input.lease_epoch)) throw new Error('invalid Tinode lease_epoch');
  for (const [field, value] of Object.entries({
    messages_per_interaction: input.messages_per_interaction,
    maximum_reconnects: input.maximum_reconnects,
    reconnect_delay_ms: input.reconnect_delay_ms,
    request_timeout_ms: input.request_timeout_ms,
    delivery_settle_ms: input.delivery_settle_ms,
    offline_recovery_message_count: input.offline_recovery_message_count,
    concurrency: input.concurrency
  })) {
    const minimum = ['messages_per_interaction', 'request_timeout_ms', 'concurrency'].includes(field) ? 1 : 0;
    if (!Number.isInteger(value) || value < minimum) throw new Error(`invalid Tinode ${field}`);
  }
  for (const [field, value] of Object.entries({
    send_to_ack_p95_limit_ms: input.send_to_ack_p95_limit_ms,
    send_to_ack_p99_limit_ms: input.send_to_ack_p99_limit_ms,
    send_to_delivery_p95_limit_ms: input.send_to_delivery_p95_limit_ms,
    send_to_delivery_p99_limit_ms: input.send_to_delivery_p99_limit_ms,
    offline_recovery_p99_limit_ms: input.offline_recovery_p99_limit_ms
  })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid Tinode ${field}`);
  }
  if (input.send_to_ack_p95_limit_ms > input.send_to_ack_p99_limit_ms) {
    throw new Error('Tinode send-to-ack P95 limit exceeds P99 limit');
  }
  if (input.send_to_delivery_p95_limit_ms > input.send_to_delivery_p99_limit_ms) {
    throw new Error('Tinode send-to-delivery P95 limit exceeds P99 limit');
  }
}

function validateConnectionInput(input: TinodeConnectionShardInput): void {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
    throw new Error('Tinode endpoint must use ws or wss');
  }
  if (!input.api_key || !input.run_id || !input.worker_id) {
    throw new Error('Tinode API key, run ID and worker ID are required');
  }
  if (!Number.isInteger(input.ordinal_start) || !Number.isInteger(input.ordinal_end_exclusive) ||
      input.ordinal_start < 0 || input.ordinal_end_exclusive <= input.ordinal_start) {
    throw new Error('Tinode shard ordinal range is invalid');
  }
  const expectedShardId =
    `connection/tinode_websocket/${input.ordinal_start}-${input.ordinal_end_exclusive}`;
  if (input.shard_id !== expectedShardId) {
    throw new Error(`Tinode shard ID must be ${expectedShardId}`);
  }
  if (!/^[1-9][0-9]{0,18}$/.test(input.lease_epoch)) {
    throw new Error('invalid Tinode lease_epoch');
  }
  for (const [field, value] of Object.entries({
    maximum_reconnects: input.maximum_reconnects,
    reconnect_delay_ms: input.reconnect_delay_ms,
    request_timeout_ms: input.request_timeout_ms,
    connection_hold_ms: input.connection_hold_ms,
    activity_interval_ms: input.activity_interval_ms,
    concurrency: input.concurrency
  })) {
    const minimum = ['maximum_reconnects', 'reconnect_delay_ms'].includes(field) ? 0 : 1;
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`invalid Tinode ${field}`);
    }
  }
  if (input.activity_interval_ms > input.connection_hold_ms) {
    throw new Error('Tinode activity interval exceeds the connection hold duration');
  }
}

function quantile(samples: number[], value: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(value * sorted.length) - 1)];
}

function countSequenceRegressions(sequences: readonly number[]): number {
  let regressions = 0;
  for (let index = 1; index < sequences.length; index += 1) {
    if (sequences[index] <= sequences[index - 1]) regressions += 1;
  }
  return regressions;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function endpointWithApiKey(endpoint: string, apiKey: string): string {
  const url = new URL(endpoint);
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

function sum<T>(items: T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
