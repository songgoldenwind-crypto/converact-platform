import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  request as requestHttps,
  type RequestOptions as HttpsRequestOptions
} from 'node:https';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  RtpengineNgClient
} from '../src/agent-runtime/ivekit/media-control/rtpengine-ng.js';
import {
  HttpCellAdmissionClient
} from '../src/agent-runtime/ivekit/placement/admission-http.js';
import {
  composeOwnerEpoch,
  splitOwnerEpoch
} from '../src/agent-runtime/ivekit/placement/owner-epoch.js';
import type {
  AdmissionReservation,
  CapacityRequirement
} from '../src/agent-runtime/ivekit/placement/types.js';
import {
  RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS,
  buildRtpengineAcceptanceEvidence,
  runRtpengineControlMatrix,
  runRtpengineMediaScenario,
  type RtpengineAcceptanceCheck,
  type RtpengineAcceptanceAdmissionIdentity,
  type RtpengineAcceptanceAdmissionPort,
  type RtpengineAcceptanceEvidence,
  type RtpengineAcceptanceIdentity,
  type RtpengineMediaScenarioResult
} from './ivekit-rtpengine-acceptance.js';

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/;
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/;
const MAX_PROCESS_OUTPUT_BYTES = 1_048_576;
const MAX_TLS_FILE_BYTES = 262_144;

export interface RtpengineAcceptanceCliConfig {
  media_control_base_url: string;
  media_control_token: string;
  media_control_fetch: typeof fetch;
  bind_address: string;
  expires_at: string;
  identity: RtpengineAcceptanceIdentity;
  output_file: string;
  source_dir: string;
  docker_binary: string;
  container_prefix: string;
  containers: {
    media_control: string;
    admission: string;
    rtpengine: string;
  };
  ng: {
    host: string;
    port: number;
  };
  media_ports: {
    minimum: number;
    maximum: number;
  };
  maximum_active_calls: number;
  plaintext_packet_count: number;
  srtp_packet_count: number;
  packet_interval_ms: number;
  receive_timeout_ms: number;
  outage_hold_ms: number;
  maximum_jitter_ms: number;
  admission?: RtpengineAcceptanceAdmissionPort;
}

