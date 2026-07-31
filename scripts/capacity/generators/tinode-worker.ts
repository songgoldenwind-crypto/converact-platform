import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

import {
  runTinodeConnectionShard,
  runTinodeInteractionShard,
  type TinodeConnectionShardResult,
  type TinodeShardResult
} from './tinode.js';
import { executeTinodeCompositeRunnerInput } from './tinode-composite-runner.js';
import type {
  CapacityShardExecutionResult,
  CapacityStartShardCommand
} from '../orchestrator/types.js';

type TinodeWorkloadDomain = 'interaction' | 'connection';
type TinodeWorkloadId = 'tinode_im' | 'tinode_websocket';

export interface TinodeCapacityWorkerStaticInput extends Record<string, unknown> {
  endpoint: string;
  credential_bundle_path: string;
  messages_per_interaction: number;
  message_body_bytes: number;
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
  connection_hold_ms: number;
  activity_interval_ms: number;
  connection_ramp_per_second: number;
  interaction_start_rate_per_second: number;
  composite_credential_bundles?: TinodeCompositeCredentialBundleBinding[];
}

export interface TinodeCompositeCredentialBundleBinding {
  run_id: string;
  phase_id: string;
  shard_id: string;
  path: string;
  sha256: string;
}

export interface TinodeCapacityWorkerInput extends Record<string, unknown> {
  schema_version: '1.0.0';
  command: CapacityStartShardCommand;
  static_input: TinodeCapacityWorkerStaticInput;
  result_path: string;
}

interface TinodeCredential {
  workload_domain: TinodeWorkloadDomain;
  workload_id: TinodeWorkloadId;
  ordinal: number;
  auth: {
    scheme: 'token' | 'basic';
    secret: string;
  };
  topic: string;
}

interface TinodeCredentialBundle {
  schema_version: '1.0.0';
  api_key: string;
  credentials: TinodeCredential[];
}

