import { execFile as execFileCallback } from 'node:child_process';
import {
  createHash,
  createHmac,
  randomBytes
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { cpus, hostname, platform, release, totalmem } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join
} from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import {
  provisionTinodeCompositeBundle,
  type TinodeCompositeProvisionResult
} from './generators/tinode-composite-provisioner.js';
import {
  executeTinodeCompositeRunnerInput,
  type TinodeCompositeRunnerOutput
} from './generators/tinode-composite-runner.js';

const execFile = promisify(execFileCallback);

export interface TinodeStaircaseConfigInput {
  output_file: string;
  tinode_image: string;
  postgres_image: string;
  points?: number[];
  tinode_port?: number;
  connection_ramp_per_second?: number;
  interaction_start_rate_per_second?: number;
  messages_per_interaction?: number;
  message_body_bytes?: number;
  connection_hold_ms?: number;
  sample_interval_ms?: number;
  agent_topic_capacity?: number;
  concurrency?: number;
  provision_concurrency?: number;
  request_timeout_ms?: number;
  delivery_settle_ms?: number;
}

export interface TinodeStaircaseConfig {
  output_file: string;
  tinode_image: string;
  postgres_image: string;
  points: number[];
  tinode_port: number;
  connection_ramp_per_second: number;
  interaction_start_rate_per_second: number;
  messages_per_interaction: number;
  message_body_bytes: number;
  connection_hold_ms: number;
  sample_interval_ms: number;
  agent_topic_capacity: number;
  concurrency: number;
  provision_concurrency: number;
  request_timeout_ms: number;
  delivery_settle_ms: number;
}

export interface TinodeApiCredential {
  api_key: string;
  api_key_salt: string;
}

export interface DockerStatsSample {
  cpu_percent: number;
  memory_bytes: number;
  pids: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  block_read_bytes: number;
  block_write_bytes: number;
}

interface GeneratorResourceSample {
  cpu_percent: number;
  rss_bytes: number;
}

interface TinodeStaircaseResourceSample {
  elapsed_ms: number;
  sample_interval_ms: number;
  tinode: DockerStatsSample | null;
  tinode_live_sessions: number | null;
  generator: GeneratorResourceSample;
  errors: string[];
}

interface TinodeStaircasePointEvidence {
  connections: number;
  interactions: number;
  logical_identities: number | null;
  topics: number | null;
  messages: number;
  status: 'controlled_pass' | 'controlled_failed';
  capacity_claim: 'none';
  observation_scope: 'client_and_sut_single_node';
  provision_result_sha256: string | null;
  result_sha256: string | null;
  credential_bundle_sha256: string | null;
  client: TinodeCompositeRunnerOutput['client'] | null;
  reconciliation: {
    client_attempted: number | null;
    client_accepted: number | null;
    client_active_peak: number | null;
    client_closed: number | null;
    sut_live_sessions_max: number | null;
    exact_match: boolean;
  };
  tinode_resources: {
    cpu_max_percent: number | null;
    memory_max_bytes: number | null;
    pids_max: number | null;
    network_rx_max_bytes: number | null;
    network_tx_max_bytes: number | null;
  };
  generator_resources: {
    cpu_max_percent: number | null;
    rss_max_bytes: number | null;
  };
  resource_samples: TinodeStaircaseResourceSample[];
  sampling_error_count: number;
  sensitive_inputs_removed: boolean;
  error?: string;
}

export interface TinodeStaircaseEvidence {
  schema_version: '1.0.0';
  evidence_id: string;
  captured_at: string;
  status: 'controlled_pass' | 'controlled_failed';
  evidence_level: 'controlled';
  capacity_claim: 'none';
  observation_scope: 'client_and_sut_single_node';
  verification_scope: string;
  server: {
    hostname: string;
    platform: string;
    kernel_release: string;
    logical_cpu_count: number;
    cpu_model: string;
    memory_bytes: number;
    docker_server_version: string;
  };
  source: {
    git_commit: string;
    relevant_files_dirty: boolean;
    sha256: Record<string, string>;
  };
  images: {
    tinode: DockerImageIdentity;
    postgres: DockerImageIdentity;
  };
  workload: {
    points: number[];
    messages_per_interaction: number;
    message_body_bytes: number;
    connection_ramp_per_second: number;
    interaction_start_rate_per_second: number;
    connection_hold_ms: number;
    resource_sample_interval_target_ms: number;
    receipts_enabled: true;
    topology: string;
  };
  controls: {
    isolated_docker_network_per_point: true;
    read_only_tinode_rootfs: true;
    capabilities_dropped: true;
    no_new_privileges: true;
    credential_bundle_mode: '0600';
    credential_bundle_removed_after_run: boolean;
    source_tree_dirty_recorded: true;
    led_containers_before: Array<{ name: string; status: string }>;
    led_containers_after: Array<{ name: string; status: string }>;
    led_state_preserved: boolean;
    test_resources_remaining: number;
  };
  points: TinodeStaircasePointEvidence[];
  limitations: string[];
  failure?: {
    connections: number | null;
    reason: string;
  };
}