export function loadRtpengineAcceptanceCliConfig(
  env: Record<string, string | undefined>
): RtpengineAcceptanceCliConfig {
  const baseUrl = required(env, 'IVEKIT_MEDIA_CONTROL_ENDPOINT');
  checkedHttpUrl(baseUrl);
  const mediaControlFetch = loadRtpengineAcceptanceFetch(baseUrl, env);
  const token = required(env, 'IVEKIT_MEDIA_CONTROL_TOKEN');
  if (token.length < 24 || token.length > 512 || /[\0\r\n]/.test(token)) {
    throw new Error('IVEKIT_MEDIA_CONTROL_TOKEN is invalid');
  }
  const bindAddress = required(
    env,
    'IVEKIT_RTPENGINE_ACCEPTANCE_BIND_ADDRESS'
  );
  if (isIP(bindAddress) === 0) {
    throw new Error('IVEKIT_RTPENGINE_ACCEPTANCE_BIND_ADDRESS is invalid');
  }
  const expiresAt = required(
    env,
    'IVEKIT_RTPENGINE_ACCEPTANCE_EXPIRES_AT'
  );
  if (!canonicalDate(expiresAt) || Date.parse(expiresAt) <= Date.now()) {
    throw new Error('IVEKIT_RTPENGINE_ACCEPTANCE_EXPIRES_AT is invalid');
  }
  const sourceCommit = required(
    env,
    'IVEKIT_RTPENGINE_ACCEPTANCE_SOURCE_COMMIT'
  );
  const imageDigest = required(
    env,
    'IVEKIT_RTPENGINE_ACCEPTANCE_IMAGE_DIGEST'
  );
  const configHash = required(
    env,
    'IVEKIT_RTPENGINE_ACCEPTANCE_CONFIG_HASH'
  );
  if (!SOURCE_COMMIT.test(sourceCommit)) {
    throw new Error('IVEKIT_RTPENGINE_ACCEPTANCE_SOURCE_COMMIT is invalid');
  }
  if (!SHA256_DIGEST.test(imageDigest)) {
    throw new Error('IVEKIT_RTPENGINE_ACCEPTANCE_IMAGE_DIGEST is invalid');
  }
  if (!SHA256_DIGEST.test(configHash)) {
    throw new Error('IVEKIT_RTPENGINE_ACCEPTANCE_CONFIG_HASH is invalid');
  }
  const runtimeMode = required(
    env,
    'IVEKIT_RTPENGINE_ACCEPTANCE_RUNTIME_MODE'
  );
  if (runtimeMode !== 'userspace' && runtimeMode !== 'kernel') {
    throw new Error('IVEKIT_RTPENGINE_ACCEPTANCE_RUNTIME_MODE is invalid');
  }
  const outputFile = absolutePath(
    required(env, 'IVEKIT_RTPENGINE_ACCEPTANCE_OUTPUT'),
    'IVEKIT_RTPENGINE_ACCEPTANCE_OUTPUT'
  );
  const sourceDir = absolutePath(
    required(env, 'IVEKIT_RTPENGINE_ACCEPTANCE_SOURCE_DIR'),
    'IVEKIT_RTPENGINE_ACCEPTANCE_SOURCE_DIR'
  );
  const dockerBinary = absolutePath(
    required(env, 'IVEKIT_RTPENGINE_ACCEPTANCE_DOCKER_BINARY'),
    'IVEKIT_RTPENGINE_ACCEPTANCE_DOCKER_BINARY'
  );
  const containerPrefix = required(
    env,
    'IVEKIT_RTPENGINE_ACCEPTANCE_CONTAINER_PREFIX'
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}-$/.test(containerPrefix)) {
    throw new Error('acceptance container prefix is invalid');
  }
  const containers = {
    media_control: acceptanceContainer(
      env,
      'IVEKIT_RTPENGINE_ACCEPTANCE_MEDIA_CONTROL_CONTAINER',
      containerPrefix
    ),
    admission: acceptanceContainer(
      env,
      'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_CONTAINER',
      containerPrefix
    ),
    rtpengine: acceptanceContainer(
      env,
      'IVEKIT_RTPENGINE_ACCEPTANCE_RTPENGINE_CONTAINER',
      containerPrefix
    )
  };
  const ngHost = required(env, 'IVEKIT_RTPENGINE_ACCEPTANCE_NG_HOST');
  if (isIP(ngHost) === 0) {
    throw new Error('IVEKIT_RTPENGINE_ACCEPTANCE_NG_HOST is invalid');
  }
  const mediaPortMinimum = integerEnv(
    env,
    'IVEKIT_RTPENGINE_ACCEPTANCE_MEDIA_PORT_MIN',
    undefined,
    1_024,
    65_534
  );
  const mediaPortMaximum = integerEnv(
    env,
    'IVEKIT_RTPENGINE_ACCEPTANCE_MEDIA_PORT_MAX',
    undefined,
    mediaPortMinimum + 1,
    65_535
  );
  const admission = loadRtpengineAcceptanceAdmission(env);
  return {
    media_control_base_url: baseUrl,
    media_control_token: token,
    media_control_fetch: mediaControlFetch,
    bind_address: bindAddress,
    expires_at: expiresAt,
    identity: {
      source_commit: sourceCommit,
      rtpengine_image_digest: imageDigest,
      config_hash: configHash,
      runtime_mode: runtimeMode
    },
    output_file: outputFile,
    source_dir: sourceDir,
    docker_binary: dockerBinary,
    container_prefix: containerPrefix,
    containers,
    ng: {
      host: ngHost,
      port: integerEnv(
        env,
        'IVEKIT_RTPENGINE_ACCEPTANCE_NG_PORT',
        undefined,
        1,
        65_535
      )
    },
    media_ports: {
      minimum: mediaPortMinimum,
      maximum: mediaPortMaximum
    },
    maximum_active_calls: integerEnv(
      env,
      'IVEKIT_RTPENGINE_ACCEPTANCE_MAX_ACTIVE_CALLS',
      undefined,
      1,
      32
    ),
    plaintext_packet_count: integerEnv(
      env,
      'IVEKIT_RTPENGINE_ACCEPTANCE_PLAINTEXT_PACKETS',
      500,
      20,
      100_000
    ),
    srtp_packet_count: integerEnv(
      env,
      'IVEKIT_RTPENGINE_ACCEPTANCE_SRTP_PACKETS',
      100,
      20,
      100_000
    ),
    packet_interval_ms: integerEnv(
      env,
      'IVEKIT_RTPENGINE_ACCEPTANCE_PACKET_INTERVAL_MS',
      20,
      1,
      1_000
    ),
    receive_timeout_ms: integerEnv(
      env,
      'IVEKIT_RTPENGINE_ACCEPTANCE_RECEIVE_TIMEOUT_MS',
      30_000,
      1_000,
      300_000
    ),
    outage_hold_ms: integerEnv(
      env,
      'IVEKIT_RTPENGINE_ACCEPTANCE_OUTAGE_HOLD_MS',
      1_000,
      100,
      30_000
    ),
    maximum_jitter_ms: numberEnv(
      env,
      'IVEKIT_RTPENGINE_ACCEPTANCE_MAXIMUM_JITTER_MS',
      30,
      0.1,
      1_000
    ),
    ...(admission ? { admission } : {})
  };
}

