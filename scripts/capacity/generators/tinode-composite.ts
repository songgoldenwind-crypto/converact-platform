import { performance } from 'node:perf_hooks';

import { canonicalSha256 } from '../canonical-json.js';
import { TinodeWireSession } from './tinode.js';

interface TinodeAuth {
  scheme: 'token' | 'basic';
  secret: string;
}

export interface TinodeCompositeConnection {
  auth: TinodeAuth;
  topics: string[];
}

export interface TinodeCompositeInteraction {
  topic: string;
  publisher_connection_ordinal: number;
  subscriber_connection_ordinal: number;
}

export interface TinodeCompositeShardInput {
  endpoint: string;
  api_key: string;
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  connection_ordinal_start: number;
  connection_ordinal_end_exclusive: number;
  interaction_ordinal_start: number;
  interaction_ordinal_end_exclusive: number;
  connection_for_ordinal(
    ordinal: number
  ): TinodeCompositeConnection | Promise<TinodeCompositeConnection>;
  interaction_for_ordinal(
    ordinal: number
  ): TinodeCompositeInteraction | Promise<TinodeCompositeInteraction>;
  messages_per_interaction: number;
  body_for_message(ordinal: number, messageIndex: number): string;
  receipts_enabled: boolean;
  maximum_reconnects: number;
  reconnect_delay_ms: number;
  request_timeout_ms: number;
  send_to_ack_p95_limit_ms: number;
  send_to_ack_p99_limit_ms: number;
  send_to_delivery_p95_limit_ms: number;
  send_to_delivery_p99_limit_ms: number;
  delivery_settle_ms: number;
  connection_hold_ms: number;
  connection_ramp_per_second: number;
  interaction_start_rate_per_second: number;
  concurrency: number;
}

export interface TinodeCompositeShardResult {
  protocol: 'tinode_websocket';
  evidence_level: 'controlled';
  status: 'controlled_pass' | 'controlled_failed';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  connection_attempted_count: number;
  connection_accepted_count: number;
  connection_active_peak_count: number;
  connection_closed_count: number;
  connection_start_window_ms: number;
  connection_rate_conformant: boolean;
  connection_max_starts_per_second: number;
  connection_open_sample_count: number;
  connection_open_p50_ms: number;
  connection_open_p95_ms: number;
  connection_open_p99_ms: number;
  interaction_attempted_count: number;
  interaction_active_count: number;
  interaction_start_window_ms: number;
  interaction_rate_conformant: boolean;
  interaction_max_starts_per_second: number;
  socket_attempt_count: number;
  reconnect_count: number;
  published_message_count: number;
  message_send_window_ms: number;
  published_messages_per_second: number;
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
  quality_gate_passed: boolean;
  quality_reasons: string[];
  error_count: number;
  errors: string[];
  elapsed_ms: number;
  journal_sha256: string;
}

export interface TinodeStartRateEvidence {
  expected_rate_per_second: number;
  actual_rate_per_second: number;
  expected_window_ms: number;
  actual_window_ms: number;
  maximum_starts_per_second: number;
  conformant: boolean;
}

interface OpenedConnection {
  ordinal: number;
  startedAt: number;
  topics: Set<string>;
  session: TinodeWireSession | null;
  socketAttempts: number;
  reconnects: number;
  openLatencyMs: number | null;
  errors: string[];
}