interface DockerImageIdentity {
  requested_reference: string;
  image_id: string;
  architecture: string;
  operating_system: string;
  size_bytes: number;
  repo_digests: string[];
}

interface PointNames {
  prefix: string;
  network: string;
  database: string;
  tinode: string;
}

interface PointSecrets {
  api: TinodeApiCredential;
  postgres_password: string;
  auth_token_key: string;
  uid_encryption_key: string;
}

const SOURCE_FILES = [
  'scripts/capacity/generators/tinode-composite.ts',
  'scripts/capacity/generators/tinode-composite-provisioner.ts',
  'scripts/capacity/generators/tinode-composite-runner.ts',
  'scripts/capacity/tinode-staircase.ts',
  'scripts/ivekit-capacity-tinode-staircase.ts'
];

export function generateTinodeApiCredential(input: {
  salt: Buffer;
  sequence?: number;
  is_root?: boolean;
}): TinodeApiCredential {
  if (!Buffer.isBuffer(input.salt) || input.salt.length !== 32) {
    throw new Error('Tinode API key salt must contain exactly 32 bytes');
  }
  const sequence = integer(input.sequence ?? 1, 1, 65_535, 'Tinode API key sequence');
  const data = Buffer.alloc(24);
  data[0] = 1;
  data.writeUInt32LE(0, 1);
  data.writeUInt16LE(sequence, 5);
  data[7] = input.is_root ? 1 : 0;
  createHmac('md5', input.salt).update(data.subarray(0, 8)).digest().copy(data, 8);
  return {
    api_key: data.toString('base64url'),
    api_key_salt: input.salt.toString('base64')
  };
}

export function normalizeTinodeStaircaseConfig(
  input: TinodeStaircaseConfigInput
): TinodeStaircaseConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Tinode staircase config is invalid');
  }
  const outputFile = String(input.output_file || '').trim();
  if (!isAbsolute(outputFile) || !outputFile.endsWith('.json')) {
    throw new Error('Tinode staircase output_file must be an absolute JSON path');
  }
  const tinodeImage = imageReference(input.tinode_image, 'tinode_image');
  const postgresImage = imageReference(input.postgres_image, 'postgres_image');
  if (!postgresImage.includes('@sha256:')) {
    throw new Error('Tinode staircase postgres_image must use an immutable digest');
  }
  const points = [...(input.points ?? [100, 250, 500, 1_000])];
  if (points.length === 0 || points.length > 32) {
    throw new Error('Tinode staircase points must contain between 1 and 32 entries');
  }
  let previous = 0;
  for (const point of points) {
    integer(point, 2, 100_000, 'Tinode staircase point');
    if (point <= previous) throw new Error('Tinode staircase points must be strictly increasing');
    previous = point;
  }
  return {
    output_file: outputFile,
    tinode_image: tinodeImage,
    postgres_image: postgresImage,
    points,
    tinode_port: integer(input.tinode_port ?? 18_061, 1_024, 65_535, 'tinode_port'),
    connection_ramp_per_second: integer(
      input.connection_ramp_per_second ?? 100,
      1,
      100_000,
      'connection_ramp_per_second'
    ),
    interaction_start_rate_per_second: integer(
      input.interaction_start_rate_per_second ?? 33,
      1,
      100_000,
      'interaction_start_rate_per_second'
    ),
    messages_per_interaction: integer(
      input.messages_per_interaction ?? 2,
      1,
      10_000,
      'messages_per_interaction'
    ),
    message_body_bytes: integer(
      input.message_body_bytes ?? 256,
      32,
      65_536,
      'message_body_bytes'
    ),
    connection_hold_ms: integer(
      input.connection_hold_ms ?? 10_000,
      0,
      86_400_000,
      'connection_hold_ms'
    ),
    sample_interval_ms: integer(
      input.sample_interval_ms ?? 500,
      250,
      10_000,
      'sample_interval_ms'
    ),
    agent_topic_capacity: integer(
      input.agent_topic_capacity ?? 3,
      1,
      1_000,
      'agent_topic_capacity'
    ),
    concurrency: integer(input.concurrency ?? 64, 1, 100_000, 'concurrency'),
    provision_concurrency: integer(
      input.provision_concurrency ?? 64,
      1,
      1_000,
      'provision_concurrency'
    ),
    request_timeout_ms: integer(
      input.request_timeout_ms ?? 5_000,
      250,
      60_000,
      'request_timeout_ms'
    ),
    delivery_settle_ms: integer(
      input.delivery_settle_ms ?? 250,
      0,
      10_000,
      'delivery_settle_ms'
    )
  };
}