export async function prepareIsolatedRtpengineEnvironment(input: {
  restart(): Promise<void>;
  undrain(): Promise<void>;
  active_calls(): Promise<number>;
}): Promise<number> {
  await input.restart();
  await input.undrain();
  const activeCalls = await input.active_calls();
  if (!Number.isSafeInteger(activeCalls) || activeCalls !== 0) {
    throw new Error(
      `RTPengine active calls after isolated restart: ${activeCalls}`
    );
  }
  return activeCalls;
}

export async function runRtpengineAcceptanceCli(
  config: RtpengineAcceptanceCliConfig
): Promise<RtpengineAcceptanceEvidence> {
  let walInodeBefore = '';
  let walInodeAfter = '';
  let servicesStopped = false;
  try {
    await runRegressionChecks(config);
    await prepareIsolatedRtpengineEnvironment({
      restart: () => restartRtpengine(config),
      undrain: () => setNodeDrain(config, false),
      active_calls: () => activeRtpengineCalls(config)
    });
    const plaintext = await runRtpengineMediaScenario({
      media_control_base_url: config.media_control_base_url,
      media_control_token: config.media_control_token,
      media_control_fetch: config.media_control_fetch,
      bind_address: config.bind_address,
      mode: 'rtp',
      scenario_id: `server-plain-${randomSuffix()}`,
      owner_epoch: '1000',
      expires_at: config.expires_at,
      packet_count: config.plaintext_packet_count,
      packet_interval_ms: config.packet_interval_ms,
      receive_timeout_ms: config.receive_timeout_ms,
      admission: config.admission,
      during_stream: async () => {
        walInodeBefore = await mediaWalInode(config);
        try {
          await docker(config, [
            'stop',
            '--time',
            '1',
            config.containers.admission,
            config.containers.media_control
          ]);
          servicesStopped = true;
          await delay(config.outage_hold_ms);
          await restoreControlPlane(config);
          servicesStopped = false;
          walInodeAfter = await mediaWalInode(config);
          await setNodeDrain(config, false);
        } catch (error) {
          await restoreControlPlane(config).catch(() => undefined);
          servicesStopped = false;
          throw error;
        }
      }
    });
    const srtp = await runRtpengineMediaScenario({
      media_control_base_url: config.media_control_base_url,
      media_control_token: config.media_control_token,
      media_control_fetch: config.media_control_fetch,
      bind_address: config.bind_address,
      mode: 'sdes_srtp',
      scenario_id: `server-srtp-${randomSuffix()}`,
      owner_epoch: '1100',
      expires_at: config.expires_at,
      packet_count: config.srtp_packet_count,
      packet_interval_ms: config.packet_interval_ms,
      receive_timeout_ms: config.receive_timeout_ms,
      admission: config.admission
    });
    const matrix = await runRtpengineControlMatrix({
      media_control_base_url: config.media_control_base_url,
      media_control_token: config.media_control_token,
      media_control_fetch: config.media_control_fetch,
      bind_address: config.bind_address,
      expires_at: config.expires_at,
      maximum_active_calls: config.maximum_active_calls,
      admission: config.admission,
      matrix_id: `server-${randomSuffix()}`,
      set_drain: (value) => setNodeDrain(config, value),
      stop_rtpengine: async () => {
        await docker(config, ['stop', '--time', '1', config.containers.rtpengine]);
      },
      start_rtpengine: () => restoreRtpengine(config),
      regression_checks: {
        before_write_failure_classified: true,
        after_write_disconnect_reconciled: true
      }
    });
    const checks = buildChecks(
      config,
      plaintext,
      srtp,
      matrix.checks,
      walInodeBefore,
      walInodeAfter
    );
    const evidence = buildRtpengineAcceptanceEvidence({
      identity: config.identity,
      generated_at: new Date().toISOString(),
      checks,
      observations: {
        plaintext,
        sdes_srtp: srtp,
        control_matrix: matrix.observations,
        wal: {
          inode_before: walInodeBefore,
          inode_after: walInodeAfter,
          inode_preserved: walInodeBefore !== '' &&
            walInodeBefore === walInodeAfter
        },
        regression: {
          command: 'node --import tsx --test --test-name-pattern=...',
          before_write_failure_classified: true,
          after_write_disconnect_reconciled: true
        }
      },
      not_run: [
        ...(config.identity.runtime_mode === 'userspace'
          ? [{
              dependency: 'kernel-forwarding' as const,
              reason: 'userspace runtime selected for Task 9'
            }]
          : []),
        {
          dependency: 'recording',
          reason: 'recording is independently accepted in Task 10'
        },
        {
          dependency: 'transcoding',
          reason: 'transcoding is independently accepted in Task 11'
        }
      ]
    });
    await writeEvidence(config.output_file, evidence);
    return evidence;
  } finally {
    if (servicesStopped) {
      await restoreControlPlane(config).catch(() => undefined);
    }
    await restoreRtpengine(config).catch(() => undefined);
  }
}