export async function executeTinodeCapacityWorkerInput(
  raw: TinodeCapacityWorkerInput
): Promise<CapacityShardExecutionResult> {
  const input = validateWorkerInput(raw);
  const command = input.command;
  const config = input.static_input;
  if ((command.assignment.covered_workloads?.length ?? 0) > 0) {
    return executeCompositeCommand(command, config);
  }
  const bundle = readCredentialBundle(config.credential_bundle_path);
  const credentialByOrdinal = credentialsForCommand(bundle.credentials, command);
  const common = {
    endpoint: endpoint(config.endpoint),
    api_key: bundle.api_key,
    run_id: command.run_id,
    shard_id: command.shard_id,
    ordinal_start: command.assignment.ordinal_start,
    ordinal_end_exclusive: command.assignment.ordinal_end_exclusive,
    worker_id: command.worker_id,
    lease_epoch: command.lease_epoch,
    auth_for_ordinal: (ordinal: number) => credentialByOrdinal.get(ordinal)!.auth,
    topic_for_ordinal: (ordinal: number) => credentialByOrdinal.get(ordinal)!.topic,
    presence_enabled: boolean(config.presence_enabled, 'presence_enabled'),
    typing_enabled: boolean(config.typing_enabled, 'typing_enabled'),
    maximum_reconnects: integer(config.maximum_reconnects, 0, 100, 'maximum_reconnects'),
    reconnect_delay_ms: integer(config.reconnect_delay_ms, 0, 60_000, 'reconnect_delay_ms'),
    request_timeout_ms: integer(config.request_timeout_ms, 250, 60_000, 'request_timeout_ms'),
    concurrency: integer(config.concurrency, 1, 100_000, 'concurrency')
  };
  let client: TinodeShardResult | TinodeConnectionShardResult;
  if (command.assignment.workload_domain === 'interaction') {
    const bodyBytes = integer(config.message_body_bytes, 32, 65_536, 'message_body_bytes');
    client = await runTinodeInteractionShard({
      ...common,
      messages_per_interaction: integer(
        config.messages_per_interaction,
        1,
        10_000,
        'messages_per_interaction'
      ),
      body_for_message: (ordinal, messageIndex) =>
        messageBody(command.run_id, ordinal, messageIndex, bodyBytes),
      receipts_enabled: boolean(config.receipts_enabled, 'receipts_enabled'),
      send_to_ack_p95_limit_ms: positiveNumber(
        config.send_to_ack_p95_limit_ms,
        'send_to_ack_p95_limit_ms'
      ),
      send_to_ack_p99_limit_ms: positiveNumber(
        config.send_to_ack_p99_limit_ms,
        'send_to_ack_p99_limit_ms'
      ),
      send_to_delivery_p95_limit_ms: positiveNumber(
        config.send_to_delivery_p95_limit_ms,
        'send_to_delivery_p95_limit_ms'
      ),
      send_to_delivery_p99_limit_ms: positiveNumber(
        config.send_to_delivery_p99_limit_ms,
        'send_to_delivery_p99_limit_ms'
      ),
      delivery_settle_ms: integer(
        config.delivery_settle_ms,
        0,
        10_000,
        'delivery_settle_ms'
      ),
      offline_recovery_message_count: integer(
        config.offline_recovery_message_count,
        0,
        1_000,
        'offline_recovery_message_count'
      ),
      offline_recovery_p99_limit_ms: positiveNumber(
        config.offline_recovery_p99_limit_ms,
        'offline_recovery_p99_limit_ms'
      )
    });
  } else {
    client = await runTinodeConnectionShard({
      ...common,
      connection_hold_ms: integer(
        config.connection_hold_ms,
        1,
        86_400_000,
        'connection_hold_ms'
      ),
      activity_interval_ms: integer(
        config.activity_interval_ms,
        1,
        3_600_000,
        'activity_interval_ms'
      )
    });
  }
  const passed = client.status === 'controlled_pass';
  return {
    schema_version: '1.0.0',
    outcome: passed ? 'completed' : 'failed',
    error_code: passed ? '' : 'tinode_protocol_failed',
    evidence_kind: 'tinode_client_protocol',
    evidence: {
      schema_version: '1.0.0',
      evidence_level: 'controlled',
      capacity_claim: 'none',
      observation_scope: 'client_only',
      phase_id: command.phase_id,
      workload_domain: command.assignment.workload_domain,
      workload_id: command.assignment.workload_id,
      expected_count: command.assignment.expected_count,
      endpoint: publicEndpoint(config.endpoint),
      credential_bundle_sha256: fileSha256(config.credential_bundle_path),
      client
    }
  };
}