export function parseDockerStatsSample(raw: Record<string, unknown>): DockerStatsSample {
  const memory = splitPair(raw.MemUsage, 'MemUsage');
  const network = splitPair(raw.NetIO, 'NetIO');
  const block = splitPair(raw.BlockIO, 'BlockIO');
  return {
    cpu_percent: percentage(raw.CPUPerc, 'CPUPerc'),
    memory_bytes: byteQuantity(memory[0], 'MemUsage used'),
    pids: integer(Number(raw.PIDs), 0, Number.MAX_SAFE_INTEGER, 'PIDs'),
    network_rx_bytes: byteQuantity(network[0], 'NetIO received'),
    network_tx_bytes: byteQuantity(network[1], 'NetIO sent'),
    block_read_bytes: byteQuantity(block[0], 'BlockIO read'),
    block_write_bytes: byteQuantity(block[1], 'BlockIO written')
  };
}

export function parseTinodeLiveSessions(raw: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Tinode expvar response is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tinode expvar response is invalid');
  }
  return integer(
    (parsed as Record<string, unknown>).LiveSessions,
    0,
    Number.MAX_SAFE_INTEGER,
    'Tinode LiveSessions'
  );
}

export async function runTinodeStaircase(
  raw: TinodeStaircaseConfigInput
): Promise<TinodeStaircaseEvidence> {
  const config = normalizeTinodeStaircaseConfig(raw);
  if (existsSync(config.output_file)) {
    throw new Error('Tinode staircase output_file already exists');
  }
  mkdirSync(dirname(config.output_file), { recursive: true, mode: 0o755 });
  const runToken = `${compactTimestamp(new Date())}-${randomBytes(4).toString('hex')}`;
  const runDirectory = join(
    dirname(config.output_file),
    `.${basename(config.output_file, '.json')}-${runToken}`
  );

  const capturedAt = new Date().toISOString();
  const ledBefore = await ledContainerState();
  const source = await sourceIdentity();
  const images = {
    tinode: await dockerImageIdentity(config.tinode_image),
    postgres: await dockerImageIdentity(config.postgres_image)
  };
  mkdirSync(runDirectory, { mode: 0o700 });
  const points: TinodeStaircasePointEvidence[] = [];
  let failure: TinodeStaircaseEvidence['failure'];

  try {
    for (const [index, connections] of config.points.entries()) {
      const pointDirectory = join(runDirectory, `point-${connections}`);
      const names = pointNames(runToken, connections);
      try {
        const point = await runPoint({
          config,
          connections,
          point_index: index,
          point_directory: pointDirectory,
          names
        });
        points.push(point);
        if (point.status !== 'controlled_pass') {
          failure = {
            connections,
            reason: point.error || 'Tinode staircase point failed a controlled gate'
          };
          break;
        }
      } catch (error) {
        const reason = safeError(error, []);
        points.push(failedPoint(config, connections, reason));
        failure = { connections, reason };
        break;
      }
    }
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }

  const ledAfter = await ledContainerState();
  const remaining = await countTestResources(runToken);
  const ledPreserved = JSON.stringify(ledBefore) === JSON.stringify(ledAfter);
  if (!failure && !ledPreserved) {
    failure = { connections: null, reason: 'LED container state changed during Tinode staircase' };
  }
  if (!failure && remaining !== 0) {
    failure = { connections: null, reason: 'Tinode staircase left Docker resources behind' };
  }
  if (!failure && points.length !== config.points.length) {
    failure = { connections: null, reason: 'Tinode staircase did not execute every configured point' };
  }

  const evidence: TinodeStaircaseEvidence = {
    schema_version: '1.0.0',
    evidence_id: `tinode-composite-strict-staircase-${runToken}`,
    captured_at: capturedAt,
    status: failure ? 'controlled_failed' : 'controlled_pass',
    evidence_level: 'controlled',
    capacity_claim: 'none',
    observation_scope: 'client_and_sut_single_node',
    verification_scope:
      'Current-source single-node Tinode WebSocket connection and interaction staircase with strict start-rate gates',
    server: await serverIdentity(),
    source,
    images,
    workload: {
      points: [...config.points],
      messages_per_interaction: config.messages_per_interaction,
      message_body_bytes: config.message_body_bytes,
      connection_ramp_per_second: config.connection_ramp_per_second,
      interaction_start_rate_per_second: config.interaction_start_rate_per_second,
      connection_hold_ms: config.connection_hold_ms,
      resource_sample_interval_target_ms: config.sample_interval_ms,
      receipts_enabled: true,
      topology:
        'one customer device per interaction; agent identities serve bounded topic sets; remaining connections are second agent devices'
    },
    controls: {
      isolated_docker_network_per_point: true,
      read_only_tinode_rootfs: true,
      capabilities_dropped: true,
      no_new_privileges: true,
      credential_bundle_mode: '0600',
      credential_bundle_removed_after_run: points.every((point) => point.sensitive_inputs_removed),
      source_tree_dirty_recorded: true,
      led_containers_before: ledBefore,
      led_containers_after: ledAfter,
      led_state_preserved: ledPreserved,
      test_resources_remaining: remaining
    },
    points,
    limitations: [
      'This is controlled single-node evidence, not a production capacity claim.',
      'The generator and SUT share one host, so generator contention is measured but not eliminated.',
      'This run does not prove multi-node scaling, failure recovery, weak-network behavior or long-duration stability.'
    ],
    ...(failure ? { failure } : {})
  };
  writeJsonAtomic(config.output_file, evidence);
  return evidence;
}