function buildChecks(
  config: RtpengineAcceptanceCliConfig,
  plaintext: RtpengineMediaScenarioResult,
  srtp: RtpengineMediaScenarioResult,
  matrix: Awaited<ReturnType<typeof runRtpengineControlMatrix>>['checks'],
  walInodeBefore: string,
  walInodeAfter: string
): Record<RtpengineAcceptanceCheck, boolean> {
  const checks = Object.fromEntries(
    RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS.map((name) => [name, false])
  ) as Record<RtpengineAcceptanceCheck, boolean>;
  checks.plaintext_offer_answer =
    successful(plaintext.offer_result_class) &&
    successful(plaintext.answer_result_class);
  checks.plaintext_relay_endpoint =
    relayInRange(config, plaintext.relay_for_a.port) &&
    relayInRange(config, plaintext.relay_for_b.port);
  checks.plaintext_bidirectional_rtp =
    completeMedia(plaintext, config.plaintext_packet_count);
  checks.plaintext_packet_integrity =
    plaintext.endpoint_a.invalid_packets === 0 &&
    plaintext.endpoint_b.invalid_packets === 0;
  checks.plaintext_sequence_and_ssrc =
    ordered(plaintext.endpoint_a) && ordered(plaintext.endpoint_b);
  checks.plaintext_loss_and_jitter =
    quality(config, plaintext.endpoint_a) &&
    quality(config, plaintext.endpoint_b);
  checks.plaintext_rtcp =
    plaintext.endpoint_a.rtcp_packets >= 1 &&
    plaintext.endpoint_b.rtcp_packets >= 1;
  checks.sdes_srtp_offer_answer =
    successful(srtp.offer_result_class) &&
    successful(srtp.answer_result_class) &&
    srtp.relay_for_a.profile === 'RTP/SAVP' &&
    srtp.relay_for_b.profile === 'RTP/SAVP';
  checks.sdes_srtp_bidirectional =
    completeMedia(srtp, config.srtp_packet_count) &&
    srtp.endpoint_a.invalid_packets === 0 &&
    srtp.endpoint_b.invalid_packets === 0;
  checks.srtp_plaintext_absent =
    srtp.endpoint_a.wire_plaintext_match_packets === 0 &&
    srtp.endpoint_b.wire_plaintext_match_packets === 0;
  checks.control_plane_outage_continuity =
    Boolean(plaintext.continuity) &&
    plaintext.continuity!.received_after_callback >
      plaintext.continuity!.received_before_callback;
  checks.wal_restart_recovery =
    walInodeBefore !== '' &&
    walInodeBefore === walInodeAfter &&
    successful(plaintext.query_result_class || '') &&
    plaintext.continuity?.relay_port_preserved_after_restart === true;
  checks.idempotent_delete =
    plaintext.delete_replay_result_class === 'replayed';
  Object.assign(checks, matrix);
  return checks;
}

function completeMedia(
  result: RtpengineMediaScenarioResult,
  expectedPackets: number
): boolean {
  return result.endpoint_a.unique_packets === expectedPackets &&
    result.endpoint_b.unique_packets === expectedPackets;
}

function ordered(
  endpoint: RtpengineMediaScenarioResult['endpoint_a']
): boolean {
  return endpoint.duplicate_packets === 0 &&
    endpoint.out_of_order_packets === 0;
}