async function executeCompositeCommand(
  command: CapacityStartShardCommand,
  config: TinodeCapacityWorkerStaticInput
): Promise<CapacityShardExecutionResult> {
  const covered = command.assignment.covered_workloads?.[0];
  if (!covered) throw new Error('Tinode composite workload is missing');
  const bundle = compositeCredentialBundleForCommand(config, command);
  const output = await executeTinodeCompositeRunnerInput({
    schema_version: '1.0.0',
    endpoint: endpoint(config.endpoint),
    credential_bundle_path: bundle.path,
    run_id: command.run_id,
    shard_id: command.shard_id,
    worker_id: command.worker_id,
    lease_epoch: command.lease_epoch,
    connection_ordinal_start: command.assignment.ordinal_start,
    connection_ordinal_end_exclusive: command.assignment.ordinal_end_exclusive,
    interaction_ordinal_start: covered.ordinal_start,
    interaction_ordinal_end_exclusive: covered.ordinal_end_exclusive,
    messages_per_interaction: integer(
      config.messages_per_interaction,
      1,
      10_000,
      'messages_per_interaction'
    ),
    message_body_bytes: integer(config.message_body_bytes, 32, 65_536, 'message_body_bytes'),
    receipts_enabled: boolean(config.receipts_enabled, 'receipts_enabled'),
    maximum_reconnects: integer(config.maximum_reconnects, 0, 100, 'maximum_reconnects'),
    reconnect_delay_ms: integer(config.reconnect_delay_ms, 0, 60_000, 'reconnect_delay_ms'),
    request_timeout_ms: integer(config.request_timeout_ms, 250, 60_000, 'request_timeout_ms'),
    send_to_ack_p95_limit_ms: positiveNumber(
      config.send_to_ack_p95_limit_ms,
      'send_to_ack_p95_limit_ms'
    ),
    send_to_ack_p99_limit_ms: positiveNumber(
      config.send_to_ack_p99_limit_ms,
      'send_to_ack_p99_limit_ms'
    ),
    send_to_delivery_p95_limit_ms: positiveNumber(
      config.send_to_delivery_p95_limit_ms,
      'send_to_delivery_p95_limit_ms'
    ),
    send_to_delivery_p99_limit_ms: positiveNumber(
      config.send_to_delivery_p99_limit_ms,
      'send_to_delivery_p99_limit_ms'
    ),
    delivery_settle_ms: integer(config.delivery_settle_ms, 0, 10_000, 'delivery_settle_ms'),
    connection_hold_ms: integer(config.connection_hold_ms, 0, 86_400_000, 'connection_hold_ms'),
    connection_ramp_per_second: integer(
      config.connection_ramp_per_second,
      1,
      100_000,
      'connection_ramp_per_second'
    ),
    interaction_start_rate_per_second: integer(
      config.interaction_start_rate_per_second,
      1,
      100_000,
      'interaction_start_rate_per_second'
    ),
    concurrency: integer(config.concurrency, 1, 100_000, 'concurrency')
  });
  if (output.connection_expected_count !== command.assignment.expected_count ||
      output.interaction_expected_count !== covered.expected_count ||
      output.credential_bundle_sha256 !== bundle.sha256) {
    throw new Error('Tinode composite runner evidence does not match its assignment');
  }
  const client = output.client;
  const passed = client.status === 'controlled_pass';
  return {
    schema_version: '1.0.0',
    outcome: passed ? 'completed' : 'failed',
    error_code: passed ? '' : 'tinode_composite_protocol_failed',
    evidence_kind: 'tinode_composite_protocol',
    evidence: {
      schema_version: output.schema_version,
      evidence_level: output.evidence_level,
      capacity_claim: output.capacity_claim,
      observation_scope: output.observation_scope,
      phase_id: command.phase_id,
      endpoint: output.endpoint,
      credential_bundle_sha256: output.credential_bundle_sha256,
      workload_evidence: [{
        workload_domain: command.assignment.workload_domain,
        workload_id: command.assignment.workload_id,
        expected_count: command.assignment.expected_count,
        attempted_count: client.connection_attempted_count,
        accepted_count: client.connection_accepted_count,
        active_peak_count: client.connection_active_peak_count
      }, {
        workload_domain: covered.workload_domain,
        workload_id: covered.workload_id,
        expected_count: covered.expected_count,
        attempted_count: client.interaction_attempted_count,
        accepted_count: client.interaction_active_count,
        active_peak_count: client.interaction_active_count
      }],
      client
    }
  };
}

function compositeCredentialBundleForCommand(
  config: TinodeCapacityWorkerStaticInput,
  command: CapacityStartShardCommand
): TinodeCompositeCredentialBundleBinding {
  const bindings = config.composite_credential_bundles;
  if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 10_000) {
    throw new Error('Tinode composite credential bundle bindings are invalid');
  }
  const seen = new Set<string>();
  let matched: TinodeCompositeCredentialBundleBinding | undefined;
  for (const [index, binding] of bindings.entries()) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        Object.keys(binding).sort().join('|') !==
          ['phase_id', 'path', 'run_id', 'sha256', 'shard_id'].sort().join('|') ||
        !validBindingToken(binding.run_id) ||
        !validBindingToken(binding.phase_id) ||
        typeof binding.shard_id !== 'string' ||
        binding.shard_id.length < 3 ||
        binding.shard_id.length > 255 ||
        /[\r\n\0]/.test(binding.shard_id) ||
        !/^[a-f0-9]{64}$/.test(String(binding.sha256 || ''))) {
      throw new Error(`Tinode composite credential bundle binding ${index} is invalid`);
    }
    const normalized = {
      run_id: binding.run_id,
      phase_id: binding.phase_id,
      shard_id: binding.shard_id,
      path: absolutePath(binding.path, `composite credential bundle binding ${index} path`),
      sha256: binding.sha256
    };
    const key = `${normalized.run_id}\0${normalized.phase_id}\0${normalized.shard_id}`;
    if (seen.has(key)) throw new Error('Tinode composite credential bundle binding is duplicated');
    seen.add(key);
    if (normalized.run_id === command.run_id &&
        normalized.phase_id === command.phase_id &&
        normalized.shard_id === command.shard_id) {
      matched = normalized;
    }
  }
  if (!matched) throw new Error('Tinode composite credential bundle binding is missing');
  if (fileSha256(matched.path) !== matched.sha256) {
    throw new Error('Tinode composite credential bundle checksum mismatch');
  }
  return matched;
}