interface InteractionResult {
  startedAt: number;
  active: boolean;
  published: number;
  delivered: number;
  receipts: number;
  ackLatencies: number[];
  deliveryLatencies: number[];
  publishStartedAt: number[];
  publishCompletedAt: number[];
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

export async function runTinodeCompositeShard(
  input: TinodeCompositeShardInput
): Promise<TinodeCompositeShardResult> {
  validateInput(input);
  const startedAt = performance.now();
  const connectionOrdinals = range(
    input.connection_ordinal_start,
    input.connection_ordinal_end_exclusive
  );
  const interactionOrdinals = range(
    input.interaction_ordinal_start,
    input.interaction_ordinal_end_exclusive
  );
  const opened = await mapConcurrentRateLimited(
    connectionOrdinals,
    input.concurrency,
    input.connection_ramp_per_second,
    (ordinal) => openConnection(input, ordinal)
  );
  const activeConnections = new Map(
    opened
      .filter(
        (connection): connection is OpenedConnection & { session: TinodeWireSession } =>
          connection.session !== null
      )
      .map((connection) => [connection.ordinal, connection])
  );
  const interactions = await mapConcurrentRateLimited(
    interactionOrdinals,
    input.concurrency,
    input.interaction_start_rate_per_second,
    (ordinal) => runInteraction(input, ordinal, activeConnections)
  );
  if (input.connection_hold_ms > 0 &&
      activeConnections.size === connectionOrdinals.length &&
      interactions.every((interaction) => interaction.active && interaction.errors.length === 0)) {
    await delay(input.connection_hold_ms);
  }

  let closed = 0;
  const closeErrors: string[] = [];
  await mapConcurrent([...activeConnections.values()], input.concurrency, async (connection) => {
    try {
      await connection.session.closeGracefully();
      closed += 1;
    } catch (error) {
      connection.session.close();
      closeErrors.push(safeError(`connection ${connection.ordinal}`, error));
    }
  });

  const expectedMessages = interactionOrdinals.length * input.messages_per_interaction;
  const published = sum(interactions, (result) => result.published);
  const delivered = sum(interactions, (result) => result.delivered);
  const ackLatencies = interactions.flatMap((result) => result.ackLatencies);
  const deliveryLatencies = interactions.flatMap((result) => result.deliveryLatencies);
  const openLatencies = opened.flatMap((connection) =>
    connection.openLatencyMs === null ? [] : [connection.openLatencyMs]
  );
  const publishStartedAt = interactions.flatMap((result) => result.publishStartedAt);
  const publishCompletedAt = interactions.flatMap((result) => result.publishCompletedAt);
  const messageSendWindow = publishStartedAt.length === 0
    ? 0
    : roundMilliseconds(
      Math.max(...publishCompletedAt) - Math.min(...publishStartedAt)
    );
  const duplicateMessages = sum(interactions, (result) => result.duplicateMessages);
  const outOfOrderMessages = sum(interactions, (result) => result.outOfOrderMessages);
  const connectionStartRate = evaluateTinodeStartRate(
    opened.map((connection) => connection.startedAt),
    input.connection_ramp_per_second
  );
  const interactionStartRate = evaluateTinodeStartRate(
    interactions.map((interaction) => interaction.startedAt),
    input.interaction_start_rate_per_second
  );
  const protocolErrors = [
    ...opened.flatMap((connection) => connection.errors),
    ...interactions.flatMap((interaction) => interaction.errors),
    ...closeErrors
  ];
  const qualityReasons = qualityFailures({
    input,
    expectedMessages,
    ackLatencies,
    deliveryLatencies,
    delivered,
    duplicateMessages,
    outOfOrderMessages,
    connectionStartRate,
    interactionStartRate
  });
  const journal = interactions.flatMap((result) => result.journal)
    .sort((left, right) => left.ordinal - right.ordinal || left.message_index - right.message_index);
  const accepted = activeConnections.size;
  const activeInteractions = interactions.filter((result) => result.active).length;
  const passed = accepted === connectionOrdinals.length &&
    closed === connectionOrdinals.length &&
    activeInteractions === interactionOrdinals.length &&
    published === expectedMessages &&
    delivered === expectedMessages &&
    protocolErrors.length === 0 &&
    qualityReasons.length === 0;

  return {
    protocol: 'tinode_websocket',
    evidence_level: 'controlled',
    status: passed ? 'controlled_pass' : 'controlled_failed',
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    connection_attempted_count: connectionOrdinals.length,
    connection_accepted_count: accepted,
    connection_active_peak_count: accepted,
    connection_closed_count: closed,
    connection_start_window_ms: connectionStartRate.actual_window_ms,
    connection_rate_conformant: connectionStartRate.conformant,
    connection_max_starts_per_second: connectionStartRate.maximum_starts_per_second,
    connection_open_sample_count: openLatencies.length,
    connection_open_p50_ms: quantile(openLatencies, 0.5),
    connection_open_p95_ms: quantile(openLatencies, 0.95),
    connection_open_p99_ms: quantile(openLatencies, 0.99),
    interaction_attempted_count: interactionOrdinals.length,
    interaction_active_count: activeInteractions,
    interaction_start_window_ms: interactionStartRate.actual_window_ms,
    interaction_rate_conformant: interactionStartRate.conformant,
    interaction_max_starts_per_second: interactionStartRate.maximum_starts_per_second,
    socket_attempt_count: sum(opened, (connection) => connection.socketAttempts),
    reconnect_count: sum(opened, (connection) => connection.reconnects),
    published_message_count: published,
    message_send_window_ms: messageSendWindow,
    published_messages_per_second: messageSendWindow > 0
      ? roundMilliseconds(published * 1_000 / messageSendWindow)
      : 0,
    receipt_note_count: sum(interactions, (result) => result.receipts),
    send_to_ack_sample_count: ackLatencies.length,
    send_to_ack_p50_ms: quantile(ackLatencies, 0.5),
    send_to_ack_p95_ms: quantile(ackLatencies, 0.95),
    send_to_ack_p99_ms: quantile(ackLatencies, 0.99),
    delivered_message_count: delivered,
    send_to_delivery_sample_count: deliveryLatencies.length,
    send_to_delivery_p50_ms: quantile(deliveryLatencies, 0.5),
    send_to_delivery_p95_ms: quantile(deliveryLatencies, 0.95),
    send_to_delivery_p99_ms: quantile(deliveryLatencies, 0.99),
    durable_message_loss_count: Math.max(0, expectedMessages - delivered),
    duplicate_message_count: duplicateMessages,
    out_of_order_message_count: outOfOrderMessages,
    quality_gate_passed: qualityReasons.length === 0,
    quality_reasons: qualityReasons,
    error_count: protocolErrors.length,
    errors: protocolErrors.slice(0, 1_000),
    elapsed_ms: roundMilliseconds(performance.now() - startedAt),
    journal_sha256: canonicalSha256(journal)
  };
}

async function openConnection(
  input: TinodeCompositeShardInput,
  ordinal: number
): Promise<OpenedConnection> {
  const descriptor = await input.connection_for_ordinal(ordinal);
  const topics = validateConnectionDescriptor(descriptor, ordinal);
  const result: OpenedConnection = {
    ordinal,
    startedAt: performance.now(),
    topics,
    session: null,
    socketAttempts: 0,
    reconnects: 0,
    openLatencyMs: null,
    errors: []
  };
  const openStartedAt = performance.now();
  for (let attempt = 0; attempt <= input.maximum_reconnects; attempt += 1) {
    result.socketAttempts += 1;
    const session = new TinodeWireSession(
      endpointWithApiKey(input.endpoint, input.api_key),
      input.request_timeout_ms,
      Math.max(100, input.messages_per_interaction * 8)
    );
    try {
      await session.open();
      await session.request('hi', { ver: '0.22', ua: 'Converact Fabric composite capacity generator' });
      await session.request('login', {
        scheme: descriptor.auth.scheme,
        secret: descriptor.auth.secret
      });
      for (const topic of topics) await session.request('sub', { topic });
      result.session = session;
      result.openLatencyMs = roundMilliseconds(performance.now() - openStartedAt);
      return result;
    } catch (error) {
      session.close();
      if (attempt < input.maximum_reconnects) {
        result.reconnects += 1;
        await delay(input.reconnect_delay_ms);
        continue;
      }
      result.errors.push(safeError(`connection ${ordinal}`, error));
    }
  }
  return result;
}

async function runInteraction(
  input: TinodeCompositeShardInput,
  ordinal: number,
  connections: ReadonlyMap<number, OpenedConnection & { session: TinodeWireSession }>
): Promise<InteractionResult> {
  const result: InteractionResult = {
    startedAt: performance.now(),
    active: false,
    published: 0,
    delivered: 0,
    receipts: 0,
    ackLatencies: [],
    deliveryLatencies: [],
    publishStartedAt: [],
    publishCompletedAt: [],
    duplicateMessages: 0,
    outOfOrderMessages: 0,
    errors: [],
    journal: []
  };
  try {
    const interaction = await input.interaction_for_ordinal(ordinal);
    validateInteraction(interaction, ordinal, connections);
    const publisher = connections.get(interaction.publisher_connection_ordinal)!;
    const subscriber = connections.get(interaction.subscriber_connection_ordinal)!;
    result.active = true;
    const wireIds: string[] = [];
    for (let messageIndex = 0; messageIndex < input.messages_per_interaction; messageIndex += 1) {
      const messageId = `${input.run_id}/tinode_im/${ordinal}/message/${messageIndex}`;
      const wireId = `converact-${canonicalSha256(messageId)}`;
      const body = input.body_for_message(ordinal, messageIndex);
      if (typeof body !== 'string' || body.length === 0 || body.length > 65_536) {
        throw new Error(`message body is invalid for interaction ${ordinal}`);
      }
      wireIds.push(wireId);
      const sendStartedAt = performance.now();
      result.publishStartedAt.push(sendStartedAt);
      const ctrl = await publisher.session.request('pub', {
        topic: interaction.topic,
        noecho: false,
        head: {
          'x-opc-message-id': wireId,
          'x-opc-idempotency-key': wireId
        },
        content: body
      });
      result.ackLatencies.push(roundMilliseconds(performance.now() - sendStartedAt));
      result.publishCompletedAt.push(performance.now());
      const sequence = Number(ctrl.params?.seq || ctrl.params?.seq_id || 0);
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new Error(`publish acknowledgement has no sequence for interaction ${ordinal}`);
      }
      const delivery = await subscriber.session.waitForData(wireId);
      if (delivery.sequence !== sequence) {
        throw new Error(`publish and delivery sequence differ for interaction ${ordinal}`);
      }
      result.deliveryLatencies.push(roundMilliseconds(delivery.receivedAt - sendStartedAt));
      result.published += 1;
      result.delivered += 1;
      result.journal.push({
        ordinal,
        message_index: messageIndex,
        message_id: messageId,
        topic: interaction.topic,
        provider_sequence: String(sequence)
      });
      if (input.receipts_enabled) {
        subscriber.session.note({ topic: interaction.topic, what: 'recv', seq: sequence });
        subscriber.session.note({ topic: interaction.topic, what: 'read', seq: sequence });
        result.receipts += 2;
      }
    }
    if (input.delivery_settle_ms > 0) await delay(input.delivery_settle_ms);
    const stats = subscriber.session.deliveryStats(wireIds);
    result.duplicateMessages = stats.duplicateCount;
    result.outOfOrderMessages = stats.outOfOrderCount;
  } catch (error) {
    result.errors.push(safeError(`interaction ${ordinal}`, error));
  }
  return result;
}