async function runPoint(input: {
  config: TinodeStaircaseConfig;
  connections: number;
  point_index: number;
  point_directory: string;
  names: PointNames;
}): Promise<TinodeStaircasePointEvidence> {
  const { config, connections, point_index: pointIndex, point_directory: pointDirectory, names } = input;
  mkdirSync(pointDirectory, { mode: 0o700 });
  const credentialPath = join(pointDirectory, 'credentials.json');
  const postgresEnvPath = join(pointDirectory, 'postgres.env');
  const tinodeEnvPath = join(pointDirectory, 'tinode.env');
  const secrets = pointSecrets();
  const secretValues = [
    secrets.api.api_key,
    secrets.api.api_key_salt,
    secrets.postgres_password,
    secrets.auth_token_key,
    secrets.uid_encryption_key
  ];
  const interactions = Math.floor(connections * 2 / 3);
  let sampler: ReturnType<typeof startResourceSampler> | null = null;
  let pointEvidence: TinodeStaircasePointEvidence | null = null;
  let primaryError: unknown;
  let cleanupErrors: string[] = [];

  try {
    writePrivateEnv(postgresEnvPath, {
      POSTGRES_USER: 'tinode',
      POSTGRES_DB: 'tinode',
      POSTGRES_PASSWORD: secrets.postgres_password
    });
    writePrivateEnv(tinodeEnvPath, {
      ACC_GC_ENABLED: 'false',
      WAIT_FOR: 'tinode-db:5432',
      SAMPLE_DATA: '',
      AUTH_TOKEN_KEY: secrets.auth_token_key,
      POSTGRES_DSN:
        `postgres://tinode:${secrets.postgres_password}@tinode-db:5432/tinode?sslmode=disable`,
      API_KEY_SALT: secrets.api.api_key_salt,
      UID_ENCRYPTION_KEY: secrets.uid_encryption_key,
      STORE_USE_ADAPTER: 'postgres',
      RESET_DB: 'false',
      UPGRADE_DB: 'false',
      NO_DB_INIT: 'false',
      MEDIA_HANDLER: 'fs',
      FS_CORS_ORIGINS: '[]',
      AWS_CORS_ORIGINS: '[]',
      WEBRTC_ENABLED: 'false',
      TLS_ENABLED: 'false',
      TARGET_DB: 'postgres',
      SERVER_STATUS_PATH: ''
    });
    await docker(['network', 'create', names.network]);
    await docker([
      'run',
      '--detach',
      '--name',
      names.database,
      '--network',
      names.network,
      '--network-alias',
      'tinode-db',
      '--env-file',
      postgresEnvPath,
      '--tmpfs',
      '/var/lib/postgresql/data:rw,nosuid,nodev,size=2g',
      config.postgres_image
    ], 60_000);
    await waitForPostgres(names.database);
    await docker([
      'run',
      '--detach',
      '--name',
      names.tinode,
      '--network',
      names.network,
      '--network-alias',
      'tinode',
      '--publish',
      `127.0.0.1:${config.tinode_port}:6060`,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=512m,uid=10001,gid=10001,mode=700',
      '--tmpfs',
      '/var/log:rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=700',
      '--env-file',
      tinodeEnvPath,
      config.tinode_image
    ], 60_000);
    await waitForTinode(config.tinode_port, secrets.api.api_key);

    const endpoint = `ws://127.0.0.1:${config.tinode_port}/v0/channels`;
    const namespace = `ivekit-tcs-${connections}-${randomBytes(3).toString('hex')}`;
    const provisionResult = await provisionTinodeCompositeBundle({
      endpoint,
      api_key: secrets.api.api_key,
      output_path: credentialPath,
      namespace,
      connection_count: connections,
      interaction_count: interactions,
      agent_topic_capacity: config.agent_topic_capacity,
      concurrency: config.provision_concurrency,
      request_timeout_ms: config.request_timeout_ms
    });
    assertPrivateFile(credentialPath);
    const samplerStartedAt = performance.now();
    sampler = startResourceSampler({
      container: names.tinode,
      tinode_port: config.tinode_port,
      api_key: secrets.api.api_key,
      interval_ms: config.sample_interval_ms,
      started_at: samplerStartedAt,
      secret_values: secretValues
    });
    let runnerResult: TinodeCompositeRunnerOutput;
    try {
      runnerResult = await executeTinodeCompositeRunnerInput({
        schema_version: '1.0.0',
        endpoint,
        credential_bundle_path: credentialPath,
        run_id: `tinode-strict-${connections}-${pointIndex}`,
        shard_id: `composite/tinode/0-${connections}`,
        worker_id: 'tinode-staircase-worker',
        lease_epoch: '1',
        messages_per_interaction: config.messages_per_interaction,
        message_body_bytes: config.message_body_bytes,
        receipts_enabled: true,
        maximum_reconnects: 1,
        reconnect_delay_ms: 100,
        request_timeout_ms: config.request_timeout_ms,
        send_to_ack_p95_limit_ms: 200,
        send_to_ack_p99_limit_ms: 500,
        send_to_delivery_p95_limit_ms: 250,
        send_to_delivery_p99_limit_ms: 750,
        delivery_settle_ms: config.delivery_settle_ms,
        connection_hold_ms: config.connection_hold_ms,
        connection_ramp_per_second: config.connection_ramp_per_second,
        interaction_start_rate_per_second: config.interaction_start_rate_per_second,
        concurrency: config.concurrency
      });
    } finally {
      await sampler.stop();
    }
    const samples = sampler.samples();
    pointEvidence = completedPoint(
      config,
      connections,
      interactions,
      provisionResult,
      runnerResult,
      samples
    );
  } catch (error) {
    const diagnostics = await capturePointDiagnostics(names, secretValues);
    primaryError = new Error(
      `${safeError(error, secretValues)}${diagnostics ? `; diagnostics: ${diagnostics}` : ''}`
    );
    if (sampler) {
      try {
        await sampler.stop();
      } catch (stopError) {
        cleanupErrors.push(safeError(stopError, secretValues));
      }
    }
  } finally {
    cleanupErrors = [
      ...cleanupErrors,
      ...(await cleanupPoint(names, secretValues))
    ];
    rmSync(pointDirectory, { recursive: true, force: true });
  }

  if (primaryError || cleanupErrors.length > 0) {
    const parts = [
      ...(primaryError ? [safeError(primaryError, secretValues)] : []),
      ...cleanupErrors.map((error) => `cleanup: ${error}`)
    ];
    throw new Error(parts.join('; '));
  }
  if (!pointEvidence) throw new Error('Tinode staircase point produced no evidence');
  pointEvidence.sensitive_inputs_removed =
    !existsSync(credentialPath) &&
    !existsSync(postgresEnvPath) &&
    !existsSync(tinodeEnvPath);
  return pointEvidence;
}