function validBindingToken(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(value);
}

function validateWorkerInput(raw: TinodeCapacityWorkerInput): TinodeCapacityWorkerInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      raw.schema_version !== '1.0.0' ||
      !raw.static_input || typeof raw.static_input !== 'object' ||
      Array.isArray(raw.static_input)) {
    throw new Error('invalid Tinode capacity worker input');
  }
  absolutePath(raw.result_path, 'result_path');
  const command = raw.command;
  if (!command || command.schema_version !== '1.0.0' ||
      command.command_type !== 'start_shard' ||
      command.fleet_id !== 'tinode' ||
      !command.assignment ||
      command.assignment.expected_count !==
        command.assignment.ordinal_end_exclusive - command.assignment.ordinal_start ||
      !command.assignment.required_protocols.includes('tinode_websocket')) {
    throw new Error('invalid Tinode capacity command');
  }
  const pair = `${command.assignment.workload_domain}:${command.assignment.workload_id}`;
  if (!['interaction:tinode_im', 'connection:tinode_websocket'].includes(pair) ||
      command.assignment.workload_kind !== command.assignment.workload_id) {
    throw new Error('unsupported Tinode capacity workload');
  }
  const covered = command.assignment.covered_workloads ?? [];
  if (covered.length > 0) {
    if (pair !== 'connection:tinode_websocket' || covered.length !== 1) {
      throw new Error('unsupported Tinode composite capacity workload');
    }
    const logical = covered[0];
    if (`${logical.workload_domain}:${logical.workload_id}` !== 'interaction:tinode_im' ||
        logical.workload_kind !== logical.workload_id ||
        logical.expected_count !== logical.ordinal_end_exclusive - logical.ordinal_start) {
      throw new Error('unsupported Tinode composite capacity workload');
    }
  }
  const expectedShardId = [
    command.assignment.workload_domain,
    command.assignment.workload_id,
    `${command.assignment.ordinal_start}-${command.assignment.ordinal_end_exclusive}`
  ].join('/');
  if (command.shard_id !== expectedShardId) {
    throw new Error('Tinode capacity shard identity mismatch');
  }
  if (!/^[1-9][0-9]{0,18}$/.test(command.lease_epoch)) {
    throw new Error('Tinode capacity lease epoch is invalid');
  }
  absolutePath(raw.static_input.credential_bundle_path, 'credential_bundle_path');
  endpoint(raw.static_input.endpoint);
  return structuredClone(raw);
}

