import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  runTinodeCompositeShard,
  type TinodeCompositeConnection,
  type TinodeCompositeInteraction,
  type TinodeCompositeShardInput,
  type TinodeCompositeShardResult
} from './tinode-composite.js';

export interface TinodeCompositeRunnerInput {
  schema_version: '1.0.0';
  endpoint: string;
  credential_bundle_path: string;
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  connection_ordinal_start?: number;
  connection_ordinal_end_exclusive?: number;
  interaction_ordinal_start?: number;
  interaction_ordinal_end_exclusive?: number;
  messages_per_interaction: number;
  message_body_bytes: number;
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

export interface TinodeCompositeRunnerOutput {
  schema_version: '1.0.0';
  evidence_level: 'controlled';
  capacity_claim: 'none';
  observation_scope: 'client_only';
  endpoint: string;
  connection_expected_count: number;
  interaction_expected_count: number;
  credential_bundle_sha256: string;
  client: TinodeCompositeShardResult;
}

interface TinodeCompositeCredentialBundle {
  api_key: string;
  connections: Map<number, TinodeCompositeConnection>;
  interactions: Map<number, TinodeCompositeInteraction>;
}

interface TinodeCompositeRunnerDependencies {
  run(input: TinodeCompositeShardInput): Promise<TinodeCompositeShardResult>;
}

export async function executeTinodeCompositeRunnerInput(
  raw: TinodeCompositeRunnerInput,
  dependencies: TinodeCompositeRunnerDependencies = { run: runTinodeCompositeShard }
): Promise<TinodeCompositeRunnerOutput> {
  const input = validateRunnerInput(raw);
  const bundle = readCredentialBundle(input.credential_bundle_path);
  const ranges = resolveOrdinalRanges(input, bundle);
  const connectionCount = ranges.connection_end - ranges.connection_start;
  const interactionCount = ranges.interaction_end - ranges.interaction_start;
  const client = await dependencies.run({
    endpoint: input.endpoint,
    api_key: bundle.api_key,
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    connection_ordinal_start: ranges.connection_start,
    connection_ordinal_end_exclusive: ranges.connection_end,
    interaction_ordinal_start: ranges.interaction_start,
    interaction_ordinal_end_exclusive: ranges.interaction_end,
    connection_for_ordinal: (ordinal) => bundle.connections.get(ordinal)!,
    interaction_for_ordinal: (ordinal) => bundle.interactions.get(ordinal)!,
    messages_per_interaction: input.messages_per_interaction,
    body_for_message: (ordinal, messageIndex) =>
      messageBody(input.run_id, ordinal, messageIndex, input.message_body_bytes),
    receipts_enabled: input.receipts_enabled,
    maximum_reconnects: input.maximum_reconnects,
    reconnect_delay_ms: input.reconnect_delay_ms,
    request_timeout_ms: input.request_timeout_ms,
    send_to_ack_p95_limit_ms: input.send_to_ack_p95_limit_ms,
    send_to_ack_p99_limit_ms: input.send_to_ack_p99_limit_ms,
    send_to_delivery_p95_limit_ms: input.send_to_delivery_p95_limit_ms,
    send_to_delivery_p99_limit_ms: input.send_to_delivery_p99_limit_ms,
    delivery_settle_ms: input.delivery_settle_ms,
    connection_hold_ms: input.connection_hold_ms,
    connection_ramp_per_second: input.connection_ramp_per_second,
    interaction_start_rate_per_second: input.interaction_start_rate_per_second,
    concurrency: input.concurrency
  });
  return {
    schema_version: '1.0.0',
    evidence_level: 'controlled',
    capacity_claim: 'none',
    observation_scope: 'client_only',
    endpoint: publicEndpoint(input.endpoint),
    connection_expected_count: connectionCount,
    interaction_expected_count: interactionCount,
    credential_bundle_sha256: fileSha256(input.credential_bundle_path),
    client
  };
}

function readCredentialBundle(path: string): TinodeCompositeCredentialBundle {
  if (!isAbsolute(path)) throw new Error('Tinode composite credential bundle path must be absolute');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 64 * 1024 * 1024) {
    throw new Error('Tinode composite credential bundle must be a bounded regular file');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Tinode composite credential bundle permissions must deny group and other access');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Tinode composite credential bundle is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tinode composite credential bundle is invalid');
  }
  const raw = parsed as Record<string, any>;
  if (raw.schema_version !== '1.0.0' ||
      !Array.isArray(raw.connections) || !Array.isArray(raw.interactions) ||
      raw.connections.length < 2 || raw.connections.length > 1_000_000 ||
      raw.interactions.length < 1 || raw.interactions.length > 1_000_000) {
    throw new Error('Tinode composite credential bundle is invalid');
  }
  const apiKey = secret(raw.api_key, 'api_key', 4_096);
  const connections = new Map<number, TinodeCompositeConnection>();
  for (const [index, item] of raw.connections.entries()) {
    const value = record(item, `connection ${index}`);
    const ordinal = integer(value.ordinal, 0, Number.MAX_SAFE_INTEGER, `connection ${index} ordinal`);
    if (connections.has(ordinal)) throw new Error(`Tinode composite connection ${index} is duplicated`);
    const scheme = String(value.auth?.scheme || '');
    if (scheme !== 'token' && scheme !== 'basic') {
      throw new Error(`Tinode composite connection ${index} has an invalid auth scheme`);
    }
    if (!Array.isArray(value.topics) || value.topics.length < 1 || value.topics.length > 1_000) {
      throw new Error(`Tinode composite connection ${index} has invalid topics`);
    }
    const topics = value.topics.map((topic: unknown) => validTopic(topic, `connection ${index}`));
    if (new Set(topics).size !== topics.length) {
      throw new Error(`Tinode composite connection ${index} has duplicate topics`);
    }
    connections.set(ordinal, {
      auth: {
        scheme,
        secret: secret(value.auth?.secret, `connection ${index} secret`, 8_192)
      },
      topics
    });
  }
  const interactions = new Map<number, TinodeCompositeInteraction>();
  for (const [index, item] of raw.interactions.entries()) {
    const value = record(item, `interaction ${index}`);
    const ordinal = integer(value.ordinal, 0, Number.MAX_SAFE_INTEGER, `interaction ${index} ordinal`);
    if (interactions.has(ordinal)) throw new Error(`Tinode composite interaction ${index} is duplicated`);
    const interaction = {
      topic: validTopic(value.topic, `interaction ${index}`),
      publisher_connection_ordinal: integer(
        value.publisher_connection_ordinal,
        0,
        Number.MAX_SAFE_INTEGER,
        `interaction ${index} publisher`
      ),
      subscriber_connection_ordinal: integer(
        value.subscriber_connection_ordinal,
        0,
        Number.MAX_SAFE_INTEGER,
        `interaction ${index} subscriber`
      )
    };
    validateInteractionMapping(interaction, connections, index);
    interactions.set(ordinal, interaction);
  }
  return { api_key: apiKey, connections, interactions };
}