function validateConnectionDescriptor(
  descriptor: TinodeCompositeConnection,
  ordinal: number
): Set<string> {
  if (!descriptor || !descriptor.auth?.secret) {
    throw new Error(`Tinode auth secret is missing for connection ${ordinal}`);
  }
  if (!Array.isArray(descriptor.topics) || descriptor.topics.length === 0) {
    throw new Error(`Tinode topics are missing for connection ${ordinal}`);
  }
  const topics = new Set(descriptor.topics);
  if (topics.size !== descriptor.topics.length) {
    throw new Error(`Tinode topics contain duplicates for connection ${ordinal}`);
  }
  for (const topic of topics) validateTopic(topic, `connection ${ordinal}`);
  return topics;
}

function validateInteraction(
  interaction: TinodeCompositeInteraction,
  ordinal: number,
  connections: ReadonlyMap<number, OpenedConnection>
): void {
  validateTopic(interaction.topic, `interaction ${ordinal}`);
  if (interaction.publisher_connection_ordinal === interaction.subscriber_connection_ordinal) {
    throw new Error(`interaction ${ordinal} must use distinct publisher and subscriber connections`);
  }
  for (const [role, connectionOrdinal] of [
    ['publisher', interaction.publisher_connection_ordinal],
    ['subscriber', interaction.subscriber_connection_ordinal]
  ] as const) {
    const connection = connections.get(connectionOrdinal);
    if (!connection) throw new Error(`interaction ${ordinal} ${role} connection is not active`);
    if (!connection.topics.has(interaction.topic)) {
      throw new Error(`interaction ${ordinal} ${role} is not subscribed to its topic`);
    }
  }
}