function readCredentialBundle(path: string): TinodeCredentialBundle {
  absolutePath(path, 'credential_bundle_path');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 ||
      stat.size > 64 * 1024 * 1024) {
    throw new Error('Tinode credential bundle must be a bounded regular file');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Tinode credential bundle permissions must deny group and other access');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Tinode credential bundle is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tinode credential bundle is invalid');
  }
  const raw = parsed as Record<string, unknown>;
  const apiKey = secret(raw.api_key, 'api_key', 4_096);
  if (raw.schema_version !== '1.0.0' || !Array.isArray(raw.credentials) ||
      raw.credentials.length < 1 || raw.credentials.length > 1_000_000) {
    throw new Error('Tinode credential bundle is invalid');
  }
  const seen = new Set<string>();
  const credentials = raw.credentials.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Tinode credential ${index} is invalid`);
    }
    const value = item as Record<string, any>;
    const workloadDomain = String(value.workload_domain) as TinodeWorkloadDomain;
    const workloadId = String(value.workload_id) as TinodeWorkloadId;
    const pair = `${workloadDomain}:${workloadId}`;
    if (!['interaction:tinode_im', 'connection:tinode_websocket'].includes(pair)) {
      throw new Error(`Tinode credential ${index} has an unsupported workload`);
    }
    const ordinal = integer(value.ordinal, 0, Number.MAX_SAFE_INTEGER, `credential ${index} ordinal`);
    const key = `${pair}:${ordinal}`;
    if (seen.has(key)) throw new Error(`Tinode credential ${index} is duplicated`);
    seen.add(key);
    const scheme = String(value.auth?.scheme || '');
    if (scheme !== 'token' && scheme !== 'basic') {
      throw new Error(`Tinode credential ${index} has an invalid auth scheme`);
    }
    const topic = String(value.topic || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(topic)) {
      throw new Error(`Tinode credential ${index} has an invalid topic`);
    }
    return {
      workload_domain: workloadDomain,
      workload_id: workloadId,
      ordinal,
      auth: {
        scheme,
        secret: secret(value.auth?.secret, `credential ${index} secret`, 8_192)
      },
      topic
    } satisfies TinodeCredential;
  });
  return { schema_version: '1.0.0', api_key: apiKey, credentials };
}

function credentialsForCommand(
  credentials: TinodeCredential[],
  command: CapacityStartShardCommand
): Map<number, TinodeCredential> {
  const result = new Map<number, TinodeCredential>();
  for (const credential of credentials) {
    if (credential.workload_domain !== command.assignment.workload_domain ||
        credential.workload_id !== command.assignment.workload_id ||
        credential.ordinal < command.assignment.ordinal_start ||
        credential.ordinal >= command.assignment.ordinal_end_exclusive) {
      continue;
    }
    result.set(credential.ordinal, credential);
  }
  for (let ordinal = command.assignment.ordinal_start;
    ordinal < command.assignment.ordinal_end_exclusive;
    ordinal += 1) {
    if (!result.has(ordinal)) {
      throw new Error(`Tinode credential bundle is missing ordinal ${ordinal}`);
    }
  }
  return result;
}

function messageBody(
  runId: string,
  ordinal: number,
  messageIndex: number,
  bytes: number
): string {
  const prefix = `${runId}:${ordinal}:${messageIndex}:`;
  if (Buffer.byteLength(prefix) >= bytes) return prefix.slice(0, bytes);
  return `${prefix}${'x'.repeat(bytes - Buffer.byteLength(prefix))}`;
}

function endpoint(value: unknown): string {
  const url = new URL(String(value || ''));
  if (!['ws:', 'wss:'].includes(url.protocol) ||
      url.username || url.password || url.hash ||
      [...url.searchParams.keys()].length > 0) {
    throw new Error('Tinode endpoint must be a credential-free ws or wss URL');
  }
  return url.toString();
}

function publicEndpoint(value: unknown): string {
  const url = new URL(endpoint(value));
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function absolutePath(value: unknown, field: string): string {
  const result = String(value || '');
  if (!result.startsWith('/') || /[\r\n\0]/.test(result) ||
      result.split('/').includes('..')) {
    throw new Error(`Tinode ${field} must be an absolute path`);
  }
  return result;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Tinode ${field} must be boolean`);
  return value;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Tinode ${field} is invalid`);
  }
  return Number(value);
}

function positiveNumber(value: unknown, field: string): number {
  if (!Number.isFinite(value) || Number(value) <= 0) {
    throw new Error(`Tinode ${field} is invalid`);
  }
  return Number(value);
}

function secret(value: unknown, field: string, maximumBytes: number): string {
  const result = String(value || '');
  const size = Buffer.byteLength(result);
  if (size < 1 || size > maximumBytes || /[\r\n\0]/.test(result)) {
    throw new Error(`Tinode ${field} is invalid`);
  }
  return result;
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