function validateRunnerInput(raw: TinodeCompositeRunnerInput): TinodeCompositeRunnerInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema_version !== '1.0.0') {
    throw new Error('Tinode composite runner input is invalid');
  }
  const endpoint = new URL(String(raw.endpoint || ''));
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) {
    throw new Error('Tinode composite endpoint must use WebSocket');
  }
  for (const [field, value] of Object.entries({
    run_id: raw.run_id,
    shard_id: raw.shard_id,
    worker_id: raw.worker_id,
    lease_epoch: raw.lease_epoch
  })) {
    if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Tinode composite ${field} is invalid`);
    }
  }
  if (!isAbsolute(String(raw.credential_bundle_path || ''))) {
    throw new Error('Tinode composite credential_bundle_path must be absolute');
  }
  for (const [field, value, minimum, maximum] of [
    ['messages_per_interaction', raw.messages_per_interaction, 1, 10_000],
    ['message_body_bytes', raw.message_body_bytes, 32, 65_536],
    ['maximum_reconnects', raw.maximum_reconnects, 0, 100],
    ['reconnect_delay_ms', raw.reconnect_delay_ms, 0, 60_000],
    ['request_timeout_ms', raw.request_timeout_ms, 250, 60_000],
    ['delivery_settle_ms', raw.delivery_settle_ms, 0, 10_000],
    ['connection_hold_ms', raw.connection_hold_ms, 0, 86_400_000],
    ['connection_ramp_per_second', raw.connection_ramp_per_second, 1, 100_000],
    ['interaction_start_rate_per_second', raw.interaction_start_rate_per_second, 1, 100_000],
    ['concurrency', raw.concurrency, 1, 100_000]
  ] as const) {
    integer(value, minimum, maximum, field);
  }
  for (const [field, value] of [
    ['send_to_ack_p95_limit_ms', raw.send_to_ack_p95_limit_ms],
    ['send_to_ack_p99_limit_ms', raw.send_to_ack_p99_limit_ms],
    ['send_to_delivery_p95_limit_ms', raw.send_to_delivery_p95_limit_ms],
    ['send_to_delivery_p99_limit_ms', raw.send_to_delivery_p99_limit_ms]
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Tinode composite ${field} is invalid`);
  }
  if (typeof raw.receipts_enabled !== 'boolean') {
    throw new Error('Tinode composite receipts_enabled is invalid');
  }
  const rangeValues = [
    raw.connection_ordinal_start,
    raw.connection_ordinal_end_exclusive,
    raw.interaction_ordinal_start,
    raw.interaction_ordinal_end_exclusive
  ];
  const suppliedRangeValues = rangeValues.filter((value) => value !== undefined);
  if (suppliedRangeValues.length !== 0 && suppliedRangeValues.length !== rangeValues.length) {
    throw new Error('Tinode composite ordinal ranges must be supplied together');
  }
  if (suppliedRangeValues.length > 0) {
    integer(raw.connection_ordinal_start, 0, Number.MAX_SAFE_INTEGER, 'connection_ordinal_start');
    integer(raw.connection_ordinal_end_exclusive, 1, Number.MAX_SAFE_INTEGER, 'connection_ordinal_end_exclusive');
    integer(raw.interaction_ordinal_start, 0, Number.MAX_SAFE_INTEGER, 'interaction_ordinal_start');
    integer(raw.interaction_ordinal_end_exclusive, 1, Number.MAX_SAFE_INTEGER, 'interaction_ordinal_end_exclusive');
    if (raw.connection_ordinal_end_exclusive! <= raw.connection_ordinal_start! ||
        raw.interaction_ordinal_end_exclusive! <= raw.interaction_ordinal_start!) {
      throw new Error('Tinode composite ordinal ranges are invalid');
    }
  }
  return structuredClone(raw);
}