function quality(
  config: RtpengineAcceptanceCliConfig,
  endpoint: RtpengineMediaScenarioResult['endpoint_a']
): boolean {
  return endpoint.lost_packets === 0 &&
    endpoint.jitter_ms <= config.maximum_jitter_ms &&
    endpoint.first_packet_ms !== null &&
    endpoint.first_packet_ms <= 2_000;
}

function relayInRange(
  config: RtpengineAcceptanceCliConfig,
  port: number
): boolean {
  return port >= config.media_ports.minimum &&
    port <= config.media_ports.maximum;
}

function successful(value: string): boolean {
  return value === 'committed' || value === 'replayed';
}

async function runRegressionChecks(
  config: RtpengineAcceptanceCliConfig
): Promise<void> {
  await executable(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-name-pattern',
      'rejects excess work before write|classifies disconnect after write|pre-write NG connection outage',
      join(config.source_dir, 'test/ivekit-rtpengine-ng.test.ts'),
      join(config.source_dir, 'test/ivekit-rtpengine-media-transport.test.ts')
    ],
    60_000
  );
}

async function mediaWalInode(
  config: RtpengineAcceptanceCliConfig
): Promise<string> {
  const output = await docker(config, [
    'exec',
    config.containers.media_control,
    'node',
    '-e',
    'process.stdout.write(String(require("fs").statSync("/var/lib/ivekit-media-control/media-command.wal").ino))'
  ]);
  if (!/^[1-9][0-9]{0,31}$/.test(output.trim())) {
    throw new Error('media-control WAL inode is invalid');
  }
  return output.trim();
}

async function restoreControlPlane(
  config: RtpengineAcceptanceCliConfig
): Promise<void> {
  await docker(config, ['start', config.containers.admission]);
  await docker(config, ['start', config.containers.media_control]);
  const readyUrl = new URL('/readyz', config.media_control_base_url);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await config.media_control_fetch(readyUrl, {
        signal: AbortSignal.timeout(1_000)
      });
      if (response.ok) return;
    } catch {
      // The bounded retry loop records the terminal failure.
    }
    await delay(100);
  }
  throw new Error('media-control did not become ready after restart');
}

async function restoreRtpengine(
  config: RtpengineAcceptanceCliConfig
): Promise<void> {
  await docker(config, ['start', config.containers.rtpengine]);
  await waitForRtpengine(config);
}

async function restartRtpengine(
  config: RtpengineAcceptanceCliConfig
): Promise<void> {
  await docker(config, [
    'restart',
    '--time',
    '1',
    config.containers.rtpengine
  ]);
  await waitForRtpengine(config);
}

async function waitForRtpengine(
  config: RtpengineAcceptanceCliConfig
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await nodeControl(config, 'ivekit status');
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error('RTPengine did not become ready after restart');
}

async function activeRtpengineCalls(
  config: RtpengineAcceptanceCliConfig
): Promise<number> {
  const response = await nodeControl(config, 'ivekit status');
  const value = response['ivekit-active-calls'];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('RTPengine active-call status is invalid');
  }
  return Number(value);
}

async function setNodeDrain(
  config: RtpengineAcceptanceCliConfig,
  draining: boolean
): Promise<void> {
  await nodeControl(config, draining ? 'ivekit drain' : 'ivekit undrain');
}

async function nodeControl(
  config: RtpengineAcceptanceCliConfig,
  command: 'ivekit status' | 'ivekit drain' | 'ivekit undrain'
): Promise<Record<string, unknown>> {
  const client = new RtpengineNgClient({
    host: config.ng.host,
    port: config.ng.port,
    maxConnections: 1,
    maxInFlight: 4,
    requestTimeoutMs: 2_000,
    maxRequestBytes: 65_536,
    maxResponseBytes: 65_536,
    maxQueuedBytes: 262_144
  });
  try {
    const commandId = `acceptance-${randomUUID()}`;
    const response = await client.request(
      { command },
      {
        command_id: commandId,
        command_hash: createHash('sha256')
          .update(commandId, 'utf8')
          .digest('hex')
      }
    );
    const result = Buffer.isBuffer(response.result)
      ? response.result.toString('utf8')
      : String(response.result ?? '');
    if (result !== 'ok') throw new Error(`${command} was rejected`);
    return response;
  } finally {
    await client.close();
  }
}

async function docker(
  config: RtpengineAcceptanceCliConfig,
  args: string[]
): Promise<string> {
  return executable(config.docker_binary, args, 60_000);
}

function executable(
  executablePath: string,
  args: string[],
  timeoutMs: number
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      executablePath,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message)
            .replace(/[\0\r\n]+/g, ' ')
            .slice(0, 512);
          rejectPromise(new Error(`acceptance process failed: ${detail}`));
          return;
        }
        resolvePromise(String(stdout));
      }
    );
  });
}