function completedPoint(
  config: TinodeStaircaseConfig,
  connections: number,
  interactions: number,
  provisionResult: TinodeCompositeProvisionResult,
  runnerResult: TinodeCompositeRunnerOutput,
  samples: TinodeStaircaseResourceSample[]
): TinodeStaircasePointEvidence {
  const client = runnerResult.client;
  const liveSessionsMax = maximum(samples, (sample) => sample.tinode_live_sessions);
  const exactMatch =
    client.connection_attempted_count === connections &&
    client.connection_accepted_count === connections &&
    client.connection_active_peak_count === connections &&
    client.connection_closed_count === connections &&
    liveSessionsMax === connections;
  const samplingErrorCount = samples.reduce(
    (total, sample) => total + sample.errors.length,
    0
  );
  const passed =
    client.status === 'controlled_pass' &&
    client.connection_rate_conformant &&
    client.interaction_rate_conformant &&
    exactMatch &&
    samples.length > 0 &&
    samplingErrorCount === 0;
  const reasons = [
    ...(client.status !== 'controlled_pass' ? ['client generator failed'] : []),
    ...(!client.connection_rate_conformant ? ['connection start rate was not conformant'] : []),
    ...(!client.interaction_rate_conformant ? ['interaction start rate was not conformant'] : []),
    ...(!exactMatch ? ['client and Tinode LiveSessions did not reconcile exactly'] : []),
    ...(samples.length === 0 ? ['resource sampler produced no samples'] : []),
    ...(samplingErrorCount > 0 ? ['resource sampler reported errors'] : [])
  ];
  return {
    connections,
    interactions,
    logical_identities: provisionResult.logical_identity_count,
    topics: provisionResult.topic_count,
    messages: interactions * config.messages_per_interaction,
    status: passed ? 'controlled_pass' : 'controlled_failed',
    capacity_claim: 'none',
    observation_scope: 'client_and_sut_single_node',
    provision_result_sha256: canonicalSha256(provisionResult),
    result_sha256: canonicalSha256(runnerResult),
    credential_bundle_sha256: provisionResult.bundle_sha256,
    client,
    reconciliation: {
      client_attempted: client.connection_attempted_count,
      client_accepted: client.connection_accepted_count,
      client_active_peak: client.connection_active_peak_count,
      client_closed: client.connection_closed_count,
      sut_live_sessions_max: liveSessionsMax,
      exact_match: exactMatch
    },
    tinode_resources: {
      cpu_max_percent: maximum(samples, (sample) => sample.tinode?.cpu_percent ?? null),
      memory_max_bytes: maximum(samples, (sample) => sample.tinode?.memory_bytes ?? null),
      pids_max: maximum(samples, (sample) => sample.tinode?.pids ?? null),
      network_rx_max_bytes: maximum(
        samples,
        (sample) => sample.tinode?.network_rx_bytes ?? null
      ),
      network_tx_max_bytes: maximum(
        samples,
        (sample) => sample.tinode?.network_tx_bytes ?? null
      )
    },
    generator_resources: {
      cpu_max_percent: maximum(samples, (sample) => sample.generator.cpu_percent),
      rss_max_bytes: maximum(samples, (sample) => sample.generator.rss_bytes)
    },
    resource_samples: samples,
    sampling_error_count: samplingErrorCount,
    sensitive_inputs_removed: false,
    ...(reasons.length > 0 ? { error: reasons.join('; ') } : {})
  };
}