function validateInput(input: TinodeCompositeShardInput): void {
  const endpoint = new URL(input.endpoint);
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error('Tinode endpoint must use WebSocket');
  if (!input.api_key || input.api_key.length > 4_096) throw new Error('Tinode API key is invalid');
  for (const [field, value] of Object.entries({
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id
  })) {
    if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Tinode ${field} is invalid`);
    }
  }
  for (const [field, start, end] of [
    [
      'connection',
      input.connection_ordinal_start,
      input.connection_ordinal_end_exclusive
    ],
    [
      'interaction',
      input.interaction_ordinal_start,
      input.interaction_ordinal_end_exclusive
    ]
  ] as const) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      throw new Error(`Tinode ${field} ordinal range is invalid`);
    }
  }
  for (const [field, value, minimum, maximum] of [
    ['messages_per_interaction', input.messages_per_interaction, 1, 10_000],
    ['maximum_reconnects', input.maximum_reconnects, 0, 100],
    ['reconnect_delay_ms', input.reconnect_delay_ms, 0, 60_000],
    ['request_timeout_ms', input.request_timeout_ms, 250, 60_000],
    ['delivery_settle_ms', input.delivery_settle_ms, 0, 10_000],
    ['connection_hold_ms', input.connection_hold_ms, 0, 86_400_000],
    ['connection_ramp_per_second', input.connection_ramp_per_second, 1, 100_000],
    ['interaction_start_rate_per_second', input.interaction_start_rate_per_second, 1, 100_000],
    ['concurrency', input.concurrency, 1, 100_000]
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`Tinode ${field} is invalid`);
    }
  }
  for (const [field, value] of [
    ['send_to_ack_p95_limit_ms', input.send_to_ack_p95_limit_ms],
    ['send_to_ack_p99_limit_ms', input.send_to_ack_p99_limit_ms],
    ['send_to_delivery_p95_limit_ms', input.send_to_delivery_p95_limit_ms],
    ['send_to_delivery_p99_limit_ms', input.send_to_delivery_p99_limit_ms]
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Tinode ${field} is invalid`);
  }
}