function validateInteractionMapping(
  interaction: TinodeCompositeInteraction,
  connections: ReadonlyMap<number, TinodeCompositeConnection>,
  index: number
): void {
  if (interaction.publisher_connection_ordinal === interaction.subscriber_connection_ordinal) {
    throw new Error(`Tinode composite interaction ${index} must use distinct connections`);
  }
  for (const [role, ordinal] of [
    ['publisher', interaction.publisher_connection_ordinal],
    ['subscriber', interaction.subscriber_connection_ordinal]
  ] as const) {
    const connection = connections.get(ordinal);
    if (!connection) throw new Error(`Tinode composite interaction ${index} ${role} is missing`);
    if (!connection.topics.includes(interaction.topic)) {
      throw new Error(`Tinode composite interaction ${index} ${role} is not subscribed`);
    }
  }
}

function resolveOrdinalRanges(
  input: TinodeCompositeRunnerInput,
  bundle: TinodeCompositeCredentialBundle
): {
  connection_start: number;
  connection_end: number;
  interaction_start: number;
  interaction_end: number;
} {
  const ranges = {
    connection_start: input.connection_ordinal_start ?? 0,
    connection_end: input.connection_ordinal_end_exclusive ?? bundle.connections.size,
    interaction_start: input.interaction_ordinal_start ?? 0,
    interaction_end: input.interaction_ordinal_end_exclusive ?? bundle.interactions.size
  };
  assertExactRange(bundle.connections, ranges.connection_start, ranges.connection_end, 'connection');
  assertExactRange(bundle.interactions, ranges.interaction_start, ranges.interaction_end, 'interaction');
  return ranges;
}

function assertExactRange<T>(
  values: ReadonlyMap<number, T>,
  start: number,
  endExclusive: number,
  label: string
): void {
  if (values.size !== endExclusive - start) {
    throw new Error(`Tinode composite ${label} bundle does not match its ordinal range`);
  }
  for (let ordinal = start; ordinal < endExclusive; ordinal += 1) {
    if (!values.has(ordinal)) {
      throw new Error(`Tinode composite ${label} ordinals must exactly cover the declared range`);
    }
  }
}

function messageBody(runId: string, ordinal: number, messageIndex: number, bytes: number): string {
  const prefix = `${runId}/${ordinal}/${messageIndex}:`;
  return `${prefix}${'x'.repeat(Math.max(0, bytes - Buffer.byteLength(prefix)))}`.slice(0, bytes);
}

function publicEndpoint(value: string): string {
  const endpoint = new URL(value);
  endpoint.username = '';
  endpoint.password = '';
  endpoint.searchParams.delete('apikey');
  return endpoint.toString();
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Tinode composite ${label} is invalid`);
  }
  return value as Record<string, any>;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Tinode composite ${label} is invalid`);
  }
  return Number(value);
}

function secret(value: unknown, label: string, maximum: number): string {
  const normalized = String(value || '');
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Tinode composite ${label} is invalid`);
  }
  return normalized;
}

function validTopic(value: unknown, label: string): string {
  const topic = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(topic)) {
    throw new Error(`Tinode composite ${label} has an invalid topic`);
  }
  return topic;
}