async function writeEvidence(
  outputFile: string,
  evidence: RtpengineAcceptanceEvidence
): Promise<void> {
  const parent = dirname(outputFile);
  if (!isAbsolute(parent)) throw new Error('evidence directory is invalid');
  const handle = await open(outputFile, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function acceptanceContainer(
  env: Record<string, string | undefined>,
  name: string,
  prefix: string
): string {
  const value = required(env, name);
  if (!CONTAINER.test(value) || !value.startsWith(prefix)) {
    throw new Error(`${name} violates the acceptance container prefix`);
  }
  return value;
}

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value) ||
      /[\0\r\n]/.test(value) ||
      value.split('/').includes('..')) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function checkedHttpUrl(
  value: string,
  field = 'IVEKIT_MEDIA_CONTROL_ENDPOINT'
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} is invalid`);
  }
  if (!['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '' && url.pathname !== '/')) {
    throw new Error(`${field} is invalid`);
  }
}

function loadRtpengineAcceptanceAdmission(
  env: Record<string, string | undefined>
): RtpengineAcceptanceAdmissionPort | undefined {
  const fields = [
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_ENDPOINT',
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_TOKEN',
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_TENANT_ID',
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_REGION_ID',
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_ZONE_ID',
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_CELL_ID',
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_PROFILE_ID',
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_OWNER_NODE_ID',
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_REQUIRED_CAPACITY_JSON'
  ] as const;
  const configured = fields.filter((field) => env[field]?.trim());
  if (configured.length === 0) return undefined;
  if (configured.length !== fields.length) {
    throw new Error('Cell admission configuration must be complete');
  }

  const endpoint = required(
    env,
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_ENDPOINT'
  );
  checkedHttpUrl(
    endpoint,
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_ENDPOINT'
  );
  const tenantId = acceptanceIdentifier(
    required(env, 'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_TENANT_ID'),
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_TENANT_ID'
  );
  const regionId = acceptanceIdentifier(
    required(env, 'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_REGION_ID'),
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_REGION_ID'
  );
  const zoneId = acceptanceIdentifier(
    required(env, 'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_ZONE_ID'),
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_ZONE_ID'
  );
  const cellId = acceptanceIdentifier(
    required(env, 'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_CELL_ID'),
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_CELL_ID'
  );
  const profileId = acceptanceIdentifier(
    required(env, 'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_PROFILE_ID'),
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_PROFILE_ID'
  );
  const ownerNodeId = acceptanceIdentifier(
    required(env, 'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_OWNER_NODE_ID'),
    'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_OWNER_NODE_ID'
  );
  const requiredCapacity = acceptanceCapacity(
    required(
      env,
      'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_REQUIRED_CAPACITY_JSON'
    )
  );
  const client = new HttpCellAdmissionClient({
    endpoint,
    service_token: required(
      env,
      'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_TOKEN'
    ),
    timeout_ms: 5_000
  });

  const identity = (
    reservation: AdmissionReservation,
    expectedState: AdmissionReservation['state'],
    expectedReservationId?: string
  ): RtpengineAcceptanceAdmissionIdentity => {
    if (reservation.state !== expectedState ||
        reservation.region_id !== regionId ||
        reservation.zone_id !== zoneId ||
        reservation.cell_id !== cellId ||
        reservation.owner_node_id !== ownerNodeId ||
        (expectedReservationId &&
          reservation.reservation_id !== expectedReservationId)) {
      throw new Error('Cell admission reservation identity is invalid');
    }
    splitOwnerEpoch(reservation.owner_epoch);
    return {
      admission_reservation_id: acceptanceIdentifier(
        reservation.reservation_id,
        'Cell admission reservation ID'
      ),
      tenant_id: tenantId,
      cell_id: cellId,
      owner_node_id: ownerNodeId,
      owner_epoch: reservation.owner_epoch
    };
  };

  return {
    reserve: async ({ interaction_id, idempotency_key }) => {
      acceptanceIdentifier(interaction_id, 'acceptance interaction ID');
      acceptanceIdentifier(idempotency_key, 'acceptance idempotency key');
      const state = await client.state();
      return identity(await client.reserve({
        request_id: `${idempotency_key}-request`,
        idempotency_key,
        tenant_id: tenantId,
        routing_partition_id: 'rtpengine-acceptance',
        interaction_id,
        interaction_kind: 'sip_voice',
        profile_id: profileId,
        required_capacity: requiredCapacity,
        preferred_region_id: regionId,
        preferred_zone_id: zoneId,
        preferred_cell_id: cellId,
        preferred_owner_node_id: ownerNodeId,
        region_id: regionId,
        zone_id: zoneId,
        cell_id: cellId,
        snapshot_version: Math.max(1, state.capacity_sequence),
        cell_lease_epoch: state.cell_lease_epoch
      }), 'reserved');
    },
    activate: async (reservation) => identity(
      await client.activate(reservation.admission_reservation_id),
      'active',
      reservation.admission_reservation_id
    ),
    takeover: async (reservation) => {
      const current = splitOwnerEpoch(reservation.owner_epoch);
      const state = await client.state();
      if (state.cell_lease_epoch < current.cell_lease_epoch) {
        throw new Error('Cell admission lease epoch regressed');
      }
      let nextSequence = state.cell_lease_epoch === current.cell_lease_epoch
        ? current.cell_local_sequence
        : 0;
      for (const candidate of state.reservations) {
        const owner = splitOwnerEpoch(candidate.owner_epoch);
        if (owner.cell_lease_epoch === state.cell_lease_epoch) {
          nextSequence = Math.max(
            nextSequence,
            owner.cell_local_sequence
          );
        }
      }
      if (nextSequence >= 0xffff_ffff) {
        throw new Error('Cell admission owner epoch is exhausted');
      }
      const ownerEpoch = composeOwnerEpoch(
        state.cell_lease_epoch,
        nextSequence + 1
      );
      return identity(await client.takeover(
        reservation.admission_reservation_id,
        {
          expected_owner_epoch: reservation.owner_epoch,
          owner_epoch: ownerEpoch,
          owner_node_id: ownerNodeId
        }
      ), 'active', reservation.admission_reservation_id);
    },
    close: async (reservation) => {
      identity(
        await client.close(reservation.admission_reservation_id),
        'closed',
        reservation.admission_reservation_id
      );
    }
  };
}

function acceptanceIdentifier(value: string, field: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function acceptanceCapacity(value: string): CapacityRequirement {
  if (Buffer.byteLength(value, 'utf8') > 4_096) {
    throw new Error(
      'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_REQUIRED_CAPACITY_JSON is invalid'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_REQUIRED_CAPACITY_JSON is invalid'
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_REQUIRED_CAPACITY_JSON is invalid'
    );
  }
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 16 ||
      entries.some(([name, amount]) =>
        !IDENTIFIER.test(name) ||
        !Number.isFinite(amount) ||
        Number(amount) <= 0 ||
        Number(amount) > 1_000_000
      )) {
    throw new Error(
      'IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_REQUIRED_CAPACITY_JSON is invalid'
    );
  }
  return Object.fromEntries(
    entries.map(([name, amount]) => [name, Number(amount)])
  );
}

function loadRtpengineAcceptanceFetch(
  baseUrl: string,
  env: Record<string, string | undefined>
): typeof fetch {
  const endpoint = new URL(baseUrl);
  const identityFile = String(
    env.IVEKIT_RTPENGINE_ACCEPTANCE_TLS_IDENTITY_FILE || ''
  ).trim();
  const caFile = String(
    env.IVEKIT_RTPENGINE_ACCEPTANCE_TLS_CA_FILE || ''
  ).trim();
  const configuredServername = String(
    env.IVEKIT_RTPENGINE_ACCEPTANCE_TLS_SERVERNAME || ''
  ).trim();
  const configured = [identityFile, caFile].filter(Boolean).length;

  if (endpoint.protocol === 'http:') {
    if (configured !== 0 || configuredServername) {
      throw new Error('RTPengine acceptance TLS requires an HTTPS endpoint');
    }
    return globalThis.fetch;
  }
  if (configured !== 2) {
    throw new Error(
      'RTPengine acceptance TLS fields must be configured together'
    );
  }
  const servername = checkedTlsServername(
    configuredServername || unbracketedHostname(endpoint.hostname)
  );
  const identity = readAcceptanceTlsFile(
    identityFile,
    'IVEKIT_RTPENGINE_ACCEPTANCE_TLS_IDENTITY_FILE',
    true
  );
  const ca = readAcceptanceTlsFile(
    caFile,
    'IVEKIT_RTPENGINE_ACCEPTANCE_TLS_CA_FILE',
    false
  );
  return createAcceptanceMutualTlsFetch({
    endpoint,
    identity,
    ca,
    servername
  });
}

function createAcceptanceMutualTlsFetch(input: {
  endpoint: URL;
  identity: Buffer;
  ca: Buffer;
  servername: string;
}): typeof fetch {
  return (async (
    requestInput: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1] = {}
  ) => {
    const target = new URL(
      typeof requestInput === 'string'
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.href
          : requestInput.url
    );
    if (target.protocol !== 'https:' ||
        target.origin !== input.endpoint.origin) {
      throw new Error(
        'RTPengine acceptance TLS request must use the configured HTTPS origin'
      );
    }
    if (init.signal?.aborted) throw abortError();
    const encoded = encodeAcceptanceRequestBody(init.body);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const options: HttpsRequestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: init.method || 'GET',
      headers: {
        ...headers,
        ...(encoded && headers['content-length'] === undefined
          ? { 'content-length': String(encoded.length) }
          : {})
      },
      key: input.identity,
      cert: input.identity,
      ca: input.ca,
      ...(isIP(input.servername) === 0
        ? { servername: input.servername }
        : {}),
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    };
    return await new Promise<Response>((resolvePromise, rejectPromise) => {
      const request = requestHttps(options, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let oversized = false;
        response.on('data', (chunk: Buffer | string) => {
          if (oversized) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > MAX_PROCESS_OUTPUT_BYTES) {
            oversized = true;
            request.destroy(
              new Error('RTPengine acceptance response is too large')
            );
            return;
          }
          chunks.push(buffer);
        });
        response.once('error', rejectPromise);
        response.on('end', () => {
          if (oversized) return;
          const status = response.statusCode || 502;
          const body = [204, 205, 304].includes(status)
            ? null
            : Buffer.concat(chunks, total);
          resolvePromise(new Response(body, {
            status,
            statusText: response.statusMessage,
            headers: acceptanceResponseHeaders(response.headers)
          }));
        });
      });
      const abort = () => request.destroy(abortError());
      init.signal?.addEventListener('abort', abort, { once: true });
      request.once('close', () =>
        init.signal?.removeEventListener('abort', abort)
      );
      request.once('error', rejectPromise);
      if (encoded) request.write(encoded);
      request.end();
    });
  }) as typeof fetch;
}

function readAcceptanceTlsFile(
  path: string,
  field: string,
  secret: boolean
): Buffer {
  absolutePath(path, field);
  const metadata = statSync(path);
  if (!metadata.isFile()) throw new Error(`${field} must be a file`);
  if (metadata.size < 1 || metadata.size > MAX_TLS_FILE_BYTES) {
    throw new Error(`${field} size is invalid`);
  }
  if (secret &&
      process.platform !== 'win32' &&
      (metadata.mode & 0o037) !== 0) {
    throw new Error(`${field} permissions are too broad`);
  }
  const value = readFileSync(path);
  if (value.length < 1 || value.length > MAX_TLS_FILE_BYTES) {
    throw new Error(`${field} size is invalid`);
  }
  return value;
}

function checkedTlsServername(value: string): string {
  if (!value ||
      value.length > 253 ||
      /[\0\r\n/\\]/.test(value) ||
      (isIP(value) === 0 &&
        !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value))) {
    throw new Error(
      'IVEKIT_RTPENGINE_ACCEPTANCE_TLS_SERVERNAME is invalid'
    );
  }
  return value;
}

function unbracketedHostname(value: string): string {
  return value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value;
}

function encodeAcceptanceRequestBody(
  value: RequestInit['body']
): Buffer | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error('RTPengine acceptance request body is unsupported');
}

function acceptanceResponseHeaders(
  input: import('node:http').IncomingHttpHeaders
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function required(
  env: Record<string, string | undefined>,
  name: string
): string {
  const value = env[name]?.trim();
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number | undefined,
  minimum: number,
  maximum: number
): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value! < minimum || value! > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value!;
}

function numberEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function canonicalDate(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function randomSuffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

if (process.argv[1] &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const config = loadRtpengineAcceptanceCliConfig(process.env);
    const evidence = await runRtpengineAcceptanceCli(config);
    process.stdout.write(`${JSON.stringify({
      status: evidence.status,
      output_file: config.output_file,
      checks_passed: Object.values(evidence.checks).filter(Boolean).length,
      checks_total: RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS.length
    })}\n`);
    if (evidence.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `iveKit RTPengine acceptance failed: ${
        message.replace(/[\0\r\n]+/g, ' ').slice(0, 512)
      }\n`
    );
    process.exitCode = 1;
  }
}