function qualityFailures(input: {
  input: TinodeCompositeShardInput;
  expectedMessages: number;
  ackLatencies: number[];
  deliveryLatencies: number[];
  delivered: number;
  duplicateMessages: number;
  outOfOrderMessages: number;
  connectionStartRate: TinodeStartRateEvidence;
  interactionStartRate: TinodeStartRateEvidence;
}): string[] {
  const reasons: string[] = [];
  const ackP95 = quantile(input.ackLatencies, 0.95);
  const ackP99 = quantile(input.ackLatencies, 0.99);
  const deliveryP95 = quantile(input.deliveryLatencies, 0.95);
  const deliveryP99 = quantile(input.deliveryLatencies, 0.99);
  if (input.ackLatencies.length !== input.expectedMessages) {
    reasons.push('Tinode composite send-to-ack sample count does not match expected messages');
  }
  if (ackP95 > input.input.send_to_ack_p95_limit_ms) {
    reasons.push(`Tinode composite send-to-ack P95 ${ackP95}ms exceeds its limit`);
  }
  if (ackP99 > input.input.send_to_ack_p99_limit_ms) {
    reasons.push(`Tinode composite send-to-ack P99 ${ackP99}ms exceeds its limit`);
  }
  if (input.deliveryLatencies.length !== input.expectedMessages) {
    reasons.push('Tinode composite send-to-delivery sample count does not match expected messages');
  }
  if (deliveryP95 > input.input.send_to_delivery_p95_limit_ms) {
    reasons.push(`Tinode composite send-to-delivery P95 ${deliveryP95}ms exceeds its limit`);
  }
  if (deliveryP99 > input.input.send_to_delivery_p99_limit_ms) {
    reasons.push(`Tinode composite send-to-delivery P99 ${deliveryP99}ms exceeds its limit`);
  }
  if (input.delivered !== input.expectedMessages) {
    reasons.push(`Tinode composite durable message loss count is ${input.expectedMessages - input.delivered}`);
  }
  if (input.duplicateMessages > 0) {
    reasons.push(`Tinode composite duplicate message count is ${input.duplicateMessages}`);
  }
  if (input.outOfOrderMessages > 0) {
    reasons.push(`Tinode composite out-of-order message count is ${input.outOfOrderMessages}`);
  }
  if (!input.connectionStartRate.conformant) {
    reasons.push('Tinode composite connection start rate is not conformant');
  }
  if (!input.interactionStartRate.conformant) {
    reasons.push('Tinode composite interaction start rate is not conformant');
  }
  return reasons;
}