function failedPoint(
  config: TinodeStaircaseConfig,
  connections: number,
  error: string
): TinodeStaircasePointEvidence {
  const interactions = Math.floor(connections * 2 / 3);
  return {
    connections,
    interactions,
    logical_identities: null,
    topics: null,
    messages: interactions * config.messages_per_interaction,
    status: 'controlled_failed',
    capacity_claim: 'none',
    observation_scope: 'client_and_sut_single_node',
    provision_result_sha256: null,
    result_sha256: null,
    credential_bundle_sha256: null,
    client: null,
    reconciliation: {
      client_attempted: null,
      client_accepted: null,
      client_active_peak: null,
      client_closed: null,
      sut_live_sessions_max: null,
      exact_match: false
    },
    tinode_resources: {
      cpu_max_percent: null,
      memory_max_bytes: null,
      pids_max: null,
      network_rx_max_bytes: null,
      network_tx_max_bytes: null
    },
    generator_resources: {
      cpu_max_percent: null,
      rss_max_bytes: null
    },
    resource_samples: [],
    sampling_error_count: 0,
    sensitive_inputs_removed: true,
    error
  };
}

function startResourceSampler(input: {
  container: string;
  tinode_port: number;
  api_key: string;
  interval_ms: number;
  started_at: number;
  secret_values: string[];
}): {
  stop(): Promise<void>;
  samples(): TinodeStaircaseResourceSample[];
} {
  let stopped = false;
  const samples: TinodeStaircaseResourceSample[] = [];
  let previousCpu = process.cpuUsage();
  let previousAt = performance.now();
  const task = (async () => {
    while (!stopped) {
      const errors: string[] = [];
      let tinode: DockerStatsSample | null = null;
      let liveSessions: number | null = null;
      try {
        tinode = await dockerStats(input.container);
      } catch (error) {
        errors.push(safeError(error, input.secret_values));
      }
      try {
        liveSessions = await readTinodeLiveSessions(input.tinode_port, input.api_key);
      } catch (error) {
        errors.push(safeError(error, input.secret_values));
      }
      const sampledAt = performance.now();
      const cpu = process.cpuUsage(previousCpu);
      const elapsed = Math.max(0.001, sampledAt - previousAt);
      previousCpu = process.cpuUsage();
      previousAt = sampledAt;
      samples.push({
        elapsed_ms: roundMilliseconds(sampledAt - input.started_at),
        sample_interval_ms: roundMilliseconds(elapsed),
        tinode,
        tinode_live_sessions: liveSessions,
        generator: {
          cpu_percent: roundMilliseconds(
            ((cpu.user + cpu.system) / (elapsed * 1_000)) * 100
          ),
          rss_bytes: process.memoryUsage().rss
        },
        errors
      });
      if (!stopped) await delay(input.interval_ms);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await task;
    },
    samples() {
      return structuredClone(samples);
    }
  };
}

async function dockerStats(container: string): Promise<DockerStatsSample> {
  const output = await docker([
    'stats',
    '--no-stream',
    '--format',
    '{{json .}}',
    container
  ], 10_000);
  return parseDockerStatsSample(JSON.parse(output.trim()) as Record<string, unknown>);
}

async function readTinodeLiveSessions(port: number, apiKey: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/stats/expvar/`, {
      headers: { 'X-Tinode-APIKey': apiKey },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Tinode expvar returned HTTP ${response.status}`);
    return parseTinodeLiveSessions(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

async function waitForPostgres(container: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = 'PostgreSQL readiness was not attempted';
  while (Date.now() < deadline) {
    try {
      await docker(['exec', container, 'pg_isready', '-U', 'tinode', '-d', 'tinode'], 5_000);
      return;
    } catch (error) {
      lastError = safeError(error, []);
      await delay(500);
    }
  }
  throw new Error(`PostgreSQL did not become ready: ${lastError}`);
}

async function waitForTinode(port: number, apiKey: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = 'Tinode readiness was not attempted';
  while (Date.now() < deadline) {
    try {
      await readTinodeLiveSessions(port, apiKey);
      return;
    } catch (error) {
      lastError = safeError(error, [apiKey]);
      await delay(500);
    }
  }
  throw new Error(`Tinode did not become ready: ${lastError}`);
}

async function cleanupPoint(names: PointNames, secrets: string[]): Promise<string[]> {
  const errors: string[] = [];
  for (const container of [names.tinode, names.database]) {
    try {
      await docker(['rm', '--force', container], 30_000);
    } catch (error) {
      const message = safeError(error, secrets);
      if (!/No such container/i.test(message)) errors.push(message);
    }
  }
  try {
    await docker(['network', 'rm', names.network], 30_000);
  } catch (error) {
    const message = safeError(error, secrets);
    if (!/not found|No such network/i.test(message)) errors.push(message);
  }
  return errors;
}

async function capturePointDiagnostics(names: PointNames, secrets: string[]): Promise<string> {
  const diagnostics: string[] = [];
  for (const [label, container] of [
    ['tinode', names.tinode],
    ['postgres', names.database]
  ] as const) {
    try {
      const state = (await docker([
        'inspect',
        '--format',
        '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{json .State.Error}}',
        container
      ])).trim();
      diagnostics.push(`${label} state: ${safeError(state, secrets)}`);
    } catch (error) {
      diagnostics.push(`${label} state unavailable: ${safeError(error, secrets)}`);
      continue;
    }
    try {
      const logs = (await docker(['logs', '--tail', '80', container], 10_000)).trim();
      if (logs) diagnostics.push(`${label} logs: ${safeError(logs, secrets)}`);
    } catch (error) {
      diagnostics.push(`${label} logs unavailable: ${safeError(error, secrets)}`);
    }
    if (label === 'tinode') {
      try {
        const logs = (await docker([
          'exec',
          container,
          '/bin/bash',
          '-c',
          'tail -n 80 /var/log/tinode.log'
        ], 10_000)).trim();
        if (logs) diagnostics.push(`tinode file log: ${safeError(logs, secrets)}`);
      } catch {
        // A stopped container cannot expose its internal log file.
      }
    }
  }
  return diagnostics.join(' | ').slice(0, 8_192);
}

async function countTestResources(runToken: string): Promise<number> {
  const token = testResourceToken(runToken);
  const containers = (await docker([
    'ps',
    '--all',
    '--filter',
    `name=ivekit-tcs-${token}`,
    '--format',
    '{{.Names}}'
  ])).trim().split(/\r?\n/).filter(Boolean);
  const networks = (await docker([
    'network',
    'ls',
    '--filter',
    `name=ivekit-tcs-${token}`,
    '--format',
    '{{.Name}}'
  ])).trim().split(/\r?\n/).filter(Boolean);
  return containers.length + networks.length;
}

async function ledContainerState(): Promise<Array<{ name: string; status: string }>> {
  const ids = (await docker([
    'ps',
    '--filter',
    'name=led-platform-',
    '--format',
    '{{.ID}}'
  ])).trim().split(/\r?\n/).filter(Boolean);
  if (ids.length === 0) return [];
  const output = await docker([
    'inspect',
    '--format',
    '{{.Id}}\t{{.Name}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.RestartCount}}',
    ...ids
  ]);
  return output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, rawName, state, health, restarts] = line.split('\t');
    return {
      name: rawName.replace(/^\//, ''),
      status: `${id}|${state}|${health}|restarts=${restarts}`
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

async function sourceIdentity(): Promise<TinodeStaircaseEvidence['source']> {
  const sha256: Record<string, string> = {};
  for (const file of SOURCE_FILES) {
    sha256[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  const safeDirectory = `safe.directory=${process.cwd()}`;
  const commit = (await command('git', ['-c', safeDirectory, 'rev-parse', 'HEAD'])).trim();
  const dirty = (await command('git', [
    '-c',
    safeDirectory,
    'status',
    '--porcelain',
    '--',
    ...SOURCE_FILES
  ])).trim().length > 0;
  return {
    git_commit: commit,
    relevant_files_dirty: dirty,
    sha256
  };
}

async function serverIdentity(): Promise<TinodeStaircaseEvidence['server']> {
  return {
    hostname: hostname(),
    platform: platform(),
    kernel_release: release(),
    logical_cpu_count: cpus().length,
    cpu_model: cpus()[0]?.model || 'unknown',
    memory_bytes: totalmem(),
    docker_server_version: (
      await docker(['version', '--format', '{{.Server.Version}}'])
    ).trim()
  };
}

async function dockerImageIdentity(reference: string): Promise<DockerImageIdentity> {
  const output = await docker([
    'image',
    'inspect',
    '--format',
    '{{.Id}}\t{{.Architecture}}\t{{.Os}}\t{{.Size}}\t{{json .RepoDigests}}',
    reference
  ]);
  const [imageId, architecture, operatingSystem, size, repoDigests] = output.trim().split('\t');
  const parsedDigests = JSON.parse(repoDigests || '[]');
  return {
    requested_reference: reference,
    image_id: imageId,
    architecture,
    operating_system: operatingSystem,
    size_bytes: integer(Number(size), 1, Number.MAX_SAFE_INTEGER, 'Docker image size'),
    repo_digests: Array.isArray(parsedDigests)
      ? parsedDigests.map((value) => String(value)).sort()
      : []
  };
}

function pointSecrets(): PointSecrets {
  return {
    api: generateTinodeApiCredential({ salt: randomBytes(32) }),
    postgres_password: randomBytes(24).toString('base64url'),
    auth_token_key: randomBytes(32).toString('base64'),
    uid_encryption_key: randomBytes(16).toString('base64')
  };
}

function pointNames(runToken: string, connections: number): PointNames {
  const shortToken = testResourceToken(runToken);
  const prefix = `ivekit-tcs-${shortToken}-${connections}`;
  return {
    prefix,
    network: `${prefix}-net`,
    database: `${prefix}-db`,
    tinode: `${prefix}-app`
  };
}

function writePrivateEnv(path: string, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) {
      throw new Error('Tinode staircase env file contains an invalid entry');
    }
  }
  const body = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n');
  writeFileSync(path, `${body}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

function assertPrivateFile(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error('Tinode staircase credential bundle is not private');
  }
}

function testResourceToken(runToken: string): string {
  return createHash('sha256').update(runToken).digest('hex').slice(0, 10);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
    flag: 'wx'
  });
  renameSync(temporary, path);
}

async function docker(args: string[], timeout = 30_000): Promise<string> {
  return command('docker', args, timeout);
}

async function command(executable: string, args: string[], timeout = 30_000): Promise<string> {
  try {
    const result = await execFile(executable, args, {
      cwd: process.cwd(),
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8'
    });
    return String(result.stdout || '');
  } catch (error) {
    const value = error as Error & { stderr?: string; stdout?: string };
    const detail = String(value.stderr || value.stdout || value.message || '').trim();
    throw new Error(`${executable} failed${detail ? `: ${detail}` : ''}`);
  }
}

function splitPair(value: unknown, label: string): [string, string] {
  const parts = String(value || '').split('/').map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Docker ${label} is invalid`);
  }
  return [parts[0], parts[1]];
}

function percentage(value: unknown, label: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)%$/.exec(String(value || '').trim());
  if (!match) throw new Error(`Docker ${label} is invalid`);
  return Number(match[1]);
}

function byteQuantity(value: string, label: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?i?b)$/i.exec(value.trim());
  if (!match) throw new Error(`Docker ${label} byte quantity is invalid`);
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const powers: Record<string, number> = {
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    kib: 1_024,
    mib: 1_048_576,
    gib: 1_073_741_824,
    tib: 1_099_511_627_776
  };
  return amount * powers[unit];
}

function imageReference(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 512 || /[\s\0]/.test(normalized)) {
    throw new Error(`Tinode staircase ${label} is invalid`);
  }
  return normalized;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

function maximum<T>(values: T[], pick: (value: T) => number | null): number | null {
  const selected = values.map(pick).filter((value): value is number => value !== null);
  return selected.length > 0 ? Math.max(...selected) : null;
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeError(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(Boolean)) {
    message = message.split(secret).join('[REDACTED]');
  }
  return message.slice(0, 4_096);
}

function compactTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