function endpointWithApiKey(endpoint: string, apiKey: string): string {
  const url = new URL(endpoint);
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

function validateTopic(topic: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(topic)) {
    throw new Error(`Tinode topic is invalid for ${label}`);
  }
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, index) => start + index);
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return result;
}

async function mapConcurrentRateLimited<T, R>(
  values: readonly T[],
  concurrency: number,
  startsPerSecond: number,
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const intervalMs = 1_000 / startsPerSecond;
  let nextStartAt = performance.now();
  let startGate = Promise.resolve();
  return mapConcurrent(values, concurrency, async (value, index) => {
    const admitted = startGate.then(async () => {
      await waitForTinodeStartGate(nextStartAt);
      nextStartAt = performance.now() + intervalMs;
    });
    startGate = admitted.catch(() => undefined);
    await admitted;
    return operation(value, index);
  });
}

export async function waitForTinodeStartGate(
  notBeforeMs: number,
  dependencies: {
    now(): number;
    wait(milliseconds: number): Promise<void>;
  } = {
    now: () => performance.now(),
    wait: delay
  }
): Promise<number> {
  if (!Number.isFinite(notBeforeMs)) throw new Error('Tinode start gate deadline is invalid');
  let now = dependencies.now();
  while (now < notBeforeMs) {
    await dependencies.wait(Math.max(1, Math.ceil(notBeforeMs - now)));
    const advanced = dependencies.now();
    if (!Number.isFinite(advanced) || advanced <= now) {
      throw new Error('Tinode start gate clock did not advance');
    }
    now = advanced;
  }
  return now;
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function quantile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return roundMilliseconds(sorted[index]);
}

export function evaluateTinodeStartRate(
  starts: readonly number[],
  expectedRatePerSecond: number
): TinodeStartRateEvidence {
  if (!Number.isFinite(expectedRatePerSecond) || expectedRatePerSecond <= 0 ||
      starts.some((value) => !Number.isFinite(value))) {
    throw new Error('Tinode start-rate evidence is invalid');
  }
  const sorted = [...starts].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return {
      expected_rate_per_second: expectedRatePerSecond,
      actual_rate_per_second: 0,
      expected_window_ms: 0,
      actual_window_ms: 0,
      maximum_starts_per_second: 0,
      conformant: false
    };
  }
  const expectedWindow = (sorted.length - 1) * 1_000 / expectedRatePerSecond;
  const actualWindow = sorted.length < 2 ? 0 : sorted[sorted.length - 1] - sorted[0];
  const minimumWindow = Math.max(0, expectedWindow * 0.9 - 2);
  const maximumWindow = expectedWindow * 1.2 + 100;
  const maximumStarts = maximumStartsInWindow(sorted, 1_000);
  return {
    expected_rate_per_second: expectedRatePerSecond,
    actual_rate_per_second: sorted.length < 2
      ? 0
      : roundMilliseconds((sorted.length - 1) * 1_000 / Math.max(actualWindow, 0.001)),
    expected_window_ms: roundMilliseconds(expectedWindow),
    actual_window_ms: roundMilliseconds(actualWindow),
    maximum_starts_per_second: maximumStarts,
    conformant: actualWindow >= minimumWindow &&
      actualWindow <= maximumWindow &&
      maximumStarts <= Math.ceil(expectedRatePerSecond)
  };
}

function maximumStartsInWindow(sorted: readonly number[], windowMs: number): number {
  let maximum = 0;
  let left = 0;
  for (let right = 0; right < sorted.length; right += 1) {
    while (sorted[right] - sorted[left] >= windowMs) left += 1;
    maximum = Math.max(maximum, right - left + 1);
  }
  return maximum;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}`.slice(0, 2_000);
}
